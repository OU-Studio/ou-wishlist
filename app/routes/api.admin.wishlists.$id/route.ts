import prisma from "../../db.server";
import { authenticate } from "../../shopify.server";

export async function loader({ request, params }: { request: Request; params: { id?: string } }) {
  await authenticate.admin(request);

  const id = params.id;
  if (!id) return Response.json({ error: "Missing id" }, { status: 400 });

  const wishlist = await prisma.wishlist.findFirst({
    where: { id },
    select: {
      id: true,
      name: true,
      shopId: true,
      customerId: true,
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
        },
      },
    },
  });

  if (!wishlist) return Response.json({ error: "Wishlist not found" }, { status: 404 });
  return Response.json({ wishlist }, { status: 200 });
}
