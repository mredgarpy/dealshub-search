/**
 * DealsHub Miami — Wishlist JavaScript
 * localStorage-based wishlist for external deal products
 */

window.DealsHubWishlist = (function () {
  'use strict';

  const STORAGE_KEY = 'dealshub_wishlist';

  function getAll() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); } catch { return []; }
  }

  function saveAll(items) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
    document.dispatchEvent(new CustomEvent('wishlist:updated', { detail: { count: items.length, items } }));
  }

  function has(id) {
    return getAll().some(i => String(i.id) === String(id));
  }

  function add(product) {
    const items = getAll();
    if (!has(product.id)) {
      items.push({ ...product, id: String(product.id), addedAt: Date.now() });
      saveAll(items);
    }
  }

  function remove(id) {
    const items = getAll().filter(i => String(i.id) !== String(id));
    saveAll(items);
  }

  function toggle(product) {
    if (has(product.id)) { remove(product.id); return false; }
    else { add(product); return true; }
  }

  /* ── Wishlist page rendering ─────────────────────────────── */
  function renderWishlistPage(containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;

    const items = getAll();

    if (!items.length) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="empty-state__icon">❤️</div>
          <h2 class="empty-state__title">Your wishlist is empty</h2>
          <p class="empty-state__text">Save your favorite deals here to find them easily later.</p>
          <a href="/pages/dealshub" class="btn btn--primary btn--lg">Explore Deals</a>
        </div>`;
      return;
    }

    container.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:24px;flex-wrap:wrap;gap:12px;">
        <h2 style="font-size:1.1rem;font-weight:700;">${items.length} saved deal${items.length !== 1 ? 's' : ''}</h2>
        <button class="btn btn--ghost btn--sm" id="clear-wishlist-btn">Clear All</button>
      </div>
      <div class="grid grid--products">
        ${items.map(p => buildWishlistCard(p)).join('')}
      </div>`;

    // Clear all
    document.getElementById('clear-wishlist-btn') &&
      document.getElementById('clear-wishlist-btn').addEventListener('click', () => {
        if (confirm('Remove all items from your wishlist?')) {
          saveAll([]);
          renderWishlistPage(containerId);
        }
      });

    // Remove individual
    container.querySelectorAll('.wishlist-remove-btn').forEach(btn => {
      btn.addEventListener('click', function () {
        const id = this.dataset.id;
        remove(id);
        renderWishlistPage(containerId);
        window.DealsHubTheme && window.DealsHubTheme.showToast('Removed from wishlist', 'info');
      });
    });
  }

  function buildWishlistCard(p) {
    const price = '$' + parseFloat(p.price || 0).toFixed(2);
    const img   = p.image ? `<img src="${esc(p.image)}" alt="${esc(p.title)}" class="product-card__img" loading="lazy">` : '';
    return `
      <article class="product-card" data-product-id="${esc(p.id)}">
        <div class="product-card__media ratio--portrait">
          ${img}
          <div class="product-card__img-placeholder" ${p.image ? 'style="display:none"' : ''}>
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#ccc" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/></svg>
          </div>
          <div class="product-card__actions" style="opacity:1;transform:none;">
            <button class="product-card__action-btn wishlist-remove-btn is-wishlisted"
              data-id="${esc(p.id)}" title="Remove from wishlist" aria-label="Remove from wishlist">
              <svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2">
                <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>
              </svg>
            </button>
          </div>
          ${p.source ? `<div class="product-card__source-badge source-badge--${esc(p.source)}">${esc(p.source)}</div>` : ''}
        </div>
        <div class="product-card__body">
          <h3 class="product-card__title">${esc(p.title)}</h3>
          <div class="product-card__pricing">
            <span class="product-card__price">${price}</span>
          </div>
        </div>
        <div class="product-card__footer">
          <a href="${esc(p.url)}" target="_blank" rel="noopener noreferrer" class="product-card__cta btn">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="15" height="15"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
            View Deal
          </a>
        </div>
      </article>`;
  }

  function esc(s) {
    return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  // Init wishlist page if we're on /pages/wishlist
  document.addEventListener('DOMContentLoaded', () => {
    const wishlistPageContainer = document.getElementById('wishlist-products');
    if (wishlistPageContainer) renderWishlistPage('wishlist-products');
  });

  return { getAll, has, add, remove, toggle, renderWishlistPage };

})();
