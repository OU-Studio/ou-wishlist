import { resolveCustomerIdentity } from "../../utils/identity.server";
import prisma from "../../db.server";
import { readBody, asString } from "../../utils/api.server";

const EXT_ORIGIN = "https://extensions.shopifycdn.com";
const API_VERSION = "2026-01";

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
  return res.json();
}

export async function loader({ request }: { request: Request }) {
  if (request.method === "OPTIONS") return corsNoContent(request);
  return corsJson(request, { error: "Method not allowed" }, 405);
}

export async function action({ request }: { request: Request }) {
  if (request.method === "OPTIONS") return corsNoContent(request);

  try {
    const identity = await resolveCustomerIdentity(request);

    const body = await readBody(request);
    const q = (asString(body.q) || "").trim();

    // Basic guard: don’t allow empty query to fetch everything
    if (q.length < 2) return corsJson(request, { products: [] }, 200);

    const token = await getAnyToken(identity.shop.shop);
    if (!token) return corsJson(request, { error: "Missing access token for shop" }, 500);

    const gql = `#graphql
      query SearchProducts($query: String!) {
        products(first: 20, query: $query) {
          nodes {
            id
            title
            featuredImage { url altText }
            variants(first: 20) {
              nodes {
                id
                title
                price
              }
            }
          }
        }
      }
    `;

    // Shopify product search syntax: use title:*term* for simple matching
    const query = `title:*${q}* OR sku:*${q}*`;

    const out = await adminGraphql(identity.shop.shop, token, gql, { query });

    if (out?.errors?.length) {
      return corsJson(request, { error: "GraphQL error", errors: out.errors }, 400);
    }

    const products = out?.data?.products?.nodes ?? [];
    return corsJson(request, { products }, 200);
  } catch (e: any) {
    return corsJson(request, { error: e?.message || "Unauthorized" }, 401);
  }
}