import prisma from "../../db.server";
import { readBody, asString } from "../../utils/api.server";
import { resolveCustomerIdentity } from "../../utils/identity.server";

const API_VERSION = "2025-10";

function corsJson(request: Request, data: unknown, status = 200) {
  const origin = request.headers.get("Origin") || "";
  const allowOrigin = origin === "https://extensions.shopifycdn.com" ? origin : "*";
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": allowOrigin,
      Vary: "Origin",
      "Access-Control-Allow-Methods": "POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    },
  });
}

function corsNoContent(request: Request) {
  const origin = request.headers.get("Origin") || "";
  const allowOrigin = origin === "https://extensions.shopifycdn.com" ? origin : "*";
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": allowOrigin,
      Vary: "Origin",
      "Access-Control-Allow-Methods": "POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    },
  });
}

function asVariantGid(idOrGid: string) {
  const s = String(idOrGid || "").trim();
  if (s.startsWith("gid://")) return s;
  return `gid://shopify/ProductVariant/${s}`;
}

async function getOfflineToken(shop: string) {
  const sess = await prisma.session.findFirst({
    where: { shop, isOnline: false },
    select: { accessToken: true },
  });
  return sess?.accessToken || null;
}

async function adminGraphql(shop: string, accessToken: string, query: string, variables: any) {
  const res = await fetch(`https://${shop}/admin/api/${API_VERSION}/graphql.json`, {
    method: "POST",
    headers: {
      "X-Shopify-Access-Token": accessToken,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });
  return res.json();
}

export async function action({ request, params }: { request: Request; params: { id?: string } }) {
  if (request.method === "OPTIONS") return corsNoContent(request);

  try {
    const identity = await resolveCustomerIdentity(request);
    const wishlistId = params.id;
    if (!wishlistId) return corsJson(request, { error: "Missing id" }, 400);
    if (request.method !== "POST") return corsJson(request, { error: "Method not allowed" }, 405);

    const wishlist = await prisma.wishlist.findFirst({
      where: { id: wishlistId, shopId: identity.shop.id, customerId: identity.customer.id, isArchived: false },
      include: { items: true },
    });

    if (!wishlist) return corsJson(request, { error: "Wishlist not found" }, 404);
    if (!wishlist.items.length) return corsJson(request, { error: "Wishlist is empty" }, 400);

    const body = await readBody(request);
    const note = (asString(body.note) || "").trim();

    const token = await getOfflineToken(identity.shop.shop);
    if (!token) return corsJson(request, { error: "Missing offline access token for shop" }, 500);

    const lineItems = wishlist.items.map((i: any) => ({
      variantId: asVariantGid(i.variantId),
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

    const result = await adminGraphql(identity.shop.shop, token, gql, {
      input: {
        note: [
          `Wishlist: ${wishlist.id} (${wishlist.name})`,
          note ? `Customer note: ${note}` : null,
        ].filter(Boolean).join("\n"),
        tags: [`wishlist:${wishlist.id}`, `wishlistName:${wishlist.name}`],
        lineItems,
      },
    });

    const errs = result?.data?.draftOrderCreate?.userErrors || [];
    if (errs.length) {
      const submission = await prisma.wishlistSubmission.create({
        data: { shopId: identity.shop.id, wishlistId: wishlist.id, customerId: identity.customer.id, status: "failed", note: note || null },
        select: { id: true, status: true, draftOrderId: true, createdAt: true },
      });
      return corsJson(request, { error: "Draft order create failed", userErrors: errs, submission }, 400);
    }

    const draftOrderId = result?.data?.draftOrderCreate?.draftOrder?.id as string | undefined;

    const submission = await prisma.wishlistSubmission.create({
      data: {
        shopId: identity.shop.id,
        wishlistId: wishlist.id,
        customerId: identity.customer.id,
        status: "created",
        draftOrderId: draftOrderId ?? null,
        note: note || null,
      },
      select: { id: true, status: true, draftOrderId: true, createdAt: true },
    });

    return corsJson(request, { submission }, 201);
  } catch (e: any) {
    return corsJson(request, { error: e?.message || "Unauthorized" }, 401);
  }
}
