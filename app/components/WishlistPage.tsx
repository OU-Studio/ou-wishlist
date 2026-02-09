import { useEffect, useMemo, useState } from "react";

const API_BASE = "https://studio-ore-quote.up.railway.app";

type Props = {
  shop: string;
  customerId: string | null;
};

export function WishlistPage({ shop, customerId }: Props) {
  const [loadingIndex, setLoadingIndex] = useState(true);
  const [wishlists, setWishlists] = useState<any[]>([]);
  const [indexError, setIndexError] = useState<string | null>(null);

  const baseParams = useMemo(() => {
    return { customerId: customerId || "", shop };
  }, [customerId, shop]);

  function buildUrl(path: string, overrides: Record<string, any> = {}) {
    const u = new URL(API_BASE + path);
    const params = { ...baseParams, ...overrides };
    Object.entries(params).forEach(([k, v]) => {
      if (v) u.searchParams.set(k, String(v));
    });
    return u.toString();
  }

  async function apiFetch(path: string) {
    const res = await fetch(buildUrl(path), { method: "GET" });
    const text = await res.text().catch(() => "");
    const json = text ? JSON.parse(text) : {};
    if (!res.ok) throw new Error((json as any)?.error || `Request failed (${res.status})`);
    return json;
  }

  async function loadWishlists() {
    try {
      setLoadingIndex(true);
      setIndexError(null);
      const json = await apiFetch("/api/wishlists");
      setWishlists(Array.isArray((json as any).wishlists) ? (json as any).wishlists : []);
    } catch (e: any) {
      setIndexError(String(e?.message || e));
    } finally {
      setLoadingIndex(false);
    }
  }

  useEffect(() => {
    loadWishlists();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shop, customerId]);

  return (
    <div style={{ padding: 24, maxWidth: 900, margin: "0 auto" }}>
      <h1>Wishlists</h1>

      {!customerId && (
        <p>You must be logged in to view wishlists.</p>
      )}

      {indexError && <p style={{ color: "crimson" }}>{indexError}</p>}
      {loadingIndex && <p>Loading…</p>}

      {!loadingIndex && !indexError && (
        <ul>
          {wishlists.map((w: any) => (
            <li key={w.id}>{w.name}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
