import { authenticate } from "../shopify.server";
import { prisma } from "../db.server";

function json(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function getLoggedInCustomerId(request: Request) {
  const url = new URL(request.url);
  return url.searchParams.get("logged_in_customer_id");
}

function gid(type: "Product" | "ProductVariant", raw: string) {
  const s = String(raw || "").trim();
  if (!s) return null;
  if (s.startsWith("gid://")) return s;
  if (/^\d+$/.test(s)) return `gid://shopify/${type}/${s}`;
  return s;
}

export async function action({
  request,
  params,
}: {
  request: Request;
  params: { id?: string };
}) {
  const auth = await authenticate.public.appProxy(request).catch(() => null);
  const session = auth?.session;

  if (!session?.shop) return json({ error: "Unauthorized app proxy request" }, 401);

  const loggedInCustomerId = getLoggedInCustomerId(request);
  if (!loggedInCustomerId) return json({ error: "Customer not logged in" }, 401);

  const wishlistId = params.id;
  if (!wishlistId) return json({ error: "Missing wishlist id" }, 400);

  const shop = await prisma.shop.findUnique({
    where: { shop: session.shop },
    select: { id: true },
  });
  if (!shop) return json({ error: "Shop not found" }, 404);

  const customer = await prisma.customer.findUnique({
    where: { shopId_customerId: { shopId: shop.id, customerId: loggedInCustomerId } },
    select: { id: true },
  });
  if (!customer) return json({ error: "Customer not found" }, 404);

  const wishlist = await prisma.wishlist.findFirst({
    where: { id: wishlistId, shopId: shop.id, customerId: customer.id, isArchived: false },
    select: { id: true },
  });
  if (!wishlist) return json({ error: "Wishlist not found" }, 404);

  const body = await request.json().catch(() => ({}));
  const productId = gid("Product", body?.productId);
  const variantId = gid("ProductVariant", body?.variantId);
  const quantity = Math.max(1, parseInt(String(body?.quantity ?? 1), 10) || 1);

  if (!productId || !variantId) return json({ error: "Missing productId/variantId" }, 400);

  const item = await prisma.wishlistItem.upsert({
    where: { wishlistId_variantId: { wishlistId: wishlist.id, variantId } },
    update: { quantity },
    create: { wishlistId: wishlist.id, productId, variantId, quantity },
    select: { id: true, quantity: true },
  });

  return json({ item }, 201);
}
