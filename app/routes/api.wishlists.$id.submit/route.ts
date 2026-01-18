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

async function getShopAccessToken(shopDomain: string) {
  // Ideally choose OFFLINE session. If you can, filter by isOnline=false.
  const sess = await prisma.session.findFirst({
    where: { shop: shopDomain },
    select: { accessToken: true, isOnline: true },
    orderBy: { expires: "desc" }, // if online sessions exist, pick newest
  });
  return sess?.accessToken ?? null;
}

async function resolvePresentmentCurrency(shopId: string, countryCode: string | null) {
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
    if (request.method !== "POST") return corsJson(request, { error: "Method not allowed" }, 405);

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
    if (!wishlist.items.length) return corsJson(request, { error: "Wishlist is empty" }, 400);

    const body = await readBody(request);
    const note = (asString(body.note) || "").trim();
    const countryCode = (asString((body as any).countryCode) || "").trim().toUpperCase() || null;

    // Create a submission row immediately (queued), then update it based on outcome
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
      await prisma.wishlistSubmission.update({
        where: { id: submission.id },
        data: { status: "failed" },
      });

      return corsJson(
        request,
        {
          error: "Missing offline access token for shop",
          submission: { ...submission, status: "failed" },
        },
        500
      );
    }

    const presentmentCurrencyCode = await resolvePresentmentCurrency(identity.shop.id, countryCode);

    const lineItems = wishlist.items.map((i) => ({
      variantId: i.variantId, // gid://shopify/ProductVariant/...
      quantity: i.quantity,
    }));

    const gql = `#graphql
      mutation CreateDraftOrder($input: DraftOrderInput!) {
        draftOrderCreate(input: $input) {
          draftOrder { id name }
          userErrors { field message }
        }
      }
    `;

    const draftNote = [
      `Wishlist: ${wishlist.id} (${wishlist.name})`,
      countryCode ? `Country: ${countryCode}` : null,
      presentmentCurrencyCode ? `Currency: ${presentmentCurrencyCode}` : null,
      note ? `Customer note: ${note}` : null,
    ]
      .filter(Boolean)
      .join("\n");

    const customerGid = `gid://shopify/Customer/${identity.customer.customerId}`;

    const res = await fetch(`https://${identity.shop.shop}/admin/api/${ADMIN_API_VERSION}/graphql.json`, {
      method: "POST",
      headers: {
        "X-Shopify-Access-Token": accessToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: gql,
        variables: {
          input: {
            customerId: customerGid,
            note: draftNote,
            tags: [
              `wishlist:${wishlist.id}`,
              `wishlistName:${wishlist.name}`,
              `wishlist-submission`,
              countryCode ? `country:${countryCode}` : null,
              presentmentCurrencyCode ? `currency:${presentmentCurrencyCode}` : null,
            ].filter(Boolean),
            lineItems,
            ...(presentmentCurrencyCode ? { presentmentCurrencyCode } : {}),
          },
        },
      }),
    });

    const json: any = await res.json();

    if (json?.errors?.length) {
      await prisma.wishlistSubmission.update({
        where: { id: submission.id },
        data: { status: "failed" },
      });

      return corsJson(
        request,
        {
          error: "GraphQL error",
          errors: json.errors,
          submission: { ...submission, status: "failed" },
          countryCode,
          presentmentCurrencyCode,
        },
        400
      );
    }

    const userErrors = json?.data?.draftOrderCreate?.userErrors ?? [];
    if (userErrors.length) {
      await prisma.wishlistSubmission.update({
        where: { id: submission.id },
        data: { status: "failed" },
      });

      return corsJson(
        request,
        {
          error: "Draft order create failed",
          userErrors,
          submission: { ...submission, status: "failed" },
          countryCode,
          presentmentCurrencyCode,
        },
        400
      );
    }

    const draftOrderId = json?.data?.draftOrderCreate?.draftOrder?.id ?? null;

    const updated = await prisma.wishlistSubmission.update({
      where: { id: submission.id },
      data: { status: "created", draftOrderId },
      select: { id: true, status: true, draftOrderId: true, createdAt: true },
    });

    return corsJson(
      request,
      {
        submission: updated,
        countryCode,
        presentmentCurrencyCode,
        _submitVersion: "draftOrderCreate-v2-currency-rules",
      },
      201
    );
  } catch (e: any) {
    return corsJson(request, { error: e?.message || "Unauthorized" }, 401);
  }
}
