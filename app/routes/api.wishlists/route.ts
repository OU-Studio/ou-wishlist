import prisma from "../../db.server";
import { readBody, asString } from "../../utils/api.server";
import { resolveCustomerIdentity } from "../../utils/identity.server";

const EXT_ORIGIN = "https://extensions.shopifycdn.com";

function corsHeaders(request: Request) {
  const origin = request.headers.get("Origin") || "";
  const allowOrigin = origin === EXT_ORIGIN ? origin : "*";

  return {
    "Access-Control-Allow-Origin": allowOrigin,
    Vary: "Origin",
    "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Content-Type": "application/json",
  } as Record<string, string>;
}

function corsJson(request: Request, data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: corsHeaders(request),
  });
}

function corsNoContent(request: Request) {
  return new Response(null, {
    status: 204,
    headers: {
      ...corsHeaders(request),
      "Content-Type": "text/plain",
    },
  });
}

export async function loader({ request }: { request: Request }) {
  if (request.method === "OPTIONS") return corsNoContent(request);
  if (request.method !== "GET") return corsJson(request, { error: "Method not allowed" }, 405);

  try {
    const identity = await resolveCustomerIdentity(request);

    const wishlists = await prisma.wishlist.findMany({
  where: {
    shopId: identity.shop.id,
    customerId: identity.customer.id,
    isArchived: false,
  },
  orderBy: { updatedAt: "desc" },
  select: {
    id: true,
    name: true,
    createdAt: true,
    updatedAt: true,
    customer: {
      select: {
        email: true,
        firstName: true,
        lastName: true,
      },
    },
  },
});


    return corsJson(request, { wishlists }, 200);
  } catch (e: any) {
    return corsJson(request, { error: e?.message || "Unauthorized" }, 401);
  }
}

export async function action({ request }: { request: Request }) {
  if (request.method === "OPTIONS") return corsNoContent(request);
  if (request.method !== "POST") return corsJson(request, { error: "Method not allowed" }, 405);

  try {
    const identity = await resolveCustomerIdentity(request);

    const body = await readBody(request);
    const name = (asString((body as any).name) || "").trim();

    if (!name) return corsJson(request, { error: "Wishlist name is required" }, 400);
    if (name.length > 80) return corsJson(request, { error: "Wishlist name must be 80 chars or less" }, 400);

    const existing = await prisma.wishlist.findFirst({
      where: {
        shopId: identity.shop.id,
        customerId: identity.customer.id,
        name,
        isArchived: false,
      },
      select: { id: true, name: true, createdAt: true, updatedAt: true },
    });

    if (existing) {
      // Keep response format consistent (always with explicit CORS headers)
      return corsJson(
        request,
        { error: "A wishlist with that name already exists", wishlist: existing },
        409
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
    return corsJson(request, { error: e?.message || "Unauthorized" }, 401);
  }
}
