import { useMemo, useState } from "react";
import type { LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

type Rule = {
  id: string;
  countryCode: string;
  currency: string;
  updatedAt: string;
};

function getText(input: any): string {
  // s-text-field typically sends an event
  if (typeof input === "string") return input;
  const v1 = input?.target?.value;
  if (v1 != null) return String(v1);
  const v2 = input?.detail?.value;
  if (v2 != null) return String(v2);
  return String(input ?? "");
}

export async function loader({ request }: LoaderFunctionArgs) {
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

  return { rules, shopDomain: session.shop };
}

export default function CurrencyRulesPage() {
  const data = useLoaderData() as { rules: Rule[]; shopDomain: string };
  const fetcher = useFetcher();

  const [countryCode, setCountryCode] = useState("");
  const [currency, setCurrency] = useState("");

  const saving = fetcher.state !== "idle";

  // ensure we always include ?shop=... for admin auth
  const actionUrl = useMemo(() => {
    const shop = data.shopDomain;
    return `/api/admin/market-currency-rules?shop=${encodeURIComponent(shop)}`;
  }, [data.shopDomain]);

  function submitUpsert() {
    fetcher.submit(
      {
        intent: "upsert",
        countryCode: countryCode.trim().toUpperCase(),
        currency: currency.trim().toUpperCase(),
      },
      { method: "post", action: actionUrl }
    );
  }

  function submitDelete(id: string) {
    fetcher.submit({ intent: "delete", id }, { method: "post", action: actionUrl });
  }

  return (
    <s-page heading="Currency rules">
      <s-section heading="Add / update rule">
        <s-stack direction="block" gap="base">
          <s-text-field
            label="Country code"
            value={countryCode}
            onChange={(e) => setCountryCode(getText(e).toUpperCase())}
          />
          <s-text-field
            label="Currency"
            value={currency}
            onChange={(e) => setCurrency(getText(e).toUpperCase())}
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
