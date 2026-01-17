import prisma from "../../db.server";
import { readBody, asString } from "../../utils/api.server";
import { resolveCustomerIdentity } from "../../utils/identity.server";

function corsJson(request: Request, data: unknown, status = 200) {
  const origin = request.headers.get("Origin") || "";
  const allowOrigin = origin === "https://extensions.shopifycdn.com" ? origin : "*";
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": allowOrigin,
      Vary: "Origin",
      "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
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
      "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    },
  });
}

export async function loader({ request, params }: { request: Request; params: { id?: string } }) {
  if (request.method === "OPTIONS") return corsNoContent(request);

  try {
    const identity = await resolveCustomerIdentity(request);
    const wishlistId = params.id;
    if (!wishlistId) return corsJson(request, { error: "Missing id" }, 400);

    const wishlist = await prisma.wishlist.findFirst({
      where: { id: wishlistId, shopId: identity.shop.id, customerId: identity.customer.id, isArchived: false },
      include: { items: { orderBy: { createdAt: "desc" } } },
    });

    if (!wishlist) return corsJson(request, { error: "Wishlist not found" }, 404);
    return corsJson(request, { items: wishlist.items }, 200);
  } catch (e: any) {
    return corsJson(request, { error: e?.message || "Unauthorized" }, 401);
  }
}

export async function action({ request, params }: { request: Request; params: { id?: string } }) {
  if (request.method === "OPTIONS") return corsNoContent(request);

  try {
    const identity = await resolveCustomerIdentity(request);
    const wishlistId = params.id;
    if (!wishlistId) return corsJson(request, { error: "Missing id" }, 400);
    if (request.method !== "POST") return corsJson(request, { error: "Method not allowed" }, 405);

    const body = await readBody(request);
    const productId = (asString(body.productId) || "").trim();
    const variantId = (asString(body.variantId) || "").trim();
    const qtyRaw = Number(body.quantity);
    const quantity = Number.isFinite(qtyRaw) && qtyRaw > 0 ? Math.floor(qtyRaw) : 1;

    if (!productId) return corsJson(request, { error: "productId is required" }, 400);
    if (!variantId) return corsJson(request, { error: "variantId is required" }, 400);

    const wishlist = await prisma.wishlist.findFirst({
      where: { id: wishlistId, shopId: identity.shop.id, customerId: identity.customer.id, isArchived: false },
      select: { id: true },
    });
    if (!wishlist) return corsJson(request, { error: "Wishlist not found" }, 404);

    // ✅ No duplicates: if same variant exists, increment qty
    const existing = await prisma.wishlistItem.findFirst({
      where: { wishlistId, variantId },
      select: { id: true, quantity: true },
    });

    if (existing) {
      const updated = await prisma.wishlistItem.update({
        where: { id: existing.id },
        data: { quantity: existing.quantity + quantity, productId },
        select: { id: true, productId: true, variantId: true, quantity: true, createdAt: true, updatedAt: true },
      });
      return corsJson(request, { item: updated, merged: true }, 200);
    }

    const item = await prisma.wishlistItem.create({
      data: { wishlistId, productId, variantId, quantity },
      select: { id: true, productId: true, variantId: true, quantity: true, createdAt: true, updatedAt: true },
    });

    return corsJson(request, { item, merged: false }, 201);
  } catch (e: any) {
    return corsJson(request, { error: e?.message || "Unauthorized" }, 401);
  }
}
