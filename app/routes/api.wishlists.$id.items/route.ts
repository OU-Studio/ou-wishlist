import prisma from "../../db.server";
import { readBody, asString } from "../../utils/api.server";
import { resolveCustomerIdentity } from "../../utils/identity.server";

const EXT_ORIGIN = "https://extensions.shopifycdn.com";

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

    const wishlist = await prisma.wishlist.findFirst({
      where: { id: wishlistId, shopId: identity.shop.id, customerId: identity.customer.id, isArchived: false },
      select: { id: true },
    });
    if (!wishlist) return corsJson(request, { error: "Wishlist not found" }, 404);

    if (request.method !== "POST") return corsJson(request, { error: "Method not allowed" }, 405);

    const body = await readBody(request);

    const productId = (asString(body.productId) || "").trim();
    const variantId = (asString(body.variantId) || "").trim();
    const quantity = Number(body.quantity ?? 1);

    if (!productId) return corsJson(request, { error: "productId is required" }, 400);
    if (!variantId) return corsJson(request, { error: "variantId is required" }, 400);
    if (!Number.isFinite(quantity) || quantity < 1 || quantity > 999) {
      return corsJson(request, { error: "quantity must be a number between 1 and 999" }, 400);
    }

    // If you have a unique index on (wishlistId, variantId), swap this to upsert.
    const item = await prisma.wishlistItem.create({
      data: { wishlistId, productId, variantId, quantity },
      select: { id: true, productId: true, variantId: true, quantity: true, createdAt: true },
    });

    return corsJson(request, { item }, 201);
  } catch (e: any) {
    return corsJson(request, { error: e?.message || "Unauthorized" }, 401);
  }
}
