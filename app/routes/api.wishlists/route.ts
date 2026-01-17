import { authenticate } from "../../shopify.server";
import prisma from "../../db.server";

async function upsertShop(shopDomain: string) {
  return prisma.shop.upsert({
    where: { shop: shopDomain },
    update: {},
    create: { shop: shopDomain },
  });
}

async function upsertCustomer(params: {
  shopId: string;
  customerId: string;
  email?: string | null;
  firstName?: string | null;
  lastName?: string | null;
}) {
  const { shopId, customerId, email, firstName, lastName } = params;
  return prisma.customer.upsert({
    where: { shopId_customerId: { shopId, customerId } },
    update: {
      email: email ?? undefined,
      firstName: firstName ?? undefined,
      lastName: lastName ?? undefined,
    },
    create: {
      shopId,
      customerId,
      email: email ?? null,
      firstName: firstName ?? null,
      lastName: lastName ?? null,
    },
  });
}

function getPlaceholderCustomerKey(session: any) {
  const userId = session.onlineAccessInfo?.associated_user?.id;
  if (userId) return String(userId);
  return `offline:${session.shop}`;
}

export async function loader({ request }: { request: Request }) {
  const { session } = await authenticate.admin(request);

  const shop = await upsertShop(session.shop);

  const customerKey = getPlaceholderCustomerKey(session);
  const user = session.onlineAccessInfo?.associated_user;

  const customer = await upsertCustomer({
    shopId: shop.id,
    customerId: customerKey,
    email: user?.email ?? null,
    firstName: user?.first_name ?? null,
    lastName: user?.last_name ?? null,
  });

  const wishlists = await prisma.wishlist.findMany({
    where: { shopId: shop.id, customerId: customer.id, isArchived: false },
    orderBy: { updatedAt: "desc" },
    select: { id: true, name: true, createdAt: true, updatedAt: true },
  });

  return Response.json({ wishlists }, { status: 200 });
}

export async function action({ request }: { request: Request }) {
  const { session } = await authenticate.admin(request);

  const shop = await upsertShop(session.shop);

  const customerKey = getPlaceholderCustomerKey(session);
  const user = session.onlineAccessInfo?.associated_user;

  const customer = await upsertCustomer({
    shopId: shop.id,
    customerId: customerKey,
    email: user?.email ?? null,
    firstName: user?.first_name ?? null,
    lastName: user?.last_name ?? null,
  });

  const form = await request.formData();
  const rawName = form.get("name");
  const name = typeof rawName === "string" ? rawName.trim() : "";

  if (!name) {
    return Response.json({ error: "Wishlist name is required" }, { status: 400 });
  }
  if (name.length > 80) {
    return Response.json({ error: "Wishlist name must be 80 chars or less" }, { status: 400 });
  }

  try {
    const wishlist = await prisma.wishlist.create({
      data: {
        shopId: shop.id,
        customerId: customer.id,
        name,
      },
      select: { id: true, name: true, createdAt: true, updatedAt: true },
    });

    return Response.json({ wishlist }, { status: 201 });
  } catch (err: any) {
    if (err?.code === "P2002") {
      return Response.json(
        { error: "A wishlist with that name already exists" },
        { status: 409 }
      );
    }
    throw err;
  }
}
