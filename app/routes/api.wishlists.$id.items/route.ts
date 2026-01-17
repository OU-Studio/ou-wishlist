import prisma from "../../db.server";
import { getShopCustomerAdmin, readBody, asString, asInt } from "../../utils/api.server";

export async function action({ request, params }: { request: Request; params: { id?: string } }) {
  const { shop, customer } = await getShopCustomerAdmin(request);
  const wishlistId = params.id;

  if (!wishlistId) return Response.json({ error: "Missing id" }, { status: 400 });

  const wishlist = await prisma.wishlist.findFirst({
    where: { id: wishlistId, shopId: shop.id, customerId: customer.id, isArchived: false },
    select: { id: true },
  });
  if (!wishlist) return Response.json({ error: "Wishlist not found" }, { status: 404 });

  const body = await readBody(request);
  const productId = asString(body.productId);
  const variantId = asString(body.variantId);
  const quantity = asInt(body.quantity, 1);

  if (!productId || !variantId) {
    return Response.json({ error: "productId and variantId are required" }, { status: 400 });
  }
  if (quantity < 1 || quantity > 999) {
    return Response.json({ error: "quantity must be 1..999" }, { status: 400 });
  }

  const item = await prisma.wishlistItem.upsert({
    where: { wishlistId_variantId: { wishlistId, variantId } },
    update: { quantity: { increment: quantity } },
    create: { wishlistId, productId, variantId, quantity },
    select: { id: true, productId: true, variantId: true, quantity: true, createdAt: true, updatedAt: true },
  });

  return Response.json({ item }, { status: 201 });
}
