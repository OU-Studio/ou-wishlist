import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";

const API_BASE = "https://ou-wishlist-production.up.railway.app";

export default async () => {
  render(<Extension />, document.body);
};

function Extension() {
  const [out, setOut] = useState("idle");

  const customerGid = shopify?.authenticatedAccount?.customer?.value?.id;
  const customerId = customerGid
    ? customerGid.replace("gid://shopify/Customer/", "")
    : null;

  const [status, setStatus] = useState("loading");
  const [count, setCount] = useState(null);
  const [error, setError] = useState(null);

 useEffect(() => {
  if (!customerGid) return;

  (async () => {
    try {
      const res = await fetch(`${API_BASE}/api/wishlists`, { method: "GET" });

      const text = await res.text().catch(() => "");
      const preview = text.slice(0, 200);

      setOut(JSON.stringify(
        { status: res.status, ok: res.ok, bodyPreview: preview },
        null,
        2
      ));
    } catch (e) {
      setOut(String(e));
    }
  })();
}, [customerGid]);


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

      <s-text>{out}</s-text>
    </s-page>
  );
}
