import type { LoaderFunctionArgs } from "react-router";
import { Form, Link, useLoaderData, useSearchParams } from "react-router";
import { authenticate } from "../shopify.server";
import { prisma } from "../db.server";


type LoaderData = {
  q: string;
  status: "active" | "archived" | "all";
  sort: "created" | "name";
  page: number;
  pageSize: number;
  total: number;
  storeHandle: string; // from myshopify subdomain
  rows: Array<{
    id: string;
    name: string;
    isArchived: boolean;
    createdAt: string;
    itemCount: number;
    customer: {
      id: string;
      customerId: string;
      // If your schema has these, they’ll show; otherwise it’ll just fall back to ID.
      firstName?: string | null;
      lastName?: string | null;
      email?: string | null;
    } | null;
    latestSubmission: {
      id: string;
      status: string;
      draftOrderId: string | null;
    } | null;
  }>;
};

function clampInt(v: string | null, fallback: number, min = 1, max = 10_000) {
  const n = Number.parseInt(String(v ?? ""), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function formatDateGB(iso: string) {
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

function draftOrderAdminUrl(storeHandle: string, draftOrderGid: string) {
  // gid://shopify/DraftOrder/1209432670464 -> 1209432670464
  const numericId = String(draftOrderGid).split("/").pop();
  return `https://admin.shopify.com/store/${storeHandle}/draft_orders/${numericId}`;
}

function displayCustomer(c: LoaderData["rows"][number]["customer"]) {
  if (!c) return "—";
  const name = [c.firstName, c.lastName].filter(Boolean).join(" ").trim();
  if (name && c.email) return `${name} • ${c.email}`;
  if (name) return name;
  if (c.email) return c.email;
  return "—";
}


export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);

  const q = (url.searchParams.get("q") || "").trim();
  const status = (url.searchParams.get("status") || "active") as LoaderData["status"];
  const sort = (url.searchParams.get("sort") || "created") as LoaderData["sort"];

  const page = clampInt(url.searchParams.get("page"), 1);
  const pageSize = clampInt(url.searchParams.get("pageSize"), 25, 5, 100);
  const skip = (page - 1) * pageSize;
  const take = pageSize;

  const storeHandle = String(session.shop || "").split(".")[0] || "unknown";

  const shopRow = await prisma.shop.findUnique({
    where: { shop: session.shop },
    select: { id: true },
  });

  if (!shopRow) {
    return {
      q,
      status,
      sort,
      page,
      pageSize,
      total: 0,
      rows: [],
      storeHandle,
    } satisfies LoaderData;
  }

  const where: any = { shopId: shopRow.id };

  if (status === "active") where.isArchived = false;
  if (status === "archived") where.isArchived = true;

  if (q) {
    where.OR = [
      { name: { contains: q, mode: "insensitive" } },
      { customer: { customerId: { contains: q, mode: "insensitive" } } },
      // keep these if your schema has them
      { customer: { email: { contains: q, mode: "insensitive" } } },
      { customer: { firstName: { contains: q, mode: "insensitive" } } },
      { customer: { lastName: { contains: q, mode: "insensitive" } } },
    ];
  }

  const orderBy =
    sort === "name"
      ? [{ name: "asc" as const }, { createdAt: "desc" as const }]
      : [{ createdAt: "desc" as const }];

  const [total, wishlists] = await Promise.all([
    prisma.wishlist.count({ where }),
    prisma.wishlist.findMany({
      where,
      orderBy,
      skip,
      take,
      select: {
        id: true,
        name: true,
        isArchived: true,
        createdAt: true,
        _count: { select: { items: true } },
        customer: {
          select: {
            id: true,
            customerId: true,
            // If your schema doesn’t have these, remove them
            firstName: true,
            lastName: true,
            email: true,
          },
        },
        submissions: {
          orderBy: { createdAt: "desc" },
          take: 1,
          select: {
            id: true,
            status: true,
            draftOrderId: true,
          },
        },
      },
    }),
  ]);

  const rows: LoaderData["rows"] = wishlists.map((w) => ({
    id: w.id,
    name: w.name,
    isArchived: w.isArchived,
    createdAt: w.createdAt.toISOString(),
    itemCount: w._count.items,
    customer: w.customer
      ? {
          id: w.customer.id,
          customerId: w.customer.customerId,
          firstName: (w.customer as any).firstName ?? null,
          lastName: (w.customer as any).lastName ?? null,
          email: (w.customer as any).email ?? null,
        }
      : null,
    latestSubmission: w.submissions?.[0]
      ? {
          id: w.submissions[0].id,
          status: w.submissions[0].status,
          draftOrderId: w.submissions[0].draftOrderId,
        }
      : null,
  }));

  return {
    q,
    status,
    sort,
    page,
    pageSize,
    total,
    rows,
    storeHandle,
  } satisfies LoaderData;
}

export default function WishlistsAdminPage() {
  const data = useLoaderData() as LoaderData;
  const [sp] = useSearchParams();

  const totalPages = Math.max(1, Math.ceil(data.total / data.pageSize));

  function pageLink(nextPage: number) {
    const u = new URLSearchParams(sp);
    u.set("page", String(nextPage));
    return `?${u.toString()}`;
  }

  return (
    <s-page>
      <s-section>
        <s-heading>Quotations</s-heading>

        <Form method="get">
          <s-stack direction="block" gap="base">
            <s-text-field label="Search" name="q" value={data.q} />

            <s-stack direction="inline" gap="base">
              <label>
                <span style={{ display: "block", marginBottom: 6 }}>Status</span>
                <select name="status" defaultValue={data.status}>
                  <option value="active">Active</option>
                  <option value="archived">Archived</option>
                  <option value="all">All</option>
                </select>
              </label>

              <label>
                <span style={{ display: "block", marginBottom: 6 }}>Sort</span>
                <select name="sort" defaultValue={data.sort}>
                  <option value="created">Newest</option>
                  <option value="name">Name (A–Z)</option>
                </select>
              </label>

              <label>
                <span style={{ display: "block", marginBottom: 6 }}>Page size</span>
                <select name="pageSize" defaultValue={String(data.pageSize)}>
                  <option value="10">10</option>
                  <option value="25">25</option>
                  <option value="50">50</option>
                  <option value="100">100</option>
                </select>
              </label>

              <input type="hidden" name="page" value="1" />
              <s-button variant="primary" type="submit">
                Apply
              </s-button>
            </s-stack>

            <s-text>
              {data.total} total • Page {data.page} of {totalPages}
            </s-text>
          </s-stack>
        </Form>
      </s-section>

      <s-section>
        {data.rows.length === 0 ? (
          <s-text>No quotations found.</s-text>
        ) : (
          <s-unordered-list>
            {data.rows.map((w) => {
              const draftOrderLink =
                w.latestSubmission?.draftOrderId
                  ? draftOrderAdminUrl(data.storeHandle, w.latestSubmission.draftOrderId)
                  : null;

              return (
                <s-list-item key={w.id}>
                  <s-stack direction="block" gap="base">
                    <s-stack direction="inline" gap="base">
                      <s-text>
                        <strong>{w.name}</strong> {w.isArchived ? <span>(archived)</span> : null}
                      </s-text>
                      <s-text>• {w.itemCount} items</s-text>
                      <s-text>• Created {formatDateGB(w.createdAt)}</s-text>
                    </s-stack>

                    <s-text>Customer: {displayCustomer(w.customer)}</s-text>

                    <s-stack direction="inline" gap="base">
                      <Link to={`/app/wishlists/${w.id}`}>
                        <s-button variant="secondary">View</s-button>
                      </Link>

                      {/* Only show if submitted AND has draftOrderId */}
                      {draftOrderLink ? (
                        <a href={draftOrderLink} target="_blank" rel="noreferrer">
                          <s-button variant="primary">Open draft order</s-button>
                        </a>
                      ) : null}
                    </s-stack>
                  </s-stack>
                </s-list-item>
              );
            })}
          </s-unordered-list>
        )}
      </s-section>

      <s-section>
        <s-stack direction="inline" gap="base">
          <Link to={pageLink(Math.max(1, data.page - 1))} aria-disabled={data.page <= 1}>
            <s-button variant="secondary" disabled={data.page <= 1}>
              Prev
            </s-button>
          </Link>

          <Link to={pageLink(Math.min(totalPages, data.page + 1))} aria-disabled={data.page >= totalPages}>
            <s-button variant="secondary" disabled={data.page >= totalPages}>
              Next
            </s-button>
          </Link>
        </s-stack>
      </s-section>
    </s-page>
  );
}
