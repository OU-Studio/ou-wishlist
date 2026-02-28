import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { prisma } from "../db.server";
import { authenticate } from "../shopify.server";

// optionally assert session.shop === shopDomain

async function resolveShopAndCustomer(shopDomain: string, shopifyCustomerId: string) {
  const shopRow = await prisma.shop.findUnique({
    where: { shop: shopDomain },
    select: { id: true },
  });
  if (!shopRow) return null;

  const customerRow = await prisma.customer.findUnique({
    where: {
      shopId_customerId: { shopId: shopRow.id, customerId: shopifyCustomerId },
    },
    select: { id: true },
  });
  if (!customerRow) return null;

  return { shopId: shopRow.id, customerPk: customerRow.id };
}

async function getOfflineAccessToken(shopDomain: string) {
  // Shopify session storage typically has an offline session with isOnline=false
  const sess = await prisma.session.findFirst({
    where: { shop: shopDomain, isOnline: false },
    select: { accessToken: true },
  });
  return sess?.accessToken || null;
}

function toCustomerGid(raw: string) {
  const s = String(raw || "").trim();
  if (!s) return null;
  if (s.startsWith("gid://")) return s;
  if (/^\d+$/.test(s)) return `gid://shopify/Customer/${s}`;
  return s;
}

async function createDraftOrder(opts: {
  shopDomain: string;
  accessToken: string;
  customerGid: string | null;
  note: string | null;
  lineItems: Array<{ variantId: string; quantity: number }>;
}) {
  const mutation = `
    mutation DraftOrderCreate($input: DraftOrderInput!) {
      draftOrderCreate(input: $input) {
        draftOrder {
          id
          invoiceUrl
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const input: any = {
    lineItems: opts.lineItems.map((li) => ({
      variantId: li.variantId,
      quantity: li.quantity,
    })),
  };

  // Attach customer + note if available
  if (opts.customerGid) input.customerId = opts.customerGid;
  if (opts.note) input.note = opts.note;

  const res = await fetch(`https://${opts.shopDomain}/admin/api/2024-10/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": opts.accessToken,
    },
    body: JSON.stringify({ query: mutation, variables: { input } }),
  });

  const text = await res.text().catch(() => "");
  const json = text ? JSON.parse(text) : null;

  if (!res.ok) {
    throw new Error(`Draft order create failed (${res.status}): ${text || "no body"}`);
  }

  const payload = json?.data?.draftOrderCreate;
  const errs = payload?.userErrors || [];
  if (errs.length) {
    throw new Error(errs.map((e: any) => e.message).join(" | "));
  }

  const draftOrder = payload?.draftOrder;
  if (!draftOrder?.id) throw new Error("Draft order not returned");

  return { id: draftOrder.id as string, invoiceUrl: draftOrder.invoiceUrl as string | null };
}

type Snapshot = {
  title: string | null;
  handle: string | null;
  variantTitle: string | null;
  sku: string | null;
  price: string | null;
  imageUrl: string | null;
};

async function fetchVariantSnapshots(shopDomain: string, accessToken: string, variantIds: string[]) {
  const query = `
    query Variants($ids: [ID!]!) {
      nodes(ids: $ids) {
        ... on ProductVariant {
          id
          title
          sku
          price
          image { url }
          product {
            title
            handle
            featuredImage { url }
          }
        }
      }
    }
  `;

  const res = await fetch(`https://${shopDomain}/admin/api/2024-10/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": accessToken,
    },
    body: JSON.stringify({ query, variables: { ids: variantIds } }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Shopify lookup failed (${res.status}): ${text || "no body"}`);
  }

  const json = await res.json();
  const nodes = json?.data?.nodes || [];

  const map = new Map<string, Snapshot>();
  for (const v of nodes) {
    if (!v?.id) continue;
    map.set(v.id, {
      title: v.product?.title ?? null,
      handle: v.product?.handle ?? null,
      variantTitle: v.title ?? null,
      sku: v.sku ?? null,
      price: v.price ?? null,
      imageUrl: v.image?.url ?? v.product?.featuredImage?.url ?? null,
    });
  }

  return map;
}

