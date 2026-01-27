import prisma from "../../db.server";
import { readBody, asString } from "../../utils/api.server";
import { resolveCustomerIdentity } from "../../utils/identity.server";

const EXT_ORIGIN = "https://extensions.shopifycdn.com";
const ADMIN_API_VERSION = "2025-10";

/* -------------------- CORS -------------------- */

function allowOrigin(request: Request) {
  const origin = request.headers.get("Origin") || "";
  // lock to extension origin only (no "*")
  return origin === EXT_ORIGIN ? origin : "";
}

function corsHeaders(request: Request) {
  const origin = allowOrigin(request);

  // If not allowed, return minimal headers; caller will get 403 from handler.
  if (!origin) {
    return {
      Vary: "Origin",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    } as Record<string, string>;
  }

  return {
    "Access-Control-Allow-Origin": origin,
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

function requireAllowedOrigin(request: Request) {
  const origin = request.headers.get("Origin") || "";
  return origin === EXT_ORIGIN;
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
    where: { shop: shopDomain, isOnline: false },
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

/* -------------------- HELPERS -------------------- */

function normalizeMarketCountry(countryCode: string | null) {
  if (!countryCode) return null;
  const cc = String(countryCode).trim().toUpperCase();
  if (cc === "UK") return "GB";
  return cc.length === 2 ? cc : null;
}

async function adminGraphql(shopDomain: string, accessToken: string, query: string, variables: any) {
  const res = await fetch(`https://${shopDomain}/admin/api/${ADMIN_API_VERSION}/graphql.json`, {
    method: "POST",
    headers: {
      "X-Shopify-Access-Token": accessToken,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });

  const json: any = await res.json().catch(() => ({}));

  if (!res.ok) {
    return { ok: false, status: res.status, json };
  }
  return { ok: true, status: res.status, json };
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

  // Hard lock this endpoint to UI extensions origin
  if (!requireAllowedOrigin(request)) {
    return corsJson(request, { error: "Forbidden origin" }, 403);
  }

  try {
    const identity = await resolveCustomerIdentity(request);
    const wishlistId = params.id;

    if (!wishlistId) return corsJson(request, { error: "Missing wishlist id" }, 400);
    if (request.method !== "POST") return corsJson(request, { error: "Method not allowed" }, 405);

    const wishlist = await prisma.wishlist.findFirst({
      where: {
        id: wishlistId,
        shopId: identity.shop.id,
        customerId: identity.customer.id,
        isArchived: false,
      },
      include: { items: true },
    });

    if (!wishlist) return corsJson(request, { error: "Wishlist not found" }, 404);
    if (!wishlist.items.length) return corsJson(request, { error: "Wishlist is empty" }, 400);

    const body = await readBody(request);
    const note = (asString(body.note) || "").trim();
    const countryCode = (asString((body as any).countryCode) || "").trim().toUpperCase() || null;

    // Optional: basic anti-spam (1 submission per wishlist per 30s)
    const recent = await prisma.wishlistSubmission.findFirst({
      where: { wishlistId: wishlist.id, customerId: identity.customer.id },
      orderBy: { createdAt: "desc" },
      select: { id: true, createdAt: true, status: true, draftOrderId: true },
    });

    if (recent) {
      const ageMs = Date.now() - new Date(recent.createdAt).getTime();
      if (ageMs < 30_000 && (recent.status === "queued" || recent.status === "created")) {
        // Return the recent submission instead of creating a new draft order
        return corsJson(
          request,
          {
            submission: {
              id: recent.id,
              status: recent.status,
              draftOrderId: recent.draftOrderId ?? null,
            },
            _submitVersion: "draftOrderCreate-webhook-based-v2-idempotent",
          },
          200
        );
      }
    }

    /* ---------- create submission (queued) ---------- */

    const submission = await prisma.wishlistSubmission.create({
      data: {
        shopId: identity.shop.id,
        wishlistId: wishlist.id,
        customerId: identity.customer.id,
        status: "queued",
        note: note || null,
      },
      select: { id: true, status: true, createdAt: true },
    });

    /* ---------- admin token ---------- */

    const accessToken = await getOfflineAccessToken(identity.shop.shop);
    if (!accessToken) {
      await prisma.wishlistSubmission.update({
        where: { id: submission.id },
        data: { status: "failed" },
      });
      return corsJson(request, { error: "Missing offline admin access token" }, 500);
    }

    /* ---------- currency ---------- */

    const requestedCurrency = await resolveRuleCurrency(identity.shop.id, countryCode);

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

    const customerGid = `gid://shopify/Customer/${identity.customer.customerId}`;
    const marketCC = normalizeMarketCountry(countryCode);

    /* ---------- Fetch best address ---------- */

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

    const addrResp = await adminGraphql(identity.shop.shop, accessToken, addrQuery, { id: customerGid });
    const customerNode = addrResp.ok ? addrResp.json?.data?.customer : null;

    const bestAddress =
      customerNode?.defaultAddress ??
      customerNode?.addressesV2?.nodes?.[0] ??
      null;

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

    /* ---------- Create Draft Order ---------- */

    const createGql = `#graphql
      mutation CreateDraftOrder($input: DraftOrderInput!) {
        draftOrderCreate(input: $input) {
          draftOrder {
            id
            name
            presentmentCurrencyCode
            marketRegionCountryCode
          }
          userErrors { field message }
        }
      }
    `;

    const input: any = {
      purchasingEntity: { customerId: customerGid },

      ...(mailingAddress
        ? { shippingAddress: mailingAddress, billingAddress: mailingAddress }
        : { useCustomerDefaultAddress: true }),

      ...(marketCC ? { marketRegionCountryCode: marketCC } : {}),

      note: draftNote,
      tags: ["wishlist-submission"],
      lineItems,

      ...(requestedCurrency ? { presentmentCurrencyCode: requestedCurrency } : {}),
    };

    const createResp = await adminGraphql(identity.shop.shop, accessToken, createGql, { input });
    const createJson = createResp.json;

    const userErrors = createJson?.data?.draftOrderCreate?.userErrors ?? [];
    const draftOrder = createJson?.data?.draftOrderCreate?.draftOrder ?? null;

    if (!createResp.ok || userErrors.length || !draftOrder?.id) {
      await prisma.wishlistSubmission.update({
        where: { id: submission.id },
        data: { status: "failed" },
      });

      return corsJson(
        request,
        {
          error: "Draft order create failed",
          userErrors,
          status: createResp.status,
        },
        400
      );
    }

    /* ---------- SUCCESS (persist ID) ---------- */

    await prisma.wishlistSubmission.update({
      where: { id: submission.id },
      data: { status: "created", draftOrderId: draftOrder.id },
    });

    // Return minimal data to the client (avoid leaking addresses)
    return corsJson(
      request,
      {
        submission: {
          id: submission.id,
          status: "created",
          draftOrderId: draftOrder.id,
        },
        draftOrder: {
          id: draftOrder.id,
          name: draftOrder.name,
          presentmentCurrencyCode: draftOrder.presentmentCurrencyCode,
          marketRegionCountryCode: draftOrder.marketRegionCountryCode,
        },
        _submitVersion: "draftOrderCreate-webhook-based-v2-hardened",
      },
      201
    );
  } catch (e: any) {
    return corsJson(request, { error: e?.message || "Unauthorized" }, 401);
  }
}
