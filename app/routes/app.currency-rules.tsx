import { useEffect, useState } from "react";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";

type Rule = {
  id: string;
  countryCode: string;
  currency: string;
  updatedAt: string;
};

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);

  const res = await fetch(
    new URL(`/api/admin/market-currency-rules?shop=${encodeURIComponent(session.shop)}`, request.url),
    { headers: { Cookie: request.headers.get("Cookie") || "" } }
  );

  const data = await res.json();
  return data;
}

export default function CurrencyRulesPage() {
  const data = useLoaderData() as { rules: Rule[] };
  const fetcher = useFetcher();

  const [countryCode, setCountryCode] = useState("");
  const [currency, setCurrency] = useState("");

  const saving = fetcher.state !== "idle";

  function submitUpsert() {
    fetcher.submit(
      { intent: "upsert", countryCode: countryCode.trim(), currency: currency.trim() },
      { method: "post", action: "/api/admin/market-currency-rules" }
    );
  }

  function submitDelete(id: string) {
    fetcher.submit(
      { intent: "delete", id },
      { method: "post", action: "/api/admin/market-currency-rules" }
    );
  }

  return (
    <s-page heading="Currency rules">
      <s-section heading="Add / update rule">
        <s-stack direction="block" gap="base">
          <s-text-field
            label="Country code"
            value={countryCode}
            onChange={(v) => setCountryCode(String(v).toUpperCase())}
          />
          <s-text-field
            label="Currency"
            value={currency}
            onChange={(v) => setCurrency(String(v).toUpperCase())}
          />
          <s-button
            variant="primary"
            onClick={submitUpsert}
            {...(saving ? { loading: true } : {})}
          >
            Save rule
          </s-button>
        </s-stack>
      </s-section>

      <s-section heading="Existing rules">
        <s-stack direction="block" gap="base">
          {data.rules?.length ? (
            data.rules.map((r) => (
              <s-box
                key={r.id}
                padding="base"
                borderWidth="base"
                borderRadius="base"
              >
                <s-stack direction="inline" gap="base">
                  <s-text>
                    <strong>{r.countryCode}</strong> → {r.currency}
                  </s-text>
                  <s-button
                    variant="secondary"
                    onClick={() => {
                      setCountryCode(r.countryCode);
                      setCurrency(r.currency);
                    }}
                  >
                    Edit
                  </s-button>
                  <s-button
                    variant="secondary"
                    onClick={() => submitDelete(r.id)}
                  >
                    Delete
                  </s-button>
                </s-stack>
              </s-box>
            ))
          ) : (
            <s-text>No rules yet.</s-text>
          )}
        </s-stack>
      </s-section>
    </s-page>
  );
}
