import prisma from "../db.server";
import { getAdminAccessToken } from "../utils/shopToken.server"; // your refresh-capable helper

const ADMIN_API_VERSION = "2025-10";

export async function enrichCustomerProfile(shopDomain: string, shopId: string, customerId: string) {
  // Only enrich if missing
  const existing = await prisma.customer.findUnique({
    where: { shopId_customerId: { shopId, customerId } },
    select: { firstName: true, lastName: true, email: true },
  });

  if (existing?.email || existing?.firstName || existing?.lastName) return;

  const token = await getAdminAccessToken(shopDomain);
  if (!token) return; // can't enrich without offline token; admin needs to re-auth

  const customerGid = `gid://shopify/Customer/${customerId}`;

  const query = `#graphql
    query Customer($id: ID!) {
      customer(id: $id) {
        firstName
        lastName
        email
      }
    }
  `;

  const resp = await fetch(`https://${shopDomain}/admin/api/${ADMIN_API_VERSION}/graphql.json`, {
    method: "POST",
    headers: {
      "X-Shopify-Access-Token": token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables: { id: customerGid } }),
  });

  const json = await resp.json().catch(() => null);
  const c = json?.data?.customer;

  if (!c) return;

  await prisma.customer.update({
    where: { shopId_customerId: { shopId, customerId } },
    data: {
      firstName: c.firstName ?? null,
      lastName: c.lastName ?? null,
      email: c.email ?? null,
    },
  });
}
