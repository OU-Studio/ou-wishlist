import prisma from "../../db.server";
import { authenticate } from "../../shopify.server";

function bad(msg: string, status = 400) {
  return Response.json({ error: msg }, { status });
}

export async function loader({ request }: { request: Request }) {
  const { session } = await authenticate.admin(request);

  const shop = await prisma.shop.upsert({
    where: { shop: session.shop },
    update: {},
    create: { shop: session.shop },
  });

  const rules = await prisma.marketCurrencyRule.findMany({
    where: { shopId: shop.id },
    orderBy: { countryCode: "asc" },
    select: { id: true, countryCode: true, currency: true, updatedAt: true },
  });

  return Response.json({ rules });
}

export async function action({ request }: { request: Request }) {
  const { session } = await authenticate.admin(request);

  const shop = await prisma.shop.upsert({
    where: { shop: session.shop },
    update: {},
    create: { shop: session.shop },
  });

  const body = await request.json().catch(() => null);
  if (!body) return bad("Invalid JSON");

  const countryCode = String(body.countryCode || "").trim().toUpperCase();
  const currency = String(body.currency || "").trim().toUpperCase();

  if (!countryCode || countryCode.length !== 2) return bad("countryCode must be ISO-2 (e.g. CA)");
  if (!currency || currency.length !== 3) return bad("currency must be ISO-3 (e.g. USD)");

  if (request.method === "POST" || request.method === "PUT") {
    const rule = await prisma.marketCurrencyRule.upsert({
      where: { shopId_countryCode: { shopId: shop.id, countryCode } }, 
      update: { currency },
      create: { shopId: shop.id, countryCode, currency },
      select: { id: true, countryCode: true, currency: true, updatedAt: true },
    });
    return Response.json({ rule }, { status: 200 });
  }

  if (request.method === "DELETE") {
    await prisma.marketCurrencyRule.deleteMany({ 
      where: { shopId: shop.id, countryCode },
    });
    return Response.json({ ok: true }, { status: 200 });
  }

  return bad("Method not allowed", 405);
}
