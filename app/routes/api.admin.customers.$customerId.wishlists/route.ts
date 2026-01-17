import prisma from "../../db.server";
import { authenticate } from "../../shopify.server";

export async function loader({ request, params }: { request: Request; params: { customerId?: string } }) {
  await authenticate.admin(request);

  const customerId = params.customerId;
  if (!customerId) return Response.json({ error: "Missing customerId" }, { status: 400 });

  const wishlists = await prisma.wishlist.findMany({
    where: { customerId, isArchived: false },
    orderBy: { updatedAt: "desc" },
    select: { id: true, name: true, createdAt: true, updatedAt: true },
  });

  return Response.json({ wishlists }, { status: 200 });
}
