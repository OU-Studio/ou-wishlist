import prisma from "../../db.server";
import { readBody } from "../../utils/api.server";
import { resolveCustomerIdentity } from "../../utils/identity.server";

const API_VERSION = "2025-10";
const EXT_ORIGIN = "https://extensions.shopifycdn.com";

function allowOrigin(request: Request) {
  const origin = request.headers.get("Origin") || "";
  return origin === EXT_ORIGIN ? origin : "*";
}

function corsHeaders(request: Request) {
  return {
    "Access-Control-Allow-Origin": allowOrigin(request),
    Vary: "Origin",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  } as Record<string, string>;
}

function corsJson(request: Request, data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(request),
    },
  });
}

function corsNoContent(request: Request) {
  return new Response(null, {
    status: 204,
    headers: corsHeaders(request),
  });
}

function asGid(kind: "Product" | "ProductVariant", idOrGid: string) {
  const s = String(idOrGid || "").trim();
  if (!s) return null;
  if (s.startsWith("gid://")) return s;
  return `gid://shopify/${kind}/${s}`;
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
  return res.json();
}

export async function action({ request }: { request: Request }) {
  if (request.method === "OPTIONS") return corsNoContent(request);

  try {
    const identity = await resolveCustomerIdentity(request);

    if (request.method !== "POST") {
      return corsJson(request, { error: "Method not allowed" }, 405);
    }

    const body = await readBody(request);

    const productIdsRaw = Array.isArray(body.productIds) ? body.productIds : [];
    const variantIdsRaw = Array.isArray(body.variantIds) ? body.variantIds : [];

    const productIds = productIdsRaw.map((x: any) => asGid("Product", String(x))).filter(Boolean);
    const variantIds = variantIdsRaw.map((x: any) => asGid("ProductVariant", String(x))).filter(Boolean);

    const token = await getAnyToken(identity.shop.shop);
    if (!token) return corsJson(request, { error: "Missing offline access token for shop" }, 500);

    const gql = `#graphql
      query Lookup($productIds: [ID!]!, $variantIds: [ID!]!) {
        products: nodes(ids: $productIds) {
          ... on Product {
            id
            title
            featuredImage { url altText }
          }
        }
        variants: nodes(ids: $variantIds) {
          ... on ProductVariant {
            id
            title
            price
            image { url altText }
            product { id title }
          }
        }
      }
    `;

    const out = await adminGraphql(identity.shop.shop, token, gql, {
      productIds,
      variantIds,
    });

    if (out?.errors?.length) return corsJson(request, { error: "GraphQL error", errors: out.errors }, 400);

    const products = (out?.data?.products || []).filter(Boolean);
    const variants = (out?.data?.variants || []).filter(Boolean);

    const productMap: Record<string, any> = {};
    for (const p of products) productMap[p.id] = p;

    const variantMap: Record<string, any> = {};
    for (const v of variants) variantMap[v.id] = v;

    return corsJson(request, { productMap, variantMap }, 200);
  } catch (e: any) {
    return corsJson(request, { error: e?.message || "Unauthorized" }, 401);
  }
}

export async function loader({ request }: { request: Request }) {
  if (request.method === "OPTIONS") return corsNoContent(request);

  const url = new URL(request.url);
  const shop = url.searchParams.get("shop") || "";
  const sess = shop
    ? await prisma.session.findMany({
        where: { shop },
        select: { id: true, shop: true, isOnline: true, scope: true, expires: true, accessToken: true },
        take: 5,
      })
    : [];

  return corsJson(request, {
    ok: true,
    shop,
    sessionCount: sess.length,
    sessions: sess.map((s) => ({
      id: s.id,
      shop: s.shop,
      isOnline: s.isOnline,
      scope: s.scope,
      expires: s.expires,
      hasAccessToken: !!s.accessToken,
    })),
  });
}
