import prisma from "../../db.server";
import { getShopCustomerAdmin, readBody, asString } from "../../utils/api.server";

export async function action({ request, params }: { request: Request; params: { id?: string } }) {
  const { shop, customer, admin } = await getShopCustomerAdmin(request);
  const wishlistId = params.id;

  if (!wishlistId) return Response.json({ error: "Missing id" }, { status: 400 });

  const wishlist = await prisma.wishlist.findFirst({
    where: { id: wishlistId, shopId: shop.id, customerId: customer.id, isArchived: false },
    include: { items: true },
  });

  if (!wishlist) return Response.json({ error: "Wishlist not found" }, { status: 404 });
  if (!wishlist.items.length) return Response.json({ error: "Wishlist is empty" }, { status: 400 });

  const body = await readBody(request);
  const note = asString(body.note);

  // Draft order line items
const lineItems = wishlist.items.map((i: { variantId: string; quantity: number }) => ({
  variantId: i.variantId,
  quantity: i.quantity,
}));

  // Create Draft Order (minimal)
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
          note: [
            `Wishlist: ${wishlist.id} (${wishlist.name})`,
            note ? `Customer note: ${note}` : null,
          ].filter(Boolean).join("\n"),
          tags: [`wishlist:${wishlist.id}`, `wishlistName:${wishlist.name}`],
          lineItems,
        },
      },
    }
  );

  const draftJson: any = await draftRes.json();
  const errs = draftJson?.data?.draftOrderCreate?.userErrors || [];
  if (errs.length) {
    const submission = await prisma.wishlistSubmission.create({
      data: { shopId: shop.id, wishlistId: wishlist.id, customerId: customer.id, status: "failed", note },
      select: { id: true, status: true, draftOrderId: true, createdAt: true },
    });
    return Response.json({ error: "Draft order create failed", userErrors: errs, submission }, { status: 400 });
  }

  const draftOrderId = draftJson?.data?.draftOrderCreate?.draftOrder?.id as string | undefined;

  const submission = await prisma.wishlistSubmission.create({
    data: {
      shopId: shop.id,
      wishlistId: wishlist.id,
      customerId: customer.id,
      status: "created",
      draftOrderId: draftOrderId ?? null,
      note,
    },
    select: { id: true, status: true, draftOrderId: true, createdAt: true },
  });

  return Response.json({ submission }, { status: 201 });
}
