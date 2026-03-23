/**
 * DealsHub Miami â Header JavaScript v1.3
 * Handles: mobile nav, search typeahead, recent searches, cart/wishlist sync
 * DOM IDs: dh-hamburger, dh-mobile-menu, dh-drawer-close,
 *          dh-search-input, dh-search-btn, dh-search-results, dh-wish-count
 */

(function () {
  'use strict';

  var API_BASE = (window.DealsHub && window.DealsHub.apiBase)
    ? window.DealsHub.apiBase
    : 'https://dealshub-search.onrender.com';

  /* ââ Recent Searches Storage âââââââââââââââââââââââââââââââ */
  var RS_KEY = 'dh_recent_searches';
  var RS_MAX = 8;

  function getRecentSearches() {
    try { return JSON.parse(localStorage.getItem(RS_KEY) || '[]'); }
    catch (e) { return []; }
  }
  function saveRecentSearch(q) {
    if (!q || q.length < 2) return;
    try {
      var arr = getRecentSearches().filter(function (s) { return s.toLowerCase() !== q.toLowerCase(); });
      arr.unshift(q);
      if (arr.length > RS_MAX) arr = arr.slice(0, RS_MAX);
      localStorage.setItem(RS_KEY, JSON.stringify(arr));
    } catch (e) { /* empty */ }
  }
  function removeRecentSearch(q) {
    try {
      var arr = getRecentSearches().filter(function (s) { return s !== q; });
      localStorage.setItem(RS_KEY, JSON.stringify(arr));
    } catch (e) { /* empty */ }
  }
  function clearAllRecentSearches() {
    try { localStorage.removeItem(RS_KEY); } catch (e) { /* empty */ }
  }

  /* ââ Mobile Nav âââââââââââââââââââââââââââââââââââââââââââ */
  var ham = document.getElementById('dh-hamburger');
  var menu = document.getElementById('dh-mobile-menu');
  var drawerClose = document.getElementById('dh-drawer-close');

  if (ham && menu) {
    ham.addEventListener('click', function () { menu.classList.add('active'); });
  }
  if (drawerClose && menu) {
    drawerClose.addEventListener('click', function () { menu.classList.remove('active'); });
  }
  if (menu) {
    menu.addEventListener('click', function (e) {
      if (e.target === menu) menu.classList.remove('active');
    });
  }

  /* ââ Header Search (typeahead + recent) âââââââââââââââââââ */
  var searchInput = document.getElementById('dh-search-input');
  var searchBtn = document.getElementById('dh-search-btn');
  var resultsBox = document.getElementById('dh-search-results');

  if (searchInput && resultsBox) {
    var debounceTimer = null;
    var currentQuery = '';
    var abortCtrl = null;

    /* Show recent searches on focus when input is empty */
    searchInput.addEventListener('focus', function () {
      if (!searchInput.value.trim()) showRecentSearches();
    });

    /* Typeahead on input */
    searchInput.addEventListener('input', function () {
      clearTimeout(debounceTimer);
      var q = searchInput.value.trim();
      if (!q || q.length < 2) {
        if (!q) showRecentSearches();
        else hideResults();
        return;
      }
      debounceTimer = setTimeout(function () { fetchSuggestions(q); }, 350);
    });

    /* Enter key â navigate to search results page */
    searchInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        var q = searchInput.value.trim();
        if (q) {
          saveRecentSearch(q);
          window.location.href = '/pages/search-results?q=' + encodeURIComponent(q);
        }
      }
      /* Arrow key navigation */
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        navigateItems(e.key === 'ArrowDown' ? 1 : -1);
      }
      if (e.key === 'Escape') hideResults();
    });

    /* Search button click */
    if (searchBtn) {
      searchBtn.addEventListener('click', function () {
        var q = searchInput.value.trim();
        if (q) {
          saveRecentSearch(q);
          window.location.href = '/pages/search-results?q=' + encodeURIComponent(q);
        }
      });
    }

    /* Click outside closes dropdown */
    document.addEventListener('click', function (e) {
      if (!e.target.closest('.dh-search-wrap') && !e.target.closest('#dh-search-results')) {
        hideResults();
      }
    });

    /* ââ Fetch suggestions from API ââ */
    function fetchSuggestions(q) {
      currentQuery = q;
      if (abortCtrl) abortCtrl.abort();
      abortCtrl = new AbortController();

      resultsBox.classList.add('active');
      resultsBox.innerHTML = '<div style="text-align:center;padding:24px"><div class="dh-spinner"></div></div>';

      fetch(API_BASE + '/api/search?q=' + encodeURIComponent(q) + '&limit=6', { signal: abortCtrl.signal })
        .then(function (res) { return res.json(); })
        .then(function (data) {
          if (currentQuery !== q) return;
          var items = data.results || [];
          if (!items.length) {
            resultsBox.innerHTML = '<div style="padding:24px;text-align:center;color:#999">No results for &ldquo;' + escapeHtml(q) + '&rdquo;</div>';
            return;
          }
          renderSuggestions(items, q);
        })
        .catch(function (err) {
          if (err.name === 'AbortError') return;
          resultsBox.innerHTML = '<div style="padding:24px;text-align:center;color:#999">Error. Please try again.</div>';
        });
    }

    /* ââ Render product suggestions ââ */
    function renderSuggestions(items, q) {
      var sc = { amazon: '#ff9900', aliexpress: '#e62e04', sephora: '#000', macys: '#333', shein: '#222' };

      var html = '<div class="dh-sr-header">' +
        '<strong>' + items.length + ' results</strong>' +
        '<a href="/pages/search-results?q=' + encodeURIComponent(q) + '">View all &rarr;</a>' +
        '</div>';

      html += items.slice(0, 6).map(function (p) {
        var href = '/pages/product?id=' + encodeURIComponent(p.id) + '&store=' + encodeURIComponent(p.source);
        var rawTitle = decodeEntities((p.title || '').substring(0, 70));
        var title = escapeHtml(rawTitle);
        var numPrice = parsePrice(p.price);
        var numOrig = parsePrice(p.originalPrice);
        var price = numPrice ? '$' + numPrice.toFixed(2) : '';
        var orig = numOrig && numOrig > numPrice ? numOrig : 0;
        var discount = orig && numPrice ? Math.round((1 - numPrice / orig) * 100) : 0;
        var badge = p.sourceName || p.source || '';
        var badgeColor = sc[p.source] || '#666';

        return '<a href="' + href + '" class="dh-sr-item" data-q="' + escapeAttr(p.title) + '">' +
          '<img src="' + (p.image || '') + '" class="dh-sr-img" loading="lazy" onerror="this.style.display=\'none\'">' +
          '<div class="dh-sr-info">' +
          '<div class="dh-sr-title">' + highlight(title, q) + '</div>' +
          '<div class="dh-sr-meta">' +
          '<span class="dh-sr-price">' + price + '</span>' +
          (orig ? '<span style="text-decoration:line-through;color:#999;font-size:11px">$' + orig.toFixed(2) + '</span>' +
            '<span style="color:#e53e3e;font-size:11px;font-weight:600">-' + discount + '%</span>' : '') +
          '<span class="dh-sr-badge" style="background:' + badgeColor + '">' + escapeHtml(badge) + '</span>' +
          '</div></div></a>';
      }).join('');

      /* "See all results" footer */
      html += '<a href="/pages/search-results?q=' + encodeURIComponent(q) + '" class="dh-sr-footer">' +
        'See all results for &ldquo;<strong>' + escapeHtml(q) + '</strong>&rdquo; ' +
        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M5 12h14M12 5l7 7-7 7"/></svg>' +
        '</a>';

      resultsBox.innerHTML = html;
      resultsBox.classList.add('active');
    }

    /* ââ Show recent searches ââ */
    function showRecentSearches() {
      var recent = getRecentSearches();
      if (!recent.length) { hideResults(); return; }

      var html = '<div class="dh-sr-recent-header">' +
        '<span class="dh-sr-recent-label">Recent Searches</span>' +
        '<button type="button" class="dh-sr-recent-clear">Clear</button>' +
        '</div>';

      html += recent.map(function (term) {
        return '<a href="/pages/search-results?q=' + encodeURIComponent(term) + '" class="dh-sr-item dh-sr-recent-item" data-q="' + escapeAttr(term) + '">' +
          '<svg class="dh-sr-recent-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>' +
          '<span class="dh-sr-recent-text">' + escapeHtml(term) + '</span>' +
          '<button type="button" class="dh-sr-recent-remove" data-term="' + escapeAttr(term) + '" aria-label="Remove">' +
          '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>' +
          '</button></a>';
      }).join('');

      resultsBox.innerHTML = html;
      resultsBox.classList.add('active');

      /* Bind clear all */
      var clearBtn = resultsBox.querySelector('.dh-sr-recent-clear');
      if (clearBtn) {
        clearBtn.addEventListener('click', function (e) {
          e.preventDefault(); e.stopPropagation();
          clearAllRecentSearches();
          hideResults();
        });
      }

      /* Bind individual remove buttons */
      resultsBox.querySelectorAll('.dh-sr-recent-remove').forEach(function (btn) {
        btn.addEventListener('click', function (e) {
          e.preventDefault(); e.stopPropagation();
          removeRecentSearch(this.dataset.term);
          showRecentSearches();
        });
      });

      /* Clicking a recent search fills the input */
      resultsBox.querySelectorAll('.dh-sr-recent-item').forEach(function (item) {
        item.addEventListener('click', function () {
          saveRecentSearch(this.dataset.q || '');
        });
      });
    }

    /* ââ Arrow key navigation ââ */
    function navigateItems(dir) {
      var items = resultsBox.querySelectorAll('.dh-sr-item');
      if (!items.length) return;
      var current = resultsBox.querySelector('.dh-sr-item.is-active');
      var idx = current ? Array.from(items).indexOf(current) : -1;
      if (current) current.classList.remove('is-active');
      idx += dir;
      if (idx < 0) idx = items.length - 1;
      if (idx >= items.length) idx = 0;
      items[idx].classList.add('is-active');
      items[idx].scrollIntoView({ block: 'nearest' });
      searchInput.value = items[idx].dataset.q || searchInput.value;
    }

    /* ââ Hide results dropdown ââ */
    function hideResults() {
      resultsBox.classList.remove('active');
      resultsBox.innerHTML = '';
    }
  }

  /* ââ Utility functions ââââââââââââââââââââââââââââââââââââ */
  function parsePrice(v) {
    if (!v) return 0;
    var n = parseFloat(String(v).replace(/[^0-9.\-]/g, ''));
    return isNaN(n) ? 0 : n;
  }
  function decodeEntities(s) {
    var el = document.createElement('textarea');
    el.innerHTML = s;
    return el.value;
  }
  function escapeHtml(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function escapeAttr(s) {
    return String(s || '').replace(/"/g, '&quot;');
  }
  function highlight(text, q) {
    if (!q) return text;
    var escapedQ = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return text.replace(new RegExp('(' + escapedQ + ')', 'gi'), '<mark>$1</mark>');
  }

  /* ââ Sticky header shadow ââââââââââââââââââââââââââââââââ */
  var headerEl = document.querySelector('header.dh-header');
  if (headerEl) {
    window.addEventListener('scroll', function () {
      headerEl.style.boxShadow = window.scrollY > 10 ? '0 2px 20px rgba(0,0,0,0.3)' : '';
    }, { passive: true });
  }

  /* ââ Wishlist count sync âââââââââââââââââââââââââââââââââ */
  var wishCount = document.getElementById('dh-wish-count');
  function updateWishlistCount() {
    if (!wishCount) return;
    try {
      var items = JSON.parse(localStorage.getItem('dh_wishlist') || '[]');
      wishCount.textContent = items.length;
      wishCount.style.display = items.length > 0 ? '' : 'none';
    } catch (e) { /* empty */ }
  }
  updateWishlistCount();
  document.addEventListener('wishlist:updated', updateWishlistCount);

  /* ââ Cart count sync âââââââââââââââââââââââââââââââââââââ */
  document.addEventListener('cart:updated', function (e) {
    var badges = document.querySelectorAll('.dh-badge');
    var count = e.detail && e.detail.count !== undefined ? e.detail.count : 0;
    /* Cart badge is typically the second .dh-badge (first is wishlist) */
    if (badges.length >= 2) {
      badges[1].textContent = count;
      badges[1].style.display = count > 0 ? '' : 'none';
    }
  });

  /* ââ Inject enhanced CSS âââââââââââââââââââââââââââââââââ */
  var style = document.createElement('style');
  style.textContent = [
    /* Search results dropdown enhancements */
    '.dh-sr-header { padding:10px 16px; border-bottom:2px solid #f0f0f0; display:flex; justify-content:space-between; align-items:center; }',
    '.dh-sr-header a { color:#e53e3e; font-size:13px; font-weight:600; text-decoration:none; }',
    '.dh-sr-header a:hover { text-decoration:underline; }',
    '.dh-sr-item.is-active { background:var(--color-bg, #f5f5f5); }',
    '.dh-sr-item mark { background:rgba(255,107,53,0.2); color:var(--color-primary, #ff6b35); border-radius:2px; }',
    '.dh-sr-footer { display:flex; align-items:center; justify-content:center; gap:8px; padding:12px 16px; font-size:0.82rem; color:var(--color-primary, #ff6b35); font-weight:600; border-top:1px solid #f0f0f0; text-decoration:none; transition:background 0.15s; }',
    '.dh-sr-footer:hover { background:#f5f5f5; }',
    /* Recent searches */
    '.dh-sr-recent-header { display:flex; align-items:center; justify-content:space-between; padding:10px 16px 6px; border-bottom:1px solid #f0f0f0; }',
    '.dh-sr-recent-label { font-size:0.72rem; font-weight:600; text-transform:uppercase; letter-spacing:0.05em; color:#888; }',
    '.dh-sr-recent-clear { font-size:0.72rem; color:var(--color-primary, #ff6b35); background:none; border:none; cursor:pointer; padding:2px 4px; font-weight:500; }',
    '.dh-sr-recent-clear:hover { text-decoration:underline; }',
    '.dh-sr-recent-item { gap:10px; }',
    '.dh-sr-recent-icon { flex-shrink:0; opacity:0.4; }',
    '.dh-sr-recent-text { flex:1; font-size:0.875rem; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }',
    '.dh-sr-recent-remove { flex-shrink:0; background:none; border:none; cursor:pointer; padding:4px; border-radius:4px; opacity:0.4; display:flex; align-items:center; justify-content:center; }',
    '.dh-sr-recent-remove:hover { opacity:1; background:rgba(0,0,0,0.06); }'
  ].join('\n');
  document.head.appendChild(style);

})();
