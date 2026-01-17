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

export async function loader({ request }: { request: Request }) {
  if (request.method === "OPTIONS") return corsNoContent(request);

  try {
    const identity = await resolveCustomerIdentity(request);

    const wishlists = await prisma.wishlist.findMany({
      where: {
        shopId: identity.shop.id,
        customerId: identity.customer.id,
        isArchived: false,
      },
      orderBy: { updatedAt: "desc" },
      select: { id: true, name: true, createdAt: true, updatedAt: true },
    });

    // Always return explicit CORS headers for customer account requests
    return corsJson(request, { wishlists }, 200);
  } catch (e: any) {
    // Never redirect; always return JSON + CORS so the extension can read it
    const msg =
      e instanceof Response
        ? "Unauthorized"
        : e?.message || "Unauthorized";
    return corsJson(request, { error: msg }, 401);
  }
}

export async function action({ request }: { request: Request }) {
  if (request.method === "OPTIONS") return corsNoContent(request);

  try {
    const identity = await resolveCustomerIdentity(request);

    const body = await readBody(request);
    const name = (asString(body.name) || "").trim();

    if (!name) {
      return corsJson(request, { error: "Wishlist name is required" }, 400);
    }
    if (name.length > 80) {
      return corsJson(
        request,
        { error: "Wishlist name must be 80 chars or less" },
        400
      );
    }

    const wishlist = await prisma.wishlist.create({
      data: {
        shopId: identity.shop.id,
        customerId: identity.customer.id,
        name,
      },
      select: { id: true, name: true, createdAt: true, updatedAt: true },
    });

    return corsJson(request, { wishlist }, 201);
  } catch (e: any) {
    const msg =
      e instanceof Response
        ? "Unauthorized"
        : e?.message || "Unauthorized";
    return corsJson(request, { error: msg }, 401);
  }
}
 