import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { prisma } from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  // Find shop row
  const shopRow = await prisma.shop.findUnique({
    where: { shop },
    select: { id: true },
  });

  if (shopRow) {
    const shopId = shopRow.id;

    // Delete everything owned by the shop
    await prisma.$transaction([
      prisma.wishlistSubmission.deleteMany({ where: { shopId } }),
      prisma.wishlistItem.deleteMany({
        where: { wishlist: { shopId } },
      }),
      prisma.wishlist.deleteMany({ where: { shopId } }),
      prisma.marketCurrencyRule.deleteMany({ where: { shopId } }),
      prisma.session.deleteMany({ where: { shop } }),
      prisma.shop.delete({ where: { id: shopId } }),
    ]);
  } else {
    // Fallback: at least kill sessions
    await prisma.session.deleteMany({ where: { shop } });
  }

  return new Response(null, { status: 200 });
};
