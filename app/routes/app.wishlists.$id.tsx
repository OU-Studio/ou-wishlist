// app/routes/app.wishlists.$id.tsx
import type { LoaderFunctionArgs } from "react-router";
import { Link, useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import { prisma } from "../db.server";

type Money = { amount: string; currencyCode: string } | null;

type LoaderData = {
  storeHandle: string;
  wishlist: {
    id: string;
    name: string;
    isArchived: boolean;
    createdAt: string;
    updatedAt: string;
    customer: {
      customerId: string;
      firstName?: string | null;
      lastName?: string | null;
      email?: string | null;
    } | null;
    items: Array<{
      id: string;
      productId: string;
      variantId: string;
      quantity: number;
      createdAt?: string;
    }>;
    latestSubmission: {
      id: string;
      status: string;
      createdAt: string;
      draftOrderId: string | null;
    } | null;
  };
  lookup: {
    productMap: Record<string, any>;
    variantMap: Record<string, any>;
  };
};

function normalizeGid(id: string, kind: "Product" | "ProductVariant") {
  if (!id) return null;
  if (id.startsWith("gid://")) return id;
  return `gid://shopify/${kind}/${id}`;
}

function formatDateTimeGB(iso: string) {
  return new Date(iso).toLocaleString("en-GB", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function draftOrderAdminUrl(storeHandle: string, draftOrderGid: string) {
  const numericId = String(draftOrderGid).split("/").pop();
  return `https://admin.shopify.com/store/${storeHandle}/draft_orders/${numericId}`;
}

function displayCustomer(c: LoaderData["wishlist"]["customer"]) {
  if (!c) return "—";
  const name = [c.firstName, c.lastName].filter(Boolean).join(" ").trim();
  if (name && c.email) return `${name} • ${c.email}`;
  if (name) return name;
  if (c.email) return c.email;
  return "—";
}

const CURRENCY_SYMBOL: Record<string, string> = {
  GBP: "£",
  EUR: "€",
  USD: "$",
  CAD: "$",
  AUD: "$",
  NZD: "$",
  JPY: "¥",
  CNY: "¥",
  HKD: "$",
  SGD: "$",
  CHF: "CHF ",
  SEK: "kr ",
  NOK: "kr ",
  DKK: "kr ",
};

function formatMoney(price: Money) {
  if (!price?.amount) return null;
  const n = Number(price.amount);
  const amountStr = Number.isFinite(n)
    ? n.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : String(price.amount);

  const symbol = price.currencyCode ? (CURRENCY_SYMBOL[price.currencyCode] ?? `${price.currencyCode} `) : "";
  return `${symbol}${amountStr}`;
}

function getImageUrl(v: any, p: any) {
  return (
    v?.image?.url ||
    v?.image?.src ||
    p?.featuredImage?.url ||
    p?.featuredImage?.src ||
    p?.image?.url ||
    p?.image?.src ||
    p?.images?.nodes?.[0]?.url ||
    p?.media?.nodes?.[0]?.previewImage?.url ||
    null
  );
}

function getAltText(v: any, p: any, title: string) {
  return v?.image?.altText || p?.featuredImage?.altText || title || "Product image";
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  const { session, admin } = await authenticate.admin(request);

  const wishlistId = params.id;
  if (!wishlistId) throw new Response("Missing quotation id", { status: 400 });

  const storeHandle = String(session.shop || "").split(".")[0] || "unknown";

  const shopRow = await prisma.shop.findUnique({
    where: { shop: session.shop },
    select: { id: true },
  });

  if (!shopRow) throw new Response("Shop not found", { status: 404 });

  const wl = await prisma.wishlist.findFirst({
    where: { id: wishlistId, shopId: shopRow.id },
    select: {
      id: true,
      name: true,
      isArchived: true,
      createdAt: true,
      updatedAt: true,
      customer: {
        select: {
          customerId: true,
          firstName: true,
          lastName: true,
          email: true,
        },
      },
      items: {
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          productId: true,
          variantId: true,
          quantity: true,
          createdAt: true,
        },
      },
      submissions: {
        orderBy: { createdAt: "desc" },
        take: 1,
        select: {
          id: true,
          status: true,
          createdAt: true,
          draftOrderId: true,
        },
      },
    },
  });

  if (!wl) throw new Response("quotation not found", { status: 404 });

  // Build GID lists for lookup
  const productIds = Array.from(
    new Set(
      wl.items
        .map((it) => normalizeGid(String(it.productId || ""), "Product"))
        .filter(Boolean) as string[]
    )
  );

  const variantIds = Array.from(
    new Set(
      wl.items
        .map((it) => normalizeGid(String(it.variantId || ""), "ProductVariant"))
        .filter(Boolean) as string[]
    )
  );

  let productMap: Record<string, any> = {};
  let variantMap: Record<string, any> = {};

  if (productIds.length || variantIds.length) {
    const gql = `#graphql
      query Lookup($productIds: [ID!]!, $variantIds: [ID!]!) {
        shop { currencyCode }

        products: nodes(ids: $productIds) {
          ... on Product {
            id
            title
            handle
            featuredImage { url altText }
          }
        }

        variants: nodes(ids: $variantIds) {
          ... on ProductVariant {
            id
            title
            sku
            image { url altText }
            product { id title handle }
            price
          }
        }
      }
    `;

    const resp = await admin.graphql(gql, {
      variables: { productIds, variantIds },
    });

    const json: any = await resp.json();

    const shopCurrency = json?.data?.shop?.currencyCode ?? null;

    const products = Array.isArray(json?.data?.products) ? json.data.products : [];
    const variants = Array.isArray(json?.data?.variants) ? json.data.variants : [];

    for (const p of products) {
      if (p?.id) productMap[p.id] = p;
    }

    for (const v of variants) {
      if (!v?.id) continue;

      // Your other code assumes v.price may be scalar -> normalize to {amount,currencyCode}
      const baseAmount = v?.price != null ? String(v.price) : null;
      const normalizedPrice =
        baseAmount && shopCurrency ? { amount: baseAmount, currencyCode: shopCurrency } : null;

      variantMap[v.id] = {
        ...v,
        price: normalizedPrice,
      };
    }
  }

  const data: LoaderData = {
    storeHandle,
    wishlist: {
      id: wl.id,
      name: wl.name,
      isArchived: wl.isArchived,
      createdAt: wl.createdAt.toISOString(),
      updatedAt: wl.updatedAt.toISOString(),
      customer: wl.customer
        ? {
            customerId: wl.customer.customerId,
            firstName: wl.customer.firstName ?? null,
            lastName: wl.customer.lastName ?? null,
            email: wl.customer.email ?? null,
          }
        : null,
      items: wl.items.map((it) => ({
        id: it.id,
        productId: String(it.productId),
        variantId: String(it.variantId),
        quantity: it.quantity,
        createdAt: it.createdAt?.toISOString?.() ?? undefined,
      })),
      latestSubmission: wl.submissions?.[0]
        ? {
            id: wl.submissions[0].id,
            status: wl.submissions[0].status,
            createdAt: wl.submissions[0].createdAt.toISOString(),
            draftOrderId: wl.submissions[0].draftOrderId,
          }
        : null,
    },
    lookup: { productMap, variantMap },
  };

  return data;
}

export default function WishlistDetailPage() {
  const data = useLoaderData() as LoaderData;

  const w = data.wishlist;
  const draftUrl =
    w.latestSubmission?.draftOrderId
      ? draftOrderAdminUrl(data.storeHandle, w.latestSubmission.draftOrderId)
      : null;

  return (
    <s-page>
      <s-section>
        <s-stack direction="inline" gap="base">
          <Link to="/app/wishlists">
            <s-button variant="secondary">Back</s-button>
          </Link>
          <s-heading>{w.name}</s-heading>
          {w.isArchived ? <s-text>(archived)</s-text> : null}
        </s-stack>

        <s-text>Customer: {displayCustomer(w.customer)}</s-text>
        <s-text>Created: {formatDateTimeGB(w.createdAt)}</s-text>

        {draftUrl ? (
          <s-stack direction="inline" gap="base">
            <a href={draftUrl} target="_blank" rel="noreferrer">
              <s-button variant="primary">Open draft order</s-button>
            </a>
            <s-text>Draft: {w.latestSubmission?.draftOrderId}</s-text>
          </s-stack>
        ) : (
          <s-text>No draft order submitted yet.</s-text>
        )}
      </s-section>

      <s-section>
        <s-heading>Items</s-heading>

        {w.items.length === 0 ? (
          <s-text>No items.</s-text>
        ) : (
          <s-stack direction="block" gap="base">
            {w.items.map((it) => {
              const pGid = normalizeGid(String(it.productId || ""), "Product")!;
              const vGid = normalizeGid(String(it.variantId || ""), "ProductVariant")!;

              const v = data.lookup.variantMap[vGid];
              const p = data.lookup.productMap[pGid];

              const title = v?.product?.title || p?.title || `Product ${it.productId}`;
              const variantTitle = v?.title && v.title !== "Default Title" ? v.title : null;

              const qty = Number(it.quantity || 1);
              const unitPrice: Money = v?.price ?? null;
              const priceText = formatMoney(unitPrice);

              const unitAmount = unitPrice?.amount != null ? Number(unitPrice.amount) : null;
              const lineTotal =
                unitAmount != null && unitPrice?.currencyCode
                  ? formatMoney({
                      amount: (unitAmount * qty).toFixed(2),
                      currencyCode: unitPrice.currencyCode,
                    })
                  : null;

              const imgUrl = getImageUrl(v, p);
              const alt = getAltText(v, p, title);

              return (
                <s-box key={it.id}>
                  <s-stack direction="block" gap="base">
                    <s-stack direction="inline" gap="base">
                      {imgUrl ? (
                        <s-box inlineSize="120px" blockSize="120px">
                          <s-image src={imgUrl} alt={alt} objectFit="cover" />
                        </s-box>
                      ) : (
                        <s-box inlineSize="120px" blockSize="120px">
                          <s-text>No image</s-text>
                        </s-box>
                      )}

                      <s-stack direction="block" gap="small-100">
                        <s-text>{title}</s-text>
                        {variantTitle ? <s-text>{variantTitle}</s-text> : null}
                        {priceText ? <s-text>Price: {priceText}</s-text> : null}
                        <s-text>Qty: {qty}</s-text>
                        {lineTotal ? <s-text>Total: {lineTotal}</s-text> : null}
                      </s-stack>
                    </s-stack>

                    <s-divider></s-divider>
                  </s-stack>
                </s-box>
              );
            })}
          </s-stack>
        )}
      </s-section>
    </s-page>
  );
}
