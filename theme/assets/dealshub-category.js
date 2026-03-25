/* StyleHub Category Landing Page v2.0 — Infinite Scroll + Server-Side Pagination
   Dynamic category with origin filter, sort, best sellers carousel, product grid + infinite scroll
   URL: /pages/category?cat=electronics|fashion|beauty|home|sports|gaming|baby
*/
(function(){
  'use strict';
  var API = 'https://dealshub-search.onrender.com';
  var PAGE_SIZE = 20;

  var categoryMap = {
    electronics: {name: 'Electronics', icon: '🎧', amazonId: 'electronics', gradient: 'linear-gradient(135deg,#3b82f6 0%,#1d4ed8 100%)', searchTerms: 'electronics gadgets tech'},
    fashion:     {name: 'Fashion', icon: '👗', amazonId: 'fashion', gradient: 'linear-gradient(135deg,#ec4899 0%,#db2777 100%)', searchTerms: 'fashion clothing shoes accessories'},
    beauty:      {name: 'Beauty', icon: '💄', amazonId: 'beauty', gradient: 'linear-gradient(135deg,#a855f7 0%,#7c3aed 100%)', searchTerms: 'beauty skincare makeup cosmetics'},
    home:        {name: 'Home & Garden', icon: '🏠', amazonId: 'garden', gradient: 'linear-gradient(135deg,#22c55e 0%,#16a34a 100%)', searchTerms: 'home garden kitchen decor'},
    sports:      {name: 'Sports', icon: '⚽', amazonId: 'sporting', gradient: 'linear-gradient(135deg,#f97316 0%,#ea580c 100%)', searchTerms: 'sports fitness outdoor exercise'},
    gaming:      {name: 'Gaming', icon: '🎮', amazonId: 'videogames', gradient: 'linear-gradient(135deg,#6366f1 0%,#4f46e5 100%)', searchTerms: 'gaming videogames console'},
    baby:        {name: 'Baby', icon: '👶', amazonId: 'baby-products', gradient: 'linear-gradient(135deg,#f472b6 0%,#ec4899 100%)', searchTerms: 'baby kids children toys'}
  };

  var params = new URLSearchParams(window.location.search);
  var catSlug = (params.get('cat') || 'electronics').toLowerCase();
  var cat = categoryMap[catSlug] || categoryMap.electronics;

  var originFilter = 'all';
  var sortBy = 'relevance';
  var allProducts = [];
  var filteredProducts = [];
  var displayedCount = 0;
  var apiPage = 1;
  var isFetchingPage = false;
  var noMoreResults = false;
  var isLoadingMore = false;
  var seenKeys = {};
  var scrollObserver = null;

  function esc(s){var d=document.createElement('div');d.textContent=s||'';return d.innerHTML}
  function fmtPrice(n){return n?'$'+parseFloat(n).toFixed(2):''}

  function productCard(p){
    var source = (p.source||'').toLowerCase();
    var isUSA = source === 'amazon' || (p.originType === 'USA');
    var price = typeof p.price === 'number' ? p.price : parseFloat(String(p.price||'0').replace(/[^0-9.]/g,''));
    var origPrice = typeof p.originalPrice === 'number' ? p.originalPrice : parseFloat(String(p.originalPrice||'0').replace(/[^0-9.]/g,''));
    var discount = origPrice > price ? Math.round((1 - price/origPrice)*100) : 0;
    var rating = p.rating ? parseFloat(p.rating) : 0;
    var link = '/pages/product?id=' + encodeURIComponent(p.id || p.sourceId || '') + '&store=' + encodeURIComponent(source || 'amazon');
    if(p.title) link += '&title=' + encodeURIComponent(p.title);

    var h = '<a href="' + link + '" style="text-decoration:none;display:block;background:#fff;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;transition:box-shadow .2s,transform .2s" onmouseover="this.style.boxShadow=\'0 4px 16px rgba(0,0,0,.1)\';this.style.transform=\'translateY(-2px)\'" onmouseout="this.style.boxShadow=\'none\';this.style.transform=\'none\'">';
    h += '<div style="position:relative;aspect-ratio:1;background:#f8f9fa;overflow:hidden">';
    h += '<img src="' + esc(p.image || p.primaryImage || '') + '" alt="" style="width:100%;height:100%;object-fit:contain" loading="lazy">';
    var badgeBg = isUSA ? '#16a34a' : '#d97706';
    var badgeLabel = isUSA ? '🇺🇸 USA' : '🌍 Int\'l';
    h += '<span style="position:absolute;top:8px;right:8px;background:' + badgeBg + ';color:#fff;padding:2px 8px;border-radius:4px;font-size:9px;font-weight:700">' + badgeLabel + '</span>';
    if(discount > 0) h += '<span style="position:absolute;top:8px;left:8px;background:#e53e3e;color:#fff;padding:2px 8px;border-radius:4px;font-size:10px;font-weight:700">-' + discount + '%</span>';
    h += '</div>';
    h += '<div style="padding:12px">';
    h += '<div style="font-size:13px;color:#4a5568;line-height:1.3;height:36px;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical">' + esc((p.title||'').substring(0,80)) + '</div>';
    if(rating > 0){
      h += '<div style="display:flex;align-items:center;gap:4px;margin-top:6px">';
      h += '<span style="color:#f59e0b;font-size:12px">';
      for(var i=1;i<=5;i++) h += i <= Math.round(rating) ? '★' : '☆';
      h += '</span>';
      if(p.reviews) h += '<span style="font-size:11px;color:#9ca3af">(' + (p.reviews >= 1000 ? (p.reviews/1000).toFixed(1)+'K' : p.reviews) + ')</span>';
      h += '</div>';
    }
    h += '<div style="margin-top:6px;display:flex;align-items:baseline;gap:6px">';
    if(price > 0) h += '<span style="font-size:16px;font-weight:700;color:#e53e3e">' + fmtPrice(price) + '</span>';
    if(origPrice > price) h += '<span style="font-size:12px;color:#9ca3af;text-decoration:line-through">' + fmtPrice(origPrice) + '</span>';
    h += '</div>';
    h += '</div></a>';
    return h;
  }

  function setupHero(){
    var hero = document.getElementById('dh-cat-hero');
    var title = document.getElementById('dh-cat-title');
    var subtitle = document.getElementById('dh-cat-subtitle');
    if(hero) hero.style.background = cat.gradient;
    if(title) title.textContent = cat.icon + ' ' + cat.name;
    if(subtitle) subtitle.textContent = 'Shop the best ' + cat.name.toLowerCase() + ' products at great prices';
    document.title = cat.name + ' — StyleHub Miami';
  }

  function setupOriginFilters(){
    var el = document.getElementById('dh-cat-origin-filters');
    if(!el) return;
    var filters = [
      {id: 'all', label: 'All Origins'},
      {id: 'usa', label: '🇺🇸 USA'},
      {id: 'intl', label: '🌍 International'}
    ];
    var h = '';
    filters.forEach(function(f){
      var isActive = f.id === originFilter;
      var bg = isActive ? '#1a1a2e' : '#fff';
      var color = isActive ? '#fff' : '#374151';
      var border = isActive ? '#1a1a2e' : '#e2e8f0';
      h += '<button data-origin="' + f.id + '" style="padding:8px 16px;background:' + bg + ';color:' + color + ';border:1px solid ' + border + ';border-radius:8px;font-size:13px;font-weight:500;cursor:pointer;transition:all .2s">' + f.label + '</button>';
    });
    el.innerHTML = h;
    el.querySelectorAll('button').forEach(function(btn){
      btn.addEventListener('click', function(){
        originFilter = this.getAttribute('data-origin');
        setupOriginFilters();
        applyFiltersAndRender();
      });
    });
  }

  function setupSort(){
    var sel = document.getElementById('dh-cat-sort');
    if(!sel) return;
    sel.addEventListener('change', function(){
      sortBy = this.value;
      applyFiltersAndRender();
    });
  }

  function applyFiltersAndSort(){
    filteredProducts = allProducts.filter(function(p){
      if(originFilter === 'all') return true;
      var source = (p.source||'').toLowerCase();
      var isUSA = source === 'amazon' || (p.originType === 'USA');
      return originFilter === 'usa' ? isUSA : !isUSA;
    });
    if(sortBy === 'price-low'){
      filteredProducts.sort(function(a,b){
        return (parseFloat(String(a.price||'0').replace(/[^0-9.]/g,''))||0) - (parseFloat(String(b.price||'0').replace(/[^0-9.]/g,''))||0);
      });
    } else if(sortBy === 'price-high'){
      filteredProducts.sort(function(a,b){
        return (parseFloat(String(b.price||'0').replace(/[^0-9.]/g,''))||0) - (parseFloat(String(a.price||'0').replace(/[^0-9.]/g,''))||0);
      });
    } else if(sortBy === 'rating'){
      filteredProducts.sort(function(a,b){
        return (parseFloat(b.rating)||0) - (parseFloat(a.rating)||0);
      });
    }
  }

  function applyFiltersAndRender(){
    applyFiltersAndSort();
    displayedCount = 0;
    renderGrid(true);
  }

  function renderGrid(fullRedraw){
    var gridEl = document.getElementById('dh-cat-grid');
    if(!gridEl) return;

    if(!filteredProducts.length && !isFetchingPage){
      gridEl.innerHTML = '<div style="text-align:center;padding:40px;color:#6b7280"><p style="font-size:16px">No products found with current filters</p></div>';
      hideSentinel();
      return;
    }

    if(fullRedraw){
      displayedCount = Math.min(PAGE_SIZE, filteredProducts.length);
      var h = '<div style="display:grid;grid-template-columns:repeat(5,1fr);gap:16px" class="dh-cat-grid">';
      filteredProducts.slice(0, displayedCount).forEach(function(p){ h += productCard(p); });
      h += '</div>';
      gridEl.innerHTML = h;
    } else {
      var nextBatch = filteredProducts.slice(displayedCount, displayedCount + PAGE_SIZE);
      if(!nextBatch.length){ isLoadingMore = false; return; }
      var container = gridEl.querySelector('.dh-cat-grid');
      if(!container){
        var h2 = '<div style="display:grid;grid-template-columns:repeat(5,1fr);gap:16px" class="dh-cat-grid">';
        nextBatch.forEach(function(p){ h2 += productCard(p); });
        h2 += '</div>';
        gridEl.innerHTML = h2;
        displayedCount = nextBatch.length;
      } else {
        nextBatch.forEach(function(p){
          container.insertAdjacentHTML('beforeend', productCard(p));
        });
        displayedCount += nextBatch.length;
      }
    }

    isLoadingMore = false;
    updateSentinel();
  }

  /* ---------- Server-Side Pagination ---------- */
  function fetchStorePage(store, page){
    var url = API + '/api/search?q=' + encodeURIComponent(cat.searchTerms) + '&store=' + encodeURIComponent(store) + '&limit=30&page=' + page;
    return fetch(url, {signal: AbortSignal.timeout(15000)})
      .then(function(r){ return r.ok ? r.json() : {results:[]}; })
      .catch(function(){ return {results:[]}; });
  }

  function addUniqueProducts(items){
    var count = 0;
    items.forEach(function(p){
      var key = (p.id || p.sourceId || '') + '_' + (p.source || '');
      if(!seenKeys[key]){
        seenKeys[key] = true;
        allProducts.push(p);
        count++;
      }
    });
    return count;
  }

  function fetchNextPage(){
    if(isFetchingPage || noMoreResults) return Promise.resolve(false);
    isFetchingPage = true;
    showLoadingSpinner();
    apiPage++;

    return Promise.all([
      fetchStorePage('amazon', apiPage),
      fetchStorePage('aliexpress', apiPage)
    ]).then(function(results){
      var newItems = [];
      var anyHasMore = false;
      results.forEach(function(data){
        var items = data.results || [];
        newItems = newItems.concat(items);
        if(data.hasMore !== false && items.length >= 5) anyHasMore = true;
      });

      var addedCount = addUniqueProducts(newItems);
      hideLoadingSpinner();

      if(addedCount === 0){
        noMoreResults = true;
        isFetchingPage = false;
        return false;
      }

      noMoreResults = !anyHasMore;
      /* Re-apply filters/sort without resetting displayedCount */
      applyFiltersAndSort();
      renderGrid(false);
      isFetchingPage = false;
      return true;
    }).catch(function(){
      hideLoadingSpinner();
      isFetchingPage = false;
      return false;
    });
  }

  /* ---------- Infinite Scroll ---------- */
  function getSentinel(){
    var s = document.getElementById('dh-cat-sentinel');
    if(!s){
      s = document.createElement('div');
      s.id = 'dh-cat-sentinel';
      s.style.cssText = 'height:1px;width:100%;';
      var grid = document.getElementById('dh-cat-grid');
      if(grid) grid.parentNode.insertBefore(s, grid.nextSibling);
    }
    return s;
  }

  function hideSentinel(){
    var s = document.getElementById('dh-cat-sentinel');
    if(s) s.style.display = 'none';
  }

  function updateSentinel(){
    var s = getSentinel();
    if(s) s.style.display = '';
  }

  function showLoadingSpinner(){
    var el = document.getElementById('dh-cat-loadmore');
    if(el){
      el.style.display = '';
      el.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;gap:8px;padding:20px"><div style="width:20px;height:20px;border:3px solid #e2e8f0;border-top-color:#1a1a2e;border-radius:50%;animation:dhspin 0.8s linear infinite"></div><span style="color:#6b7280;font-size:14px">Loading more products...</span></div>';
    }
  }

  function hideLoadingSpinner(){
    var el = document.getElementById('dh-cat-loadmore');
    if(el) el.style.display = 'none';
  }

  function showEndMessage(){
    var el = document.getElementById('dh-cat-loadmore');
    if(el && displayedCount > PAGE_SIZE){
      el.style.display = '';
      el.innerHTML = '<div style="text-align:center;padding:20px;color:#9ca3af;font-size:13px">You\'ve explored all available ' + cat.name.toLowerCase() + ' products</div>';
    }
  }

  function setupInfiniteScroll(){
    var sentinel = getSentinel();
    scrollObserver = new IntersectionObserver(function(entries){
      entries.forEach(function(entry){
        if(!entry.isIntersecting || isLoadingMore) return;

        if(displayedCount < filteredProducts.length){
          isLoadingMore = true;
          renderGrid(false);
        } else if(!noMoreResults && !isFetchingPage){
          isLoadingMore = true;
          fetchNextPage().then(function(gotMore){
            if(!gotMore){
              hideSentinel();
              showEndMessage();
            }
            isLoadingMore = false;
          });
        } else if(noMoreResults){
          hideSentinel();
          showEndMessage();
        }
      });
    }, {rootMargin: '400px'});

    scrollObserver.observe(sentinel);
  }

  /* ---------- Best Sellers Carousel ---------- */
  function loadBestSellers(){
    var el = document.getElementById('dh-cat-bestsellers');
    if(!el) return;
    fetch(API + '/api/amazon-bestsellers?type=BEST_SELLERS&category=' + encodeURIComponent(cat.amazonId) + '&limit=10', {signal: AbortSignal.timeout(15000)})
      .then(function(r){if(!r.ok)throw new Error();return r.json()})
      .then(function(data){
        var items = data.results || [];
        if(!items.length){el.style.display='none';return;}
        var h = '<div style="margin-bottom:8px"><h2 style="font-size:18px;font-weight:700;color:#1a1a2e;margin:0">🏆 Best Sellers in ' + cat.name + '</h2></div>';
        h += '<div style="display:flex;gap:16px;overflow-x:auto;scroll-snap-type:x mandatory;-webkit-overflow-scrolling:touch;padding-bottom:8px">';
        items.forEach(function(p){
          h += '<div style="min-width:180px;max-width:200px;flex-shrink:0;scroll-snap-align:start">' + productCard(p) + '</div>';
        });
        h += '</div>';
        el.innerHTML = h;
      })
      .catch(function(){el.style.display='none'});
  }

  /* ---------- Initial Load ---------- */
  function loadProducts(){
    var skelEl = document.getElementById('dh-cat-skeleton');
    apiPage = 1;

    Promise.all([
      fetchStorePage('amazon', 1),
      fetchStorePage('aliexpress', 1)
    ]).then(function(results){
      var newItems = [];
      results.forEach(function(data){
        (data.results || []).forEach(function(p){ newItems.push(p); });
      });
      addUniqueProducts(newItems);
      if(skelEl) skelEl.style.display = 'none';

      var loadMoreEl = document.getElementById('dh-cat-loadmore');
      if(loadMoreEl) loadMoreEl.style.display = 'none';

      applyFiltersAndRender();
      setupInfiniteScroll();
    });
  }

  function init(){
    setupHero();
    setupOriginFilters();
    setupSort();
    loadBestSellers();
    loadProducts();
  }

  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  var style = document.createElement('style');
  style.textContent = '@media(max-width:768px){.dh-cat-grid{grid-template-columns:repeat(2,1fr)!important;gap:10px!important}}@keyframes dhspin{to{transform:rotate(360deg)}}';
  document.head.appendChild(style);
})();
