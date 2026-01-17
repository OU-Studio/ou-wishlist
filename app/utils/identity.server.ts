import prisma from "../db.server";
import { authenticate } from "../shopify.server";

function shopFromDest(dest?: string | null): string | null {
  if (!dest) return null;
  try {
    return new URL(dest).host;
  } catch {
    return String(dest).replace(/^https?:\/\//, "").replace(/\/$/, "");
  }
}

function shopFromQuery(request: Request): string | null {
  try {
    const url = new URL(request.url);
    const raw = url.searchParams.get("shop");
    if (!raw) return null;

    const s = raw.trim().toLowerCase();
    if (!s) return null;

    // accept outesting1.myshopify.com OR outesting1
    return s.includes(".") ? s : `${s}.myshopify.com`;
  } catch {
    return null;
  }
}

export type CustomerIdentity = {
  type: "customer";
  shop: any;
  customer: any;
  cors: (res: Response) => Response;
};

export type AdminIdentity = {
  type: "admin";
  shop: any;
  customer: any;
  admin: any;
};

export async function resolveCustomerIdentity(request: Request): Promise<CustomerIdentity> {
  const { sessionToken, cors } = await authenticate.public.customerAccount(request);

  const shopDomain =
    shopFromDest((sessionToken as any).dest) || shopFromQuery(request);

  if (!shopDomain) {
    throw new Error("Missing shop (token.dest empty and no ?shop=)");
  }

  const customerGid =
    typeof (sessionToken as any).sub === "string" ? ((sessionToken as any).sub as string) : null;

  if (!customerGid) {
    // TEMP: log the token shape so we can see what claims exist (don’t log full JWT)
    console.log("[customerAccount token keys]", Object.keys(sessionToken as any));
    console.log("[customerAccount token]", {
      iss: (sessionToken as any).iss,
      dest: (sessionToken as any).dest,
      aud: (sessionToken as any).aud,
      sub: (sessionToken as any).sub,
    });

    throw new Error("Missing customer id in token (token.sub not present)");
  }

  const customerId = customerGid.replace("gid://shopify/Customer/", "");

  const shop = await prisma.shop.upsert({
    where: { shop: shopDomain },
    update: {},
    create: { shop: shopDomain },
  });

  const customer = await prisma.customer.upsert({
    where: { shopId_customerId: { shopId: shop.id, customerId } },
    update: {},
    create: { shopId: shop.id, customerId },
  });

  return { type: "customer", shop, customer, cors };
}


export async function resolveAdminIdentity(
  request: Request
): Promise<AdminIdentity> {
  const { session, admin } = await authenticate.admin(request);

  const shop = await prisma.shop.upsert({
    where: { shop: session.shop },
    update: {},
    create: { shop: session.shop },
  });

  const userId = session.onlineAccessInfo?.associated_user?.id;
  const customerKey = userId ? String(userId) : `offline:${session.shop}`;
  const user = session.onlineAccessInfo?.associated_user;

  const customer = await prisma.customer.upsert({
    where: { shopId_customerId: { shopId: shop.id, customerId: customerKey } },
    update: {
      email: user?.email ?? undefined,
      firstName: user?.first_name ?? undefined,
      lastName: user?.last_name ?? undefined,
    },
    create: {
      shopId: shop.id,
      customerId: customerKey,
      email: user?.email ?? null,
      firstName: user?.first_name ?? null,
      lastName: user?.last_name ?? null,
    },
  });

  return { type: "admin", shop, customer, admin };
}
