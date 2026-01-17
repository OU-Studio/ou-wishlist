import prisma from "../../db.server";
import { readBody, asString } from "../../utils/api.server";
import { resolveCustomerIdentity } from "../../utils/identity.server";

export async function loader({ request, params }: { request: Request; params: { id?: string } }) {
  const { shop, customer } = await resolveCustomerIdentity(request);
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

  if (!wishlist) return Response.json({ error: "Wishlist not found" }, { status: 404 });
  return Response.json({ wishlist }, { status: 200 });
}

export async function action({ request, params }: { request: Request; params: { id?: string } }) {
  const { shop, customer } = await resolveCustomerIdentity(request);
  const id = params.id;

  if (!id) return Response.json({ error: "Missing id" }, { status: 400 });

  const wishlist = await prisma.wishlist.findFirst({
    where: { id, shopId: shop.id, customerId: customer.id, isArchived: false },
    select: { id: true },
  });
  if (!wishlist) return Response.json({ error: "Wishlist not found" }, { status: 404 });

  const method = request.method.toUpperCase();

  if (method === "PATCH") {
    const body = await readBody(request);
    const name = asString(body.name);
    if (!name) return Response.json({ error: "Wishlist name is required" }, { status: 400 });
    if (name.length > 80) return Response.json({ error: "Wishlist name must be 80 chars or less" }, { status: 400 });

    try {
      const updated = await prisma.wishlist.update({
        where: { id },
        data: { name },
        select: { id: true, name: true, createdAt: true, updatedAt: true },
      });
      return Response.json({ wishlist: updated }, { status: 200 });
    } catch (err: any) {
      if (err?.code === "P2002") {
        return Response.json({ error: "A wishlist with that name already exists" }, { status: 409 });
      }
      throw err;
    }
  }

  if (method === "DELETE") {
    await prisma.wishlist.update({
      where: { id },
      data: { isArchived: true },
    });
    return Response.json({ ok: true }, { status: 200 });
  }

  return Response.json({ error: "Method not allowed" }, { status: 405 });
}
