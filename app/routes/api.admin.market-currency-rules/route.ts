import prisma from "../../db.server";
import { authenticate } from "../../shopify.server";

function json(data: unknown, status = 200) {
  return Response.json(data, { status });
}

function asString(v: FormDataEntryValue | null) {
  return typeof v === "string" ? v : "";
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
    orderBy: { updatedAt: "desc" },
    select: { id: true, countryCode: true, currency: true, updatedAt: true },
  });

  return json({ rules });
}

export async function action({ request }: { request: Request }) {
  const { session } = await authenticate.admin(request);

  const shop = await prisma.shop.upsert({
    where: { shop: session.shop },
    update: {},
    create: { shop: session.shop },
  });

  const form = await request.formData();
  const intent = asString(form.get("intent"));

  if (intent === "upsert") {
    const countryCode = asString(form.get("countryCode")).trim().toUpperCase();
    const currency = asString(form.get("currency")).trim().toUpperCase();

    if (countryCode.length !== 2) return json({ error: "countryCode must be ISO-2" }, 400);
    if (currency.length !== 3) return json({ error: "currency must be ISO-3" }, 400);

    const rule = await prisma.marketCurrencyRule.upsert({
      where: { shopId_countryCode: { shopId: shop.id, countryCode } },
      update: { currency },
      create: { shopId: shop.id, countryCode, currency },
      select: { id: true, countryCode: true, currency: true, updatedAt: true },
    });

    return json({ ok: true, rule });
  }

  if (intent === "delete") {
    const id = asString(form.get("id")).trim();
    if (!id) return json({ error: "Missing id" }, 400);

    await prisma.marketCurrencyRule.delete({
      where: { id },
    });

    return json({ ok: true });
  }

  return json({ error: "Unknown intent" }, 400);
}
