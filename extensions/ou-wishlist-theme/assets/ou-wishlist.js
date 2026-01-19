(function () {
  function init(root) {
    const proxyBase = root.getAttribute("data-proxy-base") || "/apps/ou-wishlist";
    const productId = root.getAttribute("data-product-id");

    const btn = root.querySelector(".ou-wishlist__btn");
    const modal = root.querySelector(".ou-wishlist__modal");
    const select = root.querySelector(".ou-wishlist__select");
    const closeBtn = root.querySelector(".ou-wishlist__close");
    const backdrop = root.querySelector(".ou-wishlist__backdrop");
    const createBtn = root.querySelector(".ou-wishlist__create");
    const newInput = root.querySelector(".ou-wishlist__new");
    const addBtn = root.querySelector(".ou-wishlist__add");
    const statusEl = root.querySelector(".ou-wishlist__status");
    const loginEl = root.querySelector(".ou-wishlist__login");

    function setStatus(msg) {
      statusEl.textContent = msg || "";
    }

    function open() {
      modal.hidden = false;
      loginEl.hidden = true;
      setStatus("");
      loadWishlists();
    }

    function close() {
      modal.hidden = true;
      setStatus("");
    }

    function getSelectedVariantId() {
      // Most themes keep selected variant in input[name="id"] inside the product form.
      const form = document.querySelector('form[action*="/cart/add"]');
      const idInput = form && form.querySelector('input[name="id"]');
      return idInput ? idInput.value : null;
    }

    async function proxyFetch(path, opts) {
      const res = await fetch(proxyBase + path, {
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        ...opts,
      });

      const text = await res.text().catch(() => "");
      const json = text ? JSON.parse(text) : {};

      if (!res.ok) throw new Error(json?.error || `Request failed (${res.status})`);
      return json;
    }

    async function loadWishlists() {
      try {
        setStatus("Loading wishlists...");
        const data = await proxyFetch("/wishlists", { method: "GET" });
        const wishlists = Array.isArray(data.wishlists) ? data.wishlists : [];

        select.innerHTML = "";
        if (!wishlists.length) {
          const opt = document.createElement("option");
          opt.value = "";
          opt.textContent = "No wishlists yet (create one below)";
          select.appendChild(opt);
        } else {
          wishlists.forEach((w) => {
            const opt = document.createElement("option");
            opt.value = w.id;
            opt.textContent = w.name;
            select.appendChild(opt);
          });
        }

        setStatus("");
      } catch (e) {
        const msg = String(e?.message || e);

        // If proxy says not logged in
        if (msg.toLowerCase().includes("not logged in") || msg.includes("(401)")) {
          setStatus("");
          loginEl.hidden = false;
          return;
        }

        setStatus(msg);
      }
    }

    async function createWishlist() {
      const name = (newInput.value || "").trim();
      if (!name) return setStatus("Enter a wishlist name.");

      setStatus("Creating...");
      const data = await proxyFetch("/wishlists", {
        method: "POST",
        body: JSON.stringify({ name }),
      });

      newInput.value = "";
      await loadWishlists();

      if (data?.wishlist?.id) select.value = data.wishlist.id;
      setStatus("Created.");
    }

    async function addToWishlist() {
      const wishlistId = select.value;
      if (!wishlistId) return setStatus("Select a wishlist (or create one).");

      const variantId = getSelectedVariantId();
      if (!variantId) return setStatus("Could not determine selected variant.");

      setStatus("Adding...");
      await proxyFetch(`/wishlists/${encodeURIComponent(wishlistId)}/items`, {
        method: "POST",
        body: JSON.stringify({
          productId,
          variantId,
          quantity: 1,
        }),
      });

      setStatus("Added to wishlist.");
    }

    btn.addEventListener("click", open);
    closeBtn.addEventListener("click", close);
    backdrop.addEventListener("click", close);
    createBtn.addEventListener("click", () => createWishlist().catch((e) => setStatus(e.message)));
    addBtn.addEventListener("click", () => addToWishlist().catch((e) => setStatus(e.message)));
  }

  function boot() {
    document.querySelectorAll(".ou-wishlist").forEach(init);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
