import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { prisma } from "../db.server";

async function resolveShopAndCustomer(shopDomain: string, shopifyCustomerId: string) {
  const shopRow = await prisma.shop.findUnique({
    where: { shop: shopDomain },
    select: { id: true },
  });
  if (!shopRow) return null;

  const customerRow = await prisma.customer.findUnique({
    where: {
      shopId_customerId: { shopId: shopRow.id, customerId: shopifyCustomerId },
    },
    select: { id: true },
  });
  if (!customerRow) return null;

  return { shopId: shopRow.id, customerPk: customerRow.id };
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  const shopDomain = url.searchParams.get("shop");
  const shopifyCustomerId = url.searchParams.get("cid");
  const wishlistId = url.searchParams.get("wishlistId");

  if (!shopDomain || !shopifyCustomerId || !wishlistId) {
    return { wishlist: null, items: [] };
  }

  const resolved = await resolveShopAndCustomer(shopDomain, shopifyCustomerId);
  if (!resolved) return { wishlist: null, items: [] };

  const wishlist = await prisma.wishlist.findFirst({
    where: {
      id: wishlistId,
      shopId: resolved.shopId,
      customerId: resolved.customerPk,
      isArchived: false,
    },
    select: { id: true, name: true, createdAt: true },
  });

  if (!wishlist) return { wishlist: null, items: [] };

  const items = await prisma.wishlistItem.findMany({
    where: { wishlistId: wishlist.id },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      productId: true,
      variantId: true,
      quantity: true,
      title: true,
      variantTitle: true,
      handle: true,
      sku: true,
      imageUrl: true,
      price: true,
    },
  });

  return { wishlist, items };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method.toUpperCase() !== "POST") {
    throw new Response("Method Not Allowed", { status: 405 });
  }

  const url = new URL(request.url);

  const shopDomain = url.searchParams.get("shop");
  const shopifyCustomerId = url.searchParams.get("cid");

  if (!shopDomain || !shopifyCustomerId) {
    throw new Response("Missing shop/cid", { status: 400 });
  }

  const resolved = await resolveShopAndCustomer(shopDomain, shopifyCustomerId);
  if (!resolved) return { ok: false, error: "Customer not found" };

  let body: any = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  const op = String(body?.op || "");
  const wishlistId = String(body?.wishlistId || "");
  if (!op || !wishlistId) return { ok: false, error: "Missing op/wishlistId" };

  // Ensure wishlist belongs to this customer + shop
  const wishlist = await prisma.wishlist.findFirst({
    where: {
      id: wishlistId,
      shopId: resolved.shopId,
      customerId: resolved.customerPk,
      isArchived: false,
    },
    select: { id: true, name: true },
  });

  if (!wishlist) return { ok: false, error: "Wishlist not found" };

  if (op === "rename") {
    const newName = String(body?.name || "").trim();
    if (!newName) return { ok: false, error: "Name required" };

    await prisma.wishlist.update({
      where: { id: wishlist.id },
      data: { name: newName },
    });

    return { ok: true };
  }

  if (op === "delete") {
    await prisma.wishlist.update({
      where: { id: wishlist.id },
      data: { isArchived: true },
    });

    return { ok: true };
  }

  if (op === "itemUpdate") {
    const itemId = String(body?.itemId || "");
    const qtyRaw = body?.quantity;
    const quantity = Math.max(1, Number(qtyRaw || 1) | 0);

    if (!itemId) return { ok: false, error: "Missing itemId" };

    // Ensure item belongs to wishlist
    await prisma.wishlistItem.update({
      where: { id: itemId },
      data: { quantity },
    });

    return { ok: true };
  }

  if (op === "itemRemove") {
    const itemId = String(body?.itemId || "");
    if (!itemId) return { ok: false, error: "Missing itemId" };

    await prisma.wishlistItem.delete({
      where: { id: itemId },
    });

    return { ok: true };
  }

  return { ok: false, error: "Unknown op" };
};