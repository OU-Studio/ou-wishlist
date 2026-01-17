import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";

const API_BASE = "https://ou-wishlist-production.up.railway.app";

export default async () => {
  render(<Extension />, document.body);
};

function Extension() {
  const customerGid = shopify?.authenticatedAccount?.customer?.value?.id;
  const customerId = customerGid
    ? customerGid.replace("gid://shopify/Customer/", "")
    : null;

  const [status, setStatus] = useState("loading");
  const [count, setCount] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`${API_BASE}/api/wishlists`, { method: "GET" });
        const json = await res.json().catch(() => ({}));

        if (!res.ok) {
          throw new Error(json?.error || `Request failed (${res.status})`);
        }

        const n = Array.isArray(json.wishlists) ? json.wishlists.length : 0;
        setCount(n);
        setStatus("ok");
      } catch (e) {
        setError(String(e));
        setStatus("error");
      }
    })();
  }, []);

  return (
    <s-page>
      <s-section>
        <s-banner>
          <s-text>Customer ID: {customerId ?? "Not authenticated"}</s-text>
        </s-banner>
      </s-section>

      <s-section>
        {status === "loading" && <s-text>Loading wishlists…</s-text>}
        {status === "ok" && <s-text>Wishlists found: {count}</s-text>}
        {status === "error" && <s-text>Error: {error}</s-text>}
      </s-section>
    </s-page>
  );
}
