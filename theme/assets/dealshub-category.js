/* StyleHub Category Landing Page v1.0 — Sprint 5
   Dynamic category with origin filter, sort, best sellers carousel, product grid + load more
   URL: /pages/category?cat=electronics|fashion|beauty|home|sports|gaming|baby
*/
(function(){
  'use strict';
  var API = 'https://dealshub-search.onrender.com';

  var categoryMap = {
    electronics: {name: 'Electronics', icon: '\ud83c\udfa7', amazonId: 'electronics', gradient: 'linear-gradient(135deg,#3b82f6 0%,#1d4ed8 100%)', searchTerms: 'electronics gadgets tech'},
    fashion:     {name: 'Fashion', icon: '\ud83d\udc57', amazonId: 'fashion', gradient: 'linear-gradient(135deg,#ec4899 0%,#db2777 100%)', searchTerms: 'fashion clothing shoes accessories'},
    beauty:      {name: 'Beauty', icon: '\ud83d\udc84', amazonId: 'beauty', gradient: 'linear-gradient(135deg,#a855f7 0%,#7c3aed 100%)', searchTerms: 'beauty skincare makeup cosmetics'},
    home:        {name: 'Home & Garden', icon: '\ud83c\udfe0', amazonId: 'garden', gradient: 'linear-gradient(135deg,#22c55e 0%,#16a34a 100%)', searchTerms: 'home garden kitchen decor'},
    sports:      {name: 'Sports', icon: '\u26bd', amazonId: 'sporting', gradient: 'linear-gradient(135deg,#f97316 0%,#ea580c 100%)', searchTerms: 'sports fitness outdoor exercise'},
    gaming:      {name: 'Gaming', icon: '\ud83c\udfae', amazonId: 'videogames', gradient: 'linear-gradient(135deg,#6366f1 0%,#4f46e5 100%)', searchTerms: 'gaming videogames console'},
    baby:        {name: 'Baby', icon: '\ud83d\udc76', amazonId: 'baby-products', gradient: 'linear-gradient(135deg,#f472b6 0%,#ec4899 100%)', searchTerms: 'baby kids children toys'}
  };

  var params = new URLSearchParams(window.location.search);
  var catSlug = (params.get('cat') || 'electronics').toLowerCase();
  var cat = categoryMap[catSlug] || categoryMap.electronics;

  var originFilter = 'all'; // all | usa | intl
  var sortBy = 'relevance';
  var allProducts = [];
  var displayedCount = 0;
  var PAGE_SIZE = 20;

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
    var badgeLabel = isUSA ? '\ud83c\uddfa\ud83c\uddf8 USA' : '\ud83c\udf0d Int\'l';
    h += '<span style="position:absolute;top:8px;right:8px;background:' + badgeBg + ';color:#fff;padding:2px 8px;border-radius:4px;font-size:9px;font-weight:700">' + badgeLabel + '</span>';
    if(discount > 0) h += '<span style="position:absolute;top:8px;left:8px;background:#e53e3e;color:#fff;padding:2px 8px;border-radius:4px;font-size:10px;font-weight:700">-' + discount + '%</span>';
    h += '</div>';
    h += '<div style="padding:12px">';
    h += '<div style="font-size:13px;color:#4a5568;line-height:1.3;height:36px;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical">' + esc((p.title||'').substring(0,80)) + '</div>';
    if(rating > 0){
      h += '<div style="display:flex;align-items:center;gap:4px;margin-top:6px">';
      h += '<span style="color:#f59e0b;font-size:12px">';
      for(var i=1;i<=5;i++) h += i <= Math.round(rating) ? '\u2605' : '\u2606';
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
      {id: 'usa', label: '\ud83c\uddfa\ud83c\uddf8 USA'},
      {id: 'intl', label: '\ud83c\udf0d International'}
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
        renderGrid();
      });
    });
  }

  function setupSort(){
    var sel = document.getElementById('dh-cat-sort');
    if(!sel) return;
    sel.addEventListener('change', function(){
      sortBy = this.value;
      renderGrid();
    });
  }

  function getFilteredSorted(){
    var filtered = allProducts.filter(function(p){
      if(originFilter === 'all') return true;
      var source = (p.source||'').toLowerCase();
      var isUSA = source === 'amazon' || (p.originType === 'USA');
      return originFilter === 'usa' ? isUSA : !isUSA;
    });

    if(sortBy === 'price-low'){
      filtered.sort(function(a,b){
        var pa = typeof a.price === 'number' ? a.price : parseFloat(String(a.price||'0').replace(/[^0-9.]/g,''));
        var pb = typeof b.price === 'number' ? b.price : parseFloat(String(b.price||'0').replace(/[^0-9.]/g,''));
        return pa - pb;
      });
    } else if(sortBy === 'price-high'){
      filtered.sort(function(a,b){
        var pa = typeof a.price === 'number' ? a.price : parseFloat(String(a.price||'0').replace(/[^0-9.]/g,''));
        var pb = typeof b.price === 'number' ? b.price : parseFloat(String(b.price||'0').replace(/[^0-9.]/g,''));
        return pb - pa;
      });
    } else if(sortBy === 'rating'){
      filtered.sort(function(a,b){
        return (parseFloat(b.rating)||0) - (parseFloat(a.rating)||0);
      });
    }
    return filtered;
  }

  function renderGrid(){
    var gridEl = document.getElementById('dh-cat-grid');
    var loadMoreEl = document.getElementById('dh-cat-loadmore');
    if(!gridEl) return;

    var items = getFilteredSorted();
    displayedCount = Math.min(PAGE_SIZE, items.length);

    if(!items.length){
      gridEl.innerHTML = '<div style="text-align:center;padding:40px;color:#6b7280"><p style="font-size:16px">No products found with current filters</p></div>';
      if(loadMoreEl) loadMoreEl.style.display = 'none';
      return;
    }

    var h = '<div style="display:grid;grid-template-columns:repeat(5,1fr);gap:16px" class="dh-cat-grid">';
    items.slice(0, displayedCount).forEach(function(p){ h += productCard(p); });
    h += '</div>';
    gridEl.innerHTML = h;

    if(loadMoreEl){
      loadMoreEl.style.display = displayedCount < items.length ? '' : 'none';
    }
  }

  function loadMore(){
    var gridEl = document.getElementById('dh-cat-grid');
    var loadMoreEl = document.getElementById('dh-cat-loadmore');
    if(!gridEl) return;
    var items = getFilteredSorted();
    var nextBatch = items.slice(displayedCount, displayedCount + PAGE_SIZE);
    displayedCount += nextBatch.length;

    var container = gridEl.querySelector('.dh-cat-grid');
    if(container){
      nextBatch.forEach(function(p){
        container.insertAdjacentHTML('beforeend', productCard(p));
      });
    }
    if(loadMoreEl){
      loadMoreEl.style.display = displayedCount < items.length ? '' : 'none';
    }
  }

  // Load best sellers carousel for this category
  function loadBestSellers(){
    var el = document.getElementById('dh-cat-bestsellers');
    if(!el) return;
    fetch(API + '/api/amazon-bestsellers?type=BEST_SELLERS&category=' + encodeURIComponent(cat.amazonId) + '&limit=10', {signal: AbortSignal.timeout(15000)})
      .then(function(r){if(!r.ok)throw new Error();return r.json()})
      .then(function(data){
        var items = data.results || [];
        if(!items.length){el.style.display='none';return;}
        var h = '<div style="margin-bottom:8px"><h2 style="font-size:18px;font-weight:700;color:#1a1a2e;margin:0">\ud83c\udfc6 Best Sellers in ' + cat.name + '</h2></div>';
        h += '<div style="display:flex;gap:16px;overflow-x:auto;scroll-snap-type:x mandatory;-webkit-overflow-scrolling:touch;padding-bottom:8px">';
        items.forEach(function(p){
          h += '<div style="min-width:180px;max-width:200px;flex-shrink:0;scroll-snap-align:start">' + productCard(p) + '</div>';
        });
        h += '</div>';
        el.innerHTML = h;
      })
      .catch(function(){el.style.display='none'});
  }

  // Load main product grid (Amazon search + AliExpress search combined)
  function loadProducts(){
    var skelEl = document.getElementById('dh-cat-skeleton');
    var promises = [
      fetch(API + '/api/search?q=' + encodeURIComponent(cat.searchTerms) + '&store=amazon&limit=30', {signal: AbortSignal.timeout(15000)}).then(function(r){return r.ok?r.json():{results:[]}}).catch(function(){return {results:[]}}),
      fetch(API + '/api/search?q=' + encodeURIComponent(cat.searchTerms) + '&store=aliexpress&limit=20', {signal: AbortSignal.timeout(15000)}).then(function(r){return r.ok?r.json():{results:[]}}).catch(function(){return {results:[]}})
    ];

    Promise.all(promises).then(function(results){
      var combined = [];
      var seen = {};
      results.forEach(function(data){
        (data.results || []).forEach(function(p){
          var key = (p.id || p.sourceId || '') + '_' + (p.source || '');
          if(!seen[key]){
            seen[key] = true;
            combined.push(p);
          }
        });
      });
      allProducts = combined;
      if(skelEl) skelEl.style.display = 'none';
      renderGrid();
    });
  }

  function init(){
    setupHero();
    setupOriginFilters();
    setupSort();
    loadBestSellers();
    loadProducts();

    var loadMoreBtn = document.getElementById('dh-cat-loadmore-btn');
    if(loadMoreBtn){
      loadMoreBtn.addEventListener('click', loadMore);
    }
  }

  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  var style = document.createElement('style');
  style.textContent = '@media(max-width:768px){.dh-cat-grid{grid-template-columns:repeat(2,1fr)!important;gap:10px!important}}';
  document.head.appendChild(style);
})();
