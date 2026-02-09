import type { LoaderFunctionArgs } from "react-router";
import crypto from "crypto";
import { prisma } from "../db.server";

function verifyProxy(url: URL, secret: string) {
  const params = new URLSearchParams(url.search);

  const signature = params.get("signature");
  if (!signature) return false;

  // Build a map of key -> list of values (to support repeated params)
  const map = new Map<string, string[]>();
  for (const [k, v] of params.entries()) {
    if (k === "signature") continue;
    const arr = map.get(k) ?? [];
    arr.push(v);
    map.set(k, arr);
  }

  // Turn into ["k=v1,v2", ...], sort, then JOIN WITH NO SEPARATOR
  const sortedParams = [...map.entries()]
    .map(([k, values]) => `${k}=${values.join(",")}`)
    .sort()
    .join("");

  const digest = crypto
    .createHmac("sha256", secret)
    .update(sortedParams)
    .digest("hex");

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

  const shopDomain = url.searchParams.get("shop");
  const shopifyCustomerId = url.searchParams.get("logged_in_customer_id");

  if (!shopDomain || !shopifyCustomerId) {
    return { wishlists: [] as Array<{ id: string; name: string; createdAt: string; updatedAt: string }> };
  }

  // Resolve Shop by domain string
  const shopRow = await prisma.shop.findUnique({
    where: { shop: shopDomain },
    select: { id: true },
  });
  if (!shopRow) return { wishlists: [] };

  // Resolve Customer by composite unique (shopId, customerId)
  const customerRow = await prisma.customer.findUnique({
    where: {
      shopId_customerId: {
        shopId: shopRow.id,
        customerId: shopifyCustomerId,
      },
    },
    select: { id: true },
  });
  if (!customerRow) return { wishlists: [] };

  // Fetch wishlists using internal Customer.id
  const wishlists = await prisma.wishlist.findMany({
    where: {
      shopId: shopRow.id,
      customerId: customerRow.id,
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
