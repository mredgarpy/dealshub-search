/* StyleHub Home Extra Sections v1.0 — Sprint 4
   Adds: Category Navigation, Best Value International, Most Wished For, Gift Ideas
   Works alongside existing dealshub-home.js
*/
(function(){
  'use strict';
  var API = 'https://dealshub-search.onrender.com';

  function esc(s){var d=document.createElement('div');d.textContent=s||'';return d.innerHTML}
  function fmtPrice(n){return n?'$'+parseFloat(n).toFixed(2):''}

  function productCard(p, idx){
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
    h += '<img src="' + esc(p.image || p.primaryImage || '') + '" alt="" style="width:100%;height:100%;object-fit:contain" loading="lazy" onerror="this.parentElement.style.background=\'#f0f0f0\'">';
    // Origin badge
    var badgeBg = isUSA ? '#16a34a' : '#d97706';
    var badgeLabel = isUSA ? '\ud83c\uddfa\ud83c\uddf8 USA' : '\ud83c\udf0d Int\'l';
    h += '<span style="position:absolute;top:8px;right:8px;background:' + badgeBg + ';color:#fff;padding:2px 8px;border-radius:4px;font-size:9px;font-weight:700;letter-spacing:.5px;z-index:2">' + badgeLabel + '</span>';
    // Discount badge
    if(discount > 0) h += '<span style="position:absolute;top:8px;left:8px;background:#e53e3e;color:#fff;padding:2px 8px;border-radius:4px;font-size:10px;font-weight:700">-' + discount + '%</span>';
    // Type badge (Best Seller, Most Wished, Gift Idea, etc.)
    if(p.badge && p.badge !== 'Best Seller') h += '<span style="position:absolute;bottom:8px;left:8px;background:#1a1a2e;color:#fff;padding:2px 8px;border-radius:4px;font-size:9px;font-weight:600">' + esc(p.badge) + '</span>';
    if(p.rank && p.rank <= 10) h += '<span style="position:absolute;bottom:8px;right:8px;background:#f59e0b;color:#fff;padding:2px 8px;border-radius:50%;font-size:10px;font-weight:700;min-width:20px;text-align:center">#' + p.rank + '</span>';
    h += '</div>';
    h += '<div style="padding:12px">';
    h += '<div style="font-size:13px;color:#4a5568;line-height:1.3;height:36px;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical">' + esc((p.title||'').substring(0,80)) + '</div>';
    // Rating
    if(rating > 0){
      h += '<div style="display:flex;align-items:center;gap:4px;margin-top:6px">';
      h += '<span style="color:#f59e0b;font-size:12px">';
      for(var i=1;i<=5;i++) h += i <= Math.round(rating) ? '\u2605' : '\u2606';
      h += '</span>';
      if(p.reviews) h += '<span style="font-size:11px;color:#9ca3af">(' + (p.reviews >= 1000 ? (p.reviews/1000).toFixed(1)+'K' : p.reviews) + ')</span>';
      h += '</div>';
    }
    // Price
    h += '<div style="margin-top:6px;display:flex;align-items:baseline;gap:6px">';
    if(price > 0) h += '<span style="font-size:16px;font-weight:700;color:#e53e3e">' + fmtPrice(price) + '</span>';
    if(origPrice > price) h += '<span style="font-size:12px;color:#9ca3af;text-decoration:line-through">' + fmtPrice(origPrice) + '</span>';
    h += '</div>';
    h += '</div></a>';
    return h;
  }

  function sectionHTML(title, subtitle, id, extra){
    var h = '<div style="margin-bottom:40px" id="' + id + '">';
    h += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;flex-wrap:wrap;gap:8px">';
    h += '<div><h2 style="font-size:22px;font-weight:800;color:#1a1a2e;margin:0">' + title + '</h2>';
    if(subtitle) h += '<p style="color:#6b7280;font-size:13px;margin:4px 0 0">' + subtitle + '</p>';
    h += '</div>';
    if(extra) h += extra;
    h += '</div>';
    return h;
  }

  function gridHTML(items, cols){
    cols = cols || 4;
    var h = '<div style="display:grid;grid-template-columns:repeat(' + cols + ',1fr);gap:16px" class="dh-extra-grid">';
    items.forEach(function(p){ h += productCard(p); });
    h += '</div>';
    return h;
  }

  function carouselHTML(items){
    var h = '<div style="display:flex;gap:16px;overflow-x:auto;scroll-snap-type:x mandatory;-webkit-overflow-scrolling:touch;padding-bottom:8px" class="dh-extra-carousel">';
    items.forEach(function(p){
      h += '<div style="min-width:200px;max-width:220px;flex-shrink:0;scroll-snap-align:start">' + productCard(p) + '</div>';
    });
    h += '</div>';
    return h;
  }

  function fetchJSON(path){
    return fetch(API + path, {signal: AbortSignal.timeout(15000)})
      .then(function(r){if(!r.ok)throw new Error('HTTP '+r.status);return r.json()});
  }

  // === SECTION: Category Navigation Pills ===
  function buildCategoryNav(){
    var el = document.getElementById('dh-extra-categories');
    if(!el) return;
    var cats = [
      {icon: '\ud83c\udfa7', name: 'Electronics', slug: 'electronics'},
      {icon: '\ud83d\udc57', name: 'Fashion', slug: 'fashion'},
      {icon: '\ud83d\udc84', name: 'Beauty', slug: 'beauty'},
      {icon: '\ud83c\udfe0', name: 'Home', slug: 'home'},
      {icon: '\u26bd', name: 'Sports', slug: 'sports'},
      {icon: '\ud83c\udfae', name: 'Gaming', slug: 'gaming'},
      {icon: '\ud83d\udc76', name: 'Baby', slug: 'baby'}
    ];
    var h = '<div style="display:flex;gap:10px;overflow-x:auto;padding:12px 0;-webkit-overflow-scrolling:touch" class="dh-cat-pills">';
    cats.forEach(function(c){
      h += '<a href="/pages/search-results?q=' + encodeURIComponent(c.name) + '" style="display:flex;align-items:center;gap:6px;padding:10px 20px;background:#fff;border:1px solid #e2e8f0;border-radius:50px;text-decoration:none;white-space:nowrap;font-size:14px;font-weight:500;color:#374151;transition:all .2s;flex-shrink:0" onmouseover="this.style.background=\'#1a1a2e\';this.style.color=\'#fff\';this.style.borderColor=\'#1a1a2e\'" onmouseout="this.style.background=\'#fff\';this.style.color=\'#374151\';this.style.borderColor=\'#e2e8f0\'">';
      h += '<span style="font-size:18px">' + c.icon + '</span> ' + c.name;
      h += '</a>';
    });
    h += '</div>';
    el.innerHTML = h;
  }

  // === SECTION: Best Value International ===
  function buildBestValueIntl(){
    var el = document.getElementById('dh-extra-best-value');
    if(!el) return;
    fetchJSON('/api/best-value-intl?maxPrice=15&limit=8')
      .then(function(data){
        var items = data.results || [];
        if(!items.length){el.style.display='none';return;}
        var h = sectionHTML('\ud83c\udf0d Best Value', 'Great prices, ships internationally', 'best-value-section');
        h += carouselHTML(items);
        h += '</div>';
        el.innerHTML = h;
      })
      .catch(function(){el.style.display='none'});
  }

  // === SECTION: Most Wished For ===
  function buildMostWished(){
    var el = document.getElementById('dh-extra-most-wished');
    if(!el) return;
    fetchJSON('/api/amazon-bestsellers?type=MOST_WISHED_FOR&limit=8')
      .then(function(data){
        var items = data.results || [];
        if(!items.length){el.style.display='none';return;}
        var h = sectionHTML('\ud83d\udc9d Most Wished For', 'Top items on everyone\'s list', 'most-wished-section');
        h += carouselHTML(items);
        h += '</div>';
        el.innerHTML = h;
      })
      .catch(function(){el.style.display='none'});
  }

  // === SECTION: Gift Ideas ===
  function buildGiftIdeas(){
    var el = document.getElementById('dh-extra-gift-ideas');
    if(!el) return;
    fetchJSON('/api/amazon-bestsellers?type=GIFT_IDEAS&limit=8')
      .then(function(data){
        var items = data.results || [];
        if(!items.length){el.style.display='none';return;}
        var h = sectionHTML('\ud83c\udf81 Gift Ideas', 'Perfect presents for everyone', 'gift-ideas-section');
        h += carouselHTML(items);
        h += '</div>';
        el.innerHTML = h;
      })
      .catch(function(){el.style.display='none'});
  }

  // === SECTION: Plus CTA Banner ===
  function buildPlusBanner(){
    var el = document.getElementById('dh-extra-plus-banner');
    if(!el) return;
    try{if(localStorage.getItem('stylehub_plus')==='true')return;}catch(e){}
    el.innerHTML = '<div style="background:linear-gradient(135deg,#6b46c1 0%,#805ad5 50%,#9f7aea 100%);border-radius:16px;padding:32px;color:#fff;display:flex;align-items:center;justify-content:space-between;gap:24px;flex-wrap:wrap;margin-bottom:40px">' +
      '<div><h3 style="font-size:22px;font-weight:800;margin:0 0 8px">\u26a1 StyleHub Plus — $7.99/month</h3>' +
      '<p style="font-size:15px;opacity:.9;margin:0">FREE shipping on USA orders \u00b7 60-day returns \u00b7 2x loyalty points</p></div>' +
      '<a href="/pages/plus" style="background:#fff;color:#6b46c1;padding:14px 32px;border-radius:10px;font-weight:700;font-size:15px;text-decoration:none;white-space:nowrap;transition:transform .2s" onmouseover="this.style.transform=\'scale(1.05)\'" onmouseout="this.style.transform=\'none\'">Start your 7-day free trial \u2192</a>' +
      '</div>';
  }

  // === Initialize ===
  function init(){
    buildCategoryNav();
    // Stagger API calls to avoid hammering the backend
    setTimeout(buildBestValueIntl, 500);
    setTimeout(buildMostWished, 1000);
    setTimeout(buildGiftIdeas, 1500);
    buildPlusBanner();
  }

  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  // Responsive styles
  var style = document.createElement('style');
  style.textContent = '@media(max-width:768px){.dh-extra-grid{grid-template-columns:repeat(2,1fr)!important}.dh-cat-pills{padding:8px 0}}@media(max-width:480px){.dh-extra-grid{grid-template-columns:repeat(2,1fr)!important;gap:10px!important}}';
  document.head.appendChild(style);
})();
