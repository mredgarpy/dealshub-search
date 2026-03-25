/* StyleHub Best Sellers Page v2.0 — Infinite Scroll
   Category tabs + ranked product cards from Amazon Best Sellers API
   After curated results, continues with search-based infinite scroll
*/
(function(){
  'use strict';
  var API = 'https://dealshub-search.onrender.com';
  var PAGE_SIZE = 20;
  var categories = [
    {id: 'electronics', name: 'Electronics', icon: '🎧', searchTerms: 'best seller electronics'},
    {id: 'fashion', name: 'Fashion', icon: '👗', searchTerms: 'best seller fashion clothing'},
    {id: 'beauty', name: 'Beauty', icon: '💄', searchTerms: 'best seller beauty skincare'},
    {id: 'garden', name: 'Home', icon: '🏠', searchTerms: 'best seller home garden'},
    {id: 'sporting', name: 'Sports', icon: '⚽', searchTerms: 'best seller sports fitness'},
    {id: 'videogames', name: 'Gaming', icon: '🎮', searchTerms: 'best seller gaming'},
    {id: 'baby-products', name: 'Baby', icon: '👶', searchTerms: 'best seller baby kids'}
  ];
  var activeCategory = 'electronics';
  var cache = {};

  /* Scroll state */
  var allProducts = [];
  var displayedCount = 0;
  var seenKeys = {};
  var apiPage = 0;
  var isFetchingPage = false;
  var noMoreResults = false;
  var isLoadingMore = false;
  var curatedDone = false;
  var scrollObserver = null;

  function esc(s){var d=document.createElement('div');d.textContent=s||'';return d.innerHTML}
  function fmtPrice(n){return n?'$'+parseFloat(n).toFixed(2):''}

  function getActiveCat(){
    for(var i=0;i<categories.length;i++){
      if(categories[i].id === activeCategory) return categories[i];
    }
    return categories[0];
  }

  function productCard(p, idx){
    var source = (p.source||'').toLowerCase();
    var isUSA = source === 'amazon' || (p.originType === 'USA');
    var price = typeof p.price === 'number' ? p.price : parseFloat(String(p.price||'0').replace(/[^0-9.]/g,''));
    var origPrice = typeof p.originalPrice === 'number' ? p.originalPrice : parseFloat(String(p.originalPrice||'0').replace(/[^0-9.]/g,''));
    var discount = origPrice > price ? Math.round((1 - price/origPrice)*100) : 0;
    var rating = p.rating ? parseFloat(p.rating) : 0;
    var rank = p.rank || (idx !== undefined ? idx + 1 : 0);
    var link = '/pages/product?id=' + encodeURIComponent(p.id || p.sourceId || '') + '&store=' + encodeURIComponent(source || 'amazon');
    if(p.title) link += '&title=' + encodeURIComponent(p.title);

    var isTop10 = rank > 0 && rank <= 10;
    var cardStyle = isTop10
      ? 'text-decoration:none;display:block;background:#fff;border:2px solid #f59e0b;border-radius:12px;overflow:hidden;transition:box-shadow .2s,transform .2s'
      : 'text-decoration:none;display:block;background:#fff;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;transition:box-shadow .2s,transform .2s';

    var h = '<a href="' + link + '" style="' + cardStyle + '" onmouseover="this.style.boxShadow=\'0 4px 16px rgba(0,0,0,.1)\';this.style.transform=\'translateY(-2px)\'" onmouseout="this.style.boxShadow=\'none\';this.style.transform=\'none\'">';
    h += '<div style="position:relative;aspect-ratio:1;background:#f8f9fa;overflow:hidden">';
    h += '<img src="' + esc(p.image || p.primaryImage || '') + '" alt="" style="width:100%;height:100%;object-fit:contain" loading="lazy">';
    if(rank > 0 && rank <= 30){
      var rankBg = rank === 1 ? '#f59e0b' : rank <= 3 ? '#6b7280' : '#94a3b8';
      h += '<span style="position:absolute;top:8px;left:8px;background:' + rankBg + ';color:#fff;padding:4px 10px;border-radius:6px;font-size:12px;font-weight:800">#' + rank + '</span>';
    }
    var badgeBg = isUSA ? '#16a34a' : '#d97706';
    var badgeLabel = isUSA ? '🇺🇸 USA' : '🌍 Int\'l';
    h += '<span style="position:absolute;top:8px;right:8px;background:' + badgeBg + ';color:#fff;padding:2px 8px;border-radius:4px;font-size:9px;font-weight:700">' + badgeLabel + '</span>';
    if(discount > 0) h += '<span style="position:absolute;bottom:8px;left:8px;background:#e53e3e;color:#fff;padding:2px 8px;border-radius:4px;font-size:10px;font-weight:700">-' + discount + '%</span>';
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
    if(p.salesVolume) h += '<div style="font-size:11px;color:#6b7280;margin-top:4px">' + esc(p.salesVolume) + '</div>';
    h += '</div></a>';
    return h;
  }

  function renderTabs(){
    var tabsEl = document.getElementById('dh-bs-tabs');
    if(!tabsEl) return;
    var h = '';
    categories.forEach(function(c){
      var isActive = c.id === activeCategory;
      var bg = isActive ? '#1a1a2e' : '#fff';
      var color = isActive ? '#fff' : '#374151';
      var border = isActive ? '#1a1a2e' : '#e2e8f0';
      h += '<button data-cat="' + c.id + '" style="display:flex;align-items:center;gap:6px;padding:10px 20px;background:' + bg + ';border:1px solid ' + border + ';border-radius:50px;font-size:14px;font-weight:500;color:' + color + ';cursor:pointer;white-space:nowrap;flex-shrink:0;transition:all .2s">';
      h += '<span style="font-size:16px">' + c.icon + '</span> ' + c.name;
      h += '</button>';
    });
    tabsEl.innerHTML = h;
    tabsEl.querySelectorAll('button').forEach(function(btn){
      btn.addEventListener('click', function(){
        activeCategory = this.getAttribute('data-cat');
        renderTabs();
        resetAndLoad(activeCategory);
      });
    });
  }

  function resetScrollState(){
    allProducts = [];
    displayedCount = 0;
    seenKeys = {};
    apiPage = 0;
    isFetchingPage = false;
    noMoreResults = false;
    isLoadingMore = false;
    curatedDone = false;
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

  function resetAndLoad(catId){
    resetScrollState();
    loadCategory(catId);
  }

  function loadCategory(catId){
    var contentEl = document.getElementById('dh-bs-content');
    var skelEl = document.getElementById('dh-bs-skeleton');
    if(!contentEl) return;

    contentEl.innerHTML = '';
    if(skelEl) skelEl.style.display = '';

    var doRender = function(items){
      addUniqueProducts(items);
      curatedDone = true;
      if(skelEl) skelEl.style.display = 'none';
      renderProducts();
      setupInfiniteScroll();
    };

    if(cache[catId]){
      doRender(cache[catId]);
      return;
    }

    fetch(API + '/api/amazon-bestsellers?type=BEST_SELLERS&category=' + encodeURIComponent(catId) + '&limit=30', {signal: AbortSignal.timeout(15000)})
      .then(function(r){if(!r.ok)throw new Error('HTTP '+r.status);return r.json()})
      .then(function(data){
        var items = data.results || [];
        cache[catId] = items;
        doRender(items);
      })
      .catch(function(){
        curatedDone = true;
        if(skelEl) skelEl.style.display = 'none';
        /* Even if bestsellers fail, start search-based scroll */
        setupInfiniteScroll();
        /* Trigger first search page immediately */
        fetchNextPage();
      });
  }

  function renderProducts(){
    var contentEl = document.getElementById('dh-bs-content');
    if(!contentEl) return;

    if(!allProducts.length){
      contentEl.innerHTML = '<div style="text-align:center;padding:40px;color:#6b7280"><p style="font-size:16px">No best sellers found in this category</p></div>';
      return;
    }

    var nextBatch = allProducts.slice(displayedCount, displayedCount + PAGE_SIZE);
    if(!nextBatch.length){ isLoadingMore = false; return; }

    var container = contentEl.querySelector('.dh-bs-grid');
    if(!container){
      var h = '<div style="display:grid;grid-template-columns:repeat(5,1fr);gap:16px" class="dh-bs-grid">';
      var end = Math.min(PAGE_SIZE, allProducts.length);
      allProducts.slice(0, end).forEach(function(p, idx){ h += productCard(p, idx); });
      h += '</div>';
      contentEl.innerHTML = h;
      displayedCount = end;
    } else {
      nextBatch.forEach(function(p){
        container.insertAdjacentHTML('beforeend', productCard(p));
      });
      displayedCount += nextBatch.length;
    }
    isLoadingMore = false;
    updateSentinel();
  }

  /* ---------- Server-Side Pagination (search-based continuation) ---------- */
  function fetchNextPage(){
    if(isFetchingPage || noMoreResults) return Promise.resolve(false);
    isFetchingPage = true;
    showLoadingSpinner();
    apiPage++;

    var activeCat = getActiveCat();
    var searchTerms = activeCat.searchTerms;

    return Promise.all([
      fetch(API + '/api/search?q=' + encodeURIComponent(searchTerms) + '&store=amazon&limit=30&page=' + apiPage, {signal: AbortSignal.timeout(15000)}).then(function(r){return r.ok?r.json():{results:[]}}).catch(function(){return {results:[]}}),
      fetch(API + '/api/search?q=' + encodeURIComponent(searchTerms) + '&store=aliexpress&limit=20&page=' + apiPage, {signal: AbortSignal.timeout(15000)}).then(function(r){return r.ok?r.json():{results:[]}}).catch(function(){return {results:[]}})
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
      renderProducts();
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
    var s = document.getElementById('dh-bs-sentinel');
    if(!s){
      s = document.createElement('div');
      s.id = 'dh-bs-sentinel';
      s.style.cssText = 'height:1px;width:100%;';
      var content = document.getElementById('dh-bs-content');
      if(content) content.parentNode.insertBefore(s, content.nextSibling);
    }
    return s;
  }
  function hideSentinel(){ var s = document.getElementById('dh-bs-sentinel'); if(s) s.style.display = 'none'; }
  function updateSentinel(){ var s = getSentinel(); if(s) s.style.display = ''; }

  function showLoadingSpinner(){
    var el = document.getElementById('dh-bs-spinner');
    if(!el){
      el = document.createElement('div');
      el.id = 'dh-bs-spinner';
      var content = document.getElementById('dh-bs-content');
      if(content) content.parentNode.insertBefore(el, content.nextSibling);
    }
    el.style.display = '';
    el.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;gap:8px;padding:20px"><div style="width:20px;height:20px;border:3px solid #e2e8f0;border-top-color:#1a1a2e;border-radius:50%;animation:dhspin 0.8s linear infinite"></div><span style="color:#6b7280;font-size:14px">Loading more products...</span></div>';
  }
  function hideLoadingSpinner(){ var el = document.getElementById('dh-bs-spinner'); if(el) el.style.display = 'none'; }

  function showEndMessage(){
    var el = document.getElementById('dh-bs-spinner');
    if(!el){
      el = document.createElement('div');
      el.id = 'dh-bs-spinner';
      var content = document.getElementById('dh-bs-content');
      if(content) content.parentNode.insertBefore(el, content.nextSibling);
    }
    if(displayedCount > PAGE_SIZE){
      el.style.display = '';
      el.innerHTML = '<div style="text-align:center;padding:20px;color:#9ca3af;font-size:13px">You\'ve explored all available products</div>';
    }
  }

  function setupInfiniteScroll(){
    if(scrollObserver){scrollObserver.disconnect();}
    var sentinel = getSentinel();
    scrollObserver = new IntersectionObserver(function(entries){
      entries.forEach(function(entry){
        if(!entry.isIntersecting || isLoadingMore) return;
        if(displayedCount < allProducts.length){
          isLoadingMore = true;
          renderProducts();
        } else if(!noMoreResults && !isFetchingPage){
          isLoadingMore = true;
          fetchNextPage().then(function(gotMore){
            if(!gotMore){ hideSentinel(); showEndMessage(); }
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

  function init(){
    renderTabs();
    resetAndLoad(activeCategory);
  }

  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  var style = document.createElement('style');
  style.textContent = '@media(max-width:768px){.dh-bs-grid{grid-template-columns:repeat(2,1fr)!important;gap:10px!important}}@keyframes dhspin{to{transform:rotate(360deg)}}';
  document.head.appendChild(style);
})();
