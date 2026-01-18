import prisma from "../../db.server";
import { readBody, asString } from "../../utils/api.server";
import { resolveCustomerIdentity } from "../../utils/identity.server";

const EXT_ORIGIN = "https://extensions.shopifycdn.com";
const API_VERSION = "2025-10";

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

async function getAnyToken(shop: string) {
  const sess = await prisma.session.findFirst({
    where: { shop },
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

  const json = await res.json();
  return { ok: res.ok, status: res.status, json };
}

export async function loader({ request }: { request: Request }) {
  if (request.method === "OPTIONS") return corsNoContent(request);
  return corsJson(request, { error: "Method not allowed" }, 405);
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

    const token = await getAnyToken(identity.shop.shop);
    if (!token) return corsJson(request, { error: "Missing access token for shop" }, 500);

    const lineItems = wishlist.items.map((i) => ({
      variantId: i.variantId, // must be gid://shopify/ProductVariant/...
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
      note ? `Customer note: ${note}` : null,
    ]
      .filter(Boolean)
      .join("\n");

    const { json } = await adminGraphql(identity.shop.shop, token, gql, {
      input: {
        note: draftNote,
        tags: [`wishlist:${wishlist.id}`, `wishlistName:${wishlist.name}`],
        lineItems,
      },
    });

    if (json?.errors?.length) {
      const submission = await prisma.wishlistSubmission.create({
        data: {
          shopId: identity.shop.id,
          wishlistId: wishlist.id,
          customerId: identity.customer.id,
          status: "failed",
          note: note || null,
        },
        select: { id: true, status: true, draftOrderId: true, createdAt: true },
      });

      return corsJson(request, { error: "GraphQL error", errors: json.errors, submission }, 400);
    }

    const userErrors = json?.data?.draftOrderCreate?.userErrors ?? [];
    if (userErrors.length) {
      const submission = await prisma.wishlistSubmission.create({
        data: {
          shopId: identity.shop.id,
          wishlistId: wishlist.id,
          customerId: identity.customer.id,
          status: "failed",
          note: note || null,
        },
        select: { id: true, status: true, draftOrderId: true, createdAt: true },
      });

      return corsJson(
        request,
        { error: "Draft order create failed", userErrors, submission },
        400
      );
    }

    const draftOrderId = json?.data?.draftOrderCreate?.draftOrder?.id ?? null;

    const submission = await prisma.wishlistSubmission.create({
      data: {
        shopId: identity.shop.id,
        wishlistId: wishlist.id,
        customerId: identity.customer.id,
        status: "created",
        draftOrderId,
        note: note || null,
      },
      select: { id: true, status: true, draftOrderId: true, createdAt: true },
    });

    return corsJson(request, { submission }, 201);
  } catch (e: any) {
    return corsJson(request, { error: e?.message || "Unauthorized" }, 401);
  }
}
