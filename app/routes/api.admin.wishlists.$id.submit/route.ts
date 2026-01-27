import prisma from "../../db.server";
import { readBody, asString } from "../../utils/api.server";
import { authenticate } from "../../shopify.server";

function json(data: unknown, status = 200) {
  return Response.json(data, { status });
}

function looksLikeCurrencyError(gqlErrors: any[], userErrors: any[]) {
  const msg = [
    ...(gqlErrors || []).map((e) => e?.message).filter(Boolean),
    ...(userErrors || []).map((e) => e?.message).filter(Boolean),
  ]
    .join(" | ")
    .toLowerCase();

  if (!msg.includes("currency")) return false;

  return (
    msg.includes("not enabled") ||
    msg.includes("not supported") ||
    msg.includes("invalid") ||
    msg.includes("not available") ||
    msg.includes("not configured") ||
    msg.includes("isn't available")
  );
}

async function resolveRuleCurrency(shopId: string, countryCode: string | null) {
  if (!countryCode) return null;
  const cc = countryCode.trim().toUpperCase();
  if (cc.length !== 2) return null;

  const rule = await prisma.marketCurrencyRule.findUnique({
    where: { shopId_countryCode: { shopId, countryCode: cc } },
    select: { currency: true },
  });

  const cur = (rule?.currency || "").trim().toUpperCase();
  return cur.length === 3 ? cur : null;
}

