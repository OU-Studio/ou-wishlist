import prisma from "../../db.server";
import { authenticate } from "../../shopify.server";

export async function action({ request, params }: { request: Request; params: { id?: string } }) {
  const { admin, session } = await authenticate.admin(request);

  const id = params.id;
  if (!id) return Response.json({ error: "Missing id" }, { status: 400 });

  const wishlist = await prisma.wishlist.findFirst({
    where: { id, isArchived: false },
    include: { items: true },
  });
  if (!wishlist) return Response.json({ error: "Wishlist not found" }, { status: 404 });
  if (!wishlist.items.length) return Response.json({ error: "Wishlist is empty" }, { status: 400 });


const lineItems = wishlist.items.map((i: { variantId: string; quantity: number }) => ({
  variantId: i.variantId,
  quantity: i.quantity,
}));
  const draftRes = await admin.graphql(
    `#graphql
      mutation CreateDraftOrder($input: DraftOrderInput!) {
        draftOrderCreate(input: $input) {
          draftOrder { id name }
          userErrors { field message }
        }
      }
    `,
    {
      variables: {
        input: {
          note: `Admin manual conversion. Wishlist: ${wishlist.id} (${wishlist.name})`,
          tags: [`wishlist:${wishlist.id}`, "manual"],
          lineItems,
        },
      },
    }
  );

  const draftJson: any = await draftRes.json();
  const errs = draftJson?.data?.draftOrderCreate?.userErrors || [];
  if (errs.length) return Response.json({ error: "Draft order create failed", userErrors: errs }, { status: 400 });

  const draftOrderId = draftJson?.data?.draftOrderCreate?.draftOrder?.id as string | undefined;

  const submission = await prisma.wishlistSubmission.create({
    data: {
      shopId: wishlist.shopId,
      wishlistId: wishlist.id,
      customerId: wishlist.customerId,
      status: "created",
      draftOrderId: draftOrderId ?? null,
      note: "manual conversion",
    },
    select: { id: true, status: true, draftOrderId: true, createdAt: true },
  });

  return Response.json({ submission }, { status: 201 });
}
