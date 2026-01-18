import prisma from "../../db.server";
import { readBody } from "../../utils/api.server";
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
  // Preflight must be handled here or RR throws
  if (request.method === "OPTIONS") return corsNoContent(request);
  return corsJson(request, { error: "Method not allowed" }, 405);
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

    if (!wishlistId || !itemId) return corsJson(request, { error: "Missing id" }, 400);

    // Ensure the wishlist belongs to this customer/shop
    const wishlist = await prisma.wishlist.findFirst({
      where: { id: wishlistId, shopId: identity.shop.id, customerId: identity.customer.id, isArchived: false },
      select: { id: true },
    });
    if (!wishlist) return corsJson(request, { error: "Wishlist not found" }, 404);

    if (request.method === "PATCH") {
      const body = await readBody(request);
      const qRaw = (body?.quantity ?? body?.qty) as any;
      const quantity = Number(qRaw);

      if (!Number.isFinite(quantity) || quantity < 1 || quantity > 999) {
        return corsJson(request, { error: "quantity must be a number between 1 and 999" }, 400);
      }

      const updated = await prisma.wishlistItem.updateMany({
        where: { id: itemId, wishlistId: wishlistId },
        data: { quantity },
      });

      if (!updated.count) return corsJson(request, { error: "Item not found" }, 404);

      return corsJson(request, { ok: true }, 200);
    }

    if (request.method === "DELETE") {
      const deleted = await prisma.wishlistItem.deleteMany({
        where: { id: itemId, wishlistId: wishlistId },
      });

      if (!deleted.count) return corsJson(request, { error: "Item not found" }, 404);

      return corsJson(request, { ok: true }, 200);
    }

    return corsJson(request, { error: "Method not allowed" }, 405);
  } catch (e: any) {
    return corsJson(request, { error: e?.message || "Unauthorized" }, 401);
  }
}