async function resolveShopDefaultCurrency(shopId: string) {
  const shop = await prisma.shop.findUnique({
    where: { id: shopId },
    select: { defaultCurrency: true },
  });
  const cur = (shop?.defaultCurrency || "").trim().toUpperCase();
  return cur.length === 3 ? cur : null;
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

  const requestedCurrency = await resolveRuleCurrency(shop.id, countryCode);
  const fallbackCurrency = await resolveShopDefaultCurrency(shop.id);

  const lineItems = wishlist.items.map((i) => ({
    variantId: i.variantId,
    quantity: i.quantity,
  }));

  const customerGid = `gid://shopify/Customer/${wishlist.customer.customerId}`;

  const gql = `#graphql
    mutation CreateDraftOrder($input: DraftOrderInput!) {
      draftOrderCreate(input: $input) {
        draftOrder { id name }
        userErrors { field message }
      }
    }
  `;


  // [here] Fetch customer address (defaultAddress first, else first address in addressesV2)
// Paste this ABOVE your `baseInput` construction.

const addrQuery = `#graphql
  query CustomerAddresses($id: ID!) {
    customer(id: $id) {
      addressesV2(first: 1) {
        nodes {
          firstName
          lastName
          company
          address1
          address2
          city
          provinceCode
          zip
          countryCodeV2
          phone
        }
      }
    }
  }
`;

const addrResp = await admin.graphql(addrQuery, {
  variables: { id: customerGid },
});

const addrJson: any = await addrResp.json();

const customerNode = addrJson?.data?.customer;

// Prefer defaultAddress, fallback to first saved address
const bestAddress =
  customerNode?.addressesV2?.nodes?.[0] ??
  null;

// Map to MailingAddressInput for DraftOrderInput
const mailingAddress = bestAddress
  ? {
      firstName: bestAddress.firstName ?? '1',
      lastName: bestAddress.lastName ?? '2',
      company: bestAddress.company ?? '3',
      address1: bestAddress.address1 ?? '4',
      address2: bestAddress.address2 ?? '5',
      city: bestAddress.city ?? '6',
      provinceCode: bestAddress.provinceCode ?? '7',
      zip: bestAddress.zip ?? 'np11 4ae',

      // DraftOrder expects `countryCode`, customer address returns `countryCodeV2`
      countryCode: bestAddress.countryCodeV2 ?? '9',

      phone: bestAddress.phone ?? '07123123123',
    }
  : null;

// If you want to require an address, uncomment:
// if (!mailingAddress) return json({ error: "Customer has no saved address" }, 400);


const mailingAddress2 = {
  firstName: "Test",
  lastName: "Customer",
  address1: "123 Peter Street",
  address2: undefined,
  city: "Cardiff",
  province: "Wales",          // optional
  provinceCode: "WLS",        // optional; UK provinces are not required
  zip: "CF1 2FR",
  countryCode: "GB",          // IMPORTANT: ISO-3166-1 alpha-2
  phone: "01234123456",
};





  const baseInput: any = {
    purchasingEntity: { customerId: customerGid },
  shippingAddress: mailingAddress2,
  billingAddress: mailingAddress2,
    lineItems,
    note: [
      `Wishlist: ${wishlist.id} (${wishlist.name})`,
      countryCode ? `Country: ${countryCode}` : null,
      requestedCurrency ? `Requested currency: ${requestedCurrency}` : null,
      note ? `Staff note: ${note}` : null,
    ].filter(Boolean).join("\n"),
    tags: [
      `wishlist:${wishlist.id}`,
      `wishlistName:${wishlist.name}`,
      `wishlist-admin-submit`,
      countryCode ? `country:${countryCode}` : null,
      requestedCurrency ? `currencyRequested:${requestedCurrency}` : null,
    ].filter(Boolean)
  };

  const attempt1Input = requestedCurrency
    ? { ...baseInput, presentmentCurrencyCode: requestedCurrency }
    : { ...baseInput };

  const resp1 = await admin.graphql(gql, { variables: { input: attempt1Input } });
  const respJson1: any = await resp1.json();
  const gqlErrors1 = respJson1?.errors ?? [];
  const userErrors1 = respJson1?.data?.draftOrderCreate?.userErrors ?? [];

  if (!gqlErrors1.length && !userErrors1.length) {
    const draftOrderId = respJson1?.data?.draftOrderCreate?.draftOrder?.id ?? null;

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

    return json({
      submission,
      countryCode,
      currency: { requested: requestedCurrency, used: requestedCurrency ?? null, fallbackUsed: false },
      _submitVersion: "admin-draftOrderCreate-v3-currency-fallback",
    }, 201);
  }

  // retry if currency error
  if (requestedCurrency && looksLikeCurrencyError(gqlErrors1, userErrors1)) {
    const attempt2Input =
      fallbackCurrency
        ? { ...baseInput, presentmentCurrencyCode: fallbackCurrency, tags: [...baseInput.tags, `currencyFallback:${fallbackCurrency}`] }
        : { ...baseInput, tags: [...baseInput.tags, `currencyFallback:shop-default`] };

    const resp2 = await admin.graphql(gql, { variables: { input: attempt2Input } });
    const respJson2: any = await resp2.json();
    const gqlErrors2 = respJson2?.errors ?? [];
    const userErrors2 = respJson2?.data?.draftOrderCreate?.userErrors ?? [];

    if (!gqlErrors2.length && !userErrors2.length) {
      const draftOrderId = respJson2?.data?.draftOrderCreate?.draftOrder?.id ?? null;

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

      return json({
        submission,
        countryCode,
        currency: { requested: requestedCurrency, used: fallbackCurrency ?? null, fallbackUsed: true },
        _submitVersion: "admin-draftOrderCreate-v3-currency-fallback",
      }, 201);
    }

    return json({
      error: "Draft order create failed (after currency fallback)",
      countryCode,
      currency: { requested: requestedCurrency, fallback: fallbackCurrency ?? null },
      attempt: "fallback",
      gqlErrors: gqlErrors2,
      userErrors: userErrors2,
      raw: respJson2,
    }, 400);
  }

  return json({
    error: "Draft order create failed",
    countryCode,
    currency: { requested: requestedCurrency, fallback: fallbackCurrency ?? null },
    attempt: "primary",
    gqlErrors: gqlErrors1,
    userErrors: userErrors1,
    raw: respJson1,
  }, 400);
}
