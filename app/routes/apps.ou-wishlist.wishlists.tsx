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

export async function loader({ request }: { request: Request }) {
  const auth = await authenticate.public.appProxy(request).catch(() => null);
  const session = auth?.session;

  if (!session?.shop) return json({ error: "Unauthorized app proxy request" }, 401);

  const loggedInCustomerId = getLoggedInCustomerId(request);
  if (!loggedInCustomerId) return json({ error: "Customer not logged in" }, 401);

  const shop = await prisma.shop.upsert({
    where: { shop: session.shop },
    update: {},
    create: { shop: session.shop },
    select: { id: true },
  });

  const customer = await prisma.customer.upsert({
    where: { shopId_customerId: { shopId: shop.id, customerId: loggedInCustomerId } },
    update: {},
    create: { shopId: shop.id, customerId: loggedInCustomerId },
    select: { id: true },
  });

  const wishlists = await prisma.wishlist.findMany({
    where: { shopId: shop.id, customerId: customer.id, isArchived: false },
    orderBy: { updatedAt: "desc" },
    select: { id: true, name: true, updatedAt: true },
  });

  return json({ wishlists });
}

export async function action({ request }: { request: Request }) {
  const auth = await authenticate.public.appProxy(request).catch(() => null);
  const session = auth?.session;

  if (!session?.shop) return json({ error: "Unauthorized app proxy request" }, 401);

  const loggedInCustomerId = getLoggedInCustomerId(request);
  if (!loggedInCustomerId) return json({ error: "Customer not logged in" }, 401);

  const shop = await prisma.shop.upsert({
    where: { shop: session.shop },
    update: {},
    create: { shop: session.shop },
    select: { id: true },
  });

  const customer = await prisma.customer.upsert({
    where: { shopId_customerId: { shopId: shop.id, customerId: loggedInCustomerId } },
    update: {},
    create: { shopId: shop.id, customerId: loggedInCustomerId },
    select: { id: true },
  });

  const body = await request.json().catch(() => ({}));
  const name = String(body?.name || "").trim();
  if (!name) return json({ error: "Missing name" }, 400);

  const wishlist = await prisma.wishlist.upsert({
    where: { customerId_name: { customerId: customer.id, name } },
    update: { isArchived: false },
    create: { shopId: shop.id, customerId: customer.id, name },
    select: { id: true, name: true },
  });

  return json({ wishlist }, 201);
}
