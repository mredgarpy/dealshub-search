/* StyleHub New Arrivals Page v1.0 — Sprint 5
   Uses Amazon NEW_RELEASES best-sellers type with category tabs
*/
(function(){
  'use strict';
  var API = 'https://dealshub-search.onrender.com';
  var categories = [
    {id: 'electronics', name: 'Electronics', icon: '\ud83c\udfa7'},
    {id: 'fashion', name: 'Fashion', icon: '\ud83d\udc57'},
    {id: 'beauty', name: 'Beauty', icon: '\ud83d\udc84'},
    {id: 'garden', name: 'Home', icon: '\ud83c\udfe0'},
    {id: 'sporting', name: 'Sports', icon: '\u26bd'},
    {id: 'videogames', name: 'Gaming', icon: '\ud83c\udfae'},
    {id: 'baby-products', name: 'Baby', icon: '\ud83d\udc76'}
  ];
  var activeCategory = 'electronics';
  var cache = {};

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
    // NEW badge
    h += '<span style="position:absolute;top:8px;left:8px;background:#3b82f6;color:#fff;padding:3px 10px;border-radius:4px;font-size:10px;font-weight:700;letter-spacing:.5px">NEW</span>';
    // Origin badge
    var badgeBg = isUSA ? '#16a34a' : '#d97706';
    var badgeLabel = isUSA ? '\ud83c\uddfa\ud83c\uddf8 USA' : '\ud83c\udf0d Int\'l';
    h += '<span style="position:absolute;top:8px;right:8px;background:' + badgeBg + ';color:#fff;padding:2px 8px;border-radius:4px;font-size:9px;font-weight:700">' + badgeLabel + '</span>';
    if(discount > 0) h += '<span style="position:absolute;bottom:8px;left:8px;background:#e53e3e;color:#fff;padding:2px 8px;border-radius:4px;font-size:10px;font-weight:700">-' + discount + '%</span>';
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
    if(price > 0) h += '<span style="font-size:16px;font-weight:700;color:#1a1a2e">' + fmtPrice(price) + '</span>';
    if(origPrice > price) h += '<span style="font-size:12px;color:#9ca3af;text-decoration:line-through">' + fmtPrice(origPrice) + '</span>';
    h += '</div>';
    h += '</div></a>';
    return h;
  }

  function renderTabs(){
    var tabsEl = document.getElementById('dh-na-tabs');
    if(!tabsEl) return;
    var h = '';
    categories.forEach(function(c){
      var isActive = c.id === activeCategory;
      var bg = isActive ? '#3b82f6' : '#fff';
      var color = isActive ? '#fff' : '#374151';
      var border = isActive ? '#3b82f6' : '#e2e8f0';
      h += '<button data-cat="' + c.id + '" style="display:flex;align-items:center;gap:6px;padding:10px 20px;background:' + bg + ';border:1px solid ' + border + ';border-radius:50px;font-size:14px;font-weight:500;color:' + color + ';cursor:pointer;white-space:nowrap;flex-shrink:0;transition:all .2s">';
      h += '<span style="font-size:16px">' + c.icon + '</span> ' + c.name;
      h += '</button>';
    });
    tabsEl.innerHTML = h;
    tabsEl.querySelectorAll('button').forEach(function(btn){
      btn.addEventListener('click', function(){
        activeCategory = this.getAttribute('data-cat');
        renderTabs();
        loadCategory(activeCategory);
      });
    });
  }

  function loadCategory(catId){
    var contentEl = document.getElementById('dh-na-content');
    var skelEl = document.getElementById('dh-na-skeleton');
    if(!contentEl) return;
    if(cache[catId]){ renderProducts(cache[catId]); return; }
    contentEl.innerHTML = '';
    if(skelEl) skelEl.style.display = '';

    fetch(API + '/api/amazon-bestsellers?type=NEW_RELEASES&category=' + encodeURIComponent(catId) + '&limit=30', {signal: AbortSignal.timeout(15000)})
      .then(function(r){if(!r.ok)throw new Error('HTTP '+r.status);return r.json()})
      .then(function(data){
        var items = data.results || [];
        cache[catId] = items;
        renderProducts(items);
      })
      .catch(function(){
        if(skelEl) skelEl.style.display = 'none';
        contentEl.innerHTML = '<div style="text-align:center;padding:40px;color:#6b7280"><p style="font-size:16px">Unable to load new arrivals</p><p style="font-size:13px">Please try again later</p></div>';
      });
  }

  function renderProducts(items){
    var contentEl = document.getElementById('dh-na-content');
    var skelEl = document.getElementById('dh-na-skeleton');
    if(skelEl) skelEl.style.display = 'none';
    if(!contentEl) return;
    if(!items.length){
      contentEl.innerHTML = '<div style="text-align:center;padding:40px;color:#6b7280"><p>No new arrivals found in this category</p></div>';
      return;
    }
    var h = '<div style="display:grid;grid-template-columns:repeat(5,1fr);gap:16px" class="dh-na-grid">';
    items.forEach(function(p){ h += productCard(p); });
    h += '</div>';
    contentEl.innerHTML = h;
  }

  function init(){
    renderTabs();
    loadCategory(activeCategory);
  }
  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  var style = document.createElement('style');
  style.textContent = '@media(max-width:768px){.dh-na-grid{grid-template-columns:repeat(2,1fr)!important;gap:10px!important}}';
  document.head.appendChild(style);
})();
