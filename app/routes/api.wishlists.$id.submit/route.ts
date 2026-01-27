import prisma from "../../db.server";
import { readBody, asString } from "../../utils/api.server";
import { resolveCustomerIdentity } from "../../utils/identity.server";

const EXT_ORIGIN = "https://extensions.shopifycdn.com";
const ADMIN_API_VERSION = "2025-10";

/* -------------------- CORS -------------------- */

function allowOrigin(request: Request) {
  const origin = request.headers.get("Origin") || "";
  return origin === EXT_ORIGIN ? origin : "*";
}

function corsHeaders(request: Request) {
  return {
    "Access-Control-Allow-Origin": allowOrigin(request),
    Vary: "Origin",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  } as Record<string, string>;
}

function corsJson(request: Request, data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(request) },
  });
}

function corsNoContent(request: Request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) });
}

export async function loader({ request }: { request: Request }) {
  if (request.method === "OPTIONS") return corsNoContent(request);
  return corsJson(request, { error: "Method not allowed" }, 405);
}

/* -------------------- TOKEN -------------------- */
/**
 * IMPORTANT:
 * - Always prefer OFFLINE session
 * - Never use an online token for Admin API draft orders
 */
async function getOfflineAccessToken(shopDomain: string) {
  const offline = await prisma.session.findFirst({
    where: {
      shop: shopDomain,
      isOnline: false,
    },
    select: { accessToken: true },
  });

  return offline?.accessToken ?? null;
}

/* -------------------- CURRENCY RULES -------------------- */

async function resolveRuleCurrency(shopId: string, countryCode: string | null) {
  if (!countryCode) return null;

  const rule = await prisma.marketCurrencyRule.findUnique({
    where: {
      shopId_countryCode: {
        shopId,
        countryCode: countryCode.toUpperCase(),
      },
    },
    select: { currency: true },
  });

  const cur = (rule?.currency || "").trim().toUpperCase();
  return cur.length === 3 ? cur : null;
}

/* -------------------- ACTION -------------------- */

