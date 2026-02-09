import type { LoaderFunctionArgs } from "react-router";
import crypto from "crypto";
import { prisma } from "../db.server";


function rfc3986Encode(input: string) {
  return encodeURIComponent(input).replace(/[!'()*]/g, (c) =>
    "%" + c.charCodeAt(0).toString(16).toUpperCase()
  );
}

function verifyProxy(url: URL, secret: string) {
  const params = new URLSearchParams(url.search);
  const signature = params.get("signature");
  if (!signature) return false;

  params.delete("signature");

  const message = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${rfc3986Encode(k)}=${rfc3986Encode(v)}`)
    .join("&");

  const digest = crypto.createHmac("sha256", secret).update(message).digest("hex");

  if (digest.length !== signature.length) return false;
  return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(signature));
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  const secret = process.env.SHOPIFY_API_SECRET;
  if (!secret) {
    throw new Response("Server misconfigured: missing SHOPIFY_API_SECRET", { status: 500 });
  }

  if (!verifyProxy(url, secret)) {
    throw new Response("Invalid proxy signature", { status: 401 });
  }

  const shopDomain = url.searchParams.get("shop"); // e.g. studio-ore.myshopify.com
  const shopifyCustomerId = url.searchParams.get("logged_in_customer_id"); // Shopify customer ID (string)

  if (!shopDomain || !shopifyCustomerId) {
    return { wishlists: [] as Array<{ id: string; name: string; createdAt: string; updatedAt: string }> };
  }

  // 1) Resolve Shop row by domain string (Shop.shop)
  const shopRow = await prisma.shop.findUnique({
    where: { shop: shopDomain },
    select: { id: true },
  });

  if (!shopRow) {
    return { wishlists: [] as Array<{ id: string; name: string; createdAt: string; updatedAt: string }> };
  }

  // 2) Resolve Customer row by composite unique key (shopId, customerId)
  //    Customer.customerId is the Shopify customer ID string
  const customerRow = await prisma.customer.findUnique({
    where: {
      shopId_customerId: {
        shopId: shopRow.id,
        customerId: shopifyCustomerId,
      },
    },
    select: { id: true },
  });

  if (!customerRow) {
    return { wishlists: [] as Array<{ id: string; name: string; createdAt: string; updatedAt: string }> };
  }

  // 3) Fetch wishlists by shopId and internal customer PK (Customer.id)
  const wishlists = await prisma.wishlist.findMany({
    where: {
      shopId: shopRow.id,
      customerId: customerRow.id, // internal Customer.id (cuid)
      isArchived: false,
    },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      name: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  return { wishlists };
};
