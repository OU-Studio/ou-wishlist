// app/routes/app.wishlists.$id.tsx
import type { LoaderFunctionArgs } from "react-router";
import { Link, useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import { prisma } from "../db.server";

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
};

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
  if (name) return `${name} • #${c.customerId}`;
  if (c.email) return `${c.email} • #${c.customerId}`;
  return `#${c.customerId}`;
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);

  const wishlistId = params.id;
  if (!wishlistId) {
    throw new Response("Missing quotation id", { status: 400 });
  }

  const storeHandle = String(session.shop || "").split(".")[0] || "unknown";

  const shopRow = await prisma.shop.findUnique({
    where: { shop: session.shop },
    select: { id: true },
  });

  if (!shopRow) {
    throw new Response("Shop not found", { status: 404 });
  }

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
          // remove if your schema doesn’t have them
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

  if (!wl) {
    throw new Response("quotation not found", { status: 404 });
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
            firstName: (wl.customer as any).firstName ?? null,
            lastName: (wl.customer as any).lastName ?? null,
            email: (wl.customer as any).email ?? null,
          }
        : null,
      items: wl.items.map((it) => ({
        id: it.id,
        productId: it.productId,
        variantId: it.variantId,
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
          <s-unordered-list>
            {w.items.map((it) => (
              <s-list-item key={it.id}>
                <s-stack direction="block" gap="base">
                  <s-text>
                    Variant: <strong>{it.variantId}</strong>
                  </s-text>
                  <s-text>Product: {it.productId}</s-text>
                  <s-text>Qty: {it.quantity}</s-text>
                </s-stack>
              </s-list-item>
            ))}
          </s-unordered-list>
        )}
      </s-section>
    </s-page>
  );
}
