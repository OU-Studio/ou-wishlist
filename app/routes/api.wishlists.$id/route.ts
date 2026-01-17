import prisma from "../../db.server";
import { readBody, asString } from "../../utils/api.server";
import { resolveCustomerIdentity } from "../../utils/identity.server";

function corsJson(request: Request, data: unknown, status = 200) {
  const origin = request.headers.get("Origin") || "";
  const allowOrigin =
    origin === "https://extensions.shopifycdn.com" ? origin : "*";

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
  const allowOrigin =
    origin === "https://extensions.shopifycdn.com" ? origin : "*";

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

export async function loader({ request, params }: { request: Request; params: { id?: string } }) {
  if (request.method === "OPTIONS") return corsNoContent(request);

  try {
    const identity = await resolveCustomerIdentity(request);
    const id = params.id;

    if (!id) return corsJson(request, { error: "Missing id" }, 400);

    const wishlist = await prisma.wishlist.findFirst({
      where: { id, shopId: identity.shop.id, customerId: identity.customer.id, isArchived: false },
      include: { items: { orderBy: { createdAt: "desc" } } },
    });

    if (!wishlist) return corsJson(request, { error: "Wishlist not found" }, 404);

    return corsJson(request, { wishlist }, 200);
  } catch (e: any) {
    return corsJson(request, { error: e?.message || "Unauthorized" }, 401);
  }
}

export async function action({ request, params }: { request: Request; params: { id?: string } }) {
  if (request.method === "OPTIONS") return corsNoContent(request);

  try {
    const identity = await resolveCustomerIdentity(request);
    const id = params.id;

    if (!id) return corsJson(request, { error: "Missing id" }, 400);

    if (request.method === "PATCH") {
      const body = await readBody(request);
      const name = (asString(body.name) || "").trim();

      if (!name) return corsJson(request, { error: "Wishlist name is required" }, 400);

      const updated = await prisma.wishlist.updateMany({
        where: { id, shopId: identity.shop.id, customerId: identity.customer.id, isArchived: false },
        data: { name },
      });

      if (!updated.count) return corsJson(request, { error: "Wishlist not found" }, 404);

      return corsJson(request, { ok: true }, 200);
    }

    if (request.method === "DELETE") {
      const updated = await prisma.wishlist.updateMany({
        where: { id, shopId: identity.shop.id, customerId: identity.customer.id, isArchived: false },
        data: { isArchived: true },
      });

      if (!updated.count) return corsJson(request, { error: "Wishlist not found" }, 404);

      return corsJson(request, { ok: true }, 200);
    }

    return corsJson(request, { error: "Method not allowed" }, 405);
  } catch (e: any) {
    return corsJson(request, { error: e?.message || "Unauthorized" }, 401);
  }
}
