import type { LoaderFunctionArgs } from "react-router";
import { prisma } from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  const shopDomain = url.searchParams.get("shop");
  const shopifyCustomerId = url.searchParams.get("cid"); // we pass from Liquid

  if (!shopDomain || !shopifyCustomerId) return { wishlists: [] };

  const shopRow = await prisma.shop.findUnique({
    where: { shop: shopDomain },
    select: { id: true },
  });
  if (!shopRow) return { wishlists: [] };

  const customerRow = await prisma.customer.findUnique({
    where: {
      shopId_customerId: {
        shopId: shopRow.id,
        customerId: shopifyCustomerId,
      },
    },
    select: { id: true },
  });
  if (!customerRow) return { wishlists: [] };

  const wishlists = await prisma.wishlist.findMany({
    where: {
      shopId: shopRow.id,
      customerId: customerRow.id,
      isArchived: false,
    },
    orderBy: { createdAt: "desc" },
    select: { id: true, name: true },
  });

  return { wishlists };
};