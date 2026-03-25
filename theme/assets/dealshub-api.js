// ============================================================
// DealsHub — API Client (Unified frontend API layer)
// ============================================================
window.DealsHub = window.DealsHub || {};

(function() {
  'use strict';

  const API_BASE = 'https://dealshub-search.onrender.com';
  const STORE_DOMAIN = 'stylehubmiami.com';

  // ---- FETCH WRAPPER ----
  async function apiFetch(endpoint, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeout || 15000);
    try {
      const resp = await fetch(`${API_BASE}${endpoint}`, {
        ...options,
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json', ...options.headers }
      });
      clearTimeout(timeout);
      if (!resp.ok) {
        const errText = await resp.text().catch(() => '');
        throw new Error(`API ${resp.status}: ${errText.substring(0, 200)}`);
      }
      return await resp.json();
    } catch (err) {
      clearTimeout(timeout);
      if (err.name === 'AbortError') throw new Error('Request timed out');
      throw err;
    }
  }

  // ---- SEARCH ----
  async function search(query, options = {}) {
    // Support both search(query, options) and legacy search(query, store, limit)
    if (typeof options === 'string') {
      const store = options;
      const limit = arguments[2];
      options = { store: store };
      if (limit) options.limit = limit;
    }
    const params = new URLSearchParams({ q: query });
    if (options.store) params.set('store', options.store);
    if (options.limit) params.set('limit', options.limit);
    if (options.page) params.set('page', options.page);
    if (options.category) params.set('category', options.category);
    return apiFetch(`/api/search?${params}`);
  }

  // ---- PRODUCT DETAIL ----
  async function getProduct(id, store = 'amazon') {
    return apiFetch(`/api/product/${encodeURIComponent(id)}?store=${store}`);
  }

  // ---- PREPARE CART (Sync on demand + get Shopify variant) ----
  async function prepareCart(source, sourceId, selectedVariant, quantity = 1) {
    return apiFetch('/api/prepare-cart', {
      method: 'POST',
      body: JSON.stringify({ source, sourceId, selectedVariant, quantity }),
      timeout: 30000 // Allow more time for product creation
    });
  }

  // ---- ADD TO SHOPIFY CART (Native) ----
  async function addToShopifyCart(variantId, quantity = 1, properties = {}) {
    const resp = await fetch('/cart/add.js', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        items: [{ id: variantId, quantity, properties }]
      })
    });
    if (!resp.ok) throw new Error('Failed to add to cart');
    return resp.json();
  }

  // ---- BUY NOW (Sync + redirect to checkout) ----
  async function buyNow(source, sourceId, selectedVariant, quantity = 1) {
    const result = await prepareCart(source, sourceId, selectedVariant, quantity);
    if (result.success && result.checkoutUrl) {
      window.location.href = result.checkoutUrl;
      return result;
    }
    throw new Error(result.error || 'Failed to prepare checkout');
  }

  // ---- ADD TO CART (Sync + add to native cart) ----
  async function addToCart(source, sourceId, selectedVariant, quantity = 1) {
    const result = await prepareCart(source, sourceId, selectedVariant, quantity);
    if (result.success && result.cartAddPayload) {
      const { id, quantity: qty, properties } = result.cartAddPayload;
      await addToShopifyCart(id, qty, properties);
      return result;
    }
    throw new Error(result.error || 'Failed to add to cart');
  }

  // ---- SECTIONS (Home, trending, etc.) ----
  async function getTrending() { return apiFetch('/api/trending'); }
  async function getBestsellers() { return apiFetch('/api/bestsellers'); }
  async function getNewArrivals() { return apiFetch('/api/new-arrivals'); }
  async function getFlashDeals() { return apiFetch('/api/flash-deals'); }
  async function getFeatured(category) { return apiFetch(`/api/featured?category=${encodeURIComponent(category)}`); }

  // ---- RECENTLY VIEWED ----
  function getRecentlyViewed() {
    try {
      return JSON.parse(localStorage.getItem('dh_recently_viewed') || '[]');
    } catch { return []; }
  }

  function addToRecentlyViewed(product) {
    try {
      const items = getRecentlyViewed().filter(p => p.id !== product.id || p.source !== product.source);
      items.unshift({ id: product.sourceId || product.id, source: product.source, title: product.title, image: product.primaryImage || product.image, price: product.displayPrice || product.price });
      localStorage.setItem('dh_recently_viewed', JSON.stringify(items.slice(0, 20)));
    } catch {}
  }

  // ---- WISHLIST ----
  function getWishlist() {
    try { return JSON.parse(localStorage.getItem('dh_wishlist') || '[]'); } catch { return []; }
  }

  function toggleWishlist(product) {
    const items = getWishlist();
    const idx = items.findIndex(p => p.id === product.id && p.source === product.source);
    if (idx >= 0) { items.splice(idx, 1); } else { items.push(product); }
    localStorage.setItem('dh_wishlist', JSON.stringify(items));
    return idx < 0; // true if added, false if removed
  }

  function isInWishlist(id, source) {
    return getWishlist().some(p => p.id === id && p.source === source);
  }

  // ---- EXPORT ----
  window.DealsHub = {
    search, getProduct, prepareCart, addToCart, buyNow,
    addToShopifyCart, getTrending, getBestsellers, getNewArrivals,
    getFlashDeals, getFeatured, getRecentlyViewed, addToRecentlyViewed,
    getWishlist, toggleWishlist, isInWishlist, API_BASE
  };
})();