function needsBackfill(it: {
  title: string | null;
  handle: string | null;
  imageUrl: string | null;
  variantTitle: string | null;
  sku: string | null;
  price: string | null;
}) {
  return (
    !it.title ||
    !it.handle ||
    !it.imageUrl ||
    !it.variantTitle ||
    !it.sku ||
    !it.price
  );
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  const shopDomain = url.searchParams.get("shop");
  const shopifyCustomerId = url.searchParams.get("cid");
  const wishlistId = url.searchParams.get("wishlistId");

  if (!shopDomain || !shopifyCustomerId || !wishlistId) {
    return { wishlist: null, items: [] };
  }

  const resolved = await resolveShopAndCustomer(shopDomain, shopifyCustomerId);
  if (!resolved) return { wishlist: null, items: [] };

  const wishlist = await prisma.wishlist.findFirst({
    where: {
      id: wishlistId,
      shopId: resolved.shopId,
      customerId: resolved.customerPk,
      isArchived: false,
    },
    select: { id: true, name: true, createdAt: true },
  });

  if (!wishlist) return { wishlist: null, items: [] };

  const items = await prisma.wishlistItem.findMany({
    where: { wishlistId: wishlist.id },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      productId: true,
      variantId: true,
      quantity: true,
      title: true,
      variantTitle: true,
      handle: true,
      sku: true,
      imageUrl: true,
      price: true,
    },
  });

  // --- Lazy backfill for older items with missing snapshot fields ---
  const missing = items.filter(needsBackfill);
  if (missing.length) {
    const accessToken = await getOfflineAccessToken(shopDomain);

    // If no token available, just return what we have (page will still work, but without snapshots)
    if (accessToken) {
      // Shopify nodes() can take many IDs; keep it conservative
      const ids = [...new Set(missing.map((m) => m.variantId))].slice(0, 80);

      try {
        const snapshotByVariantId = await fetchVariantSnapshots(shopDomain, accessToken, ids);

        // Update DB rows that are missing data
        const updates = missing.map((it) => {
          const snap = snapshotByVariantId.get(it.variantId);
          if (!snap) return null;

          return prisma.wishlistItem.update({
            where: { id: it.id },
            data: {
              title: snap.title,
              handle: snap.handle,
              variantTitle: snap.variantTitle,
              sku: snap.sku,
              price: snap.price,
              imageUrl: snap.imageUrl,
            },
          });
        }).filter(Boolean) as any[];

        if (updates.length) {
          await prisma.$transaction(updates);
        }

        // Merge snapshots into the response (no need to re-query)
        for (const it of items) {
          if (!needsBackfill(it)) continue;
          const snap = snapshotByVariantId.get(it.variantId);
          if (!snap) continue;

          it.title = snap.title;
          it.handle = snap.handle;
          it.variantTitle = snap.variantTitle;
          it.sku = snap.sku;
          it.price = snap.price;
          it.imageUrl = snap.imageUrl;
        }
      } catch {
        // Swallow lookup failures; return base items so the page still loads
      }
    }
  }

  return { wishlist, items };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const auth = await authenticate.public.appProxy(request).catch(() => null);
  const session = auth?.session;

  if (!session?.shop || !session?.accessToken) {
    return { ok: false, error: "Unauthorized app proxy request" };
  }

  const shopDomain = session.shop;

  if (request.method.toUpperCase() !== "POST") {
    throw new Response("Method Not Allowed", { status: 405 });
  }

  const url = new URL(request.url);
  const shopifyCustomerId = url.searchParams.get("cid");

  if (!shopDomain || !shopifyCustomerId) {
    throw new Response("Missing shop/cid", { status: 400 });
  }

  const resolved = await resolveShopAndCustomer(shopDomain, shopifyCustomerId);
  if (!resolved) return { ok: false, error: "Customer not found" };

  let body: any = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  const op = String(body?.op || "");
  const wishlistId = String(body?.wishlistId || "");
  if (!op || !wishlistId) return { ok: false, error: "Missing op/wishlistId" };

  // Ensure wishlist belongs to this customer + shop
  const wishlist = await prisma.wishlist.findFirst({
    where: {
      id: wishlistId,
      shopId: resolved.shopId,
      customerId: resolved.customerPk,
      isArchived: false,
    },
    select: { id: true, name: true },
  });

  if (!wishlist) return { ok: false, error: "Wishlist not found" };

  if (op === "rename") {
    const newName = String(body?.name || "").trim();
    if (!newName) return { ok: false, error: "Name required" };

    await prisma.wishlist.update({
      where: { id: wishlist.id },
      data: { name: newName },
    });

    return { ok: true };
  }

  if (op === "delete") {
    await prisma.wishlist.update({
      where: { id: wishlist.id },
      data: { isArchived: true },
    });

    return { ok: true };
  }

  if (op === "itemUpdate") {
    const itemId = String(body?.itemId || "");
    const qtyRaw = body?.quantity;
    const quantity = Math.max(1, Number(qtyRaw || 1) | 0);

    if (!itemId) return { ok: false, error: "Missing itemId" };

    // Ensure item belongs to wishlist
    const updated = await prisma.wishlistItem.updateMany({
      where: { id: itemId, wishlistId: wishlist.id },
      data: { quantity },
    });

    if (!updated.count) return { ok: false, error: "Item not found" };
    return { ok: true };
  }

  if (op === "itemRemove") {
    const itemId = String(body?.itemId || "");
    if (!itemId) return { ok: false, error: "Missing itemId" };

    // Ensure item belongs to wishlist
    const deleted = await prisma.wishlistItem.deleteMany({
      where: { id: itemId, wishlistId: wishlist.id },
    });

    if (!deleted.count) return { ok: false, error: "Item not found" };
    return { ok: true };
  }

    if (op === "submit") {
    const note = typeof body?.note === "string" ? body.note.trim() : null;

    // Create submission record first
    const submission = await prisma.wishlistSubmission.create({
      data: {
        shopId: resolved.shopId,
        wishlistId: wishlist.id,
        customerId: resolved.customerPk,
        status: "created",
        note: note || null,
      },
      select: { id: true, status: true },
    });

    try {
      // Pull items
      const items = await prisma.wishlistItem.findMany({
        where: { wishlistId: wishlist.id },
        select: { variantId: true, quantity: true },
      });

      if (!items.length) {
        await prisma.wishlistSubmission.update({
          where: { id: submission.id },
          data: { status: "failed", note: note || "Wishlist empty" },
        });
        return { ok: false, error: "Wishlist has no items" };
      }

      // Need offline token to call Admin API
      const accessToken = session.accessToken;
      if (!accessToken) {
        await prisma.wishlistSubmission.update({
          where: { id: submission.id },
          data: { status: "failed", note: note || "Missing offline token" },
        });
        return { ok: false, error: "Missing app access token" };
      }

      const customerGid = toCustomerGid(shopifyCustomerId); // cid is numeric string -> Customer GID

      const draft = await createDraftOrder({
        shopDomain,
        accessToken,
        customerGid,
        note,
        lineItems: items.map((it) => ({
          variantId: it.variantId,
          quantity: Math.max(1, Number(it.quantity) | 0),
        })),
      });

      // Persist draft order id
      await prisma.wishlistSubmission.update({
        where: { id: submission.id },
        data: {
          draftOrderId: draft.id,
          status: "created",
        },
      });

      return { ok: true, submissionId: submission.id, draftOrderId: draft.id, invoiceUrl: draft.invoiceUrl };
    } catch (e: any) {
      const msg = String(e?.message || e || "Submit failed");

      await prisma.wishlistSubmission.update({
        where: { id: submission.id },
        data: { status: "failed", note: note ? `${note}\n\n${msg}` : msg },
      });

      return { ok: false, error: msg };
    }
  }

  return { ok: false, error: "Unknown op" };
};