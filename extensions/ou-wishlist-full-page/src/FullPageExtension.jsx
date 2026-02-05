import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";

const API_BASE = "https://studio-ore-quote.up.railway.app";

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
  const token = await shopify.sessionToken.get();
  const payload = JSON.parse(atob(token.split(".")[1]));
  return shopFromDest(payload?.dest);
}

async function authHeaders() {
  const token = await shopify.sessionToken.get();
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}


function asText(v) {
  if (typeof v === "string") return v;
  if (v == null) return "";
  if (typeof v === "number") return String(v);

  // UI extensions sometimes pass events or { value } objects
  if (typeof v === "object") {
    if (typeof v.value === "string") return v.value;
    if (typeof v.detail?.value === "string") return v.detail.value;
    if (typeof v.target?.value === "string") return v.target.value;
    if (typeof v.currentTarget?.value === "string") return v.currentTarget.value;
  }
  return "";
}

function asInt(v, fallback = 1) {
  const s = asText(v).trim();
  const n = parseInt(s, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function Extension() {
  const customerGid = shopify?.authenticatedAccount?.customer?.value?.id;
  const customerId = customerGid
    ? customerGid.replace("gid://shopify/Customer/", "")
    : null;

  // Country is a subscribable in UI extensions
  const country = shopify?.localization?.country;
  const countryCode =
    (country && "value" in country ? country.value?.isoCode : null) ??
    (country && "isoCode" in country ? country.isoCode : null) ??
    null;

  const [shopDomain, setShopDomain] = useState(null);

  const [loadingIndex, setLoadingIndex] = useState(true);
  const [wishlists, setWishlists] = useState([]);
  const [indexError, setIndexError] = useState(null);

  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState(null);

  const [activeId, setActiveId] = useState(null);
  const [activeWishlist, setActiveWishlist] = useState(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [detailError, setDetailError] = useState(null);

  const [renameValue, setRenameValue] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const [submitNote, setSubmitNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitResult, setSubmitResult] = useState(null);

  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerQ, setPickerQ] = useState("");
  const [pickerLoading, setPickerLoading] = useState(false);
  const [pickerError, setPickerError] = useState(null);
  const [pickerResults, setPickerResults] = useState([]);

  /** @typedef {{ productMap: Record<string, any>, variantMap: Record<string, any> }} Lookup */

  /** @type {[Lookup, (v: Lookup) => void]} */
  const [lookup, setLookup] = useState({
    productMap: {},
    variantMap: {},
  });

  const baseParams = useMemo(() => {
    return { customerId: customerId || "" };
  }, [customerId]);

  async function ensureShopDomain() {
    if (shopDomain) return shopDomain;
    const sd = await getShopFromSessionToken();
    setShopDomain(sd);
    return sd;
  }

  function buildUrl(path, overrides = {}) {
    const u = new URL(API_BASE + path);
    const params = { ...baseParams, ...overrides };
    Object.entries(params).forEach(([k, v]) => {
      if (v) u.searchParams.set(k, String(v));
    });
    return u.toString();
  }

  async function apiFetch(path, options = {}) {
  const { method = "GET", body } = options;
  const sd = await ensureShopDomain();

  async function doFetch() {
    const res = await fetch(buildUrl(path, { shop: sd }), {
      method,
      headers: await authHeaders(),
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    const text = await res.text().catch(() => "");
    let json = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { raw: text };
    }

    return { res, json };
  }

  // attempt 1
  let { res, json } = await doFetch();

  // retry once if auth/session expired
  const msg = String(json?.error || json?.errors || "").toLowerCase();
  const shouldRetry =
    res.status === 401 ||
    res.status === 403 ||
    msg.includes("invalid api key") ||
    msg.includes("invalid access token") ||
    msg.includes("unauthorized");

  if (shouldRetry) {
    // attempt 2 (new token is often issued implicitly)
    ({ res, json } = await doFetch());
  }

  if (!res.ok) {
    throw new Error(json?.error || `Request failed (${res.status})`);
  }

  return json;
}



  async function loadWishlists() {
    try {
      setLoadingIndex(true);
      setIndexError(null);
      const json = await apiFetch("/api/wishlists");
      setWishlists(Array.isArray(json.wishlists) ? json.wishlists : []);
    } catch (e) {
      setIndexError(String(e?.message || e));
    } finally {
      setLoadingIndex(false);
    }
  }



  async function loadWishlistDetail(id) {
    try {
      setLoadingDetail(true);
      setDetailError(null);

      const json = await apiFetch(`/api/wishlists/${id}`);
      const wl = json.wishlist || json;

      setActiveWishlist(wl);
      setRenameValue(wl?.name || "");

      const items = Array.isArray(wl?.items) ? wl.items : [];
      const productIds = items.map((i) => i.productId).filter(Boolean);
      const variantIds = items.map((i) => i.variantId).filter(Boolean);

      if (productIds.length || variantIds.length) {
        const meta = await apiFetch("/api/lookup", {
          method: "POST",
          body: { productIds, variantIds, countryCode: countryCode || null, },
        });
        setLookup({
          productMap: meta?.productMap || {},
          variantMap: meta?.variantMap || {},
        });

      } else {
        setLookup({ productMap: {}, variantMap: {} });
      }
    } catch (e) {
      setDetailError(String(e?.message || e));
    } finally {
      setLoadingDetail(false);
    }
  }

  async function createWishlist() {
    const trimmed = asText(newName).trim();
    if (!trimmed) {
      setCreateError("Enter a name for this quotation.");
      return;
    }
    try {
      setCreating(true);
      setCreateError(null);
      await apiFetch("/api/wishlists", { method: "POST", body: { name: trimmed } });
      setNewName("");
      await loadWishlists();
    } catch (e) {
      setCreateError(String(e?.message || e));
    } finally {
      setCreating(false);
    }
  }

  async function renameWishlist() {
    if (!activeId) return;
    const trimmed = asText(renameValue).trim();
    if (!trimmed) {
      setDetailError("Name cannot be empty.");
      return;
    }
    try {
      setRenaming(true);
      setDetailError(null);
      await apiFetch(`/api/wishlists/${activeId}`, { method: "PATCH", body: { name: trimmed } });
      await loadWishlists();
      await loadWishlistDetail(activeId);
    } catch (e) {
      setDetailError(String(e?.message || e));
    } finally {
      setRenaming(false);
    }
  }

  async function deleteWishlist() {
    if (!activeId) return;
    try {
      setDeleting(true);
      setDetailError(null);

      await apiFetch(`/api/wishlists/${activeId}`, { method: "DELETE" });

      setActiveId(null);
      setActiveWishlist(null);
      setRenameValue("");
      setSubmitResult(null);

      await loadWishlists();
    } catch (e) {
      setDetailError(String(e?.message || e));
    } finally {
      setDeleting(false);
    }
  }

  async function updateItemQty(itemId, nextQty) {
    if (!activeId) return;
    const qty = Math.max(1, parseInt(String(nextQty), 10) || 1);

    try {
      setDetailError(null);

      setActiveWishlist((prev) => {
        if (!prev?.items) return prev;
        return {
          ...prev,
          items: prev.items.map((it) => (it.id === itemId ? { ...it, quantity: qty } : it)),
        };
      });

      await apiFetch(`/api/wishlists/${activeId}/items/${itemId}`, {
        method: "PATCH",
        body: { quantity: qty },
      });

      await loadWishlistDetail(activeId);
    } catch (e) {
      setDetailError(String(e?.message || e));
      try {
        await loadWishlistDetail(activeId);
      } catch { }
    }
  }

  const CURRENCY_SYMBOL = {
    GBP: "£",
    EUR: "€",
    USD: "$",
    CAD: "$",
    AUD: "$",
    NZD: "$",
    JPY: "¥",
    CNY: "¥",
    HKD: "$",
    SGD: "$",
    CHF: "CHF ",
    SEK: "kr ",
    NOK: "kr ",
    DKK: "kr ",
  };

  function formatMoney(price) {
  if (!price) return null;

  const amount = typeof price === "object" ? price.amount : String(price);
  const code = typeof price === "object" ? price.currencyCode : null;

  if (!amount) return null;

  const n = Number(amount);

  // format with commas + 2dp
  const amountStr = Number.isFinite(n)
    ? n.toLocaleString("en-GB", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })
    : String(amount);

  const symbol = code ? (CURRENCY_SYMBOL[code] ?? `${code} `) : "";
  return `${symbol}${amountStr}`;
}


  function firstDefined(...vals) {
    for (const v of vals) if (v) return v;
    return null;
  }

  // Try common shapes from Storefront/Admin lookups
  function getImageUrl(_v, p) {
    return (
      p?.featuredImage?.url ||
      p?.featuredImage?.src ||
      p?.image?.url ||
      p?.image?.src ||
      p?.images?.nodes?.[0]?.url ||
      p?.images?.[0]?.url ||
      p?.images?.[0]?.src ||
      p?.media?.nodes?.[0]?.previewImage?.url ||
      p?.media?.nodes?.[0]?.previewImage?.src ||
      p?.featuredMedia?.previewImage?.url ||
      p?.featuredMedia?.previewImage?.src ||
      p?.primaryImage?.url ||
      p?.primaryImage?.src ||
      p?.imageUrl ||
      null
    );
  }


  function getProductUrl(v, p) {
    // If your lookup includes onlineStoreUrl or handle
    return (
      v?.product?.onlineStoreUrl ||
      p?.onlineStoreUrl ||
      v?.product?.url ||
      p?.url ||
      null
    );
  }

  function getAltText(v, p, title) {
    return (
      v?.image?.altText ||
      p?.featuredImage?.altText ||
      p?.image?.altText ||
      title ||
      "Product image"
    );
  }



  async function removeItem(itemId) {
    if (!activeId) return;

    try {
      setDetailError(null);

      setActiveWishlist((prev) => {
        if (!prev?.items) return prev;
        return { ...prev, items: prev.items.filter((it) => it.id !== itemId) };
      });

      await apiFetch(`/api/wishlists/${activeId}/items/${itemId}`, { method: "DELETE" });
      await loadWishlistDetail(activeId);
    } catch (e) {
      setDetailError(String(e?.message || e));
      try {
        await loadWishlistDetail(activeId);
      } catch { }
    }
  }

  async function searchProducts(q) {
    setPickerLoading(true);
    setPickerError(null);
    try {
      const res = await apiFetch("/api/products/search", {
        method: "POST",
        body: { q, countryCode: countryCode || null, },
      });
      setPickerResults(Array.isArray(res.products) ? res.products : []);
    } catch (e) {
      setPickerError(String(e?.message || e));
    } finally {
      setPickerLoading(false);
    }
  }

  async function addVariantToActiveWishlist(productId, variantId) {
    if (!activeId) return;
    await apiFetch(`/api/wishlists/${activeId}/items`, {
      method: "POST",
      body: { productId, variantId, quantity: 1 },
    });
    await loadWishlistDetail(activeId);
  }

  async function submitForQuote() {
    if (!activeId) return;

    try {
      setSubmitting(true);
      setDetailError(null);
      setSubmitResult(null);

      const res = await apiFetch(`/api/wishlists/${activeId}/submit`, {
        method: "POST",
        body: { note: submitNote || "", countryCode: countryCode || null },
      });

      setSubmitResult(res);
      await loadWishlistDetail(activeId);
    } catch (e) {
      setDetailError(String(e?.message || e));
    } finally {
      setSubmitting(false);
    }
  }

  function openWishlist(id) {
    setActiveId(id);
    setActiveWishlist(null);
    setSubmitNote("");
    setSubmitResult(null);
    loadWishlistDetail(id);
  }

  function goBack() {
    setActiveId(null);
    setActiveWishlist(null);
    setDetailError(null);
    setSubmitResult(null);
  }

  useEffect(() => {
    loadWishlists();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!customerId) {
    return (
      <s-page>
        <s-section>
          <s-banner>
            <s-text>Not authenticated.</s-text>
          </s-banner>
        </s-section>
      </s-page>
    );
  }

  // DETAIL VIEW
  if (activeId) {
    const wl = activeWishlist;
    const items = Array.isArray(wl?.items) ? wl.items : [];

    const detailSections = [
      {
        id: "detail-subheader",
        show: true,
        node: (
          <s-button onClick={goBack} variant="secondary">
                Back
              </s-button>
        ),
      },
      {
        id: "detail-header",
        show: true,
        node: (
          <s-section>
            <s-stack direction="block" gap="base">
              
              <s-heading>Quotation: {wl?.name || "Quotations"}</s-heading>
            </s-stack>

            {loadingDetail && <s-text>Loading…</s-text>}
            {detailError && <s-text>Error: {detailError}</s-text>}
          </s-section>
        ),
      },
      {
        id: "detail-manage",
        show: !!wl,
        node: (
          <s-section>
            <s-stack direction="block" gap="base">
            <s-heading>Manage</s-heading>
            <s-stack direction="block" gap="base">
              <s-text-field
                label="Rename quotation"
                value={renameValue}
                onChange={(v) => setRenameValue(asText(v))}
                disabled={renaming || deleting}
              />

              <s-stack direction="inline" gap="base">
                <s-button onClick={renameWishlist} disabled={renaming || deleting} variant="primary">
                  {renaming ? "Saving…" : "Save name"}
                </s-button>

                <s-button onClick={deleteWishlist} disabled={deleting || renaming} variant="secondary">
                  {deleting ? "Deleting…" : "Delete quotation"}
                </s-button>
              </s-stack>
            </s-stack>
            </s-stack>
          </s-section>
        ),
      },
      {
  id: "detail-items",
  show: true,
  node: (
    <s-section>
      <s-stack direction="block" gap="base">
        <s-heading>Items</s-heading>
<s-divider></s-divider>
        {wl && items.length === 0 && <s-text>No items yet.</s-text>}

        {wl && items.length > 0 && (
          <s-stack direction="block" gap="base">
            {items.map((it) => {
              const pGid = String(it.productId || "").startsWith("gid://")
                ? it.productId
                : `gid://shopify/Product/${it.productId}`;

              const vGid = String(it.variantId || "").startsWith("gid://")
                ? it.variantId
                : `gid://shopify/ProductVariant/${it.variantId}`;

              const v = lookup?.variantMap?.[vGid];
              const p = lookup?.productMap?.[pGid];

              const title = v?.product?.title || p?.title || `Product ${it.productId}`;
              const variantTitle = v?.title && v.title !== "Default Title" ? v.title : null;

              const priceText = formatMoney(v?.price);

              const qty = Number(it.quantity || 1);
              const unitAmount = v?.price?.amount != null ? Number(v.price.amount) : null;

              const lineTotal =
                unitAmount != null && v?.price?.currencyCode
                  ? formatMoney({
                      amount: (unitAmount * qty).toFixed(2),
                      currencyCode: v.price.currencyCode,
                    })
                  : null;

              const imgUrl = getImageUrl(v, p);
              const linkUrl = getProductUrl(v, p);
              const alt = getAltText(v, p, title);

              const thumb = imgUrl ? (
                <s-box inlineSize="120px" blockSize="120px">
                  <s-image src={imgUrl} alt={alt} objectFit="cover" />
                </s-box>
              ) : (
                <s-box inlineSize="120px" blockSize="120px">
                  <s-text>No image</s-text>
                </s-box>
              );

              return (
                <s-box key={it.id}>
                  <s-stack direction="block" gap="base">
                    {/* Row: image + text */}
                    <s-stack direction="inline" gap="base">
                      {linkUrl ? <s-link href={linkUrl}>{thumb}</s-link> : thumb}

                      <s-stack direction="block" gap="small-100">
                        <s-text>{title}</s-text>
                        {variantTitle && <s-text>{variantTitle}</s-text>}
                        {priceText ? <s-text>Price: {priceText}</s-text> : null}
                        <s-text>Qty: {qty}</s-text>
                        {lineTotal ? <s-text>Total: {lineTotal}</s-text> : null}
                      </s-stack>
                    </s-stack>

                    {/* Controls */}
                    <s-stack direction="inline" gap="base">
                      <s-button
                        onClick={() => updateItemQty(it.id, (it.quantity || 1) - 1)}
                        variant="secondary"
                      >
                        −
                      </s-button>

                      <s-button
                        onClick={() => updateItemQty(it.id, (it.quantity || 1) + 1)}
                        variant="secondary"
                      >
                        +
                      </s-button>

                      <s-button onClick={() => removeItem(it.id)} variant="secondary">
                        Remove
                      </s-button>
                    </s-stack>
                    <s-divider></s-divider>
                  </s-stack>
                </s-box>
              );
            })}
          </s-stack>
        )}
      </s-stack>
    </s-section>
  ),
},
      {
        id: "detail-submit",
        show: true,
        node: (
          <s-section>
            <s-stack direction="block" gap="base">
            <s-heading>Submit for quote</s-heading>
            <s-stack direction="block" gap="base">
              <s-text-field
                label="Customer note (optional)"
                value={submitNote}
                onChange={(v) => setSubmitNote(asText(v))}
                disabled={submitting}
              />

              <s-button onClick={submitForQuote} disabled={submitting} variant="primary">
                {submitting ? "Submitting…" : "Submit for quote"}
              </s-button>

              {submitResult && (
                <s-banner tone="success">
                  <s-text>Your quote request has been submitted successfully.</s-text>
                </s-banner>
              )}
            </s-stack>
            </s-stack>
          </s-section>
        ),
      },
    ];

    return (
      <s-page>
        <s-stack direction="block" gap="base">
          {detailSections.filter((s) => s.show).map((s) => (
            <s-box key={s.id}>{s.node}</s-box>
          ))}
        </s-stack>
      </s-page>
    );
  }

  // INDEX VIEW
  return (

    <s-page>
<s-heading>Quotations</s-heading>
      <s-section>
        

        <s-stack direction="block" gap="base">
          <s-text-field
            label="New quotation name"
            value={newName}
            onChange={(v) => setNewName(asText(v))}
            disabled={creating}
          />

          <s-button onClick={createWishlist} disabled={creating} variant="primary">
            {creating ? "Creating…" : "Create quotation"}
          </s-button>

          {createError && <s-text>Error: {createError}</s-text>}
        </s-stack>
      </s-section>

      <s-section>
        {loadingIndex && <s-text>Loading…</s-text>}
        {!loadingIndex && indexError && <s-text>Error: {indexError}</s-text>}

        {!loadingIndex && !indexError && wishlists.length === 0 && <s-text>No quotations yet.</s-text>}

        {!loadingIndex && !indexError && wishlists.length > 0 && (
          <s-stack direction="block" gap="base">
            {wishlists.map((w) => (
              <s-box key={w.id}>
                <s-stack direction="inline" gap="base">
                  <s-button onClick={() => openWishlist(w.id)} variant="secondary">
                    View {w.name} quotation
                  </s-button>
                </s-stack>
              </s-box>
            ))}
          </s-stack>
        )}
      </s-section>
    </s-page>
  );
}
