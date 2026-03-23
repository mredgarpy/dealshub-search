/**
 * DealsHub Miami — Global Theme JavaScript
 * Miscellaneous utilities used across the theme
 */

(function () {
  'use strict';

  /* ── Utility: Toast ──────────────────────────────────────── */
  function showToast(message, type = 'info', duration = 3000) {
    const container = document.getElementById('toast-container');
    if (!container) return;
    const icons = { success: '✅', error: '❌', info: '💬', warning: '⚠️' };
    const toast = document.createElement('div');
    toast.className = `toast toast--${type}`;
    toast.innerHTML = `
      <span class="toast__icon">${icons[type] || '💬'}</span>
      <span class="toast__message">${message}</span>
      <button class="toast__close" aria-label="Close">×</button>`;
    toast.querySelector('.toast__close').addEventListener('click', () => toast.remove());
    container.appendChild(toast);
    setTimeout(() => { toast.style.opacity = '0'; setTimeout(() => toast.remove(), 300); }, duration);
  }

  window.DealsHubTheme = window.DealsHubTheme || {};
  window.DealsHubTheme.showToast = showToast;

  /* ── Lazy load images (IntersectionObserver polyfill) ─────── */
  if ('IntersectionObserver' in window) {
    const lazyImgs = document.querySelectorAll('img[loading="lazy"]');
    // Browser natively handles loading="lazy" — no extra code needed
  }

  /* ── Smooth anchor links ──────────────────────────────────── */
  document.querySelectorAll('a[href^="#"]').forEach(a => {
    a.addEventListener('click', function (e) {
      const target = document.querySelector(this.getAttribute('href'));
      if (target) {
        e.preventDefault();
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
  });

  /* ── Back-to-top button ───────────────────────────────────── */
  const bttBtn = document.getElementById('back-to-top');
  if (bttBtn) {
    window.addEventListener('scroll', () => {
      bttBtn.style.display = window.scrollY > 400 ? 'flex' : 'none';
    }, { passive: true });
    bttBtn.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
  }

  /* ── Filter accordion ─────────────────────────────────────── */
  document.querySelectorAll('.filter-group__header').forEach(header => {
    header.addEventListener('click', function () {
      const group = this.closest('.filter-group');
      if (group) group.classList.toggle('is-open');
    });
  });

  /* ── Collection / DealsHub filter chips ─────────────────── */
  document.querySelectorAll('[data-store-chip]').forEach(chip => {
    chip.addEventListener('click', function () {
      document.querySelectorAll('[data-store-chip]').forEach(c => c.classList.remove('is-active'));
      this.classList.add('is-active');
      const store = this.dataset.storeChip;
      document.dispatchEvent(new CustomEvent('store:filter', { detail: { store } }));
    });
  });

  /* ── Collapsible content blocks ───────────────────────────── */
  document.querySelectorAll('[data-collapsible]').forEach(toggle => {
    toggle.addEventListener('click', function () {
      const targetId = this.dataset.collapsible;
      const target   = document.getElementById(targetId);
      if (!target) return;
      const isOpen   = target.getAttribute('aria-hidden') === 'false';
      target.setAttribute('aria-hidden', isOpen ? 'true' : 'false');
      target.style.display = isOpen ? 'none' : '';
      this.setAttribute('aria-expanded', !isOpen);
    });
  });

  /* ── Page: DealsHub (dealshub.liquid) ─────────────────────── */
  const dealshubPage = document.getElementById('dealshub-page');
  if (dealshubPage) initDealsHubPage();

  function initDealsHubPage() {
    const grid      = document.getElementById('dh-grid');
    const loadMore  = document.getElementById('dh-load-more');
    const filterBtns = document.querySelectorAll('[data-store-chip]');
    const searchInput = document.getElementById('dh-search-input');
    const searchForm  = document.getElementById('dh-search-form');
    const sortSelect  = document.getElementById('dh-sort');

    let currentQuery = new URLSearchParams(window.location.search).get('q') || window.DealsHub.api_default_query || 'trending deals';
    let currentStore = new URLSearchParams(window.location.search).get('store') || '';
    let currentPage  = 1;
    let isLoading    = false;

    async function load(append = false) {
      if (isLoading || !grid) return;
      isLoading = true;

      if (!append) {
        const api = window.DealsHubCarousels;
        grid.innerHTML = api ? api.buildSkeleton(12) : '<div class="products-loading"><div class="loading-spinner"></div> Loading deals...</div>';
        currentPage = 1;
      } else {
        currentPage++;
      }

      try {
        const api    = window.DealsHubAPI;
        const resp   = currentStore
          ? await api.getProducts(currentQuery, { store: currentStore, limit: 12, page: currentPage })
          : await api.getMultiStore(currentQuery, [], 12);

        let results = resp.results || [];

        // Sort
        if (sortSelect) {
          const sort = sortSelect.value;
          if (sort === 'price_asc')   results.sort((a, b) => a.price - b.price);
          if (sort === 'price_desc')  results.sort((a, b) => b.price - a.price);
          if (sort === 'discount')    results.sort((a, b) => b.discount - a.discount);
          if (sort === 'rating')      results.sort((a, b) => b.rating - a.rating);
        }

        const cards = window.DealsHubCarousels;
        if (!results.length) {
          if (!append) grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1;"><div class="empty-state__icon">🔍</div><h2 class="empty-state__title">No results found</h2><p class="empty-state__text">Try a different search or store.</p></div>`;
          if (loadMore) loadMore.style.display = 'none';
          return;
        }

        if (append) {
          grid.insertAdjacentHTML('beforeend', results.map(p => cards.buildCard(p)).join(''));
        } else {
          grid.innerHTML = results.map(p => cards.buildCard(p)).join('');
        }

        if (cards) {
          const newCards = grid.querySelectorAll('.product-card');
          // re-attach listeners to new cards
          window.DealsHubCarousels.loadGrid && null; // handled by delegation
        }

        if (loadMore) loadMore.style.display = results.length >= 12 ? '' : 'none';

        // Update URL without reload
        const url = new URL(window.location.href);
        if (currentQuery) url.searchParams.set('q', currentQuery);
        else url.searchParams.delete('q');
        if (currentStore) url.searchParams.set('store', currentStore);
        else url.searchParams.delete('store');
        window.history.replaceState({}, '', url.toString());

      } catch (err) {
        if (!append) grid.innerHTML = '<div class="products-error" style="grid-column:1/-1;"><div class="products-error__icon">😔</div><p>Could not load products. Please try again.</p></div>';
      } finally {
        isLoading = false;
      }
    }

    // Store filter chips
    filterBtns.forEach(btn => {
      btn.addEventListener('click', function () {
        filterBtns.forEach(b => b.classList.remove('is-active'));
        this.classList.add('is-active');
        currentStore = this.dataset.storeChip === 'all' ? '' : this.dataset.storeChip;
        load();
      });
    });

    // Search
    if (searchForm) {
      searchForm.addEventListener('submit', function (e) {
        e.preventDefault();
        currentQuery = searchInput ? searchInput.value.trim() || 'deals' : currentQuery;
        load();
      });
    }

    // Sort
    sortSelect && sortSelect.addEventListener('change', () => load());

    // Load more
    loadMore && loadMore.addEventListener('click', () => load(true));

    // Initial load
    load();
  }

  /* ── Animate sections on scroll ───────────────────────────── */
  if ('IntersectionObserver' in window) {
    const observer = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          entry.target.classList.add('animate-fade-up');
          observer.unobserve(entry.target);
        }
      });
    }, { threshold: 0.1 });

    document.querySelectorAll('.section__header, .hero-slide__content').forEach(el => {
      observer.observe(el);
    });
  }

})();
