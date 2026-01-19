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

/** Shopify tags: max 40 chars */
function safeTag(input: string) {
  return input.replace(/\s+/g, " ").trim().slice(0, 40);
}

/** Key/value tag, clipped to 40 total, safe characters */
function tagKV(key: string, value: string) {
  const cleanKey = key.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 20) || "k";
  const cleanVal = value
    .replace(/\s+/g, "-")
    .replace(/[^a-zA-Z0-9_-]/g, "")
    .slice(0, 30);
  return safeTag(`${cleanKey}:${cleanVal}`);
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

// NOTE: this requires Shop.defaultCurrency in your Prisma schema.
// If you don't have it, return null (and you'll just omit presentmentCurrencyCode on fallback).
async function resolveShopDefaultCurrency(shopId: string) {
  const shop = await prisma.shop.findUnique({
    where: { id: shopId },
    // @ts-ignore - only valid if you added defaultCurrency to Shop model
    select: { defaultCurrency: true },
  });
  // @ts-ignore
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

async function findDraftOrderIdByTag(args: {
  shopDomain: string;
  accessToken: string;
  tag: string;
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
          query FindDraftOrder($q: String!) {
            draftOrders(first: 5, query: $q, sortKey: UPDATED_AT, reverse: true) {
              nodes { id name }
            }
          }
        `,
        variables: { q: `tag:${args.tag}` },
      }),
    }
  );

  const json: any = await res.json();
  const node = json?.data?.draftOrders?.nodes?.[0];
  return node?.id ?? null;
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

    // Create submission early
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

    // ✅ short, always-valid tag (<= 40)
    const submissionTag = safeTag(`wsSub:${submission.id.slice(-12)}`);

    // ✅ tags must be <= 40 each (NO wishlistName tag)
    const baseTags = [
      safeTag("wishlist-submission"),
      tagKV("wishlist", wishlist.id),
      submissionTag,
      countryCode ? tagKV("country", countryCode) : null,
      requestedCurrency ? tagKV("curReq", requestedCurrency) : null,
    ].filter(Boolean) as string[];

    // Put long values in the note, not tags
    const baseNoteLines = [
      `Wishlist: ${wishlist.id} (${wishlist.name})`,
      `Submission: ${submission.id}`,
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

    // attempt 1 (requested currency if present)
    const attempt1Input = requestedCurrency
      ? { ...baseInput, presentmentCurrencyCode: requestedCurrency }
      : { ...baseInput };

    const attempt1 = await draftOrderCreate({
      shopDomain: identity.shop.shop,
      accessToken,
      input: attempt1Input,
    });

    // success if draftOrderId exists (or recover by tag)
    let draftOrderId: string | null = attempt1.draftOrderId;
    if (!draftOrderId) {
      draftOrderId = await findDraftOrderIdByTag({
        shopDomain: identity.shop.shop,
        accessToken,
        tag: submissionTag,
      });
    }

    if (draftOrderId) {
      const nextStatus =
        attempt1.gqlErrors.length || attempt1.userErrors.length
          ? "created_with_warnings"
          : "created";

      const updated = await prisma.wishlistSubmission.update({
        where: { id: submission.id },
        data: { status: nextStatus, draftOrderId },
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
          recoveredByTag: !attempt1.draftOrderId && !!draftOrderId,
          _submitVersion: "draftOrderCreate-v6-safe-tags",
        },
        201
      );
    }

    // retry on currency error
    if (requestedCurrency && looksLikeCurrencyError(attempt1.gqlErrors, attempt1.userErrors)) {
      const attempt2Tags = [
        ...baseTags,
        fallbackCurrency ? tagKV("curFb", fallbackCurrency) : safeTag("curFb:shop"),
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

      let draftOrderId2: string | null = attempt2.draftOrderId;
      if (!draftOrderId2) {
        draftOrderId2 = await findDraftOrderIdByTag({
          shopDomain: identity.shop.shop,
          accessToken,
          tag: submissionTag,
        });
      }

      if (draftOrderId2) {
        const nextStatus =
          attempt2.gqlErrors.length || attempt2.userErrors.length
            ? "created_with_warnings"
            : "created";

        const updated = await prisma.wishlistSubmission.update({
          where: { id: submission.id },
          data: { status: nextStatus, draftOrderId: draftOrderId2 },
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
            recoveredByTag: !attempt2.draftOrderId && !!draftOrderId2,
            _submitVersion: "draftOrderCreate-v6-safe-tags",
          },
          201
        );
      }

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
