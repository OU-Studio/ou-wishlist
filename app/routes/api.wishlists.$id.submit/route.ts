import prisma from "../../db.server";
import { readBody, asString } from "../../utils/api.server";
import { resolveCustomerIdentity } from "../../utils/identity.server";

export async function action({
  request,
  params,
}: {
  request: Request;
  params: { id?: string };
}) {
  const { shop, customer } = await resolveCustomerIdentity(request);
  const wishlistId = params.id;

  if (!wishlistId) {
    return Response.json({ error: "Missing id" }, { status: 400 });
  }

  const wishlist = await prisma.wishlist.findFirst({
    where: {
      id: wishlistId,
      shopId: shop.id,
      customerId: customer.id,
      isArchived: false,
    },
    include: { items: true },
  });

  if (!wishlist) {
    return Response.json({ error: "Wishlist not found" }, { status: 404 });
  }

  if (!wishlist.items.length) {
    return Response.json({ error: "Wishlist is empty" }, { status: 400 });
  }

  const body = await readBody(request);
  const note = asString(body.note);

  // Create a submission request (NO draft order here)
  const submission = await prisma.wishlistSubmission.create({
    data: {
      shopId: shop.id,
      wishlistId: wishlist.id,
      customerId: customer.id,
      status: "requested",
      note,
    },
    select: {
      id: true,
      status: true,
      createdAt: true,
    },
  });

  return Response.json({ submission }, { status: 201 });
}
