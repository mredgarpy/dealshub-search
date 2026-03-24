/* StyleHub Deals Page v1.0 — Sprint 5
   Sections: Lightning Deals, Best Value ($5/$10/$25), USA Deals, Top Discounts
*/
(function(){
  'use strict';
  var API = 'https://dealshub-search.onrender.com';

  function esc(s){var d=document.createElement('div');d.textContent=s||'';return d.innerHTML}
  function fmtPrice(n){return n?'$'+parseFloat(n).toFixed(2):''}

  function productCard(p, opts){
    opts = opts || {};
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
    // Rank badge
    if(opts.showRank && p.rank && p.rank <= 10) h += '<span style="position:absolute;bottom:8px;right:8px;background:#f59e0b;color:#fff;padding:2px 8px;border-radius:50%;font-size:10px;font-weight:700;min-width:20px;text-align:center">#' + p.rank + '</span>';
    // Lightning badge
    if(opts.lightning) h += '<span style="position:absolute;bottom:8px;left:8px;background:#e53e3e;color:#fff;padding:3px 10px;border-radius:4px;font-size:9px;font-weight:700">\u26a1 Lightning</span>';
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
    h += '<div style="margin-top:6px;display:flex;align-items:baseline;gap:6px;flex-wrap:wrap">';
    if(price > 0) h += '<span style="font-size:16px;font-weight:700;color:#e53e3e">' + fmtPrice(price) + '</span>';
    if(origPrice > price) h += '<span style="font-size:12px;color:#9ca3af;text-decoration:line-through">' + fmtPrice(origPrice) + '</span>';
    if(discount > 0) h += '<span style="font-size:11px;color:#16a34a;font-weight:600">Save ' + discount + '%</span>';
    h += '</div>';
    h += '</div></a>';
    return h;
  }

  function sectionTitle(icon, title, subtitle){
    var h = '<div style="margin-bottom:16px">';
    h += '<h2 style="font-size:22px;font-weight:800;color:#1a1a2e;margin:0">' + icon + ' ' + title + '</h2>';
    if(subtitle) h += '<p style="color:#6b7280;font-size:13px;margin:4px 0 0">' + subtitle + '</p>';
    h += '</div>';
    return h;
  }

  function carouselHTML(items, opts){
    var h = '<div style="display:flex;gap:16px;overflow-x:auto;scroll-snap-type:x mandatory;-webkit-overflow-scrolling:touch;padding-bottom:8px" class="dh-deals-carousel">';
    items.forEach(function(p){
      h += '<div style="min-width:200px;max-width:220px;flex-shrink:0;scroll-snap-align:start">' + productCard(p, opts) + '</div>';
    });
    h += '</div>';
    return h;
  }

  function gridHTML(items, opts){
    var h = '<div style="display:grid;grid-template-columns:repeat(5,1fr);gap:16px" class="dh-deals-grid">';
    items.forEach(function(p){ h += productCard(p, opts); });
    h += '</div>';
    return h;
  }

  function fetchJSON(path){
    return fetch(API + path, {signal: AbortSignal.timeout(15000)})
      .then(function(r){if(!r.ok)throw new Error('HTTP '+r.status);return r.json()});
  }

  function removeSkeleton(){
    var s = document.getElementById('dh-deals-skeleton');
    if(s) s.remove();
  }

  var loaded = 0;
  function sectionLoaded(){
    loaded++;
    if(loaded >= 1) removeSkeleton();
  }

  // === Lightning Deals (trending with high discounts) ===
  function buildLightning(){
    var el = document.getElementById('dh-deals-lightning');
    if(!el) return;
    fetchJSON('/api/trending?limit=30')
      .then(function(data){
        var items = (data.results || data || []).filter(function(p){
          var price = typeof p.price === 'number' ? p.price : parseFloat(String(p.price||'0').replace(/[^0-9.]/g,''));
          var orig = typeof p.originalPrice === 'number' ? p.originalPrice : parseFloat(String(p.originalPrice||'0').replace(/[^0-9.]/g,''));
          return orig > price && ((1 - price/orig) >= 0.20);
        }).slice(0, 10);
        if(!items.length){el.style.display='none';sectionLoaded();return;}
        var h = '<div style="margin-bottom:40px">';
        h += sectionTitle('\u26a1', 'Lightning Deals', 'Limited-time savings — grab them fast');
        h += carouselHTML(items, {lightning: true});
        h += '</div>';
        el.innerHTML = h;
        sectionLoaded();
      })
      .catch(function(){el.style.display='none';sectionLoaded()});
  }

  // === Best Value Under $X ===
  function buildUnder(maxPrice, elId, label){
    var el = document.getElementById(elId);
    if(!el) return;
    fetchJSON('/api/best-value-intl?maxPrice=' + maxPrice + '&limit=10')
      .then(function(data){
        var items = (data.results || []).slice(0, 10);
        if(!items.length){el.style.display='none';sectionLoaded();return;}
        var h = '<div style="margin-bottom:40px">';
        h += sectionTitle('\ud83d\udcb0', label, 'Quality finds at unbeatable prices');
        h += carouselHTML(items);
        h += '</div>';
        el.innerHTML = h;
        sectionLoaded();
      })
      .catch(function(){el.style.display='none';sectionLoaded()});
  }

  // === USA Deals (Amazon trending with discounts) ===
  function buildUSADeals(){
    var el = document.getElementById('dh-deals-usa');
    if(!el) return;
    fetchJSON('/api/amazon-bestsellers?type=BEST_SELLERS&category=aps&limit=20')
      .then(function(data){
        var items = (data.results || []).filter(function(p){
          var price = typeof p.price === 'number' ? p.price : parseFloat(String(p.price||'0').replace(/[^0-9.]/g,''));
          var orig = typeof p.originalPrice === 'number' ? p.originalPrice : parseFloat(String(p.originalPrice||'0').replace(/[^0-9.]/g,''));
          return orig > price;
        }).slice(0, 10);
        if(!items.length){el.style.display='none';sectionLoaded();return;}
        var h = '<div style="margin-bottom:40px">';
        h += sectionTitle('\ud83c\uddfa\ud83c\uddf8', 'USA Deals', 'Top savings from US-based sellers');
        h += carouselHTML(items, {showRank: true});
        h += '</div>';
        el.innerHTML = h;
        sectionLoaded();
      })
      .catch(function(){el.style.display='none';sectionLoaded()});
  }

  // === Top Discounts (search for deals, sort by discount) ===
  function buildTopDiscount(){
    var el = document.getElementById('dh-deals-top-discount');
    if(!el) return;
    fetchJSON('/api/search?q=deal+sale&store=amazon&limit=30')
      .then(function(data){
        var items = (data.results || []).map(function(p){
          var price = typeof p.price === 'number' ? p.price : parseFloat(String(p.price||'0').replace(/[^0-9.]/g,''));
          var orig = typeof p.originalPrice === 'number' ? p.originalPrice : parseFloat(String(p.originalPrice||'0').replace(/[^0-9.]/g,''));
          p._discount = orig > price ? Math.round((1 - price/orig)*100) : 0;
          return p;
        }).filter(function(p){return p._discount >= 15;})
          .sort(function(a,b){return b._discount - a._discount;})
          .slice(0, 10);
        if(!items.length){el.style.display='none';sectionLoaded();return;}
        var h = '<div style="margin-bottom:40px">';
        h += sectionTitle('\ud83d\udd25', 'Top Discounts', 'The biggest price drops right now');
        h += gridHTML(items);
        h += '</div>';
        el.innerHTML = h;
        sectionLoaded();
      })
      .catch(function(){el.style.display='none';sectionLoaded()});
  }

  function init(){
    buildLightning();
    setTimeout(function(){ buildUnder(5, 'dh-deals-under5', 'Best Value Under $5'); }, 300);
    setTimeout(function(){ buildUnder(10, 'dh-deals-under10', 'Best Value Under $10'); }, 600);
    setTimeout(function(){ buildUnder(25, 'dh-deals-under25', 'Best Value Under $25'); }, 900);
    setTimeout(buildUSADeals, 1200);
    setTimeout(buildTopDiscount, 1500);
  }

  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  var style = document.createElement('style');
  style.textContent = '@media(max-width:768px){.dh-deals-grid{grid-template-columns:repeat(2,1fr)!important;gap:10px!important}}';
  document.head.appendChild(style);
})();
