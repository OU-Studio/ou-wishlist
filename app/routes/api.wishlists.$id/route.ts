import { authenticate } from "../../shopify.server";
import prisma from "../../db.server";

function getPlaceholderCustomerKey(session: any) {
  const userId = session.onlineAccessInfo?.associated_user?.id;
  if (userId) return String(userId);
  return `offline:${session.shop}`;
}

async function getShopAndCustomer(request: Request) {
  const { session } = await authenticate.admin(request);

  const shop = await prisma.shop.upsert({
    where: { shop: session.shop },
    update: {},
    create: { shop: session.shop },
  });

  const customerKey = getPlaceholderCustomerKey(session);
  const user = session.onlineAccessInfo?.associated_user;

  const customer = await prisma.customer.upsert({
    where: { shopId_customerId: { shopId: shop.id, customerId: customerKey } },
    update: {
      email: user?.email ?? undefined,
      firstName: user?.first_name ?? undefined,
      lastName: user?.last_name ?? undefined,
    },
    create: {
      shopId: shop.id,
      customerId: customerKey,
      email: user?.email ?? null,
      firstName: user?.first_name ?? null,
      lastName: user?.last_name ?? null,
    },
  });

  return { shop, customer };
}

export async function loader({
  request,
  params,
}: {
  request: Request;
  params: { id?: string };
}) {
  const { shop, customer } = await getShopAndCustomer(request);
  const id = params.id;

  if (!id) return Response.json({ error: "Missing id" }, { status: 400 });

  const wishlist = await prisma.wishlist.findFirst({
    where: { id, shopId: shop.id, customerId: customer.id, isArchived: false },
    select: {
      id: true,
      name: true,
      createdAt: true,
      updatedAt: true,
      items: {
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          productId: true,
          variantId: true,
          quantity: true,
          title: true,
          variantTitle: true,
          sku: true,
          imageUrl: true,
          price: true,
          createdAt: true,
          updatedAt: true,
        },
      },
    },
  });

  if (!wishlist) {
    return Response.json({ error: "Wishlist not found" }, { status: 404 });
  }

  return Response.json({ wishlist }, { status: 200 });
}

// POST /api/wishlists/:id/items
export async function action({
  request,
  params,
}: {
  request: Request;
  params: { id?: string };
}) {
  const { shop, customer } = await getShopAndCustomer(request);
  const wishlistId = params.id;

  if (!wishlistId) return Response.json({ error: "Missing id" }, { status: 400 });

  // Ensure wishlist belongs to customer
  const wishlist = await prisma.wishlist.findFirst({
    where: { id: wishlistId, shopId: shop.id, customerId: customer.id, isArchived: false },
    select: { id: true },
  });

  if (!wishlist) {
    return Response.json({ error: "Wishlist not found" }, { status: 404 });
  }

  const form = await request.formData();
  const variantId = form.get("variantId");
  const productId = form.get("productId");
  const qty = form.get("quantity");

  const variantIdStr = typeof variantId === "string" ? variantId.trim() : "";
  const productIdStr = typeof productId === "string" ? productId.trim() : "";
  const quantity = typeof qty === "string" ? parseInt(qty, 10) : 1;

  if (!variantIdStr || !productIdStr) {
    return Response.json({ error: "productId and variantId are required" }, { status: 400 });
  }
  if (!Number.isFinite(quantity) || quantity < 1 || quantity > 999) {
    return Response.json({ error: "quantity must be 1..999" }, { status: 400 });
  }

  try {
    const item = await prisma.wishlistItem.upsert({
      where: { wishlistId_variantId: { wishlistId, variantId: variantIdStr } },
      update: { quantity: { increment: quantity } },
      create: {
        wishlistId,
        productId: productIdStr,
        variantId: variantIdStr,
        quantity,
      },
      select: { id: true, productId: true, variantId: true, quantity: true, createdAt: true, updatedAt: true },
    });

    return Response.json({ item }, { status: 201 });
  } catch (err: any) {
    throw err;
  }
}
