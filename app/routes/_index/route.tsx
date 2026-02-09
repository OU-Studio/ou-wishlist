import type { LoaderFunctionArgs } from "react-router";
import { redirect, useLoaderData } from "react-router";
import { WishlistPage } from "../../components/WishlistPage";

import { login } from "../../shopify.server";

import styles from "./styles.module.css";

const API_BASE = "https://studio-ore-quote.up.railway.app"; // or your own origin



async function getWishlistsSSR(shop: string, customerId: string | null) {
  // This assumes your API allows shop/customerId without bearer token.
  // If it doesn't, this request will fail and we’ll switch to a proxy-safe endpoint next.
  const u = new URL(`${API_BASE}/api/wishlists`);
  u.searchParams.set("shop", shop);
  if (customerId) u.searchParams.set("customerId", customerId);

  const res = await fetch(u.toString(), { headers: { Accept: "application/json" } });
  const text = await res.text();

  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }

  if (!res.ok) {
    const msg =
      data?.error ||
      data?.message ||
      `Wishlists request failed (${res.status})`;
    throw new Response(msg, { status: res.status });
  }

  // Adjust depending on your response shape
  return Array.isArray(data?.wishlists) ? data.wishlists : (Array.isArray(data) ? data : []);
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  const pathPrefix = url.searchParams.get("path_prefix") || "";
  const isAppProxy = pathPrefix.startsWith("/apps/quote");

  if (isAppProxy) {
    const shop = url.searchParams.get("shop");
    if (!shop) throw new Response("Missing shop", { status: 400 });

    const customerId = url.searchParams.get("logged_in_customer_id");

    let wishlists: any[] = [];
    let error: string | null = null;

    try {
      wishlists = await getWishlistsSSR(shop, customerId);
    } catch (e: any) {
      error = e?.message || "Failed to load wishlists";
    }

    return {
      isAppProxy: true,
      shop,
      customerId,
      wishlists,
      error,
    };
  }

  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return { showForm: Boolean(login), isAppProxy: false };
};

export default function App() {
  const data = useLoaderData<typeof loader>();

  if ((data as any).isAppProxy) {
    const d = data as any;

    return (
      <div style={{ padding: 24, maxWidth: 900, margin: "0 auto" }}>
        <h1>Wishlists</h1>

        {!d.customerId && <p>You must be logged in to view wishlists.</p>}

        {d.error && <p style={{ color: "crimson" }}>{d.error}</p>}

        {!d.error && (
          <ul>
            {(d.wishlists || []).map((w: any) => (
              <li key={w.id}>
                <strong>{w.name ?? w.title ?? w.id}</strong>
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }

  return (
    <div className={styles.index}>

    </div>
  );
}
