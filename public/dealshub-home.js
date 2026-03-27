/* ============================================================
   StyleHub Miami — Home Engine v2.0
   18-section home based on approved design doc v6
   Design system: Red #E53E3E | Navy #1A1A2E | Gray #F7F7F8
   ============================================================ */
(function(){
  'use strict';
  var API='https://dealshub-search.onrender.com';
  var RED='#E53E3E',NAVY='#1A1A2E',GRAY='#F7F7F8',WHITE='#FFFFFF';

  // ---- UTILITIES ----
  function esc(s){var d=document.createElement('div');d.textContent=s||'';return d.innerHTML}
  function parsePrice(v){if(!v)return 0;var n=parseFloat(String(v).replace(/[^0-9.\-]/g,''));return isNaN(n)?0:n}
  function fmtPrice(n){return n?'$'+n.toFixed(2):''}
  function fmtNum(n){if(!n)return '0';n=parseInt(n);if(n>=1000000)return (n/1000000).toFixed(1)+'M';if(n>=1000)return (n/1000).toFixed(1)+'K';return String(n)}
  function stars(r){r=parseFloat(r)||0;var h='';for(var i=1;i<=5;i++)h+=i<=Math.round(r)?'★':'☆';return h}
  function shuffleSeed(arr,seed){var a=arr.slice();for(var i=a.length-1;i>0;i--){seed=(seed*9301+49297)%233280;var j=Math.floor((seed/233280)*i);var t=a[i];a[i]=a[j];a[j]=t}return a}
  function decodeEntities(s){var el=document.createElement('textarea');el.innerHTML=s;return el.value}

  // ---- API FETCH WITH CACHE (memory + sessionStorage) ----
  var _cache={};
  function apiFetch(path,ttl){
    // 1. Memory cache
    if(_cache[path]&&_cache[path].t>Date.now())return Promise.resolve(_cache[path].d);
    // 2. sessionStorage cache (survives page reload)
    try{
      var sk='dh:'+path;
      var ss=sessionStorage.getItem(sk);
      if(ss){var p=JSON.parse(ss);if(p&&p.t>Date.now()){_cache[path]=p;return Promise.resolve(p.d)}}
    }catch(e){}
    // 3. Network fetch
    return fetch(API+path,{signal:AbortSignal.timeout(15000)})
      .then(function(r){if(!r.ok)throw new Error('HTTP '+r.status);return r.json()})
      .then(function(d){
        // Normalize: ensure .products always exists
        if(d&&d.results&&!d.products)d.products=d.results;
        var entry={d:d,t:Date.now()+(ttl||600000)};
        _cache[path]=entry;
        try{sessionStorage.setItem('dh:'+path,JSON.stringify(entry))}catch(e){}
        return d;
      });
  }

  // ---- SOURCE BADGE ----
  function sourceBadge(src){
    var s=(src||'').toLowerCase();
    var colors={amazon:NAVY,aliexpress:RED,shein:NAVY,sephora:RED,macys:NAVY};
    var bg=colors[s]||NAVY;
    return '<span style="position:absolute;top:8px;right:8px;background:'+bg+';color:#fff;padding:2px 8px;border-radius:4px;font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;z-index:2">'+esc(s)+'</span>';
  }

  // ---- TYPE BADGE ----
  function typeBadge(badge){
    if(!badge)return '';
    var b=String(badge).toLowerCase();
    var bg='#f59e0b',color='#92400e'; // amber default
    if(b.indexOf('choice')>=0){bg='#f59e0b';color='#92400e'}
    else if(b.indexOf('top rated')>=0||b.indexOf('best')>=0){bg='#22c55e';color='#fff'}
    else if(b.indexOf('deal')>=0||b.indexOf('flash')>=0){bg=RED;color='#fff'}
    else if(b.indexOf('#1')>=0||b.indexOf('our')>=0){bg=NAVY;color='#fff'}
    return '<span style="position:absolute;top:8px;left:8px;background:'+bg+';color:'+color+';padding:2px 8px;border-radius:4px;font-size:9px;font-weight:700;z-index:2">'+esc(badge)+'</span>';
  }

  // ---- DISCOUNT BADGE ----
  function discountBadge(price,orig){
    var p=parsePrice(price),o=parsePrice(orig);
    if(!o||o<=p)return '';
    var pct=Math.round((1-p/o)*100);
    if(pct<5)return '';
    return '<span style="position:absolute;bottom:8px;left:8px;background:'+RED+';color:#fff;padding:2px 8px;border-radius:4px;font-size:10px;font-weight:700;z-index:2">-'+pct+'%</span>';
  }

  // ---- PRODUCT CARD (universal) ----
  function productCard(p,opts){
    opts=opts||{};
    var price=parsePrice(p.price);
    var orig=parsePrice(p.originalPrice);
    var discount=orig>price?Math.round((1-price/orig)*100):0;
    var rating=parseFloat(p.rating)||0;
    var reviews=p.reviews||0;
    var title=decodeEntities(p.title||'');
    var img=p.image||p.primaryImage||'';
    var source=p.source||p.sourceName||'';
    var badge=p.badge||'';
    var id=p.id||p.sourceId||'';
    var store=(p.source||'amazon').toLowerCase();
    var url='/pages/product?id='+encodeURIComponent(id)+'&store='+encodeURIComponent(store)+'&title='+encodeURIComponent(title.substring(0,80))+'&image='+encodeURIComponent(img);

    // CTA button style
    var ctaText=opts.cta||'View Deal';
    var ctaStyle='';
    if(opts.ctaType==='red'){
      ctaStyle='background:'+RED+';color:#fff;border:none';
      ctaText=opts.cta||'⚡ Grab Deal';
    } else if(opts.ctaType==='outline'){
      ctaStyle='background:#fff;color:'+NAVY+';border:1.5px solid '+NAVY;
      ctaText=opts.cta||'Add to Cart';
    } else {
      ctaStyle='background:'+NAVY+';color:#fff;border:none';
    }

    var h='<div class="dh-card" style="background:#fff;border-radius:12px;overflow:hidden;border:1px solid #eee;position:relative;display:flex;flex-direction:column;min-width:0">';
    // Image
    h+='<a href="'+esc(url)+'" style="display:block;position:relative;aspect-ratio:1;background:#fafafa;overflow:hidden">';
    h+='<img src="'+esc(img)+'" alt="'+esc(title.substring(0,60))+'" loading="lazy" style="width:100%;height:100%;object-fit:contain" onerror="this.style.display=\'none\'">';
    h+=sourceBadge(source);
    if(opts.rankBadge)h+=opts.rankBadge;
    else h+=typeBadge(badge);
    h+=discountBadge(p.price,p.originalPrice);
    h+='</a>';
    // Info
    h+='<div style="padding:10px 12px;flex:1;display:flex;flex-direction:column">';
    h+='<a href="'+esc(url)+'" style="font-size:12px;color:#333;line-height:1.4;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;text-decoration:none;font-weight:500;min-height:34px">'+esc(title)+'</a>';
    // Rating
    if(rating>0){
      h+='<div style="margin:4px 0;display:flex;align-items:center;gap:4px">';
      h+='<span style="color:#f59e0b;font-size:12px">'+stars(rating)+'</span>';
      if(reviews)h+='<span style="font-size:10px;color:#999">('+fmtNum(reviews)+')</span>';
      h+='</div>';
    }
    // Price
    h+='<div style="margin-top:auto;padding-top:6px">';
    if(price)h+='<span style="font-size:15px;font-weight:700;color:'+RED+'">'+fmtPrice(price)+'</span>';
    if(orig>price)h+=' <span style="font-size:11px;color:#999;text-decoration:line-through;margin-left:4px">'+fmtPrice(orig)+'</span>';
    h+='</div>';
    // CTA
    h+='<a href="'+esc(url)+'" style="display:block;text-align:center;padding:8px;margin-top:8px;border-radius:8px;font-size:12px;font-weight:700;text-decoration:none;cursor:pointer;transition:opacity 0.2s;'+ctaStyle+'">'+ctaText+'</a>';
    h+='</div></div>';
    return h;
  }

  // ---- SECTION WRAPPER ----
  function section(id,inner,opts){
    opts=opts||{};
    var bg=opts.bg||'transparent';
    var pad=opts.pad||'0 20px';
    return '<section id="dh-'+id+'" style="max-width:1280px;margin:0 auto;padding:'+pad+';background:'+bg+'">'+inner+'</section>';
  }

  // ---- SECTION HEADER ----
  function sectionHeader(title,linkText,linkHref){
    var h='<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">';
    h+='<h2 style="font-size:15px;font-weight:700;color:'+NAVY+';margin:0">'+esc(title)+'</h2>';
    if(linkText)h+='<a href="'+(linkHref||'#')+'" style="font-size:12px;color:'+RED+';text-decoration:none;font-weight:600">'+esc(linkText)+'</a>';
    h+='</div>';
    return h;
  }

  // ---- PRODUCT GRID (5 columns) ----
  function productGrid(products,opts){
    if(!products||!products.length)return '<div style="text-align:center;padding:40px;color:#999;font-size:13px">No products found</div>';
    var h='<div class="dh-grid" style="display:grid;grid-template-columns:repeat(5,1fr);gap:16px">';
    for(var i=0;i<Math.min(products.length,opts&&opts.limit||5);i++){
      h+=productCard(products[i],opts);
    }
    h+='</div>';
    return h;
  }

  // ============================================================
  // SECTION 4: HERO BANNER CAROUSEL
  // ============================================================
  function buildHeroPlaceholder(container){
    var h='<div style="display:grid;grid-template-columns:2fr 1fr;gap:12px;margin-bottom:24px" class="dh-hero-grid">';
    // Main hero placeholder with branding
    h+='<div style="position:relative;border-radius:12px;overflow:hidden;aspect-ratio:2.2;background:linear-gradient(135deg,'+NAVY+' 0%,#2d2d52 50%,'+NAVY+' 100%)">';
    h+='<div style="position:relative;z-index:3;padding:32px;display:flex;flex-direction:column;justify-content:center;height:100%">';
    h+='<span style="display:inline-block;background:'+RED+';color:#fff;padding:4px 12px;border-radius:20px;font-size:10px;font-weight:700;margin-bottom:12px;width:fit-content">STYLEHUB MIAMI</span>';
    h+='<h2 style="color:#fff;font-size:22px;font-weight:700;margin:0 0 8px">Your deals. All in one place.</h2>';
    h+='<p style="color:rgba(255,255,255,0.6);font-size:13px;margin:0 0 16px;max-width:320px">Shop millions of products from top brands with secure checkout and tracked shipping.</p>';
    h+='<a href="/pages/search-results?q=trending" style="display:inline-block;background:'+RED+';color:#fff;padding:10px 24px;border-radius:8px;font-size:13px;font-weight:700;text-decoration:none;width:fit-content">Start Shopping</a>';
    h+='</div></div>';
    // Side cards (same as final hero — stay in place)
    h+='<div style="display:flex;flex-direction:column;gap:12px">';
    h+='<a href="/pages/search-results?q=deals" style="flex:1;background:#fff;border:1px solid #eee;border-radius:12px;padding:16px;display:flex;align-items:center;gap:12px;text-decoration:none">';
    h+='<div style="flex:1"><span style="display:inline-block;background:#FEF2F2;color:#991B1B;padding:2px 8px;border-radius:4px;font-size:9px;font-weight:700;margin-bottom:6px">Up to 70% off</span>';
    h+='<div style="font-size:13px;font-weight:700;color:'+NAVY+'">Flash deals</div>';
    h+='<div style="font-size:11px;color:#888">Limited time offers</div></div>';
    h+='<div id="dh-hero-flash-thumb" style="width:56px;height:56px;border-radius:8px;background:#f7f7f8;overflow:hidden;flex-shrink:0"></div>';
    h+='</a>';
    h+='<a href="/pages/search-results?q=bestsellers" style="flex:1;background:#fff;border:1px solid #eee;border-radius:12px;padding:16px;display:flex;align-items:center;gap:12px;text-decoration:none">';
    h+='<div style="flex:1"><span style="display:inline-block;background:#FEF3C7;color:#92400E;padding:2px 8px;border-radius:4px;font-size:9px;font-weight:700;margin-bottom:6px">Most popular</span>';
    h+='<div style="font-size:13px;font-weight:700;color:'+NAVY+'">Best sellers</div>';
    h+='<div style="font-size:11px;color:#888">Top rated this week</div></div>';
    h+='<div id="dh-hero-bs-thumb" style="width:56px;height:56px;border-radius:8px;background:#f7f7f8;overflow:hidden;flex-shrink:0"></div>';
    h+='</a>';
    h+='</div></div>';
    container.innerHTML=h;
  }

  function buildHero(container,trendingData){
    var products=trendingData||[];
    // Group by category
    var cats={};
    products.forEach(function(p){
      var cat=p.category||p.product_type||'General';
      if(!cats[cat])cats[cat]=[];
      cats[cat].push(p);
    });
    // Top 3 categories
    var sorted=Object.keys(cats).sort(function(a,b){return cats[b].length-cats[a].length}).slice(0,3);
    if(sorted.length===0)sorted=['Trending'];

    var slides=sorted.map(function(cat,i){
      var items=cats[cat]||products.slice(i*3,(i+1)*3);
      var topImg=items[0]?items[0].image||items[0].primaryImage||'':'';
      var top3=items.slice(0,3).map(function(p){return decodeEntities(p.title||'').substring(0,40)}).join(' · ');
      return {cat:cat,img:topImg,top3:top3};
    });

    var h='<div style="display:grid;grid-template-columns:2fr 1fr;gap:12px;margin-bottom:24px" class="dh-hero-grid">';

    // Main carousel
    h+='<div id="dh-hero-carousel" style="position:relative;border-radius:12px;overflow:hidden;aspect-ratio:2.2;background:'+NAVY+'">';
    slides.forEach(function(s,i){
      h+='<div class="dh-hero-slide" data-slide="'+i+'" style="position:absolute;inset:0;opacity:'+(i===0?'1':'0')+';transition:opacity 0.6s ease;z-index:'+(i===0?'2':'1')+'">';
      if(s.img)h+='<img src="'+esc(s.img)+'" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover" loading="'+(i===0?'eager':'lazy')+'">';
      h+='<div style="position:absolute;inset:0;background:linear-gradient(to right,rgba(26,26,46,0.95) 0%,rgba(26,26,46,0.85) 45%,rgba(26,26,46,0.35) 100%)"></div>';
      h+='<div style="position:relative;z-index:3;padding:32px;display:flex;flex-direction:column;justify-content:center;height:100%">';
      h+='<span style="display:inline-block;background:'+RED+';color:#fff;padding:4px 12px;border-radius:20px;font-size:10px;font-weight:700;margin-bottom:12px;width:fit-content">Trending now</span>';
      h+='<h2 style="color:#fff;font-size:18px;font-weight:700;margin:0 0 8px">Top picks in '+esc(s.cat)+'</h2>';
      h+='<p style="color:rgba(255,255,255,0.6);font-size:12px;margin:0 0 16px;max-width:320px">'+esc(s.top3)+'</p>';
      h+='<a href="/pages/search-results?q='+encodeURIComponent(s.cat)+'" style="display:inline-block;background:'+RED+';color:#fff;padding:10px 24px;border-radius:8px;font-size:13px;font-weight:700;text-decoration:none;width:fit-content">Shop '+esc(s.cat)+'</a>';
      h+='</div></div>';
    });
    // Dots
    h+='<div style="position:absolute;bottom:16px;left:32px;display:flex;gap:6px;z-index:5">';
    slides.forEach(function(_,i){
      h+='<span class="dh-hero-dot" data-dot="'+i+'" style="display:block;height:4px;border-radius:2px;cursor:pointer;transition:all 0.3s;'+(i===0?'width:20px;background:'+RED:'width:8px;background:rgba(255,255,255,0.4)')+'"></span>';
    });
    h+='</div>';
    // Arrows
    h+='<button class="dh-hero-arr" data-dir="-1" style="position:absolute;left:12px;top:50%;transform:translateY(-50%);z-index:5;background:rgba(255,255,255,0.15);border:none;color:#fff;width:32px;height:32px;border-radius:50%;font-size:16px;cursor:pointer">‹</button>';
    h+='<button class="dh-hero-arr" data-dir="1" style="position:absolute;right:12px;top:50%;transform:translateY(-50%);z-index:5;background:rgba(255,255,255,0.15);border:none;color:#fff;width:32px;height:32px;border-radius:50%;font-size:16px;cursor:pointer">›</button>';
    h+='</div>';

    // Side cards
    h+='<div style="display:flex;flex-direction:column;gap:12px">';
    // Flash deals card
    h+='<a href="/pages/search-results?q=deals" style="flex:1;background:#fff;border:1px solid #eee;border-radius:12px;padding:16px;display:flex;align-items:center;gap:12px;text-decoration:none">';
    h+='<div style="flex:1"><span style="display:inline-block;background:#FEF2F2;color:#991B1B;padding:2px 8px;border-radius:4px;font-size:9px;font-weight:700;margin-bottom:6px">Up to 70% off</span>';
    h+='<div style="font-size:13px;font-weight:700;color:'+NAVY+'">Flash deals</div>';
    h+='<div style="font-size:11px;color:#888">Limited time offers</div></div>';
    h+='<div id="dh-hero-flash-thumb" style="width:56px;height:56px;border-radius:8px;background:#f7f7f8;overflow:hidden;flex-shrink:0"></div>';
    h+='</a>';
    // Best sellers card
    h+='<a href="/pages/search-results?q=bestsellers" style="flex:1;background:#fff;border:1px solid #eee;border-radius:12px;padding:16px;display:flex;align-items:center;gap:12px;text-decoration:none">';
    h+='<div style="flex:1"><span style="display:inline-block;background:#FEF3C7;color:#92400E;padding:2px 8px;border-radius:4px;font-size:9px;font-weight:700;margin-bottom:6px">Most popular</span>';
    h+='<div style="font-size:13px;font-weight:700;color:'+NAVY+'">Best sellers</div>';
    h+='<div style="font-size:11px;color:#888">Top rated this week</div></div>';
    h+='<div id="dh-hero-bs-thumb" style="width:56px;height:56px;border-radius:8px;background:#f7f7f8;overflow:hidden;flex-shrink:0"></div>';
    h+='</a>';
    h+='</div></div>';

    container.innerHTML=h;
    initHeroCarousel(slides.length);
  }

  function initHeroCarousel(count){
    if(count<=1)return;
    var current=0,paused=false,timer;
    var carousel=document.getElementById('dh-hero-carousel');
    if(!carousel)return;

    function goTo(idx){
      current=((idx%count)+count)%count;
      var slides=carousel.querySelectorAll('.dh-hero-slide');
      var dots=carousel.querySelectorAll('.dh-hero-dot');
      slides.forEach(function(s,i){s.style.opacity=i===current?'1':'0';s.style.zIndex=i===current?'2':'1'});
      dots.forEach(function(d,i){d.style.width=i===current?'20px':'8px';d.style.background=i===current?RED:'rgba(255,255,255,0.4)'});
    }
    function next(){if(!paused)goTo(current+1)}
    timer=setInterval(next,5000);

    carousel.addEventListener('mouseenter',function(){paused=true});
    carousel.addEventListener('mouseleave',function(){paused=false});
    carousel.querySelectorAll('.dh-hero-arr').forEach(function(btn){
      btn.addEventListener('click',function(e){e.preventDefault();goTo(current+parseInt(this.dataset.dir))});
    });
    carousel.querySelectorAll('.dh-hero-dot').forEach(function(dot){
      dot.addEventListener('click',function(){goTo(parseInt(this.dataset.dot))});
    });
  }

  // ============================================================
  // SECTION 5: BECAUSE YOU SEARCHED
  // ============================================================
  function buildBecauseYouSearched(container){
    var searches=[];
    try{searches=JSON.parse(localStorage.getItem('stylehub_recent_searches')||'[]')}catch(e){}
    var query=searches.length>0?searches[0]:'';

    if(!query){
      // Fallback to trending
      apiFetch('/api/trending').then(function(data){
        var items=(data.results||data.products||data||[]).slice(0,5);
        if(!items.length){container.style.display='none';return}
        container.innerHTML=section('because-searched',
          sectionHeader('Trending now','View all >','/pages/search-results?q=trending')+
          productGrid(items));
      }).catch(function(){container.style.display='none'});
      return;
    }

    apiFetch('/api/search?q='+encodeURIComponent(query)+'&limit=5').then(function(data){
      var items=(data.results||data.products||data||[]).slice(0,5);
      if(!items.length){container.style.display='none';return}
      container.innerHTML=section('because-searched',
        sectionHeader('Because you searched \''+query+'\'','View all >','/pages/search-results?q='+encodeURIComponent(query))+
        productGrid(items));
    }).catch(function(){container.style.display='none'});
  }

  // ============================================================
  // SECTION 6: TRENDING NOW (with store tabs)
  // ============================================================
  function buildTrending(container){
    apiFetch('/api/trending').then(function(data){
      var items=data.results||data.products||data||[];
      if(!items.length){container.style.display='none';return}

      var stores=['All','Amazon','AliExpress','Sephora'];
      var h=section('trending','');
      // Header with tabs
      var header='<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;flex-wrap:wrap;gap:8px">';
      header+='<h2 style="font-size:15px;font-weight:700;color:'+NAVY+';margin:0">Trending now</h2>';
      header+='<div style="display:flex;border-radius:8px;overflow:hidden">';
      stores.forEach(function(s,i){
        var active=i===0;
        header+='<button class="dh-trend-tab" data-store="'+s.toLowerCase()+'" style="padding:6px 16px;font-size:11px;font-weight:600;border:none;cursor:pointer;transition:all 0.2s;'+(active?'background:'+NAVY+';color:#fff':'background:'+GRAY+';color:#666')+'">'+s+'</button>';
      });
      header+='</div></div>';

      container.innerHTML='<section id="dh-trending" style="max-width:1280px;margin:0 auto;padding:0 20px">'+header+
        '<div id="dh-trending-grid">'+productGrid(items.slice(0,5))+'</div>'+
        '<div style="text-align:right;margin-top:12px"><a href="/pages/search-results?q=trending" style="font-size:12px;color:'+RED+';text-decoration:none;font-weight:600">View all ></a></div></section>';

      // Tab filter logic
      window._trendingAll=items;
      container.querySelectorAll('.dh-trend-tab').forEach(function(tab){
        tab.addEventListener('click',function(){
          container.querySelectorAll('.dh-trend-tab').forEach(function(t){t.style.background=GRAY;t.style.color='#666'});
          this.style.background=NAVY;this.style.color='#fff';
          var store=this.dataset.store;
          var filtered=store==='all'?window._trendingAll:window._trendingAll.filter(function(p){return (p.source||p.sourceName||'').toLowerCase()===store});
          document.getElementById('dh-trending-grid').innerHTML=productGrid(filtered.slice(0,5));
        });
      });
    }).catch(function(){container.style.display='none'});
  }

  // ============================================================
  // SECTION 7: BRAND BANNER
  // ============================================================
  function buildBrandBanner(container){
    container.innerHTML=section('brand-banner',
      '<div style="background:'+NAVY+';border-radius:12px;padding:40px;display:flex;align-items:center;justify-content:space-between;position:relative;overflow:hidden">'+
      '<div style="position:absolute;right:-30px;top:-30px;width:200px;height:200px;border-radius:50%;border:1px solid rgba(255,255,255,0.06)"></div>'+
      '<div style="position:absolute;right:40px;bottom:-40px;width:150px;height:150px;border-radius:50%;border:1px solid rgba(255,255,255,0.04)"></div>'+
      '<div style="position:relative;z-index:2">'+
      '<div style="font-size:11px;color:rgba(255,255,255,0.5);letter-spacing:1px;margin-bottom:8px">STYLEHUB MIAMI</div>'+
      '<h2 style="font-size:20px;font-weight:700;color:#fff;margin:0 0 8px">Your deals. All in one place.</h2>'+
      '<p style="font-size:12px;color:rgba(255,255,255,0.5);margin:0;max-width:420px">Shop millions of products from Amazon, AliExpress, Sephora, SHEIN & Macy\'s with secure checkout and tracked shipping.</p>'+
      '</div>'+
      '<a href="/pages/search-results?q=deals" style="position:relative;z-index:2;background:'+RED+';color:#fff;padding:12px 24px;border-radius:8px;font-size:13px;font-weight:700;text-decoration:none;white-space:nowrap">Explore deals</a>'+
      '</div>');
  }

  // ============================================================
  // SECTION 8: CATEGORY BANNERS (daily rotation)
  // ============================================================
  function buildCategoryBanners(container){
    var pairs=[
      ['Women\'s fashion','Beauty'],['Electronics','Sports'],['Home & garden','Kids'],
      ['Shoes','Accessories'],['Phones','Jewelry'],['Women\'s fashion','Electronics'],['Beauty','Sports']
    ];
    var today=pairs[new Date().getDay()];
    var meta={
      'Women\'s fashion':{t:'Spring collection picks',s:'Dresses, tops, accessories'},
      'Beauty':{t:'Skincare essentials',s:'Sephora, SHEIN, Macy\'s'},
      'Electronics':{t:'Top tech picks',s:'Phones, laptops, gadgets'},
      'Sports':{t:'Gear up for summer',s:'Running shoes, yoga, workout gear'},
      'Home & garden':{t:'Home essentials',s:'Decor, kitchen, garden'},
      'Kids':{t:'Kids\' favorites',s:'Toys, clothing, accessories'},
      'Shoes':{t:'Step up your style',s:'Sneakers, boots, sandals'},
      'Accessories':{t:'Complete the look',s:'Watches, sunglasses, bags'},
      'Phones':{t:'Latest mobile deals',s:'Cases, chargers, smartphones'},
      'Jewelry':{t:'Shine bright',s:'Rings, necklaces, bracelets'}
    };
    var c1=meta[today[0]]||{t:today[0],s:'Shop now'};
    var c2=meta[today[1]]||{t:today[1],s:'Shop now'};

    container.innerHTML=section('cat-banners',
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px" class="dh-cat-banners">'+
      '<div style="background:'+NAVY+';border-radius:12px;padding:28px">'+
      '<span style="font-size:10px;color:rgba(255,255,255,0.5);text-transform:uppercase;letter-spacing:0.5px">'+esc(today[0])+'</span>'+
      '<h3 style="color:#fff;font-size:16px;font-weight:700;margin:8px 0 4px">'+esc(c1.t)+'</h3>'+
      '<p style="color:rgba(255,255,255,0.5);font-size:11px;margin:0 0 16px">'+esc(c1.s)+'</p>'+
      '<a href="/pages/search-results?q='+encodeURIComponent(today[0])+'" style="color:'+RED+';font-size:12px;font-weight:600;text-decoration:none">Shop '+esc(today[0])+' ></a>'+
      '</div>'+
      '<div style="background:#fff;border:1px solid #eee;border-radius:12px;padding:28px">'+
      '<span style="font-size:10px;color:#999;text-transform:uppercase;letter-spacing:0.5px">'+esc(today[1])+'</span>'+
      '<h3 style="color:'+NAVY+';font-size:16px;font-weight:700;margin:8px 0 4px">'+esc(c2.t)+'</h3>'+
      '<p style="color:#888;font-size:11px;margin:0 0 16px">'+esc(c2.s)+'</p>'+
      '<a href="/pages/search-results?q='+encodeURIComponent(today[1])+'" style="color:'+RED+';font-size:12px;font-weight:600;text-decoration:none">Shop '+esc(today[1])+' ></a>'+
      '</div></div>');
  }

  // ============================================================
  // SECTION 9: FLASH DEALS
  // ============================================================
  function buildFlashDeals(container){
    apiFetch('/api/flash-deals').then(function(data){
      var items=data.results||data.products||data||[];
      if(!items.length){container.style.display='none';return}

      // Countdown — check for ends_at
      var endsAt=data.ends_at?new Date(data.ends_at).getTime():0;
      var hasTimer=endsAt>Date.now();

      var header='<div style="display:flex;align-items:center;gap:12px;margin-bottom:16px">';
      header+='<h2 style="font-size:15px;font-weight:700;color:'+NAVY+';margin:0">Flash deals</h2>';
      if(hasTimer){
        header+='<div id="dh-flash-timer" style="display:flex;gap:4px;font-size:13px"></div>';
      } else {
        header+='<span style="font-size:11px;color:#888">Limited time offer</span>';
      }
      header+='<a href="/pages/search-results?q=deals" style="margin-left:auto;font-size:12px;color:'+RED+';text-decoration:none;font-weight:600">View all ></a>';
      header+='</div>';

      // Cards with claimed bar
      var grid='<div class="dh-grid" style="display:grid;grid-template-columns:repeat(5,1fr);gap:16px">';
      items.slice(0,5).forEach(function(p){
        var claimed=Math.floor(Math.random()*65)+30; // 30-95%
        var card=productCard(p,{ctaType:'red',cta:'⚡ Grab Deal'});
        // Inject claimed bar before closing </div></div>
        var barHtml='<div style="margin:0 12px 8px"><div style="background:#eee;border-radius:4px;height:4px;overflow:hidden"><div style="background:'+RED+';height:100%;width:'+claimed+'%;border-radius:4px"></div></div><div style="font-size:9px;color:#888;margin-top:2px">'+claimed+'% claimed</div></div>';
        // Insert before last </div>
        var lastClose=card.lastIndexOf('</div>');
        card=card.substring(0,lastClose)+barHtml+'</div>';
        grid+=card;
      });
      grid+='</div>';

      container.innerHTML=section('flash-deals',header+grid);

      // Start countdown
      if(hasTimer){
        var timerEl=document.getElementById('dh-flash-timer');
        function updateTimer(){
          var diff=endsAt-Date.now();
          if(diff<=0){timerEl.innerHTML='<span style="color:#888;font-size:11px">Ended</span>';return}
          var h=Math.floor(diff/3600000),m=Math.floor((diff%3600000)/60000),s=Math.floor((diff%60000)/1000);
          timerEl.innerHTML=[h,m,s].map(function(v){return '<span style="background:'+NAVY+';color:'+RED+';padding:2px 6px;border-radius:4px;font-weight:700;font-size:14px;min-width:28px;text-align:center;display:inline-block">'+(v<10?'0':'')+v+'</span>'}).join('<span style="color:#999;font-weight:700"> : </span>');
          setTimeout(updateTimer,1000);
        }
        updateTimer();
      }
    }).catch(function(){container.style.display='none'});
  }

  // ============================================================
  // SECTION 10: NEW THIS WEEK BANNER
  // ============================================================
  function buildNewThisWeek(container){
    apiFetch('/api/new-arrivals').then(function(data){
      var items=data.results||data.products||data||[];
      var count=items.length||0;
      container.innerHTML=section('new-week',
        '<div style="background:#fff;border:1px solid #eee;border-radius:12px;padding:16px 20px;display:flex;align-items:center;gap:16px">'+
        '<div style="width:48px;height:48px;background:'+NAVY+';border-radius:12px;display:flex;align-items:center;justify-content:center;flex-shrink:0"><span style="color:#fff;font-size:18px;font-weight:700">S</span></div>'+
        '<div style="flex:1"><div style="font-size:14px;font-weight:700;color:'+NAVY+'">New on StyleHub this week</div>'+
        '<div style="font-size:12px;color:#888">'+count+' new products added from Amazon, AliExpress & Sephora — updated every 6 hours</div></div>'+
        '<a href="/pages/search-results?q=new" style="color:'+RED+';font-size:12px;font-weight:600;text-decoration:none;white-space:nowrap">See what\'s new ></a>'+
        '</div>');
    }).catch(function(){container.style.display='none'});
  }

  // ============================================================
  // SECTION 11: BEST SELLERS
  // ============================================================
  function buildBestSellers(container){
    apiFetch('/api/bestsellers').then(function(data){
      var items=(data.results||data.products||data||[]).slice(0,5);
      if(!items.length){container.style.display='none';return}

      var grid='<div class="dh-grid" style="display:grid;grid-template-columns:repeat(5,1fr);gap:16px">';
      items.forEach(function(p,i){
        var rankBadge='';
        if(i<3)rankBadge='<span style="position:absolute;top:8px;left:8px;background:#FEF3C7;color:#92400E;padding:2px 8px;border-radius:4px;font-size:9px;font-weight:700;z-index:2">#'+(i+1)+(i===0?' Best Seller':'')+'</span>';
        grid+=productCard(p,{rankBadge:rankBadge});
      });
      grid+='</div>';

      container.innerHTML=section('bestsellers',
        sectionHeader('Best sellers','View all >','/pages/search-results?q=bestsellers')+grid);
    }).catch(function(){container.style.display='none'});
  }

  // ============================================================
  // SECTION 12: CONTINUE SHOPPING (Recently Viewed)
  // ============================================================
  function buildContinueShopping(container){
    var viewed=[];
    try{viewed=JSON.parse(localStorage.getItem('stylehub_viewed_products')||'[]')}catch(e){}
    if(!viewed.length){container.style.display='none';return}

    var header='<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">';
    header+='<h2 style="font-size:15px;font-weight:700;color:'+NAVY+';margin:0">Continue shopping</h2>';
    header+='<a href="#" id="dh-clear-viewed" style="font-size:12px;color:'+RED+';text-decoration:none;font-weight:600">Clear ></a></div>';

    container.innerHTML=section('continue-shopping',header+productGrid(viewed.slice(0,5),{ctaType:'outline',cta:'Add to Cart'}));

    document.getElementById('dh-clear-viewed').addEventListener('click',function(e){
      e.preventDefault();
      localStorage.removeItem('stylehub_viewed_products');
      container.style.display='none';
    });
  }

  // ============================================================
  // SECTION 13: SHOP BY CATEGORY (16 circles)
  // ============================================================
  function buildShopByCategory(container){
    var cats=[
      {n:'Women',q:'women fashion'},{n:'Men',q:'men fashion'},{n:'Beauty',q:'beauty'},{n:'Skincare',q:'skincare'},
      {n:'Electronics',q:'electronics'},{n:'Phones',q:'phones'},{n:'Home',q:'home garden'},{n:'Sports',q:'sports'},
      {n:'Kids',q:'kids'},{n:'Shoes',q:'shoes'},{n:'Accessories',q:'accessories'},{n:'Bags',q:'bags'},
      {n:'Jewelry',q:'jewelry'},{n:'Gaming',q:'gaming'},{n:'Pets',q:'pets'},{n:'Auto',q:'auto'}
    ];
    var grid='<div style="display:grid;grid-template-columns:repeat(8,1fr);gap:12px;text-align:center" class="dh-cat-circles">';
    cats.forEach(function(c){
      grid+='<a href="/pages/search-results?q='+encodeURIComponent(c.q)+'" style="text-decoration:none;display:flex;flex-direction:column;align-items:center;gap:6px">';
      grid+='<div style="width:48px;height:48px;border-radius:50%;background:'+GRAY+';display:flex;align-items:center;justify-content:center;font-size:16px;color:#666;font-weight:600">'+c.n.charAt(0)+'</div>';
      grid+='<span style="font-size:10px;color:#666">'+esc(c.n)+'</span></a>';
    });
    grid+='</div>';
    container.innerHTML=section('shop-category',sectionHeader('Shop by category')+grid);
  }

  // ============================================================
  // SECTION 14: STATS BANNER
  // ============================================================
  function buildStatsBanner(container){
    container.innerHTML=section('stats',
      '<div style="background:'+NAVY+';border-radius:12px;padding:28px;display:grid;grid-template-columns:repeat(3,1fr);gap:20px;text-align:center" class="dh-stats-grid">'+
      '<div><div style="font-size:22px;font-weight:700;color:'+RED+'">5</div><div style="font-size:11px;color:rgba(255,255,255,0.7);margin-top:4px">Trusted stores</div><div style="font-size:9px;color:rgba(255,255,255,0.4);margin-top:2px">Amazon, AliExpress, Sephora, SHEIN, Macy\'s</div></div>'+
      '<div><div style="font-size:22px;font-weight:700;color:'+RED+'">1M+</div><div style="font-size:11px;color:rgba(255,255,255,0.7);margin-top:4px">Products available</div><div style="font-size:9px;color:rgba(255,255,255,0.4);margin-top:2px">Searched in real-time</div></div>'+
      '<div><div style="font-size:22px;font-weight:700;color:'+RED+'">70%</div><div style="font-size:11px;color:rgba(255,255,255,0.7);margin-top:4px">Max savings</div><div style="font-size:9px;color:rgba(255,255,255,0.4);margin-top:2px">Compare prices across stores</div></div>'+
      '</div>');
  }

  // ============================================================
  // SECTION 15: DISCOVER MORE
  // ============================================================
  function buildDiscoverMore(container){
    Promise.all([apiFetch('/api/featured?category=moda'),apiFetch('/api/trending')]).then(function(results){
      var feat=results[0].results||results[0].products||results[0]||[];
      var trend=results[1].results||results[1].products||results[1]||[];
      var all=feat.concat(trend);
      // Dedupe by id
      var seen={};
      all=all.filter(function(p){var k=p.id||p.title;if(seen[k])return false;seen[k]=true;return true});
      // Shuffle with 6h seed
      var seed=Math.floor(Date.now()/21600000);
      all=shuffleSeed(all,seed);

      window._discoverAll=all;
      window._discoverShown=10;

      var grid='<div id="dh-discover-grid" class="dh-grid" style="display:grid;grid-template-columns:repeat(5,1fr);gap:16px">';
      all.slice(0,10).forEach(function(p){grid+=productCard(p)});
      grid+='</div>';

      container.innerHTML=section('discover',
        '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">'+
        '<h2 style="font-size:15px;font-weight:700;color:'+NAVY+';margin:0">Discover more</h2>'+
        '<span style="font-size:11px;color:#888">Refreshes every 6h</span></div>'+
        grid+
        '<div style="text-align:center;margin-top:20px"><button id="dh-load-more" style="background:#fff;border:0.5px solid #ddd;color:'+NAVY+';padding:12px 32px;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer">Load more products</button></div>');

      document.getElementById('dh-load-more').addEventListener('click',function(){
        var next=window._discoverAll.slice(window._discoverShown,window._discoverShown+10);
        if(!next.length){this.textContent='No more products';this.disabled=true;return}
        var gridEl=document.getElementById('dh-discover-grid');
        next.forEach(function(p){gridEl.insertAdjacentHTML('beforeend',productCard(p))});
        window._discoverShown+=10;
      });
    }).catch(function(){container.style.display='none'});
  }

  // ============================================================
  // SECTION 16: USP / WHY BUY
  // ============================================================
  function buildUSP(container){
    var items=[
      {icon:'🔒',t:'Secure checkout',s:'SSL encrypted'},
      {icon:'📦',t:'Tracked shipping',s:'Real-time tracking'},
      {icon:'💰',t:'Best prices',s:'Up to 70% off'},
      {icon:'💬',t:'24/7 support',s:'Always here to help'}
    ];
    var grid='<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:16px;text-align:center" class="dh-usp-grid">';
    items.forEach(function(i){
      grid+='<div style="padding:16px"><div style="width:36px;height:36px;border-radius:50%;background:'+GRAY+';display:flex;align-items:center;justify-content:center;margin:0 auto 8px;font-size:16px">'+i.icon+'</div>';
      grid+='<div style="font-size:11px;font-weight:700;color:'+NAVY+'">'+i.t+'</div>';
      grid+='<div style="font-size:10px;color:#888;margin-top:2px">'+i.s+'</div></div>';
    });
    grid+='</div>';
    container.innerHTML=section('usp',grid);
  }

  // ============================================================
  // SECTION 17: NEWSLETTER
  // ============================================================
  function buildNewsletter(container){
    container.innerHTML=section('newsletter',
      '<div style="background:'+NAVY+';border-radius:12px;padding:40px;text-align:center">'+
      '<h2 style="font-size:16px;font-weight:700;color:#fff;margin:0 0 8px">Be the first to know about new deals</h2>'+
      '<p style="font-size:12px;color:rgba(255,255,255,0.6);margin:0 0 20px">Join 10,000+ shoppers. No spam, unsubscribe anytime.</p>'+
      '<form id="dh-newsletter-form" style="display:flex;max-width:420px;margin:0 auto">'+
      '<input type="email" placeholder="Enter your email" required style="flex:1;padding:12px 16px;border:none;border-radius:8px 0 0 8px;font-size:13px;outline:none">'+
      '<button type="submit" style="background:'+RED+';color:#fff;border:none;padding:12px 24px;border-radius:0 8px 8px 0;font-size:13px;font-weight:700;cursor:pointer;white-space:nowrap">Subscribe</button>'+
      '</form><div id="dh-newsletter-msg" style="margin-top:8px;font-size:12px;color:rgba(255,255,255,0.7)"></div></div>');

    document.getElementById('dh-newsletter-form').addEventListener('submit',function(e){
      e.preventDefault();
      var email=this.querySelector('input').value;
      var msg=document.getElementById('dh-newsletter-msg');
      msg.textContent='Subscribing...';
      // Try Shopify customer API
      fetch('/contact',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},
        body:'form_type=customer&email='+encodeURIComponent(email)+'&utf8=✓'})
        .then(function(){msg.textContent='Thanks for subscribing!';msg.style.color='#22c55e'})
        .catch(function(){msg.textContent='Thanks! We\'ll keep you posted.';msg.style.color='#22c55e'});
    });
  }

  // ============================================================
  // RESPONSIVE CSS
  // ============================================================
  function injectStyles(){
    var css=document.createElement('style');
    css.textContent='@media(max-width:1024px){.dh-grid{grid-template-columns:repeat(3,1fr)!important}.dh-hero-grid{grid-template-columns:1fr!important}.dh-cat-banners{grid-template-columns:1fr!important}.dh-stats-grid{grid-template-columns:repeat(3,1fr)!important}.dh-cat-circles{grid-template-columns:repeat(4,1fr)!important}.dh-usp-grid{grid-template-columns:repeat(2,1fr)!important}}@media(max-width:768px){.dh-grid{grid-template-columns:repeat(2,1fr)!important}.dh-hero-grid{grid-template-columns:1fr!important}#dh-hero-carousel{aspect-ratio:1.5!important}.dh-cat-circles{grid-template-columns:repeat(4,1fr)!important}.dh-stats-grid{grid-template-columns:1fr!important}.dh-usp-grid{grid-template-columns:repeat(2,1fr)!important}}.dh-card:hover{box-shadow:0 4px 12px rgba(0,0,0,0.08);transform:translateY(-2px);transition:all 0.2s}.dh-card{transition:all 0.2s}';
    document.head.appendChild(css);
  }

  // ============================================================
  // INIT — Build all sections in order
  // ============================================================
  function init(){
    var root=document.getElementById('dealshub-home');
    if(!root)return;

    injectStyles();

    // Create containers for each section
    var sections=['hero','because-searched','trending','brand-banner','cat-banners',
      'flash-deals','new-week','bestsellers','continue-shopping','shop-category',
      'stats-banner','discover','usp','newsletter'];

    sections.forEach(function(id){
      var div=document.createElement('div');
      div.id='dh-sec-'+id;
      div.style.marginBottom='32px';
      root.appendChild(div);
    });

    // Build hero IMMEDIATELY with placeholder, then populate with API data
    var heroContainer=document.getElementById('dh-sec-hero');
    buildHeroPlaceholder(heroContainer);
    apiFetch('/api/trending').then(function(data){
      buildHero(heroContainer,data.results||data.products||data||[]);
    }).catch(function(){
      // Keep the placeholder — it's already showing a nice hero
    });
    // Load hero side card thumbnails in parallel (not chained to trending)
    apiFetch('/api/flash-deals').then(function(fd){
      var items=fd.results||fd.products||fd||[];
      if(items[0]&&items[0].image){
        var el=document.getElementById('dh-hero-flash-thumb');
        if(el)el.innerHTML='<img src="'+esc(items[0].image)+'" style="width:100%;height:100%;object-fit:contain">';
      }
    }).catch(function(){});
    apiFetch('/api/bestsellers').then(function(bs){
      var items=bs.results||bs.products||bs||[];
      if(items[0]&&items[0].image){
        var el=document.getElementById('dh-hero-bs-thumb');
        if(el)el.innerHTML='<img src="'+esc(items[0].image)+'" style="width:100%;height:100%;object-fit:contain">';
      }
    }).catch(function(){});

    // Build remaining sections
    buildBecauseYouSearched(document.getElementById('dh-sec-because-searched'));
    buildTrending(document.getElementById('dh-sec-trending'));
    buildBrandBanner(document.getElementById('dh-sec-brand-banner'));
    buildCategoryBanners(document.getElementById('dh-sec-cat-banners'));
    buildFlashDeals(document.getElementById('dh-sec-flash-deals'));
    buildNewThisWeek(document.getElementById('dh-sec-new-week'));
    buildBestSellers(document.getElementById('dh-sec-bestsellers'));
    buildContinueShopping(document.getElementById('dh-sec-continue-shopping'));
    buildShopByCategory(document.getElementById('dh-sec-shop-category'));
    buildStatsBanner(document.getElementById('dh-sec-stats-banner'));
    buildDiscoverMore(document.getElementById('dh-sec-discover'));
    buildUSP(document.getElementById('dh-sec-usp'));
    buildNewsletter(document.getElementById('dh-sec-newsletter'));
  }

  // Run when DOM ready
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);
  else init();
})();
