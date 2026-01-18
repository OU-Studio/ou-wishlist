import prisma from "../../db.server";
import { readBody, asString } from "../../utils/api.server";
import { authenticate } from "../../shopify.server";

const ADMIN_API_VERSION = "2025-10";

function json(data: unknown, status = 200) {
  return Response.json(data, { status });
}

export async function action({
  request,
  params,
}: {
  request: Request;
  params: { id?: string };
}) {
  const { session, admin } = await authenticate.admin(request);

  const wishlistId = params.id;
  if (!wishlistId) return json({ error: "Missing id" }, 400);
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const shop = await prisma.shop.upsert({
    where: { shop: session.shop },
    update: {},
    create: { shop: session.shop },
  });

  const wishlist = await prisma.wishlist.findFirst({
    where: { id: wishlistId, shopId: shop.id, isArchived: false },
    include: { items: true, customer: true },
  });

  if (!wishlist) return json({ error: "Wishlist not found" }, 404);
  if (!wishlist.items.length) return json({ error: "Wishlist is empty" }, 400);

  const body = await readBody(request);
  const note = (asString(body.note) || "").trim();
  const countryCode = (asString((body as any).countryCode) || "").trim().toUpperCase() || null;

  const presentmentCurrencyCode = countryCode
    ? (
        await prisma.marketCurrencyRule.findUnique({
          where: { shopId_countryCode: { shopId: shop.id, countryCode } },
          select: { currency: true },
        })
      )?.currency?.trim()?.toUpperCase() ?? null
    : null;

  const lineItems = wishlist.items.map((i) => ({
    variantId: i.variantId,
    quantity: i.quantity,
  }));

  const draftNote = [
    `Wishlist: ${wishlist.id} (${wishlist.name})`,
    countryCode ? `Country: ${countryCode}` : null,
    presentmentCurrencyCode ? `Currency: ${presentmentCurrencyCode}` : null,
    note ? `Staff note: ${note}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  const customerGid = `gid://shopify/Customer/${wishlist.customer.customerId}`;

  const gql = `#graphql
    mutation CreateDraftOrder($input: DraftOrderInput!) {
      draftOrderCreate(input: $input) {
        draftOrder { id name }
        userErrors { field message }
      }
    }
  `;

  const resp = await admin.graphql(gql, {
    variables: {
      input: {
        customerId: customerGid,
        note: draftNote,
        tags: [
          `wishlist:${wishlist.id}`,
          `wishlistName:${wishlist.name}`,
          `wishlist-admin-submit`,
          countryCode ? `country:${countryCode}` : null,
          presentmentCurrencyCode ? `currency:${presentmentCurrencyCode}` : null,
        ].filter(Boolean),
        lineItems,
        ...(presentmentCurrencyCode ? { presentmentCurrencyCode } : {}),
      },
    },
  });

  const respJson: any = await resp.json();

  if (respJson?.errors?.length) {
    return json({ error: "GraphQL error", errors: respJson.errors }, 400);
  }

  const userErrors = respJson?.data?.draftOrderCreate?.userErrors ?? [];
  if (userErrors.length) {
    return json({ error: "Draft order create failed", userErrors }, 400);
  }

  const draftOrderId = respJson?.data?.draftOrderCreate?.draftOrder?.id ?? null;

  const submission = await prisma.wishlistSubmission.create({
    data: {
      shopId: shop.id,
      wishlistId: wishlist.id,
      customerId: wishlist.customerId,
      status: "created",
      draftOrderId,
      note: note || null,
    },
    select: { id: true, status: true, draftOrderId: true, createdAt: true },
  });

  return json(
    {
      submission,
      countryCode,
      presentmentCurrencyCode,
      _submitVersion: "admin-draftOrderCreate-v2-currency-rules",
    },
    201
  );
}
