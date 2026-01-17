import prisma from "../../db.server";
import {  readBody, asString } from "../../utils/api.server";
import { resolveCustomerIdentity } from "../../utils/identity.server";

export async function loader({ request }: { request: Request }) {
  const { shop, customer } = await resolveCustomerIdentity(request);

  const wishlists = await prisma.wishlist.findMany({
    where: { shopId: shop.id, customerId: customer.id, isArchived: false },
    orderBy: { updatedAt: "desc" },
    select: { id: true, name: true, createdAt: true, updatedAt: true },
  });

  return Response.json({ wishlists }, { status: 200 });
}

export async function action({ request }: { request: Request }) {
  const { shop, customer } = await resolveCustomerIdentity(request);

  const body = await readBody(request);
  const name = asString(body.name);

  if (!name) return Response.json({ error: "Wishlist name is required" }, { status: 400 });
  if (name.length > 80) return Response.json({ error: "Wishlist name must be 80 chars or less" }, { status: 400 });

  try {
    const wishlist = await prisma.wishlist.create({
      data: { shopId: shop.id, customerId: customer.id, name },
      select: { id: true, name: true, createdAt: true, updatedAt: true },
    });

    return Response.json({ wishlist }, { status: 201 });
  } catch (err: any) {
    if (err?.code === "P2002") {
      return Response.json({ error: "A wishlist with that name already exists" }, { status: 409 });
    }
    throw err;
  }
}
