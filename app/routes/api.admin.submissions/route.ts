import prisma from "../../db.server";
import { authenticate } from "../../shopify.server";

export async function loader({ request }: { request: Request }) {
  await authenticate.admin(request);

  const url = new URL(request.url);
  const wishlistId = url.searchParams.get("wishlistId") || undefined;
  const customerId = url.searchParams.get("customerId") || undefined;

  const submissions = await prisma.wishlistSubmission.findMany({
    where: {
      ...(wishlistId ? { wishlistId } : {}),
      ...(customerId ? { customerId } : {}),
    },
    orderBy: { createdAt: "desc" },
    select: { id: true, status: true, draftOrderId: true, wishlistId: true, customerId: true, createdAt: true },
  });

  return Response.json({ submissions }, { status: 200 });
}
