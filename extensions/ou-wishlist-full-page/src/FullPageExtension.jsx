import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";

const API_BASE = "https://ou-wishlist-production.up.railway.app";

export default async () => {
  render(<Extension />, document.body);
};

function shopFromDest(dest) {
  if (!dest) return null;
  try {
    return new URL(dest).host;
  } catch {
    return String(dest).replace(/^https?:\/\//, "").replace(/\/$/, "");
  }
}

async function getShopFromSessionToken() {
  // customer account template exposes this
  const token = await shopify.sessionToken.get();
  const payload = JSON.parse(atob(token.split(".")[1]));
  return shopFromDest(payload?.dest);
}

function Extension() {
  const customerGid = shopify?.authenticatedAccount?.customer?.value?.id;

  const [out, setOut] = useState("idle");

  useEffect(() => {
    (async () => {
      try {
        const shopDomain = await getShopFromSessionToken();
        const url = `${API_BASE}/api/wishlists?shop=${encodeURIComponent(shopDomain || "")}`;

        const res = await fetch(url);
        const text = await res.text().catch(() => "");

        setOut(
          JSON.stringify(
            {
              shopDomain,
              status: res.status,
              ok: res.ok,
              bodyPreview: text.slice(0, 200),
              hasCustomerGid: Boolean(customerGid),
            },
            null,
            2
          )
        );
      } catch (e) {
        setOut(String(e));
      }
    })();
  }, []);

  return (
    <s-page>
      <s-section>
        <s-banner>
          <s-text>Customer: {customerGid ? "yes" : "no"}</s-text>
        </s-banner>
      </s-section>

      <s-section>
        <s-text>{out}</s-text>
      </s-section>
    </s-page>
  );
}
