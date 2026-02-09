import type { LoaderFunctionArgs } from "react-router";
import { redirect, useLoaderData } from "react-router";
import { WishlistPage } from "../../components/WishlistPage";

import { login } from "../../shopify.server";

import styles from "./styles.module.css";

const API_BASE = "https://studio-ore-quote.up.railway.app"; // or your own origin



async function getWishlistsSSR(request: Request) {
  const proxyApiUrl = new URL(request.url);

  // IMPORTANT: must match your proxy-api route filename
  proxyApiUrl.pathname = "/proxy-api/wishlists";

  const res = await fetch(proxyApiUrl.toString(), {
    headers: { Accept: "application/json" },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `Proxy wishlist fetch failed (${res.status})`);
  }

  const data = await res.json();
  return Array.isArray(data?.wishlists) ? data.wishlists : [];
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
      wishlists = await getWishlistsSSR(request);
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
