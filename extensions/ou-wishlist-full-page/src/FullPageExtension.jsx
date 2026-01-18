import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";

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
  const customerId = customerGid ? customerGid.replace("gid://shopify/Customer/", "") : "";

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

  // Add item (testing)
  const [addProductId, setAddProductId] = useState("");
  const [addVariantId, setAddVariantId] = useState("");
  const [addQty, setAddQty] = useState("1");
  const [addingItem, setAddingItem] = useState(false);

  const [submitNote, setSubmitNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitResult, setSubmitResult] = useState(null);

/** @type {[{productMap: Record<string, any>, variantMap: Record<string, any>}, (v: any) => void]} */
const [lookup, setLookup] = useState({
  productMap: {},
  variantMap: {},
});

  


  const baseParams = useMemo(() => {
    return { shop: shopDomain || "", customerId: customerId || "" };
  }, [shopDomain, customerId]);

  function buildUrl(path) {
    const u = new URL(API_BASE + path);
    Object.entries(baseParams).forEach(([k, v]) => {
      if (v) u.searchParams.set(k, v);
    });
    return u.toString();
  }

  async function apiFetch(path, options = {}) {
    const { method = "GET", body } = options;

    const res = await fetch(buildUrl(path), {
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

    if (!res.ok) {
      throw new Error(json?.error || `Request failed (${res.status})`);
    }

    return json;
  }

  async function loadShop() {
    const sd = await getShopFromSessionToken();
    setShopDomain(sd);
    return sd;
  }

  async function loadWishlists() {
    try {
      setLoadingIndex(true);
      setIndexError(null);
      if (!shopDomain) await loadShop();
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
    setSubmitResult(null);

    if (!shopDomain) await loadShop();

    // 1️⃣ Load wishlist + items
    const json = await apiFetch(`/api/wishlists/${id}`);
    const wl = json.wishlist || json;

    setActiveWishlist(wl);
    setRenameValue(wl?.name || "");

    // 2️⃣ Enrich items (product + variant metadata)
    const items = Array.isArray(wl?.items) ? wl.items : [];

    const productIds = items
      .map((i) => i.productId)
      .filter(Boolean);

    const variantIds = items
      .map((i) => i.variantId)
      .filter(Boolean);

    if (productIds.length || variantIds.length) {
      const meta = await apiFetch("/api/lookup", {
        method: "POST",
        body: {
          productIds,
          variantIds,
        },
      });

      setLookup(meta); // { productMap, variantMap }
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
      setCreateError("Enter a wishlist name.");
      return;
    }
    try {
      setCreating(true);
      setCreateError(null);
      if (!shopDomain) await loadShop();
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

    // clear detail view first so UI doesn't try to re-render stale ids
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

  async function addItem() {
    if (!activeId) return;

    const productId = asText(addProductId).trim();
    const variantId = asText(addVariantId).trim();
    const qty = asInt(addQty, 1);

    if (!productId) {
      setDetailError("Enter a productId (gid://shopify/Product/...)");
      return;
    }
    if (!variantId) {
      setDetailError("Enter a variantId (gid://shopify/ProductVariant/...)");
      return;
    }

    try {
      setAddingItem(true);
      setDetailError(null);

      await apiFetch(`/api/wishlists/${activeId}/items`, {
        method: "POST",
        body: { productId, variantId, quantity: qty },
      });

      setAddProductId("");
      setAddVariantId("");
      setAddQty("1");
      await loadWishlistDetail(activeId);
    } catch (e) {
      setDetailError(String(e?.message || e));
    } finally {
      setAddingItem(false);
    }
  }

  async function updateItemQty(itemId, nextQty) {
  if (!activeId) return;

  const qty = Math.max(1, parseInt(String(nextQty), 10) || 1);

  try {
    setDetailError(null);

    // optimistic UI update (optional but feels instant)
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

    // re-sync from server (keeps lookup/enrichment consistent)
    await loadWishlistDetail(activeId);
  } catch (e) {
    setDetailError(String(e?.message || e));
    // if patch failed, revert by reloading
    try {
      await loadWishlistDetail(activeId);
    } catch {}
  }
}

async function removeItem(itemId) {
  if (!activeId) return;

  try {
    setDetailError(null);

    // optimistic remove
    setActiveWishlist((prev) => {
      if (!prev?.items) return prev;
      return { ...prev, items: prev.items.filter((it) => it.id !== itemId) };
    });

    await apiFetch(`/api/wishlists/${activeId}/items/${itemId}`, {
      method: "DELETE",
    });

    await loadWishlistDetail(activeId);
  } catch (e) {
    setDetailError(String(e?.message || e));
    // revert by reloading
    try {
      await loadWishlistDetail(activeId);
    } catch {}
  }
}

  async function submitForQuote() {
    if (!activeId) return;
    try {
      setSubmitting(true);
      setDetailError(null);
      setSubmitResult(null);

      const note = asText(submitNote).trim();

      const json = await apiFetch(`/api/wishlists/${activeId}/submit`, {
        method: "POST",
        body: { note: note || undefined },
      });

      setSubmitResult(json);
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

    return (
      <s-page>
        <s-section>
          <s-stack direction="inline" gap="base">
            <s-button onClick={goBack} variant="secondary">
              Back
            </s-button>
            <s-heading>{wl?.name || "Wishlist"}</s-heading>
          </s-stack>

          {loadingDetail && <s-text>Loading…</s-text>}
          {detailError && <s-text>Error: {detailError}</s-text>}
        </s-section>

        {wl && (
          <s-section>
            <s-heading>Manage</s-heading>

            <s-stack direction="block" gap="base">
              <s-text-field
                label="Rename wishlist"
                value={renameValue}
                onChange={(v) => setRenameValue(asText(v))}
                disabled={renaming || deleting}
              />

              <s-stack direction="inline" gap="base">
                <s-button onClick={renameWishlist} disabled={renaming || deleting} variant="primary">
                  {renaming ? "Saving…" : "Save name"}
                </s-button>

                <s-button onClick={deleteWishlist} disabled={deleting || renaming} variant="secondary">
                  {deleting ? "Deleting…" : "Delete wishlist"}
                </s-button>
              </s-stack>
            </s-stack>
          </s-section>
        )}

        <s-section>
          <s-heading>Items</s-heading>

          {wl && items.length === 0 && <s-text>No items yet.</s-text>}

          {wl && items.length > 0 && (
            <s-unordered-list>
              {items.map((it) => (
                <s-list-item key={it.id}>
                  <s-stack direction="block" gap="base">
                    {(() => {
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
  const price = v?.price ? `£${v.price}` : null;

  return (
    <s-stack direction="block" gap="base">
      <s-text>{title}</s-text>
      {variantTitle && <s-text>{variantTitle}</s-text>}
      {price && <s-text>{price}</s-text>}
    </s-stack>
  );
})()}

                    <s-text>Qty: {it.quantity}</s-text>

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
                  </s-stack>
                </s-list-item>
              ))}
            </s-unordered-list>
          )}
        </s-section>

        <s-section>
          <s-heading>Add item (testing)</s-heading>
          <s-stack direction="block" gap="base">
            <s-text-field
              label="Product ID (gid://shopify/Product/...)"
              value={addProductId}
              onChange={(v) => setAddProductId(asText(v))}
              disabled={addingItem}
            />
            <s-text-field
              label="Variant ID (gid://shopify/ProductVariant/...)"
              value={addVariantId}
              onChange={(v) => setAddVariantId(asText(v))}
              disabled={addingItem}
            />
            <s-text-field
              label="Quantity"
              value={addQty}
              onChange={(v) => setAddQty(asText(v))}
              disabled={addingItem}
            />
            <s-button onClick={addItem} disabled={addingItem} variant="primary">
              {addingItem ? "Adding…" : "Add to wishlist"}
            </s-button>
          </s-stack>
        </s-section>

        <s-section>
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

            {submitResult && <s-text>Submitted: {JSON.stringify(submitResult).slice(0, 180)}</s-text>}
          </s-stack>
        </s-section>
      </s-page>
    );
  }

  // INDEX VIEW
  return (
    <s-page>
      <s-section>
        <s-heading>Wishlists</s-heading>

        <s-stack direction="block" gap="base">
          <s-text-field
            label="New wishlist name"
            value={newName}
            onChange={(v) => setNewName(asText(v))}
            disabled={creating}
          />

          <s-button onClick={createWishlist} disabled={creating} variant="primary">
            {creating ? "Creating…" : "Create wishlist"}
          </s-button>

          {createError && <s-text>Error: {createError}</s-text>}
        </s-stack>
      </s-section>

      <s-section>
        {loadingIndex && <s-text>Loading…</s-text>}
        {!loadingIndex && indexError && <s-text>Error: {indexError}</s-text>}

        {!loadingIndex && !indexError && wishlists.length === 0 && <s-text>No wishlists yet.</s-text>}

        {!loadingIndex && !indexError && wishlists.length > 0 && (
          <s-unordered-list>
            {wishlists.map((w) => (
              <s-list-item key={w.id}>
                <s-stack direction="inline" gap="base">
                  <s-button onClick={() => openWishlist(w.id)} variant="secondary">
                    Open
                  </s-button>
                  <s-text>{w.name}</s-text>
                </s-stack>
              </s-list-item>
            ))}
          </s-unordered-list>
        )}
      </s-section>
    </s-page>
  );
}
