/**
 * DealsHub Miami — Carousels & Dynamic Grid JavaScript
 * Renders product grids and carousels from the DealsHub API
 */

window.DealsHubCarousels = (function () {
  'use strict';

  /* ── Build product card HTML ──────────────────────────────── */
  function buildCard(product, opts = {}) {
    const api = window.DealsHubAPI;
    const cfg = window.DealsHub || {};
    const showBadge    = cfg.cardShowBadge    !== false;
    const showRating   = cfg.cardShowRating   !== false;
    const showSource   = cfg.cardShowSource   !== false;
    const showSavings  = cfg.cardShowSavings  !== false;
    const showWishlist = cfg.cardWishlistBtn  !== false;
    const showQuickV   = cfg.cardQuickView    !== false;
    const imgRatio     = cfg.cardImageRatio   || 'portrait';

    const priceStr     = api ? api.formatPrice(product.price)         : '$' + product.price;
    const origStr      = api ? api.formatPrice(product.originalPrice) : '$' + product.originalPrice;
    const starsHtml    = api ? api.starsHtml(product.rating)          : '★★★★★';
    const savingsStr   = product.discount > 0 ? `-${product.discount}%` : '';
    const isWishlisted = isInWishlist(product.id);

    return `
      <article class="product-card" data-product-id="${esc(product.id)}" data-source="${esc(product.source)}">
        <!-- Image -->
        <div class="product-card__media ratio--${imgRatio}">
          ${product.image
            ? `<img class="product-card__img" src="${esc(product.image)}" alt="${esc(product.title)}" loading="lazy" onerror="this.closest('.product-card__media').querySelector('.product-card__img-placeholder').style.display='flex'; this.style.display='none';">`
            : ''}
          <div class="product-card__img-placeholder" ${product.image ? 'style="display:none;"' : ''}>
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#ccc" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
          </div>

          <!-- Badges -->
          ${showBadge && product.badge ? `
          <div class="product-card__badges">
            <span class="badge badge--deal">${esc(product.badge)}</span>
            ${product.discount >= 50 ? '<span class="badge badge--hot">HOT</span>' : ''}
          </div>` : ''}

          <!-- Action buttons -->
          <div class="product-card__actions">
            ${showWishlist ? `
            <button class="product-card__action-btn wishlist-btn${isWishlisted ? ' is-wishlisted' : ''}"
              data-id="${esc(product.id)}"
              data-title="${esc(product.title)}"
              data-image="${esc(product.image)}"
              data-price="${product.price}"
              data-url="${esc(product.url)}"
              data-source="${esc(product.source)}"
              aria-label="${isWishlisted ? 'Remove from wishlist' : 'Add to wishlist'}"
              title="Wishlist">
              <svg viewBox="0 0 24 24" fill="${isWishlisted ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
            </button>` : ''}

            ${showQuickV ? `
            <button class="product-card__action-btn quick-view-btn"
              data-product='${escapeJson(product)}'
              aria-label="Quick View"
              title="Quick View">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
            </button>` : ''}

            <a href="${esc(product.url)}" target="_blank" rel="noopener noreferrer"
               class="product-card__action-btn"
               aria-label="View on store"
               title="Open in store">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
            </a>
          </div>

          <!-- Source badge -->
          ${showSource ? `
          <div class="product-card__source-badge source-badge--${esc(product.source)}">${esc(product.sourceName || product.source)}</div>` : ''}
        </div>

        <!-- Card body -->
        <div class="product-card__body">
          <h3 class="product-card__title" title="${esc(product.title)}">${esc(product.title)}</h3>

          ${showRating && product.rating > 0 ? `
          <div class="product-card__rating">
            <span class="stars" aria-label="${product.rating} stars">${starsHtml}</span>
            <span class="product-card__reviews">(${product.reviews.toLocaleString()})</span>
          </div>` : ''}

          <div class="product-card__pricing">
            <span class="product-card__price">${priceStr}</span>
            ${product.originalPrice > product.price ? `
              <span class="product-card__original-price">${origStr}</span>
              ${showSavings ? `<span class="product-card__savings">${savingsStr}</span>` : ''}
            ` : ''}
          </div>
        </div>

        <!-- CTA -->
        <div class="product-card__footer">
          <a href="${esc(product.url)}" target="_blank" rel="noopener noreferrer"
             class="product-card__cta btn">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="15" height="15"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
            View Deal
          </a>
        </div>
      </article>`;
  }

  /* ── Skeleton card ────────────────────────────────────────── */
  function buildSkeleton(count = 6) {
    return Array.from({ length: count }, () => `
      <div class="product-card product-card--skeleton">
        <div class="product-card__media ratio--portrait"><div style="position:absolute;inset:0;" class="skeleton"></div></div>
        <div class="product-card__body" style="gap:8px;">
          <div class="skeleton skeleton-line skeleton-line--lg"></div>
          <div class="skeleton skeleton-line skeleton-line--md"></div>
          <div class="skeleton skeleton-line skeleton-line--sm"></div>
          <div class="skeleton skeleton-line" style="width:50%;height:18px;"></div>
        </div>
        <div class="product-card__footer"><div class="skeleton" style="height:38px;border-radius:8px;"></div></div>
      </div>`).join('');
  }

  /* ── Error state ──────────────────────────────────────────── */
  function buildError(msg = 'Could not load products.') {
    return `<div class="products-error" style="grid-column:1/-1;">
      <div class="products-error__icon">😔</div>
      <p>${msg}</p>
    </div>`;
  }

  /* ── Load & render a grid section ────────────────────────── */
  async function loadGrid(el) {
    const query    = el.dataset.query || 'deals';
    const store    = el.dataset.store || '';
    const limit    = parseInt(el.dataset.limit)  || 12;
    const layout   = el.dataset.layout || 'grid'; // 'grid' | 'carousel'
    const gridEl   = el.querySelector('[data-products-target]');
    if (!gridEl) return;

    // Show skeletons
    gridEl.innerHTML = buildSkeleton(layout === 'carousel' ? 8 : limit);

    try {
      const api = window.DealsHubAPI;
      let results = [];

      if (store === 'multi' || store === '') {
        const resp = await api.getMultiStore(query, [], limit);
        results = resp.results;
      } else {
        const resp = await api.getProducts(query, { store, limit });
        results = resp.results;
      }

      if (!results.length) {
        gridEl.innerHTML = `<div class="empty-state" style="grid-column:1/-1;padding:32px;">
          <div class="empty-state__icon">🔍</div>
          <p class="empty-state__text">No products found. Try a different search.</p>
        </div>`;
        return;
      }

      gridEl.innerHTML = results.map(p => buildCard(p)).join('');
      attachCardListeners(gridEl);

    } catch (err) {
      console.warn('DealsHub grid error:', err);
      gridEl.innerHTML = buildError();
    }
  }

  /* ── Carousel nav ─────────────────────────────────────────── */
  function initCarouselNav(wrapper) {
    const carousel = wrapper.querySelector('.product-carousel');
    const prevBtn  = wrapper.querySelector('.carousel-nav--prev');
    const nextBtn  = wrapper.querySelector('.carousel-nav--next');
    if (!carousel) return;

    const step = 240;

    prevBtn && prevBtn.addEventListener('click', () => {
      carousel.scrollBy({ left: -step * 3, behavior: 'smooth' });
    });
    nextBtn && nextBtn.addEventListener('click', () => {
      carousel.scrollBy({ left: step * 3, behavior: 'smooth' });
    });

    // Update nav visibility
    function updateNav() {
      if (!prevBtn || !nextBtn) return;
      prevBtn.style.opacity = carousel.scrollLeft > 10 ? '1' : '0.3';
      nextBtn.style.opacity = carousel.scrollLeft + carousel.clientWidth < carousel.scrollWidth - 10 ? '1' : '0.3';
    }
    carousel.addEventListener('scroll', updateNav, { passive: true });
    updateNav();
  }

  /* ── Hero Slider ──────────────────────────────────────────── */
  function initHeroSlider(slider) {
    const track  = slider.querySelector('.hero-slider__track');
    const dots   = slider.querySelectorAll('.hero-slider__dot');
    const prev   = slider.querySelector('.hero-slider__prev');
    const next   = slider.querySelector('.hero-slider__next');
    const slides = slider.querySelectorAll('.hero-slide');
    if (!slides.length) return;

    let current = 0;
    let auto;

    function goTo(idx) {
      current = (idx + slides.length) % slides.length;
      if (track) track.style.transform = `translateX(-${current * 100}%)`;
      dots.forEach((d, i) => d.classList.toggle('is-active', i === current));
    }

    prev  && prev.addEventListener('click', () => { goTo(current - 1); resetAuto(); });
    next  && next.addEventListener('click', () => { goTo(current + 1); resetAuto(); });
    dots.forEach((d, i) => d.addEventListener('click', () => { goTo(i); resetAuto(); }));

    function startAuto() { auto = setInterval(() => goTo(current + 1), 5000); }
    function resetAuto()  { clearInterval(auto); startAuto(); }
    startAuto();

    // Touch swipe
    let startX = 0;
    slider.addEventListener('touchstart', e => { startX = e.touches[0].clientX; }, { passive: true });
    slider.addEventListener('touchend', e => {
      const diff = startX - e.changedTouches[0].clientX;
      if (Math.abs(diff) > 50) goTo(diff > 0 ? current + 1 : current - 1);
    }, { passive: true });
  }

  /* ── Countdown timer ──────────────────────────────────────── */
  function initCountdown(el) {
    const endTime = el.dataset.end ? new Date(el.dataset.end) : getEndOfDay();

    function getEndOfDay() {
      const d = new Date();
      d.setHours(23, 59, 59, 0);
      return d;
    }

    const hhEl = el.querySelector('[data-hh]');
    const mmEl = el.querySelector('[data-mm]');
    const ssEl = el.querySelector('[data-ss]');

    function tick() {
      const diff = Math.max(0, endTime - Date.now());
      const h = Math.floor(diff / 3600000);
      const m = Math.floor((diff % 3600000) / 60000);
      const s = Math.floor((diff % 60000) / 1000);
      if (hhEl) hhEl.textContent = String(h).padStart(2, '0');
      if (mmEl) mmEl.textContent = String(m).padStart(2, '0');
      if (ssEl) ssEl.textContent = String(s).padStart(2, '0');
    }

    tick();
    setInterval(tick, 1000);
  }

  /* ── Brand filter tabs ────────────────────────────────────── */
  function initBrandTabs(section) {
    const tabs    = section.querySelectorAll('.brand-item[data-store]');
    const gridWrap = section.querySelector('[data-products-section]');
    if (!gridWrap) return;

    tabs.forEach(tab => {
      tab.addEventListener('click', async function () {
        tabs.forEach(t => t.classList.remove('is-active'));
        this.classList.add('is-active');

        const store = this.dataset.store;
        const query = gridWrap.dataset.query || 'deals';
        const limit = parseInt(gridWrap.dataset.limit) || 12;
        const gridEl = gridWrap.querySelector('[data-products-target]');
        if (!gridEl) return;

        gridEl.innerHTML = buildSkeleton(limit);

        try {
          const api = window.DealsHubAPI;
          const resp = store === 'all'
            ? await api.getMultiStore(query, [], limit)
            : await api.getProducts(query, { store, limit });

          gridEl.innerHTML = resp.results.length
            ? resp.results.map(p => buildCard(p)).join('')
            : `<div class="empty-state" style="grid-column:1/-1;padding:32px;"><div class="empty-state__icon">🔍</div><p class="empty-state__text">No products from this store right now.</p></div>`;

          attachCardListeners(gridEl);
        } catch {
          gridEl.innerHTML = buildError();
        }
      });
    });
  }

  /* ── Card event listeners ─────────────────────────────────── */
  function attachCardListeners(container) {
    // Wishlist
    container.querySelectorAll('.wishlist-btn').forEach(btn => {
      btn.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        const id = this.dataset.id;
        const product = {
          id,
          title: this.dataset.title,
          image: this.dataset.image,
          price: this.dataset.price,
          url:   this.dataset.url,
          source: this.dataset.source
        };
        toggleWishlist(id, product, this);
      });
    });

    // Quick view
    container.querySelectorAll('.quick-view-btn').forEach(btn => {
      btn.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        try {
          const product = JSON.parse(this.dataset.product);
          openQuickView(product);
        } catch { /* empty */ }
      });
    });
  }

  /* ── Wishlist helpers ─────────────────────────────────────── */
  function getWishlist() {
    try { return JSON.parse(localStorage.getItem('dealshub_wishlist') || '[]'); } catch { return []; }
  }
  function saveWishlist(items) {
    localStorage.setItem('dealshub_wishlist', JSON.stringify(items));
    document.dispatchEvent(new CustomEvent('wishlist:updated', { detail: { count: items.length } }));
  }
  function isInWishlist(id) {
    return getWishlist().some(i => i.id === String(id));
  }
  function toggleWishlist(id, product, btn) {
    let items = getWishlist();
    const idx = items.findIndex(i => i.id === String(id));

    if (idx > -1) {
      items.splice(idx, 1);
      btn.classList.remove('is-wishlisted');
      btn.querySelector('svg').setAttribute('fill', 'none');
      btn.setAttribute('aria-label', 'Add to wishlist');
      showToast('Removed from wishlist', 'info');
    } else {
      items.push({ ...product, id: String(id) });
      btn.classList.add('is-wishlisted');
      btn.querySelector('svg').setAttribute('fill', 'currentColor');
      btn.setAttribute('aria-label', 'Remove from wishlist');
      showToast('❤️ Added to wishlist!', 'success');
    }
    saveWishlist(items);
  }

  /* ── Quick View ───────────────────────────────────────────── */
  function openQuickView(product) {
    const modal = document.getElementById('quick-view-modal');
    if (!modal) return;

    const api = window.DealsHubAPI;
    const priceStr = api ? api.formatPrice(product.price) : '$' + product.price;
    const origStr  = api ? api.formatPrice(product.originalPrice) : '$' + product.originalPrice;
    const starsHtml = api ? api.starsHtml(product.rating) : '';

    const body = modal.querySelector('#quick-view-body');
    if (body) {
      body.innerHTML = `
        <div class="quick-view-modal__img">
          ${product.image
            ? `<img src="${esc(product.image)}" alt="${esc(product.title)}" loading="lazy">`
            : `<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;background:var(--color-bg);"><svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="#ccc" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg></div>`}
        </div>
        <div class="quick-view-modal__info">
          <div class="quick-view-modal__source source-badge--${esc(product.source)}">${esc(product.sourceName || product.source)}</div>
          <h2 class="quick-view-modal__title">${esc(product.title)}</h2>
          ${product.rating > 0 ? `<div class="product-info__rating"><span class="stars">${starsHtml}</span><span style="font-size:.85rem;color:var(--color-text-muted)">${product.reviews.toLocaleString()} reviews</span></div>` : ''}
          <div class="quick-view-modal__pricing">
            <span class="quick-view-modal__price">${priceStr}</span>
            ${product.originalPrice > product.price ? `
              <span class="quick-view-modal__original">${origStr}</span>
              <span class="quick-view-modal__savings">Save ${product.discount}%</span>` : ''}
          </div>
          <div class="quick-view-modal__actions">
            <a href="${esc(product.url)}" target="_blank" rel="noopener noreferrer" class="btn btn--primary btn--full btn--lg">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="18" height="18"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
              Shop on ${esc(product.sourceName || product.source)}
            </a>
            <button class="btn btn--ghost btn--full wishlist-btn${isInWishlist(product.id) ? ' is-wishlisted' : ''}"
              data-id="${esc(product.id)}"
              data-title="${esc(product.title)}"
              data-image="${esc(product.image)}"
              data-price="${product.price}"
              data-url="${esc(product.url)}"
              data-source="${esc(product.source)}">
              <svg viewBox="0 0 24 24" fill="${isInWishlist(product.id) ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
              ${isInWishlist(product.id) ? 'Remove from Wishlist' : 'Add to Wishlist'}
            </button>
          </div>
        </div>`;

      attachCardListeners(body);
    }

    modal.classList.add('is-open');
    document.getElementById('overlay') && document.getElementById('overlay').classList.add('is-visible');
    document.body.style.overflow = 'hidden';
  }

  /* ── Toast ────────────────────────────────────────────────── */
  function showToast(message, type = 'info', duration = 3000) {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const icons = { success: '✅', error: '❌', info: '💬', warning: '⚠️' };
    const toast = document.createElement('div');
    toast.className = `toast toast--${type} animate-fade-up`;
    toast.innerHTML = `
      <span class="toast__icon">${icons[type] || '💬'}</span>
      <span class="toast__message">${message}</span>
      <button class="toast__close" aria-label="Close">×</button>`;

    toast.querySelector('.toast__close').addEventListener('click', () => toast.remove());
    container.appendChild(toast);
    setTimeout(() => toast.remove(), duration);
  }

  // Make showToast globally available
  window.DealsHubTheme = window.DealsHubTheme || {};
  window.DealsHubTheme.showToast = showToast;
  window.DealsHubTheme.openQuickView = openQuickView;

  /* ── HTML helpers ─────────────────────────────────────────── */
  function esc(s) { return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
  function escapeJson(obj) {
    try { return esc(JSON.stringify(obj)); } catch { return '{}'; }
  }

  /* ── Init everything on DOMContentLoaded ─────────────────── */
  function init() {
    // Product grids
    document.querySelectorAll('[data-dealshub-grid]').forEach(loadGrid);

    // Carousel nav arrows
    document.querySelectorAll('.product-carousel-wrapper').forEach(initCarouselNav);

    // Hero slider
    document.querySelectorAll('.hero-slider').forEach(initHeroSlider);

    // Countdown timers
    document.querySelectorAll('[data-countdown]').forEach(initCountdown);

    // Brand tabs
    document.querySelectorAll('[data-brand-section]').forEach(initBrandTabs);

    // Quick view close
    const qvModal = document.getElementById('quick-view-modal');
    const qvClose = document.getElementById('quick-view-close');
    if (qvModal && qvClose) {
      qvClose.addEventListener('click', closeQuickView);
      qvModal.addEventListener('click', e => { if (e.target === qvModal) closeQuickView(); });
    }
    document.addEventListener('keydown', e => { if (e.key === 'Escape') closeQuickView(); });

    function closeQuickView() {
      qvModal && qvModal.classList.remove('is-open');
      const overlay = document.getElementById('overlay');
      if (overlay && !document.querySelector('.cart-drawer.is-open') && !document.querySelector('.mobile-nav.is-open')) {
        overlay.classList.remove('is-visible');
      }
      document.body.style.overflow = '';
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  return { buildCard, buildSkeleton, loadGrid, initHeroSlider, initCountdown, initBrandTabs, showToast, isInWishlist };

})();
