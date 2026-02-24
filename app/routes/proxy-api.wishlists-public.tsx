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
      shopId_customerId: {
        shopId: shopRow.id,
        customerId: shopifyCustomerId, // Shopify customer id string
      },
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

  if (!shopDomain || !shopifyCustomerId) return { wishlists: [] };

  const resolved = await resolveShopAndCustomer(shopDomain, shopifyCustomerId);
  if (!resolved) return { wishlists: [] };

  const wishlists = await prisma.wishlist.findMany({
    where: {
      shopId: resolved.shopId,
      customerId: resolved.customerPk,
      isArchived: false,
    },
    orderBy: { createdAt: "desc" },
    select: { id: true, name: true, createdAt: true },
  });

  return { wishlists };
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
  if (!resolved) {
    return { ok: false, error: "Customer not found", wishlist: null };
  }

  let body: any = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  let name = String(body?.name || "").trim();
  if (!name) name = "New wishlist";

  // Ensure unique per @@unique([customerId, name])
  // Try name, then "name (2)", "name (3)"...
  let finalName = name;
  for (let i = 1; i <= 25; i++) {
    const exists = await prisma.wishlist.findFirst({
      where: {
        customerId: resolved.customerPk,
        name: finalName,
      },
      select: { id: true },
    });

    if (!exists) break;
    finalName = `${name} (${i + 1})`;
  }

  const wishlist = await prisma.wishlist.create({
    data: {
      shopId: resolved.shopId,
      customerId: resolved.customerPk,
      name: finalName,
    },
    select: { id: true, name: true, createdAt: true },
  });

  return { ok: true, wishlist };
};