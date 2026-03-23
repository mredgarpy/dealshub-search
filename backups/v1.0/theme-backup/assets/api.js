/**
 * DealsHub Miami — API Client
 * Handles all communication with the DealsHub search backend.
 * Base URL: configured via window.DealsHub.apiBase
 */

window.DealsHubAPI = (function () {
  'use strict';

  const cfg = window.DealsHub || {};
  const BASE = (cfg.apiBase || 'https://dealshub-search.onrender.com').replace(/\/$/, '');

  const CACHE = new Map();
  const CACHE_TTL = 5 * 60 * 1000; // 5 min

  /* ── Cache helpers ────────────────────────────────────────── */
  function cacheSet(key, data) {
    CACHE.set(key, { data, ts: Date.now() });
  }
  function cacheGet(key) {
    const entry = CACHE.get(key);
    if (!entry) return null;
    if (Date.now() - entry.ts > CACHE_TTL) { CACHE.delete(key); return null; }
    return entry.data;
  }

  /* ── Core fetch ──────────────────────────────────────────── */
  async function apiFetch(endpoint, opts = {}) {
    const cacheKey = endpoint;
    if (!opts.noCache) {
      const cached = cacheGet(cacheKey);
      if (cached) return cached;
    }

    const res = await fetch(BASE + endpoint, {
      signal: AbortSignal.timeout(opts.timeout || 10000),
      headers: { 'Accept': 'application/json' }
    });

    if (!res.ok) throw new Error(`API ${res.status}: ${endpoint}`);
    const data = await res.json();

    if (!opts.noCache) cacheSet(cacheKey, data);
    return data;
  }

  /* ── Normalise a product item ────────────────────────────── */
  function normalise(item) {
    if (!item) return null;
    const price = parseFloat(String(item.price || '0').replace(/[^0-9.]/g, '')) || 0;
    const originalPrice = parseFloat(String(item.originalPrice || item.original_price || '0').replace(/[^0-9.]/g, '')) || 0;
    const savings = originalPrice > price ? originalPrice - price : 0;
    const discount = originalPrice > price ? Math.round((savings / originalPrice) * 100) : 0;

    return {
      id:            item.id || item.asin || item.productId || String(Math.random()),
      title:         item.title || item.name || 'Product',
      price:         price,
      originalPrice: originalPrice || price,
      savings,
      discount,
      image:         item.image || item.img || item.thumbnail || '',
      url:           item.url || item.link || '#',
      rating:        parseFloat(item.rating) || 0,
      reviews:       parseInt(item.reviews || item.reviewCount || 0),
      badge:         item.badge || (discount >= 30 ? `${discount}% OFF` : ''),
      source:        (item.source || '').toLowerCase(),
      sourceName:    item.sourceName || item.source || '',
      isPrime:       !!item.isPrime,
      isFreeShipping: !!item.freeShipping,
      category:      item.category || ''
    };
  }

  /* ── Public API ──────────────────────────────────────────── */

  /**
   * Search products
   * @param {string} query
   * @param {object} opts - { store, limit, page }
   */
  async function search(query, opts = {}) {
    const params = new URLSearchParams({ q: query || 'deals' });
    if (opts.store && opts.store !== 'all') params.set('store', opts.store);
    if (opts.limit) params.set('limit', opts.limit);
    if (opts.page)  params.set('page', opts.page);

    const data = await apiFetch(`/api/search?${params}`, { noCache: !!opts.noCache });

    return {
      results: (data.results || []).map(normalise).filter(Boolean),
      total:   data.total || 0,
      query:   data.query || query
    };
  }

  /**
   * Get products by query (alias for search, used by sections)
   */
  async function getProducts(query, opts = {}) {
    const limit = opts.limit || cfg.productsPerSection || 12;
    return search(query, { ...opts, limit });
  }

  /**
   * Get multi-store products (parallel calls)
   */
  async function getMultiStore(query, stores = [], limit = 5) {
    const activeStores = stores.length ? stores : Object.entries(cfg.activeStores || {})
      .filter(([, v]) => v)
      .map(([k]) => k);

    const calls = activeStores.map(store =>
      search(query, { store, limit }).catch(() => ({ results: [], total: 0 }))
    );
    const responses = await Promise.allSettled(calls);

    const all = [];
    responses.forEach(r => {
      if (r.status === 'fulfilled' && r.value.results) {
        all.push(...r.value.results);
      }
    });
    return { results: all, total: all.length };
  }

  /**
   * Warm up the API (fire a dummy request after page load)
   */
  function warmUp() {
    const delay = cfg.warmUpDelay || 500;
    setTimeout(() => {
      apiFetch('/api/search?q=trending&limit=1&warmup=1', { noCache: true }).catch(() => {});
    }, delay);
  }

  /**
   * Format price as string
   */
  function formatPrice(price, currency = '$') {
    if (price === null || price === undefined || isNaN(price)) return '';
    return currency + parseFloat(price).toFixed(2);
  }

  /**
   * Generate star HTML
   */
  function starsHtml(rating) {
    const full  = Math.floor(rating);
    const half  = rating - full >= 0.5 ? 1 : 0;
    const empty = 5 - full - half;
    return '★'.repeat(full) + (half ? '½' : '') + '☆'.repeat(empty);
  }

  /**
   * Truncate text
   */
  function truncate(str, len = 80) {
    if (!str) return '';
    return str.length > len ? str.slice(0, len) + '…' : str;
  }

  // Auto warm-up on load
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', warmUp);
  } else {
    warmUp();
  }

  return { search, getProducts, getMultiStore, normalise, formatPrice, starsHtml, truncate };

})();
