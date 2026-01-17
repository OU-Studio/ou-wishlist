import prisma from "../../db.server";
import { readBody } from "../../utils/api.server";
import { resolveCustomerIdentity } from "../../utils/identity.server";

function corsJson(request: Request, data: unknown, status = 200) {
  const origin = request.headers.get("Origin") || "";
  const allowOrigin = origin === "https://extensions.shopifycdn.com" ? origin : "*";

  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": allowOrigin,
      "Vary": "Origin",
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
      "Vary": "Origin",
      "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    },
  });
}

export async function action({
  request,
  params,
}: {
  request: Request;
  params: { id?: string; itemId?: string };
}) {
  if (request.method === "OPTIONS") return corsNoContent(request);

  try {
    const identity = await resolveCustomerIdentity(request);
    const wishlistId = params.id;
    const itemId = params.itemId;

    if (!wishlistId) return corsJson(request, { error: "Missing wishlist id" }, 400);
    if (!itemId) return corsJson(request, { error: "Missing item id" }, 400);

    // Confirm wishlist belongs to customer
    const wishlist = await prisma.wishlist.findFirst({
      where: { id: wishlistId, shopId: identity.shop.id, customerId: identity.customer.id, isArchived: false },
      select: { id: true },
    });
    if (!wishlist) return corsJson(request, { error: "Wishlist not found" }, 404);

    if (request.method === "PATCH") {
      const body = await readBody(request);
      const qtyRaw = Number(body.quantity);
      const quantity = Number.isFinite(qtyRaw) && qtyRaw > 0 ? Math.floor(qtyRaw) : 1;

      const updated = await prisma.wishlistItem.updateMany({
        where: { id: itemId, wishlistId },
        data: { quantity },
      });

      if (!updated.count) return corsJson(request, { error: "Item not found" }, 404);
      return corsJson(request, { ok: true }, 200);
    }

    if (request.method === "DELETE") {
      const deleted = await prisma.wishlistItem.deleteMany({
        where: { id: itemId, wishlistId },
      });

      if (!deleted.count) return corsJson(request, { error: "Item not found" }, 404);
      return corsJson(request, { ok: true }, 200);
    }

    return corsJson(request, { error: "Method not allowed" }, 405);
  } catch (e: any) {
    return corsJson(request, { error: e?.message || "Unauthorized" }, 401);
  }
}
