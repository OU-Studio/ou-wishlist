import prisma from "../../db.server";
import { getShopCustomerAdmin, readBody, asInt } from "../../utils/api.server";

export async function action({
  request,
  params,
}: {
  request: Request;
  params: { id?: string; itemId?: string };
}) {
  const { shop, customer } = await getShopCustomerAdmin(request);
  const wishlistId = params.id;
  const itemId = params.itemId;

  if (!wishlistId || !itemId) return Response.json({ error: "Missing id/itemId" }, { status: 400 });

  // Ownership check via wishlist
  const wishlist = await prisma.wishlist.findFirst({
    where: { id: wishlistId, shopId: shop.id, customerId: customer.id, isArchived: false },
    select: { id: true },
  });
  if (!wishlist) return Response.json({ error: "Wishlist not found" }, { status: 404 });

  const item = await prisma.wishlistItem.findFirst({
    where: { id: itemId, wishlistId },
    select: { id: true },
  });
  if (!item) return Response.json({ error: "Item not found" }, { status: 404 });

  const method = request.method.toUpperCase();

  if (method === "PATCH") {
    const body = await readBody(request);
    const quantity = asInt(body.quantity, 1);
    if (quantity < 1 || quantity > 999) {
      return Response.json({ error: "quantity must be 1..999" }, { status: 400 });
    }

    const updated = await prisma.wishlistItem.update({
      where: { id: itemId },
      data: { quantity },
      select: { id: true, productId: true, variantId: true, quantity: true, createdAt: true, updatedAt: true },
    });

    return Response.json({ item: updated }, { status: 200 });
  }

  if (method === "DELETE") {
    await prisma.wishlistItem.delete({ where: { id: itemId } });
    return Response.json({ ok: true }, { status: 200 });
  }

  return Response.json({ error: "Method not allowed" }, { status: 405 });
}
