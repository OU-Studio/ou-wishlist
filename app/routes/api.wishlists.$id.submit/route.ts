import prisma from "../../db.server";
import { readBody, asString } from "../../utils/api.server";
import { resolveCustomerIdentity } from "../../utils/identity.server";

const EXT_ORIGIN = "https://extensions.shopifycdn.com";
const ADMIN_API_VERSION = "2025-10";

function allowOrigin(request: Request) {
  const origin = request.headers.get("Origin") || "";
  return origin === EXT_ORIGIN ? origin : "*";
}

function corsHeaders(request: Request) {
  return {
    "Access-Control-Allow-Origin": allowOrigin(request),
    Vary: "Origin",
    "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  } as Record<string, string>;
}

function corsJson(request: Request, data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(request) },
  });
}

function corsNoContent(request: Request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) });
}

export async function loader({ request }: { request: Request }) {
  if (request.method === "OPTIONS") return corsNoContent(request);
  return corsJson(request, { error: "Method not allowed" }, 405);
}

// Prefer OFFLINE token (isOnline=false). Fall back to any token only if needed.
async function getShopAccessToken(shopDomain: string) {
  const offline = await prisma.session.findFirst({
    where: { shop: shopDomain, isOnline: false },
    select: { accessToken: true },
  });
  if (offline?.accessToken) return offline.accessToken;

  const any = await prisma.session.findFirst({
    where: { shop: shopDomain },
    select: { accessToken: true },
    orderBy: { expires: "desc" },
  });
  return any?.accessToken ?? null;
}

async function resolveRuleCurrency(shopId: string, countryCode: string | null) {
  if (!countryCode) return null;
  const cc = countryCode.trim().toUpperCase();
  if (cc.length !== 2) return null;

  const rule = await prisma.marketCurrencyRule.findUnique({
    where: { shopId_countryCode: { shopId, countryCode: cc } },
    select: { currency: true },
  });

  const cur = (rule?.currency || "").trim().toUpperCase();
  return cur.length === 3 ? cur : null;
}

async function resolveShopDefaultCurrency(shopId: string) {
  // Requires Shop.defaultCurrency String? in schema + migration applied.
  const shop = await prisma.shop.findUnique({
    where: { id: shopId },
    select: { defaultCurrency: true },
  });
  const cur = (shop?.defaultCurrency || "").trim().toUpperCase();
  return cur.length === 3 ? cur : null;
}

function looksLikeCurrencyError(gqlErrors: any[], userErrors: any[]) {
  const msg = [
    ...(gqlErrors || []).map((e) => e?.message).filter(Boolean),
    ...(userErrors || []).map((e) => e?.message).filter(Boolean),
  ]
    .join(" | ")
    .toLowerCase();

  if (!msg.includes("currency")) return false;

  return (
    msg.includes("not enabled") ||
    msg.includes("not supported") ||
    msg.includes("invalid") ||
    msg.includes("not available") ||
    msg.includes("not configured") ||
    msg.includes("isn't available")
  );
}

async function draftOrderCreate(args: {
  shopDomain: string;
  accessToken: string;
  input: any;
}) {
  const res = await fetch(
    `https://${args.shopDomain}/admin/api/${ADMIN_API_VERSION}/graphql.json`,
    {
      method: "POST",
      headers: {
        "X-Shopify-Access-Token": args.accessToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: `#graphql
          mutation CreateDraftOrder($input: DraftOrderInput!) {
            draftOrderCreate(input: $input) {
              draftOrder { id name }
              userErrors { field message }
            }
          }
        `,
        variables: { input: args.input },
      }),
    }
  );

  const json: any = await res.json();
  const gqlErrors = json?.errors ?? [];
  const userErrors = json?.data?.draftOrderCreate?.userErrors ?? [];
  const draftOrder = json?.data?.draftOrderCreate?.draftOrder ?? null;
  const draftOrderId = draftOrder?.id ?? null;

  return {
    resOk: res.ok,
    status: res.status,
    json,
    gqlErrors,
    userErrors,
    draftOrder,
    draftOrderId,
  };
}