export async function action({
  request,
  params,
}: {
  request: Request;
  params: { id?: string };
}) {
  if (request.method === "OPTIONS") return corsNoContent(request);

  try {
    const identity = await resolveCustomerIdentity(request);
    const wishlistId = params.id;

    if (!wishlistId) {
      return corsJson(request, { error: "Missing wishlist id" }, 400);
    }

    if (request.method !== "POST") {
      return corsJson(request, { error: "Method not allowed" }, 405);
    }

    const wishlist = await prisma.wishlist.findFirst({
      where: {
        id: wishlistId,
        shopId: identity.shop.id,
        customerId: identity.customer.id,
        isArchived: false,
      },
      include: { items: true },
    });

    if (!wishlist) {
      return corsJson(request, { error: "Wishlist not found" }, 404);
    }

    if (!wishlist.items.length) {
      return corsJson(request, { error: "Wishlist is empty" }, 400);
    }

    const body = await readBody(request);
    const note = (asString(body.note) || "").trim();
    const countryCode =
      (asString((body as any).countryCode) || "").trim().toUpperCase() || null;

    /* ---------- create submission (queued) ---------- */

    const submission = await prisma.wishlistSubmission.create({
      data: {
        shopId: identity.shop.id,
        wishlistId: wishlist.id,
        customerId: identity.customer.id,
        status: "queued",
        note: note || null,
      },
      select: {
        id: true,
        status: true,
        createdAt: true,
      },
    });

    /* ---------- admin token ---------- */

    const accessToken = await getOfflineAccessToken(identity.shop.shop);

    if (!accessToken) {
      await prisma.wishlistSubmission.update({
        where: { id: submission.id },
        data: { status: "failed" },
      });

      return corsJson(
        request,
        { error: "Missing offline admin access token" },
        500
      );
    }

    /* ---------- currency ---------- */

    const requestedCurrency = await resolveRuleCurrency(
      identity.shop.id,
      countryCode
    );

    /* ---------- line items ---------- */

    const lineItems = wishlist.items.map((i) => ({
      variantId: i.variantId,
      quantity: i.quantity,
    }));

    /* ---------- build NOTE (NOT TAGS) ---------- */

    const draftNote = [
      `Wishlist submission`,
      `Submission ID: ${submission.id}`,
      `Wishlist: ${wishlist.id} (${wishlist.name})`,
      countryCode ? `Country: ${countryCode}` : null,
      requestedCurrency ? `Requested currency: ${requestedCurrency}` : null,
      note ? `Customer note: ${note}` : null,
    ]
      .filter(Boolean)
      .join("\n");

    /* ---------- GraphQL (NO DraftOrder read) ---------- */

    const gql = `#graphql
  mutation CreateDraftOrder($input: DraftOrderInput!) {
    draftOrderCreate(input: $input) {
      draftOrder {
        id
        name
        presentmentCurrencyCode
        marketRegionCountryCode
        shippingAddress { address1 city zip countryCodeV2 }
        billingAddress  { address1 city zip countryCodeV2 }
      }
      userErrors { field message }
    }
  }
`;

    const customerGid = `gid://shopify/Customer/${identity.customer.customerId}`;

    // 1) Fetch best address (defaultAddress first, else addressesV2[0])
const addrQuery = `#graphql
  query CustomerAddresses($id: ID!) {
    customer(id: $id) {
      defaultAddress {
        firstName lastName company
        address1 address2 city provinceCode zip
        countryCodeV2 phone
      }
      addressesV2(first: 1) {
        nodes {
          firstName lastName company
          address1 address2 city provinceCode zip
          countryCodeV2 phone
        }
      }
    }
  }
`;

const addrRes = await fetch(
  `https://${identity.shop.shop}/admin/api/${ADMIN_API_VERSION}/graphql.json`,
  {
    method: "POST",
    headers: {
      "X-Shopify-Access-Token": accessToken,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query: addrQuery,
      variables: { id: customerGid },
    }),
  }
);

const addrJson: any = await addrRes.json();
const customerNode = addrJson?.data?.customer;

const bestAddress =
  customerNode?.defaultAddress ??
  customerNode?.addressesV2?.nodes?.[0] ??
  null;

// Map to MailingAddressInput (DraftOrderInput expects countryCode, not countryCodeV2)
const mailingAddress = bestAddress
  ? {
      firstName: bestAddress.firstName ?? undefined,
      lastName: bestAddress.lastName ?? undefined,
      company: bestAddress.company ?? undefined,
      address1: bestAddress.address1 ?? undefined,
      address2: bestAddress.address2 ?? undefined,
      city: bestAddress.city ?? undefined,
      provinceCode: bestAddress.provinceCode ?? undefined,
      zip: bestAddress.zip ?? undefined,
      countryCode: bestAddress.countryCodeV2 ?? undefined,
      phone: bestAddress.phone ?? undefined,
    }
  : null;

// 2) Normalize market country (UK -> GB)
const marketCC =
  countryCode
    ? String(countryCode).trim().toUpperCase() === "UK"
      ? "GB"
      : String(countryCode).trim().toUpperCase()
    : null;

    const res = await fetch(
      `https://${identity.shop.shop}/admin/api/${ADMIN_API_VERSION}/graphql.json`,
      {
        method: "POST",
        headers: {
          "X-Shopify-Access-Token": accessToken,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          query: gql,
          variables: {
            input: {
              purchasingEntity: { customerId: customerGid },

  ...(mailingAddress
    ? {
        shippingAddress: mailingAddress,
        billingAddress: mailingAddress,
      }
    : {
        useCustomerDefaultAddress: true,
      }),

  ...(marketCC && marketCC.length === 2 ? { marketRegionCountryCode: marketCC } : {}),
              note: draftNote,
              tags: ["wishlist-submission"],
              lineItems,
              ...(requestedCurrency
                ? { presentmentCurrencyCode: requestedCurrency }
                : {}),
            },
          },
        }),
      }
    );

    const json: any = await res.json();

    const userErrors = json?.data?.draftOrderCreate?.userErrors ?? [];
const draftOrder = json?.data?.draftOrderCreate?.draftOrder ?? null;

if (userErrors.length || !draftOrder?.id) {
  await prisma.wishlistSubmission.update({
    where: { id: submission.id },
    data: { status: "failed" },
  });

  return corsJson(request, { error: "Draft order create failed", userErrors, raw: json }, 400);
}

// Persist immediately
await prisma.wishlistSubmission.update({
  where: { id: submission.id },
  data: { status: "created", draftOrderId: draftOrder.id },
});

return corsJson(
  request,
  {
    submission: { id: submission.id, status: "created", draftOrderId: draftOrder.id },
    draftOrder, // lets you verify address+market in the frontend logs
    _submitVersion: "draftOrderCreate-webhook-based-v2",
  },
  201
);

  } catch (e: any) {
    return corsJson(
      request,
      { error: e?.message || "Unauthorized" },
      401
    );
  }
}