export async function action({
  request,
  params,
}: {
  request: Request;
  params: { id?: string };
}) {
  if (request.method === "OPTIONS") return corsNoContent(request);

  try {
    const identity = await resolveCustomerIdentity(request);
    const wishlistId = params.id;

    if (!wishlistId) return corsJson(request, { error: "Missing id" }, 400);
    if (request.method !== "POST")
      return corsJson(request, { error: "Method not allowed" }, 405);

    const wishlist = await prisma.wishlist.findFirst({
      where: {
        id: wishlistId,
        shopId: identity.shop.id,
        customerId: identity.customer.id,
        isArchived: false,
      },
      include: { items: true },
    });

    if (!wishlist) return corsJson(request, { error: "Wishlist not found" }, 404);
    if (!wishlist.items.length)
      return corsJson(request, { error: "Wishlist is empty" }, 400);

    const body = await readBody(request);
    const note = (asString(body.note) || "").trim();
    const countryCode =
      (asString((body as any).countryCode) || "").trim().toUpperCase() || null;

    // create submission early
    const submission = await prisma.wishlistSubmission.create({
      data: {
        shopId: identity.shop.id,
        wishlistId: wishlist.id,
        customerId: identity.customer.id,
        status: "queued",
        note: note || null,
      },
      select: { id: true, status: true, draftOrderId: true, createdAt: true },
    });

    const accessToken = await getShopAccessToken(identity.shop.shop);
    if (!accessToken) {
      const failed = await prisma.wishlistSubmission.update({
        where: { id: submission.id },
        data: { status: "failed" },
        select: { id: true, status: true, draftOrderId: true, createdAt: true },
      });

      return corsJson(
        request,
        { error: "Missing offline access token for shop", submission: failed },
        500
      );
    }

    const requestedCurrency = await resolveRuleCurrency(identity.shop.id, countryCode);
    const fallbackCurrency = await resolveShopDefaultCurrency(identity.shop.id);

    const lineItems = wishlist.items.map((i) => ({
      variantId: i.variantId,
      quantity: i.quantity,
    }));

    const customerGid = `gid://shopify/Customer/${identity.customer.customerId}`;

    const baseTags = [
      `wishlist:${wishlist.id}`,
      `wishlistName:${wishlist.name}`,
      `wishlist-submission`,
      countryCode ? `country:${countryCode}` : null,
      requestedCurrency ? `currencyRequested:${requestedCurrency}` : null,
    ].filter(Boolean);

    const baseNoteLines = [
      `Wishlist: ${wishlist.id} (${wishlist.name})`,
      countryCode ? `Country: ${countryCode}` : null,
      requestedCurrency ? `Requested currency: ${requestedCurrency}` : null,
      note ? `Customer note: ${note}` : null,
    ].filter(Boolean);

    const baseInput: any = {
      customerId: customerGid,
      note: baseNoteLines.join("\n"),
      tags: baseTags,
      lineItems,
    };

    // attempt 1
    const attempt1Input = requestedCurrency
      ? { ...baseInput, presentmentCurrencyCode: requestedCurrency }
      : { ...baseInput };

    const attempt1 = await draftOrderCreate({
      shopDomain: identity.shop.shop,
      accessToken,
      input: attempt1Input,
    });

    // ✅ treat as success if draftOrderId exists (even if errors/warnings)
    if (attempt1.draftOrderId) {
      const nextStatus =
        attempt1.gqlErrors.length || attempt1.userErrors.length
          ? "created_with_warnings"
          : "created";

      const updated = await prisma.wishlistSubmission.update({
        where: { id: submission.id },
        data: { status: nextStatus, draftOrderId: attempt1.draftOrderId },
        select: { id: true, status: true, draftOrderId: true, createdAt: true },
      });

      return corsJson(
        request,
        {
          submission: updated,
          countryCode,
          currency: {
            requested: requestedCurrency,
            used: requestedCurrency ?? null,
            fallbackUsed: false,
          },
          warnings: { gqlErrors: attempt1.gqlErrors, userErrors: attempt1.userErrors },
          _submitVersion: "draftOrderCreate-v4-success-on-id-currency-fallback",
        },
        201
      );
    }

    // retry on currency error (only if we tried a requested currency)
    if (requestedCurrency && looksLikeCurrencyError(attempt1.gqlErrors, attempt1.userErrors)) {
      const attempt2Tags = [
        ...baseTags,
        fallbackCurrency ? `currencyFallback:${fallbackCurrency}` : `currencyFallback:shop-default`,
      ].filter(Boolean);

      const attempt2Note = [
        ...baseNoteLines,
        fallbackCurrency ? `Fallback currency: ${fallbackCurrency}` : `Fallback currency: (shop default)`,
      ]
        .filter(Boolean)
        .join("\n");

      const attempt2Input: any = {
        ...baseInput,
        note: attempt2Note,
        tags: attempt2Tags,
        ...(fallbackCurrency ? { presentmentCurrencyCode: fallbackCurrency } : {}),
      };

      const attempt2 = await draftOrderCreate({
        shopDomain: identity.shop.shop,
        accessToken,
        input: attempt2Input,
      });

      // ✅ treat as success if draftOrderId exists
      if (attempt2.draftOrderId) {
        const nextStatus =
          attempt2.gqlErrors.length || attempt2.userErrors.length
            ? "created_with_warnings"
            : "created";

        const updated = await prisma.wishlistSubmission.update({
          where: { id: submission.id },
          data: { status: nextStatus, draftOrderId: attempt2.draftOrderId },
          select: { id: true, status: true, draftOrderId: true, createdAt: true },
        });

        return corsJson(
          request,
          {
            submission: updated,
            countryCode,
            currency: {
              requested: requestedCurrency,
              used: fallbackCurrency ?? null,
              fallbackUsed: true,
            },
            warnings: { gqlErrors: attempt2.gqlErrors, userErrors: attempt2.userErrors },
            _submitVersion: "draftOrderCreate-v4-success-on-id-currency-fallback",
          },
          201
        );
      }

      // fallback failed
      await prisma.wishlistSubmission.update({
        where: { id: submission.id },
        data: { status: "failed" },
      });

      return corsJson(
        request,
        {
          error: "Draft order create failed (after currency fallback)",
          countryCode,
          currency: { requested: requestedCurrency, fallback: fallbackCurrency ?? null },
          attempt: "fallback",
          warnings: { gqlErrors: attempt2.gqlErrors, userErrors: attempt2.userErrors },
          raw: attempt2.json,
          submission: { ...submission, status: "failed" },
        },
        400
      );
    }

    // primary failed (no draftOrderId)
    await prisma.wishlistSubmission.update({
      where: { id: submission.id },
      data: { status: "failed" },
    });

    return corsJson(
      request,
      {
        error: "Draft order create failed",
        countryCode,
        currency: { requested: requestedCurrency, fallback: fallbackCurrency ?? null },
        attempt: "primary",
        warnings: { gqlErrors: attempt1.gqlErrors, userErrors: attempt1.userErrors },
        raw: attempt1.json,
        submission: { ...submission, status: "failed" },
      },
      400
    );
  } catch (e: any) {
    return corsJson(request, { error: e?.message || "Unauthorized" }, 401);
  }
}
