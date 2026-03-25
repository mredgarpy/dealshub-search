/* StyleHub PDP v3.0 — Complete Product Detail Page (14 Sections)
   Sprint 3: Full API data rendering — A+ images, specs, rating breakdown,
   reviews, frequently bought together, seller info, videos, sales volume
   FIX v1.1-1.5: Retained all cart/variant logic from previous versions
*/
(function(){
  'use strict';
  var API='https://dealshub-search.onrender.com';
  var container=document.getElementById('dealshub-pdp');
  if(!container)return;
  var params=new URLSearchParams(window.location.search);
  var productId=params.get('id');
  var store=params.get('store')||'amazon';
  var titleHint=params.get('title')||'';
  var _pdpProductData=null;
  if(!productId){container.innerHTML='<div style="text-align:center;padding:60px 20px"><h2>Product Not Found</h2><p>No product ID specified.</p><a href="/" style="color:#e53e3e">Back to Home</a></div>';return}

  container.innerHTML=skeletonHTML();

  fetch(API+'/api/product/'+encodeURIComponent(productId)+'?store='+encodeURIComponent(store)+(titleHint?'&title='+encodeURIComponent(titleHint):''),{signal:AbortSignal.timeout(20000)})
    .then(function(r){if(!r.ok)throw new Error('HTTP '+r.status);return r.json()})
    .then(function(data){
      var p=data;
      _pdpProductData=p;
      if(p&&!p.title&&titleHint)p.title=decodeURIComponent(titleHint);
      if(p&&(!p.image&&!p.primaryImage)&&params.get('image'))p.primaryImage=params.get('image');
      if(!p||!p.title)throw new Error('No product data');
      /* Frontend safety: clean badge + salesVolume */
      if(p.badge)p.badge=(p.badge||'').replace(/Amazon'?s?\s*Choice/gi,'Popular Choice');
      if(p.salesVolume)p.salesVolume=(p.salesVolume||'').replace(/on Amazon\s*/gi,'').replace(/New\s+in past month/i,'New this month').trim();
      renderProduct(p);
      addToRecentlyViewed(p);
    })
    .catch(function(err){
      console.error('PDP fetch error:',err);
      container.innerHTML='<div style="text-align:center;padding:60px 20px"><h2>Unable to Load Product</h2><p>'+esc(err.message)+'</p><p style="margin-top:16px"><a href="/" style="color:#e53e3e;text-decoration:underline">Back to Home</a> &middot; <a href="javascript:location.reload()" style="color:#e53e3e;text-decoration:underline">Retry</a></p></div>';
    });

  function esc(s){var d=document.createElement('div');d.textContent=s||'';return d.innerHTML}

  function skeletonHTML(){
    return '<div style="max-width:1200px;margin:0 auto;padding:20px;display:grid;grid-template-columns:1fr 1fr;gap:40px" class="dhpdp-skel">'+
      '<div style="aspect-ratio:1;background:#f0f0f0;border-radius:12px;animation:dhpulse 1.5s infinite"></div>'+
      '<div><div style="height:24px;background:#f0f0f0;border-radius:6px;width:60%;margin-bottom:16px;animation:dhpulse 1.5s infinite"></div>'+
      '<div style="height:36px;background:#f0f0f0;border-radius:6px;width:80%;margin-bottom:12px;animation:dhpulse 1.5s infinite"></div>'+
      '<div style="height:28px;background:#f0f0f0;border-radius:6px;width:40%;margin-bottom:24px;animation:dhpulse 1.5s infinite"></div>'+
      '<div style="height:48px;background:#f0f0f0;border-radius:6px;width:100%;margin-bottom:12px;animation:dhpulse 1.5s infinite"></div>'+
      '<div style="height:48px;background:#f0f0f0;border-radius:6px;width:100%;animation:dhpulse 1.5s infinite"></div></div></div>'+
      '<style>@keyframes dhpulse{0%,100%{opacity:1}50%{opacity:.5}}@media(max-width:768px){.dhpdp-skel{grid-template-columns:1fr!important}}</style>';
  }

  function renderProduct(p){
    var imgs=p.images&&p.images.length?p.images:(p.primaryImage?[p.primaryImage]:(p.image?[p.image]:[]));
    var mainImg=imgs[0]||'';
    var price=typeof p.price==='number'?p.price:parseFloat(String(p.price||'0').replace(/[^0-9.]/g,''));
    var origPrice=typeof p.originalPrice==='number'?p.originalPrice:parseFloat(String(p.originalPrice||'0').replace(/[^0-9.]/g,''));
    var discount=origPrice>price?Math.round((1-price/origPrice)*100):0;
    var rating=p.rating?parseFloat(p.rating):0;
    var reviews=p.reviews||0;

    var html='<div class="dhpdp" style="max-width:1200px;margin:0 auto;padding:20px">';

    // ═══ SECTION 1: BREADCRUMBS ═══
    html+=renderBreadcrumbs(p);

    html+='<div style="display:grid;grid-template-columns:1fr 1fr;gap:40px" class="dhpdp-grid">';

    // ═══ SECTION 2: IMAGE GALLERY (left) ═══
    html+=renderGallery(p, imgs, mainImg, discount);

    // RIGHT COLUMN
    html+='<div class="dhpdp-info">';

    // ═══ SECTION 3: PRODUCT INFO ═══
    html+=renderProductInfo(p, price, origPrice, discount, rating, reviews);

    // ═══ SECTION 4: VARIANTS ═══
    html+=renderVariants(p);

    // ═══ SECTION 5: BUY BUTTONS ═══
    html+=renderBuyButtons();

    // ═══ SECTION 6: SHIPPING & DELIVERY ═══
    html+=renderShipping(p);

    html+='</div>'; // end info
    html+='</div>'; // end grid

    // ═══ SECTION 7: BULLET POINTS ═══
    html+=renderBullets(p);

    // ═══ SECTION 8: A+ CONTENT / DESCRIPTION IMAGES ═══
    html+=renderAplusContent(p);

    // ═══ SECTION 9: PRODUCT DESCRIPTION ═══
    html+=renderDescription(p);

    // ═══ SECTION 10: SPECIFICATIONS TABLE ═══
    html+=renderSpecifications(p);

    // ═══ SECTION 11: RATING BREAKDOWN ═══
    html+=renderRatingBreakdown(p, rating, reviews);

    // ═══ SECTION 12: CUSTOMER REVIEWS ═══
    html+=renderReviews(p);

    // ═══ SECTION 13: FREQUENTLY BOUGHT TOGETHER ═══
    html+=renderFrequentlyBought(p);

    // ═══ SECTION 14: SELLER INFO ═══
    html+=renderSellerInfo(p);

    // Mobile sticky CTA
    html+='<div id="dhpdp-sticky" style="display:none;position:fixed;bottom:0;left:0;right:0;background:#fff;padding:12px 16px;box-shadow:0 -2px 10px rgba(0,0,0,0.1);z-index:1000;border-top:1px solid #eee">';
    html+='<div style="max-width:600px;margin:0 auto;display:flex;gap:10px">';
    html+='<button class="dhpdp-sticky-atc" style="flex:1;padding:14px;background:#e53e3e;color:#fff;border:none;border-radius:10px;font-size:15px;font-weight:700;cursor:pointer">Add to Cart</button>';
    html+='<button class="dhpdp-sticky-buy" style="flex:1;padding:14px;background:#1a1a1a;color:#fff;border:none;border-radius:10px;font-size:15px;font-weight:700;cursor:pointer">Buy Now</button>';
    html+='</div></div>';

    html+='</div>'; // end dhpdp

    // Responsive CSS
    html+='<style>';
    html+='.dhpdp-grid{grid-template-columns:1fr 1fr;gap:40px}';
    html+='@media(max-width:768px){.dhpdp-grid{grid-template-columns:1fr!important;gap:20px!important}.dhpdp h1{font-size:20px!important}#dhpdp-sticky{display:flex!important}}';
    html+='.dhpdp-spec-table{width:100%;border-collapse:collapse}.dhpdp-spec-table tr:nth-child(even){background:#f8fafc}.dhpdp-spec-table td{padding:10px 14px;font-size:14px;border-bottom:1px solid #f0f0f0}.dhpdp-spec-table td:first-child{font-weight:600;color:#374151;width:40%}';
    html+='.dhpdp-review{border-bottom:1px solid #f0f0f0;padding:20px 0}.dhpdp-review:last-child{border-bottom:none}';
    html+='.dhpdp-rating-bar{height:8px;background:#e5e7eb;border-radius:4px;flex:1;overflow:hidden}.dhpdp-rating-fill{height:100%;background:#f59e0b;border-radius:4px;transition:width .6s ease}';
    html+='.dhpdp-fbt-card{background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:12px;text-align:center;transition:box-shadow .2s}.dhpdp-fbt-card:hover{box-shadow:0 4px 12px rgba(0,0,0,.08)}';
    html+='.dhpdp-section{margin-top:40px;border-top:1px solid #eee;padding-top:32px}';
    html+='.dhpdp-section-title{font-size:20px;font-weight:700;color:#1a1a2e;margin-bottom:20px}';
    html+='@keyframes dhpdp-spin{to{transform:rotate(360deg)}}';
    html+='.dhpdp-opt-unavail{position:relative}';
    html+='.sh-size-pill{transition:border-color .15s,background .15s}';
    html+='</style>';

    container.innerHTML=html;
    bindEvents(p,imgs);
  }

  // ═══ SECTION 1: BREADCRUMBS ═══
  function renderBreadcrumbs(p){
    var h='<nav style="font-size:13px;color:#666;margin-bottom:16px"><a href="/" style="color:#666;text-decoration:none">Home</a>';
    var crumbs=p.breadcrumbs||[];
    if(crumbs.length){
      crumbs.forEach(function(c){
        if(typeof c==='object')c=c.title||c.name||'';
        if(c)h+=' <span style="margin:0 6px;color:#ccc">/</span> <span>'+esc(c)+'</span>';
      });
    }else if(p.category){
      h+=' <span style="margin:0 6px;color:#ccc">/</span> <span>'+esc(p.category)+'</span>';
    }
    h+=' <span style="margin:0 6px;color:#ccc">/</span> <span style="color:#333">'+esc((p.title||'').substring(0,50))+(p.title&&p.title.length>50?'...':'')+'</span></nav>';
    return h;
  }

  // ═══ SECTION 2: IMAGE GALLERY ═══
  function renderGallery(p,imgs,mainImg,discount){
    var h='<div class="dhpdp-gallery">';
    // Main image
    h+='<div style="position:relative;border-radius:12px;overflow:hidden;background:#fafafa;border:1px solid #eee">';
    if(p.badge)h+='<span style="position:absolute;top:12px;left:12px;background:#e53e3e;color:#fff;padding:4px 12px;border-radius:20px;font-size:12px;font-weight:600;z-index:2">'+esc(p.badge)+'</span>';
    if(discount>0)h+='<span style="position:absolute;top:12px;right:12px;background:#E53E3E;color:#fff;padding:4px 10px;border-radius:20px;font-size:12px;font-weight:600;z-index:2">-'+discount+'%</span>';
    // Sales volume badge
    if(p.salesVolume)h+='<span style="position:absolute;bottom:12px;left:12px;background:rgba(0,0,0,.7);color:#fff;padding:4px 10px;border-radius:20px;font-size:11px;font-weight:500;z-index:2">'+esc(p.salesVolume)+'</span>';
    h+='<img id="dhpdp-main-img" src="'+esc(mainImg)+'" alt="'+esc(p.title)+'" style="width:100%;aspect-ratio:1;object-fit:contain;display:block;cursor:zoom-in" onerror="this.src=\'data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 400 400%22><rect fill=%22%23f5f5f5%22 width=%22400%22 height=%22400%22/><text x=%22200%22 y=%22200%22 text-anchor=%22middle%22 fill=%22%23ccc%22 font-size=%2220%22>No Image</text></svg>\'"></div>';

    // Thumbnails
    if(imgs.length>1){
      h+='<div style="display:flex;gap:8px;margin-top:12px;overflow-x:auto;padding-bottom:4px" class="dhpdp-thumbs">';
      for(var i=0;i<Math.min(imgs.length,10);i++){
        h+='<img src="'+esc(imgs[i])+'" class="dhpdp-thumb" data-idx="'+i+'" style="width:64px;height:64px;object-fit:contain;border-radius:8px;border:2px solid '+(i===0?'#e53e3e':'#eee')+';cursor:pointer;flex-shrink:0;background:#fafafa" onerror="this.style.display=\'none\'">';
      }
      h+='</div>';
    }

    // Video button if available
    if(p.hasVideo&&p.videos&&p.videos.length){
      h+='<div style="margin-top:8px"><button class="dhpdp-video-btn" style="display:inline-flex;align-items:center;gap:6px;padding:8px 16px;background:#1a1a2e;color:#fff;border:none;border-radius:8px;font-size:13px;cursor:pointer">&#9654; Watch Video</button></div>';
    }
    h+='</div>';
    return h;
  }

  // ═══ SECTION 3: PRODUCT INFO ═══
  function renderProductInfo(p,price,origPrice,discount,rating,reviews){
    var h='';
    // Brand
    if(p.brand)h+='<div style="font-size:13px;color:#888;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px">'+esc(p.brand)+'</div>';

    // Origin badge
    if(p.originBadge||p.originType){
      var obType=(p.originType||'UNKNOWN').toUpperCase();
      var obIsUSA=obType==='USA';
      h+='<div style="display:inline-flex;align-items:center;gap:6px;background:'+(obIsUSA?'#ecfdf5':'#fffbeb')+';border:1px solid '+(obIsUSA?'#d1fae5':'#fef3c7')+';padding:5px 12px;border-radius:6px;font-size:13px;font-weight:600;color:'+(obIsUSA?'#059669':'#d97706')+';margin-bottom:10px">';
      h+='<span style="font-size:15px">'+(p.originFlag||'&#127758;')+'</span>';
      h+=esc(p.originBadge||obType)+' Origin';
      if(p.originDelivery)h+=' <span style="font-weight:400;margin-left:4px">&middot; '+esc(p.originDelivery)+'</span>';
      h+='</div>';
    }

    // Product condition badge
    if(p.productCondition&&p.productCondition!=='New'){
      h+='<span style="display:inline-block;background:#dbeafe;color:#1d4ed8;padding:3px 10px;border-radius:4px;font-size:12px;font-weight:600;margin-bottom:10px;margin-left:8px">'+esc(p.productCondition)+'</span>';
    }

    // Title
    h+='<h1 style="font-size:24px;font-weight:700;color:#1a1a1a;line-height:1.3;margin:0 0 12px">'+esc(p.title)+'</h1>';

    // Rating + reviews + sales volume
    if(rating>0){
      h+='<div style="display:flex;align-items:center;gap:8px;margin-bottom:12px;flex-wrap:wrap">';
      h+='<span style="color:#f59e0b;font-size:16px">'+renderStars(rating)+'</span>';
      h+='<span style="font-size:14px;color:#666">'+rating.toFixed(1)+'</span>';
      var revNum=parseInt(reviews);if(revNum&&revNum>0)h+='<a href="#dhpdp-reviews" style="font-size:13px;color:#2563eb;text-decoration:none">('+fmtNum(revNum)+' ratings)</a>';
      if(p.salesVolume)h+='<span style="font-size:12px;color:#6b7280;border-left:1px solid #e5e7eb;padding-left:8px;margin-left:4px">'+esc(p.salesVolume)+'</span>';
      h+='</div>';
    }

    // Price
    h+='<div style="margin-bottom:16px">';
    h+='<span style="font-size:32px;font-weight:700;color:#e53e3e" id="dhpdp-price">$'+price.toFixed(2)+'</span>';
    if(origPrice>price)h+=' <span style="font-size:18px;color:#999;text-decoration:line-through;margin-left:8px">$'+origPrice.toFixed(2)+'</span>';
    if(discount>0){
      var saved=(origPrice-price).toFixed(2);
      h+=' <span style="background:#dcfce7;color:#16a34a;padding:2px 8px;border-radius:4px;font-size:13px;font-weight:600;margin-left:4px">-'+discount+'% Save $'+saved+'</span>';
    }
    h+='</div>';

    // Availability / stock
    var avail=p.availability||p.stockSignal||'';
    if(avail){
      var isLow=/only\s*\d+\s*left/i.test(avail);
      var isOut=/out\s*of\s*stock/i.test(avail);
      var isIn=!isOut&&(avail.toLowerCase().indexOf('in stock')>=0||avail==='in_stock');
      var dotColor=isOut?'#ef4444':(isLow?'#f59e0b':'#22c55e');
      var textColor=isOut?'#dc2626':(isLow?'#d97706':'#16a34a');
      var label=isOut?'Out of Stock':(isLow?esc(avail):(isIn?'In Stock':'Available'));
      h+='<div style="display:flex;align-items:center;gap:6px;margin-bottom:16px"><span style="width:8px;height:8px;border-radius:50%;background:'+dotColor+'"></span><span style="font-size:14px;color:'+textColor+';font-weight:'+(isLow?'600':'400')+'">'+label+'</span></div>';
    }

    return h;
  }

  // ═══ SECTION 4: VARIANTS (v4 — ASIN-based switching, color photos, size pills, qty, specs, size chart) ═══

  /* Helper: detect size chart category from product title + breadcrumbs */
  function detectSizeChartCategory(p){
    var title=(p.title||'').toLowerCase();
    var bc=(p.breadcrumbs||[]).map(function(b){return(typeof b==='object'?(b.name||b.title||''):b).toLowerCase()}).join(' ');
    var cat=(p.category||'').toLowerCase();
    var all=title+' '+bc+' '+cat;
    if(/shoe|sneaker|boot|sandal|slipper|loafer|heel|flat|trainer|running shoe|clog/i.test(all))return 'shoes';
    if(/t-?shirt|tee|polo|tank.?top|blouse|top /i.test(all))return 'tops';
    if(/dress|gown|jumpsuit|romper/i.test(all))return 'dresses';
    if(/pant|jean|trouser|short|legging|jogger|sweatpant/i.test(all))return 'bottoms';
    if(/jacket|coat|hoodie|sweater|cardigan|vest|blazer/i.test(all))return 'outerwear';
    if(/bra|underwear|lingerie|panty|boxers|brief/i.test(all))return 'underwear';
    if(/ring|bracelet|necklace|watch.?band/i.test(all))return 'jewelry';
    if(/hat|cap|beanie|glove|belt/i.test(all))return 'accessories';
    if(/kid|boy|girl|infant|toddler|baby|children/i.test(all))return 'kids';
    return null;
  }

  function renderVariants(p){
    if(!p.options||!p.options.length)return renderQuantitySelector(p)+renderProductSpecs(p);
    var h='<div class="dhpdp-variants" style="margin-bottom:20px">';

    for(var oi=0;oi<p.options.length;oi++){
      var opt=p.options[oi];
      var isColor=opt.name==='Color';
      var isSize=opt.name==='Size';
      var selectedVal='';
      for(var sv=0;sv<(opt.values||[]).length;sv++){if(opt.values[sv].selected){selectedVal=opt.values[sv].value;break;}}
      if(!selectedVal&&opt.values&&opt.values.length)selectedVal=opt.values[0].value;

      h+='<div class="dhpdp-opt-group" data-group="'+esc(opt.name)+'" style="margin-bottom:16px">';
      h+='<label style="font-size:14px;font-weight:600;color:#333;display:block;margin-bottom:8px">'+esc(opt.name)+': <span class="dhpdp-opt-label" data-option="'+oi+'" style="color:#e53e3e;font-weight:700">'+esc(selectedVal)+'</span></label>';

      if(isColor){
        /* COLOR — thumbnail photos */
        h+='<div class="sh-color-options" style="display:flex;flex-wrap:wrap;gap:8px">';
        for(var ci=0;ci<(opt.values||[]).length;ci++){
          var cv=opt.values[ci];
          var isSel=cv.value===selectedVal;
          var isAvail=cv.is_available!==false;
          var cls='dhpdp-opt'+(isSel?' dhpdp-opt-sel':'')+(isAvail?'':' dhpdp-opt-unavail');
          h+='<button class="'+cls+'" data-option="'+oi+'" data-value="'+ci+'" data-valtitle="'+esc(cv.value)+'" data-asin="'+(cv.asin||'')+'" data-dim="Color" '+(isAvail?'':'disabled ')+' title="'+esc(cv.value)+(isAvail?'':' - Unavailable')+'" style="width:48px;height:48px;border-radius:8px;border:2px solid '+(isSel?'#e53e3e':(isAvail?'#ddd':'#eee'))+';padding:2px;cursor:'+(isAvail?'pointer':'not-allowed')+';background:#fff;position:relative;opacity:'+(isAvail?'1':'0.5')+'">';
          if(cv.image){
            h+='<img src="'+esc(cv.image)+'" alt="'+esc(cv.value)+'" style="width:100%;height:100%;object-fit:cover;border-radius:6px">';
          }else{
            h+='<span style="display:flex;align-items:center;justify-content:center;width:100%;height:100%;font-size:10px;color:#666;text-align:center;line-height:1.1">'+esc(cv.value.substring(0,8))+'</span>';
          }
          if(!isAvail)h+='<span style="position:absolute;top:0;left:0;width:100%;height:100%;display:flex;align-items:center;justify-content:center"><span style="width:120%;height:2px;background:#999;transform:rotate(-45deg)"></span></span>';
          h+='</button>';
        }
        h+='</div>';

      }else if(isSize){
        /* SIZE — pills */
        h+='<div class="sh-size-options" style="display:flex;flex-wrap:wrap;gap:6px">';
        for(var si=0;si<(opt.values||[]).length;si++){
          var sv2=opt.values[si];
          var isSel2=sv2.value===selectedVal;
          var isAvail2=sv2.is_available!==false;
          var cls2='dhpdp-opt sh-size-pill'+(isSel2?' dhpdp-opt-sel':'')+(isAvail2?'':' dhpdp-opt-unavail');
          h+='<button class="'+cls2+'" data-option="'+oi+'" data-value="'+si+'" data-valtitle="'+esc(sv2.value)+'" data-asin="'+(sv2.asin||'')+'" data-dim="Size" '+(isAvail2?'':'disabled ')+' title="'+esc(sv2.value)+(isAvail2?'':' - Unavailable')+'" style="min-width:44px;padding:8px 14px;border-radius:8px;border:2px solid '+(isSel2?'#e53e3e':(isAvail2?'#ddd':'#eee'))+';cursor:'+(isAvail2?'pointer':'not-allowed')+';background:'+(isSel2?'#fef2f2':'#fff')+';font-size:13px;font-weight:'+(isSel2?'600':'400')+';color:'+(isAvail2?'#333':'#bbb')+';text-align:center;opacity:'+(isAvail2?'1':'0.6')+';text-decoration:'+(isAvail2?'none':'line-through')+'">';
          h+=esc(sv2.value);
          h+='</button>';
        }
        h+='</div>';
        /* Size chart link */
        var sizeChartCat=detectSizeChartCategory(p);
        if(sizeChartCat){
          h+='<a href="#" class="sh-size-chart-link" data-category="'+sizeChartCat+'" style="display:inline-flex;align-items:center;gap:4px;margin-top:8px;font-size:13px;color:#2563eb;text-decoration:none;font-weight:500">&#128207; Size Chart</a>';
        }

      }else{
        /* GENERIC — pill buttons */
        h+='<div style="display:flex;flex-wrap:wrap;gap:8px">';
        for(var gi=0;gi<(opt.values||[]).length;gi++){
          var gv=opt.values[gi];
          var isSel3=gv.value===selectedVal;
          var isAvail3=gv.is_available!==false;
          h+='<button class="dhpdp-opt'+(isSel3?' dhpdp-opt-sel':'')+(isAvail3?'':' dhpdp-opt-unavail')+'" data-option="'+oi+'" data-value="'+gi+'" data-valtitle="'+esc(gv.value)+'" data-asin="'+(gv.asin||'')+'" data-dim="'+esc(opt.name)+'" '+(isAvail3?'':'disabled ')+' style="padding:8px 16px;border-radius:8px;border:2px solid '+(isSel3?'#e53e3e':(isAvail3?'#ddd':'#eee'))+';cursor:'+(isAvail3?'pointer':'not-allowed')+';background:'+(isSel3?'#fef2f2':'#fff')+';font-size:13px;color:'+(isAvail3?'#333':'#bbb')+'">'+esc(gv.value)+'</button>';
        }
        h+='</div>';
      }

      h+='</div>'; // end group
    }

    h+='</div>'; // end dhpdp-variants

    /* Variant loading overlay (hidden by default) */
    h+='<div id="dhpdp-variant-loading" style="display:none;padding:8px 0;margin-bottom:12px"><div style="display:flex;align-items:center;gap:8px"><div style="width:16px;height:16px;border:2px solid #e53e3e;border-top-color:transparent;border-radius:50%;animation:dhpdp-spin .6s linear infinite"></div><span style="font-size:13px;color:#666">Loading variant...</span></div></div>';

    /* Quantity selector */
    h+=renderQuantitySelector(p);

    /* Quick product specs (weight, material) */
    h+=renderProductSpecs(p);

    return h;
  }

  /* ═══ QUANTITY SELECTOR ═══ */
  function renderQuantitySelector(p){
    var avail=p.availability||'';
    var maxQty=10;
    var match=avail.match(/Only (\d+) left/i);
    if(match)maxQty=parseInt(match[1]);
    else if(/out of stock/i.test(avail))maxQty=0;

    var h='<div class="sh-qty-group" style="margin-bottom:16px">';
    h+='<label style="font-size:14px;font-weight:600;color:#333;display:block;margin-bottom:8px">Quantity:</label>';
    if(maxQty>0){
      h+='<div style="display:flex;align-items:center;gap:0">';
      h+='<button id="sh-qty-minus" style="width:36px;height:36px;border:1px solid #ddd;border-right:none;border-radius:6px 0 0 6px;background:#f9fafb;cursor:pointer;font-size:18px;color:#333;display:flex;align-items:center;justify-content:center" disabled>−</button>';
      h+='<input type="number" id="sh-qty" value="1" min="1" max="'+maxQty+'" style="width:48px;height:36px;border:1px solid #ddd;text-align:center;font-size:14px;font-weight:600;-moz-appearance:textfield;-webkit-appearance:none" readonly>';
      h+='<button id="sh-qty-plus" style="width:36px;height:36px;border:1px solid #ddd;border-left:none;border-radius:0 6px 6px 0;background:#f9fafb;cursor:pointer;font-size:18px;color:#333;display:flex;align-items:center;justify-content:center">+</button>';
      h+='</div>';
    }
    /* Stock indicator */
    if(maxQty===0){
      h+='<span style="font-size:13px;color:#dc2626;font-weight:600">Out of Stock</span>';
    }else if(maxQty<=5){
      h+='<span style="font-size:13px;color:#d97706;font-weight:600;margin-top:4px;display:block">Only '+maxQty+' left in stock — order soon</span>';
    }
    h+='</div>';
    return h;
  }

  /* ═══ PRODUCT SPECS (weight, material, dimensions) ═══ */
  function renderProductSpecs(p){
    var pi=p.productInformation||{};
    var specs=[];
    if(pi['Item Weight'])specs.push(['Weight',pi['Item Weight']]);
    if(pi['Package Dimensions'])specs.push(['Dimensions',pi['Package Dimensions'].split(';')[0]]);
    if(pi['Product Dimensions'])specs.push(['Dimensions',pi['Product Dimensions'].split(';')[0]]);
    if(pi['Material']||pi['Material Type'])specs.push(['Material',pi['Material']||pi['Material Type']]);
    if(pi['Sole Material'])specs.push(['Sole',pi['Sole Material']]);
    if(pi['Closure Type'])specs.push(['Closure',pi['Closure Type']]);
    if(pi['Fabric Type'])specs.push(['Fabric',pi['Fabric Type']]);
    if(!specs.length)return '';

    var h='<div class="sh-quick-specs" style="margin-bottom:16px;padding:10px 14px;background:#f8fafc;border-radius:8px;border:1px solid #f0f0f0">';
    for(var i=0;i<specs.length;i++){
      h+='<div style="display:flex;gap:8px;font-size:13px;'+(i>0?'margin-top:4px':'')+'">';
      h+='<span style="color:#6b7280;min-width:80px">'+specs[i][0]+':</span>';
      h+='<span style="color:#333;font-weight:500">'+esc(specs[i][1])+'</span>';
      h+='</div>';
    }
    h+='</div>';
    return h;
  }

  // ═══ SECTION 5: BUY BUTTONS ═══
  function renderBuyButtons(){
    var h='';
    // Trust strip
    h+='<div style="display:flex;gap:16px;margin-bottom:20px;padding:12px 16px;background:#f8fafc;border-radius:8px;flex-wrap:wrap">';
    h+='<div style="display:flex;align-items:center;gap:6px;font-size:12px;color:#666"><svg width="16" height="16" fill="none" stroke="#22c55e" stroke-width="2" viewBox="0 0 24 24"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>Secure Checkout</div>';
    h+='<div style="display:flex;align-items:center;gap:6px;font-size:12px;color:#666"><svg width="16" height="16" fill="none" stroke="#3b82f6" stroke-width="2" viewBox="0 0 24 24"><path d="M20 12V8H6a2 2 0 01-2-2c0-1.1.9-2 2-2h12v4"/><path d="M4 6v12c0 1.1.9 2 2 2h14v-4"/><circle cx="18" cy="16" r="2"/></svg>Money-Back Guarantee</div>';
    h+='<div style="display:flex;align-items:center;gap:6px;font-size:12px;color:#666"><svg width="16" height="16" fill="none" stroke="#8b5cf6" stroke-width="2" viewBox="0 0 24 24"><rect x="1" y="3" width="15" height="13" rx="2"/><path d="M16 8h4l3 3v5h-7V8z"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/></svg>Fast Shipping</div>';
    h+='</div>';
    // CTA Buttons
    h+='<div style="display:flex;flex-direction:column;gap:10px;margin-bottom:20px">';
    h+='<button id="dhpdp-atc" style="width:100%;padding:16px;background:#e53e3e;color:#fff;border:none;border-radius:10px;font-size:16px;font-weight:700;cursor:pointer;transition:background 0.2s" onmouseover="this.style.background=\'#c53030\'" onmouseout="this.style.background=\'#e53e3e\'">Add to Cart</button>';
    h+='<button id="dhpdp-buy" style="width:100%;padding:16px;background:#1a1a1a;color:#fff;border:none;border-radius:10px;font-size:16px;font-weight:700;cursor:pointer;transition:background 0.2s" onmouseover="this.style.background=\'#333\'" onmouseout="this.style.background=\'#1a1a1a\'">Buy Now</button>';
    h+='</div>';
    return h;
  }

  // ═══ SECTION 6: SHIPPING & DELIVERY ═══
  function renderShipping(p){
    var pdpIsPlus=false;
    try{pdpIsPlus=localStorage.getItem('stylehub_plus')==='true';}catch(e){}

    // Use deliveryParsed from backend (real dates from API), fallback to shippingCalc/deliveryEstimate
    var dp=p.deliveryParsed||{};
    var sc=p.shippingCalc||{};
    var del=sc.delivery||p.deliveryEstimate||{};
    var delFormatted=del.formattedRange||del.label||'3-7 business days';
    var delEarliest=del.earliest||del.earliestDate||'';
    var delLatest=del.latest||del.latestDate||'';

    // Resolve delivery dates — prefer parsed real dates, then calculated
    var standardDate=dp.standard||null;
    var fastestDate=dp.fastest||null;
    var shipCost=dp.cost||0;
    var shipIsFree=dp.isFree!==undefined?dp.isFree:(sc.isFree||shipCost===0);
    var shipThreshold=dp.threshold||sc.threshold||null;
    var orderWithin=dp.orderWithin||null;

    // For AliExpress or non-Amazon: use existing flow
    if(p.source!=='amazon'){
      shipCost=pdpIsPlus?0:(sc.cost!=null?sc.cost:(p.shippingData&&p.shippingData.cost!=null?p.shippingData.cost:null));
      shipIsFree=pdpIsPlus||sc.isFree||(shipCost===0);
    }

    var shipShipsFrom=sc.shipsFrom||(p.shippingData&&p.shippingData.shipsFrom)||null;
    var bestOffer=p.bestOffer||null;
    var ret=sc.returnWindow||p.returnPolicy||{};
    var retDays=pdpIsPlus?60:30;
    var retSummary;
    if(pdpIsPlus){retSummary=retDays+'-day returns (Plus benefit)';}else{retSummary=ret.summary||(ret.days?'Returns accepted within '+ret.days+' days':retDays+'-day returns');if(typeof ret==='string')retSummary=ret;}

    var savedZip=null;try{savedZip=localStorage.getItem('stylehub_zip');}catch(e){}

    var h='<div style="border:1px solid '+(pdpIsPlus?'#c4b5fd':'#e2e8f0')+';border-radius:10px;overflow:hidden;margin-bottom:20px">';

    // Plus member banner
    if(pdpIsPlus){h+='<div style="padding:8px 16px;background:linear-gradient(90deg,#6b46c1,#805ad5);color:#fff;font-size:13px;font-weight:700;text-align:center">&#9889; StyleHub Plus Member</div>';}

    // === DELIVERY ROW (primary — per spec) ===
    h+='<div style="padding:14px 16px;border-bottom:1px solid #f0f0f0">';

    if(pdpIsPlus&&fastestDate){
      // PLUS + fastest: show fastest as primary
      h+='<div style="font-size:16px;font-weight:700;color:#7c3aed">';
      h+='&#128197; FREE delivery '+esc(fastestDate);
      h+=' <span style="background:#7c3aed;color:#fff;font-size:10px;padding:2px 6px;border-radius:10px">PLUS</span>';
      h+='</div>';
      if(orderWithin){h+='<div style="font-size:12px;color:#d97706;margin-top:4px">&#9200; Order within '+esc(orderWithin)+'</div>';}
      if(standardDate){h+='<div style="font-size:12px;color:#888;margin-top:4px">Standard delivery: '+esc(standardDate)+'</div>';}
      if(shipCost>0){h+='<div style="font-size:12px;color:#16a34a;margin-top:2px">&#10003; You save $'+shipCost.toFixed(2)+' on shipping</div>';}
    }else if(pdpIsPlus&&!fastestDate){
      // PLUS but no fastest
      h+='<div style="font-size:16px;font-weight:700;color:#16a34a">';
      h+='&#128197; FREE delivery '+(standardDate?esc(standardDate):(delEarliest&&delLatest?esc(delEarliest)+' &ndash; '+esc(delLatest):esc(delFormatted)));
      h+='</div>';
    }else{
      // NO PLUS: standard delivery
      if(shipIsFree){
        h+='<div style="font-size:16px;font-weight:700;color:#16a34a">';
        h+='&#128197; FREE delivery '+(standardDate?esc(standardDate):(delEarliest&&delLatest?esc(delEarliest)+' &ndash; '+esc(delLatest):esc(delFormatted)));
        h+='</div>';
      }else if(shipCost>0){
        h+='<div style="font-size:16px;font-weight:600;color:#374151">';
        h+='&#128197; $'+shipCost.toFixed(2)+' delivery '+(standardDate?esc(standardDate):'');
        h+='</div>';
      }else{
        h+='<div style="font-size:16px;font-weight:600;color:#374151">';
        h+='&#128197; Delivery '+(standardDate?esc(standardDate):(delEarliest&&delLatest?esc(delEarliest)+' &ndash; '+esc(delLatest):esc(delFormatted)));
        h+='</div>';
      }

      // Plus upsell CTA
      if(fastestDate){
        h+='<div style="margin-top:10px;padding:10px 14px;background:#f5f3ff;border:1px solid #e9d5ff;border-radius:8px">';
        h+='<div style="font-size:13px;font-weight:700;color:#7c3aed">&#9889; Want it '+esc(fastestDate)+'?</div>';
        h+='<div style="font-size:12px;color:#6b7280;margin-top:2px">Get faster delivery'+(shipCost>0?' + FREE shipping':'')+' with StyleHub Plus</div>';
        h+='<a href="/pages/plus" style="display:inline-block;margin-top:6px;padding:6px 14px;background:#7c3aed;color:#fff;border-radius:6px;font-size:12px;font-weight:600;text-decoration:none">Try 7 days free &rarr;</a>';
        h+='</div>';
      }else if(shipCost>0){
        h+='<div style="margin-top:10px;padding:10px 14px;background:#f5f3ff;border:1px solid #e9d5ff;border-radius:8px">';
        h+='<div style="font-size:13px;font-weight:700;color:#7c3aed">&#9889; FREE shipping with StyleHub Plus</div>';
        h+='<div style="font-size:12px;color:#6b7280;margin-top:2px">Save $'+shipCost.toFixed(2)+' on this order</div>';
        h+='<a href="/pages/plus" style="display:inline-block;margin-top:6px;padding:6px 14px;background:#7c3aed;color:#fff;border-radius:6px;font-size:12px;font-weight:600;text-decoration:none">Try 7 days free &rarr;</a>';
        h+='</div>';
      }
    }
    h+='</div>';

    // === SELLER + ORIGIN ===
    if(shipShipsFrom||bestOffer){
      h+='<div style="padding:10px 16px;font-size:12px;color:#555;border-bottom:1px solid #f0f0f0">';
      if(shipShipsFrom)h+='Ships from <b>'+esc(shipShipsFrom)+'</b>';
      if(bestOffer&&bestOffer.seller&&bestOffer.seller!==shipShipsFrom)h+=' &middot; Sold by <b>'+esc(bestOffer.seller)+'</b>';
      if(bestOffer&&bestOffer.sellerRating)h+=' &#11088; '+esc(bestOffer.sellerRating);
      h+='</div>';
    }

    // AliExpress shipping options
    var shipOpts=p.shippingOptions||[];
    if(shipOpts.length>1&&p.source==='aliexpress'){
      h+='<div style="padding:10px 16px;border-bottom:1px solid #f0f0f0">';
      h+='<div style="font-size:11px;color:#888;margin-bottom:4px;text-transform:uppercase;letter-spacing:0.5px">Shipping options</div>';
      var maxShow=Math.min(shipOpts.length,4);
      for(var si=0;si<maxShow;si++){
        var sopt=shipOpts[si];
        var soptFee=sopt.fee===0?'<span style="color:#16a34a;font-weight:600">FREE</span>':'<span style="color:#333;font-weight:600">$'+sopt.fee.toFixed(2)+'</span>';
        var soptTime=sopt.time?sopt.time+' days':'';
        var soptTrack=sopt.tracking?'<span style="color:#16a34a;font-size:10px">&#10003; Track</span>':'';
        h+='<div style="display:flex;align-items:center;gap:8px;padding:3px 0;font-size:12px">';
        h+='<span style="color:#555;min-width:70px;font-weight:500">'+esc(sopt.company||'Standard')+'</span>';
        h+=soptFee;
        if(soptTime)h+='<span style="color:#888">&middot; '+esc(soptTime)+'</span>';
        h+=soptTrack;
        h+='</div>';
      }
      if(shipOpts.length>maxShow)h+='<div style="font-size:11px;color:#888;margin-top:2px">+'+(shipOpts.length-maxShow)+' more options</div>';
      h+='</div>';
    }
    if(!shipShipsFrom&&p.sellerData&&p.sellerData.name&&p.source==='aliexpress'){
      h+='<div style="padding:10px 16px;font-size:12px;color:#555;border-bottom:1px solid #f0f0f0">';
      h+='Sold by <b>'+esc(p.sellerData.name)+'</b>';
      if(p.shippingData&&p.shippingData.shipsFrom){
        var sf=p.shippingData.shipsFrom.toLowerCase();
        var fromFlag=sf.indexOf('united states')>=0||sf==='us'?' &#127482;&#127480;':(sf.indexOf('china')>=0?' &#127464;&#127475;':'');
        h+=' &middot; Ships from '+esc(p.shippingData.shipsFrom)+fromFlag;
      }
      h+='</div>';
    }

    // === RETURNS ===
    h+='<div style="padding:10px 16px;font-size:13px;color:#555">';
    h+='&#8617;&#65039; '+retDays+'-day returns';
    if(pdpIsPlus)h+=' <span style="background:#7c3aed;color:#fff;font-size:9px;padding:1px 5px;border-radius:8px">PLUS</span>';
    h+='</div>';

    h+='</div>';
    return h;
  }

  // ═══ SECTION 7: BULLET POINTS ═══
  function renderBullets(p){
    var bullets=p.bullets||[];
    if(!bullets.length)return '';
    var h='<div class="dhpdp-section">';
    h+='<h2 class="dhpdp-section-title">About This Product</h2>';
    h+='<ul style="list-style:none;padding:0;margin:0">';
    for(var i=0;i<bullets.length;i++){
      h+='<li style="padding:10px 0;border-bottom:1px solid #f5f5f5;font-size:14px;color:#444;display:flex;align-items:flex-start;gap:10px;line-height:1.6"><span style="color:#22c55e;font-weight:700;flex-shrink:0;margin-top:2px">&#10003;</span><span>'+esc(bullets[i])+'</span></li>';
    }
    h+='</ul></div>';
    return h;
  }

  // ═══ SECTION 8: A+ CONTENT / DESCRIPTION IMAGES ═══
  function renderAplusContent(p){
    var imgs=p.aplusImages||[];
    if(!imgs.length)return '';
    var h='<div class="dhpdp-section">';
    h+='<h2 class="dhpdp-section-title">From the Manufacturer</h2>';
    h+='<div style="display:flex;flex-direction:column;gap:4px">';
    for(var i=0;i<imgs.length;i++){
      h+='<img src="'+esc(imgs[i])+'" alt="Product details" style="width:100%;max-width:900px;margin:0 auto;display:block;border-radius:8px" loading="lazy" onerror="this.style.display=\'none\'">';
    }
    h+='</div></div>';
    return h;
  }

  // ═══ SECTION 9: PRODUCT DESCRIPTION ═══
  function renderDescription(p){
    var desc=p.description||'';
    // Safety: reject [object Object] or trivially short descriptions
    if(!desc||desc==='[object Object]'||desc==='undefined'||desc.length<10)return '';
    // Detect key:value spec dumps (not useful as description)
    var plainLines=desc.split('\n').filter(function(l){return l.trim()});
    var kvCount=plainLines.filter(function(l){return /^[A-Za-z][^:]{2,30}:\s/.test(l)}).length;
    if(kvCount>plainLines.length*0.5&&plainLines.length>3)return '';
    var h='<div class="dhpdp-section">';
    h+='<h2 class="dhpdp-section-title">Product Description</h2>';
    // Detect HTML content (from AliExpress item_detail_6) vs plain text
    if(/<(img|p|br|div|table|span|ul|ol|li|h[1-6])\b/i.test(desc)){
      // HTML description — sanitize and render
      var clean=desc
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi,'')
        .replace(/on\w+="[^"]*"/gi,'')
        .replace(/on\w+='[^']*'/gi,'')
        .replace(/style="[^"]*position\s*:\s*fixed[^"]*"/gi,'')
        .replace(/style="[^"]*position\s*:\s*absolute[^"]*"/gi,'');
      // Fix protocol-relative image URLs
      clean=clean.replace(/src="\/\//g,'src="https://');
      clean=clean.replace(/src='\/\//g,"src='https://");
      h+='<div style="font-size:14px;line-height:1.6;color:#444;max-width:900px;overflow:hidden">'+clean+'</div>';
    }else{
      // Plain text — escape and render with expand/collapse
      h+='<div style="font-size:15px;line-height:1.8;color:#444;max-width:800px">';
      if(plainLines.length>8){
        h+='<div id="dhpdp-desc-short">'+plainLines.slice(0,6).map(function(l){return '<p style="margin:0 0 12px">'+esc(l)+'</p>'}).join('')+'</div>';
        h+='<div id="dhpdp-desc-full" style="display:none">'+plainLines.map(function(l){return '<p style="margin:0 0 12px">'+esc(l)+'</p>'}).join('')+'</div>';
        h+='<button id="dhpdp-desc-toggle" onclick="document.getElementById(\'dhpdp-desc-short\').style.display=\'none\';document.getElementById(\'dhpdp-desc-full\').style.display=\'block\';this.style.display=\'none\'" style="color:#2563eb;background:none;border:none;cursor:pointer;font-size:14px;font-weight:500;padding:0">Read more &#8250;</button>';
      }else{
        h+=plainLines.map(function(l){return '<p style="margin:0 0 12px">'+esc(l)+'</p>'}).join('');
      }
      h+='</div>';
    }
    h+='</div>';
    return h;
  }

  // ═══ SECTION 10: SPECIFICATIONS TABLE ═══
  function renderSpecifications(p){
    var specs=p.specifications||[];
    var quick=p.quickSpecs||[];
    if(!specs.length&&!quick.length)return '';
    var allSpecs=specs.length?specs:quick;
    var showAll=allSpecs.length>10;
    var h='<div class="dhpdp-section">';
    h+='<h2 class="dhpdp-section-title">Technical Specifications</h2>';
    h+='<table class="dhpdp-spec-table">';
    var limit=showAll?10:allSpecs.length;
    for(var i=0;i<limit;i++){
      h+='<tr><td>'+esc(allSpecs[i].name)+'</td><td style="color:#555">'+esc(allSpecs[i].value)+'</td></tr>';
    }
    h+='</table>';
    if(showAll){
      h+='<table class="dhpdp-spec-table" id="dhpdp-specs-full" style="display:none">';
      for(var i=10;i<allSpecs.length;i++){
        h+='<tr><td>'+esc(allSpecs[i].name)+'</td><td style="color:#555">'+esc(allSpecs[i].value)+'</td></tr>';
      }
      h+='</table>';
      h+='<button onclick="document.getElementById(\'dhpdp-specs-full\').style.display=\'table\';this.style.display=\'none\'" style="color:#2563eb;background:none;border:none;cursor:pointer;font-size:14px;font-weight:500;padding:8px 0">Show all '+allSpecs.length+' specifications &#8250;</button>';
    }
    h+='</div>';
    return h;
  }

  // ═══ SECTION 11: RATING BREAKDOWN ═══
  function renderRatingBreakdown(p,rating,reviews){
    if(!rating||!reviews)return '';
    var rd=p.ratingDistribution;
    var h='<div class="dhpdp-section" id="dhpdp-reviews">';
    h+='<h2 class="dhpdp-section-title">Customer Reviews</h2>';
    h+='<div style="display:flex;gap:40px;align-items:flex-start;flex-wrap:wrap">';
    // Left: big rating
    h+='<div style="text-align:center;min-width:120px">';
    h+='<div style="font-size:48px;font-weight:700;color:#1a1a2e">'+rating.toFixed(1)+'</div>';
    h+='<div style="color:#f59e0b;font-size:20px;margin:4px 0">'+renderStars(rating)+'</div>';
    h+='<div style="font-size:13px;color:#6b7280">'+fmtNum(reviews)+' ratings</div>';
    h+='</div>';
    // Right: bar chart
    if(rd){
      h+='<div style="flex:1;min-width:200px;max-width:400px">';
      for(var i=5;i>=1;i--){
        var pct=rd[i]||0;
        h+='<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">';
        h+='<span style="font-size:13px;color:#666;width:16px;text-align:right">'+i+'</span>';
        h+='<span style="color:#f59e0b;font-size:12px">&#9733;</span>';
        h+='<div class="dhpdp-rating-bar"><div class="dhpdp-rating-fill" style="width:'+pct+'%"></div></div>';
        h+='<span style="font-size:12px;color:#888;width:32px">'+pct+'%</span>';
        h+='</div>';
      }
      h+='</div>';
    }
    h+='</div>';
    return h;
  }

  // ═══ SECTION 12: CUSTOMER REVIEWS ═══
  function renderReviews(p){
    var revs=p.topReviews||[];
    if(!revs.length)return '';
    var h='<div style="margin-top:24px">';
    h+='<h3 style="font-size:16px;font-weight:600;color:#1a1a2e;margin-bottom:16px">Top Reviews</h3>';
    for(var i=0;i<revs.length;i++){
      var r=revs[i];
      h+='<div class="dhpdp-review">';
      // Header: avatar, author, date
      h+='<div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">';
      if(r.avatar)h+='<img src="'+esc(r.avatar)+'" style="width:32px;height:32px;border-radius:50%;object-fit:cover" onerror="this.style.display=\'none\'">';
      else h+='<div style="width:32px;height:32px;border-radius:50%;background:#e5e7eb;display:flex;align-items:center;justify-content:center;font-size:14px;color:#9ca3af">'+esc((r.author||'B')[0])+'</div>';
      h+='<div>';
      h+='<div style="font-size:13px;font-weight:600;color:#333">'+esc(r.author||'Verified Buyer');
      if(r.isVerified)h+=' <span style="color:#16a34a;font-size:11px;font-weight:400">&#10003; Verified Purchase</span>';
      h+='</div>';
      if(r.date)h+='<div style="font-size:11px;color:#9ca3af">'+esc(r.date)+'</div>';
      h+='</div></div>';
      // Stars + title
      h+='<div style="margin-bottom:6px"><span style="color:#f59e0b;font-size:14px">'+renderStars(r.rating)+'</span>';
      if(r.title)h+=' <span style="font-weight:600;color:#1a1a2e;font-size:14px">'+esc(r.title)+'</span>';
      h+='</div>';
      // Variant info
      if(r.variant)h+='<div style="font-size:12px;color:#888;margin-bottom:4px">'+esc(r.variant)+'</div>';
      // Comment
      var comment=r.comment||'';
      if(comment.length>300){
        h+='<div style="font-size:14px;color:#444;line-height:1.6">'+esc(comment.substring(0,300))+'... <button onclick="this.parentElement.textContent=\''+comment.replace(/'/g,"\\'").replace(/\n/g,' ')+'\'" style="color:#2563eb;background:none;border:none;cursor:pointer;font-size:13px">Read more</button></div>';
      }else{
        h+='<div style="font-size:14px;color:#444;line-height:1.6">'+esc(comment)+'</div>';
      }
      // Review images
      if(r.images&&r.images.length){
        h+='<div style="display:flex;gap:8px;margin-top:8px;overflow-x:auto">';
        for(var ri=0;ri<Math.min(r.images.length,4);ri++){
          var imgUrl=typeof r.images[ri]==='string'?r.images[ri]:(r.images[ri].url||r.images[ri].image||'');
          if(imgUrl)h+='<img src="'+esc(imgUrl)+'" style="width:60px;height:60px;object-fit:cover;border-radius:8px;border:1px solid #e5e7eb;cursor:pointer" loading="lazy" onerror="this.style.display=\'none\'">';
        }
        h+='</div>';
      }
      // Helpful votes
      if(r.helpfulVotes)h+='<div style="font-size:12px;color:#6b7280;margin-top:6px">&#128077; '+esc(r.helpfulVotes)+'</div>';
      h+='</div>';
    }
    h+='</div></div>'; // close reviews + rating breakdown section
    return h;
  }

  // ═══ SECTION 13: FREQUENTLY BOUGHT TOGETHER ═══
  function renderFrequentlyBought(p){
    var fbt=p.frequentlyBoughtTogether||[];
    if(!fbt.length)return '';
    var total=0;
    fbt.forEach(function(item){total+=(item.price||0)});
    var h='<div class="dhpdp-section">';
    h+='<h2 class="dhpdp-section-title">Frequently Bought Together</h2>';
    h+='<div style="display:flex;align-items:center;gap:12px;overflow-x:auto;padding-bottom:8px">';
    for(var i=0;i<fbt.length;i++){
      if(i>0)h+='<span style="font-size:24px;color:#ccc;flex-shrink:0">+</span>';
      var item=fbt[i];
      var link=item.id?'/pages/product?id='+encodeURIComponent(item.id)+'&store=amazon':'#';
      h+='<a href="'+link+'" class="dhpdp-fbt-card" style="text-decoration:none;min-width:140px;max-width:160px;flex-shrink:0">';
      h+='<img src="'+esc(item.image)+'" style="width:80px;height:80px;object-fit:contain;margin:0 auto 8px;display:block" onerror="this.style.display=\'none\'" loading="lazy">';
      h+='<div style="font-size:12px;color:#374151;line-height:1.3;height:32px;overflow:hidden">'+esc((item.title||'').substring(0,60))+'</div>';
      if(item.price)h+='<div style="font-size:14px;font-weight:700;color:#e53e3e;margin-top:6px">$'+item.price.toFixed(2)+'</div>';
      h+='</a>';
    }
    h+='</div>';
    if(total>0){
      h+='<div style="margin-top:16px;padding:12px 16px;background:#f8fafc;border-radius:8px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px">';
      h+='<span style="font-size:15px;color:#333">Total: <b>$'+total.toFixed(2)+'</b></span>';
      h+='<button style="padding:10px 20px;background:#e53e3e;color:#fff;border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer" disabled title="Coming soon">Add all to cart</button>';
      h+='</div>';
    }
    h+='</div>';
    return h;
  }

  // ═══ SECTION 14: SELLER INFO ═══
  function renderSellerInfo(p){
    var seller=p.sellerData||{};
    var best=p.bestOffer||{};
    var name=seller.name||best.seller;
    if(!name)return '';
    var h='<div class="dhpdp-section">';
    h+='<h2 class="dhpdp-section-title">Seller Information</h2>';
    h+='<div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:20px">';
    h+='<div style="display:flex;align-items:center;gap:12px;margin-bottom:12px">';
    h+='<div style="width:48px;height:48px;background:#e5e7eb;border-radius:12px;display:flex;align-items:center;justify-content:center;font-size:20px;color:#9ca3af">&#128722;</div>';
    h+='<div>';
    h+='<div style="font-size:16px;font-weight:600;color:#1a1a2e">'+esc(name)+'</div>';
    var ratingLine=[];
    if(best.sellerRating||seller.rating){
      var sr=best.sellerRating||seller.rating;
      ratingLine.push('&#11088; '+esc(String(sr)));
    }
    if(best.sellerRatingInfo)ratingLine.push(esc(best.sellerRatingInfo));
    else if(seller.rating&&typeof seller.rating==='number')ratingLine.push(seller.rating+'% positive');
    if(ratingLine.length)h+='<div style="font-size:13px;color:#6b7280">'+ratingLine.join(' &middot; ')+'</div>';
    h+='</div></div>';
    // Details
    var details=[];
    if(best.shipsFrom||p.shippingData&&p.shippingData.shipsFrom)details.push('&#128230; Ships from: '+(best.shipsFrom||p.shippingData.shipsFrom));
    if(best.condition)details.push('&#128196; Condition: '+esc(best.condition));
    if(seller.storeUrl)details.push('<a href="'+esc(seller.storeUrl)+'" target="_blank" rel="noopener" style="color:#2563eb;text-decoration:none;font-size:13px">View seller\'s products &#8250;</a>');
    if(details.length){
      h+='<div style="display:flex;flex-direction:column;gap:6px">';
      details.forEach(function(d){h+='<div style="font-size:13px;color:#555">'+d+'</div>'});
      h+='</div>';
    }
    h+='</div></div>';
    return h;
  }

  // ═══ EVENT BINDING ═══
  function bindEvents(p,imgs){
    // Thumbnail clicks
    var thumbs=container.querySelectorAll('.dhpdp-thumb');
    thumbs.forEach(function(th){
      th.addEventListener('click',function(){
        var idx=parseInt(this.dataset.idx);
        var mainImg=document.getElementById('dhpdp-main-img');
        if(mainImg&&imgs[idx])mainImg.src=imgs[idx];
        thumbs.forEach(function(t){t.style.borderColor='#eee'});
        this.style.borderColor='#e53e3e';
      });
    });

    // ═══ VARIANT OPTION CLICKS — ASIN-based switching ═══
    var _currentAsin=productId; /* Active ASIN for Add to Cart */
    var _variantLoading=false;

    function updateOptionLabels(){
      container.querySelectorAll('.dhpdp-opt-label').forEach(function(label){
        var optIdx=label.dataset.option;
        var sel=container.querySelector('.dhpdp-opt-sel[data-option="'+optIdx+'"]');
        if(sel)label.textContent=sel.dataset.valtitle||'';
      });
    }
    updateOptionLabels();

    function showVariantLoading(){
      var el=document.getElementById('dhpdp-variant-loading');
      if(el)el.style.display='block';
    }
    function hideVariantLoading(){
      var el=document.getElementById('dhpdp-variant-loading');
      if(el)el.style.display='none';
    }

    /* Select a variant by calling API with new ASIN */
    function selectVariant(newAsin,dimName,value,btnEl){
      if(!newAsin||_variantLoading)return;
      _variantLoading=true;
      showVariantLoading();
      fetch(API+'/api/product/'+encodeURIComponent(newAsin)+'?store=amazon',{signal:AbortSignal.timeout(15000)})
        .then(function(r){if(!r.ok)throw new Error('HTTP '+r.status);return r.json()})
        .then(function(data){
          var np=data;
          if(!np||!np.title)throw new Error('No variant data');
          /* Update price */
          var vPrice=typeof np.price==='number'?np.price:parseFloat(String(np.price||'0').replace(/[^0-9.]/g,''));
          var vOrig=typeof np.originalPrice==='number'?np.originalPrice:parseFloat(String(np.originalPrice||'0').replace(/[^0-9.]/g,''));
          var priceEl=document.getElementById('dhpdp-price');
          if(priceEl&&vPrice>0)priceEl.textContent='$'+vPrice.toFixed(2);
          /* Update image for Color changes */
          if(dimName==='Color'&&np.primaryImage){
            var mainImg=document.getElementById('dhpdp-main-img');
            if(mainImg)mainImg.src=np.primaryImage;
            /* Also update gallery thumbnails */
            var newImgs=np.images&&np.images.length?np.images:(np.primaryImage?[np.primaryImage]:[]);
            var thumbsContainer=container.querySelector('.dhpdp-thumbs');
            if(thumbsContainer&&newImgs.length>1){
              var th='';
              for(var ti=0;ti<Math.min(newImgs.length,10);ti++){
                th+='<img src="'+esc(newImgs[ti])+'" class="dhpdp-thumb" data-idx="'+ti+'" style="width:64px;height:64px;object-fit:contain;border-radius:8px;border:2px solid '+(ti===0?'#e53e3e':'#eee')+';cursor:pointer;flex-shrink:0;background:#fafafa" onerror="this.style.display=\'none\'">';
              }
              thumbsContainer.innerHTML=th;
              imgs=newImgs;
              /* Rebind thumb clicks */
              thumbsContainer.querySelectorAll('.dhpdp-thumb').forEach(function(t2){
                t2.addEventListener('click',function(){
                  var idx2=parseInt(this.dataset.idx);
                  if(mainImg&&imgs[idx2])mainImg.src=imgs[idx2];
                  thumbsContainer.querySelectorAll('.dhpdp-thumb').forEach(function(t3){t3.style.borderColor='#eee'});
                  this.style.borderColor='#e53e3e';
                });
              });
            }
            /* If color changed, update size options with new availability */
            if(np.options){
              var sizeOpt=np.options.find(function(o){return o.name==='Size'});
              if(sizeOpt){
                var sizeGroup=container.querySelector('.dhpdp-opt-group[data-group="Size"] .sh-size-options');
                if(sizeGroup){
                  var sh='';
                  for(var si=0;si<sizeOpt.values.length;si++){
                    var sv=sizeOpt.values[si];
                    var isAvail=sv.is_available!==false;
                    sh+='<button class="dhpdp-opt sh-size-pill'+(isAvail?'':' dhpdp-opt-unavail')+'" data-option="'+container.querySelector('.dhpdp-opt-group[data-group="Size"]').querySelector('[data-option]').dataset.option+'" data-value="'+si+'" data-valtitle="'+esc(sv.value)+'" data-asin="'+(sv.asin||'')+'" data-dim="Size" '+(isAvail?'':'disabled ')+' title="'+esc(sv.value)+(isAvail?'':' - Unavailable')+'" style="min-width:44px;padding:8px 14px;border-radius:8px;border:2px solid '+(isAvail?'#ddd':'#eee')+';cursor:'+(isAvail?'pointer':'not-allowed')+';background:#fff;font-size:13px;font-weight:400;color:'+(isAvail?'#333':'#bbb')+';text-align:center;opacity:'+(isAvail?'1':'0.6')+';text-decoration:'+(isAvail?'none':'line-through')+'">'+esc(sv.value)+'</button>';
                  }
                  sizeGroup.innerHTML=sh;
                  /* Rebind size click handlers */
                  sizeGroup.querySelectorAll('.dhpdp-opt').forEach(function(sb){
                    sb.addEventListener('click',variantClickHandler);
                  });
                }
              }
            }
          }
          /* Update availability */
          if(np.availability)p.availability=np.availability;
          /* Update active ASIN */
          _currentAsin=newAsin;
          _pdpProductData=np;
          /* Update URL without reload */
          history.replaceState(null,'','/pages/product?id='+encodeURIComponent(newAsin)+'&store=amazon');
        })
        .catch(function(err){
          console.error('Variant load error:',err);
        })
        .finally(function(){
          _variantLoading=false;
          hideVariantLoading();
        });
    }

    function variantClickHandler(){
      var optIdx=this.dataset.option;
      var asin=this.dataset.asin;
      var dim=this.dataset.dim;
      var val=this.dataset.valtitle;
      /* Mark selected */
      container.querySelectorAll('.dhpdp-opt[data-option="'+optIdx+'"]').forEach(function(b){
        b.style.borderColor='#ddd';b.style.background='#fff';b.style.fontWeight='400';b.classList.remove('dhpdp-opt-sel');
      });
      this.style.borderColor='#e53e3e';this.style.background='#fef2f2';this.style.fontWeight='600';this.classList.add('dhpdp-opt-sel');
      updateOptionLabels();
      /* If ASIN available, call API */
      if(asin&&asin!==_currentAsin){
        selectVariant(asin,dim,val,this);
      }else if(!asin){
        /* Fallback: update image from button photo */
        var btnImg=this.querySelector('img');
        if(btnImg&&btnImg.src){var mainImg=document.getElementById('dhpdp-main-img');if(mainImg)mainImg.src=btnImg.src;}
      }
    }

    container.querySelectorAll('.dhpdp-opt').forEach(function(btn){
      btn.addEventListener('click',variantClickHandler);
    });

    /* ═══ QUANTITY SELECTOR ═══ */
    var qtyInput=document.getElementById('sh-qty');
    var qtyMinus=document.getElementById('sh-qty-minus');
    var qtyPlus=document.getElementById('sh-qty-plus');
    function updateQtyBtns(){
      if(!qtyInput)return;
      var v=parseInt(qtyInput.value)||1;
      var max=parseInt(qtyInput.max)||10;
      if(qtyMinus)qtyMinus.disabled=v<=1;
      if(qtyPlus)qtyPlus.disabled=v>=max;
    }
    if(qtyMinus)qtyMinus.addEventListener('click',function(){
      var v=parseInt(qtyInput.value)||1;
      if(v>1){qtyInput.value=v-1;updateQtyBtns()}
    });
    if(qtyPlus)qtyPlus.addEventListener('click',function(){
      var v=parseInt(qtyInput.value)||1;
      var max=parseInt(qtyInput.max)||10;
      if(v<max){qtyInput.value=v+1;updateQtyBtns()}
    });
    updateQtyBtns();

    /* ═══ SIZE CHART LINK ═══ */
    container.querySelectorAll('.sh-size-chart-link').forEach(function(link){
      link.addEventListener('click',function(e){
        e.preventDefault();
        showSizeChart(this.dataset.category);
      });
    });

    // Add to Cart logic (retained from v1.5)
    var atcBtn=document.getElementById('dhpdp-atc');
    var buyBtn=document.getElementById('dhpdp-buy');
    var stickyAtc=container.querySelector('.dhpdp-sticky-atc');
    var stickyBuy=container.querySelector('.dhpdp-sticky-buy');
    var MAX_RETRIES=2;
    var RETRY_DELAYS=[1500,3000];

    function getSelectedVariant(){
      var parts=[];
      container.querySelectorAll('.dhpdp-opt-group').forEach(function(group){
        var sel=group.querySelector('.dhpdp-opt-sel');
        if(sel)parts.push(sel.dataset.valtitle||'');
      });
      if(parts.length===0)return null;
      var selectedTitle=parts.join(' / ');
      if(p.variants&&p.variants.length>0){
        var match=p.variants.find(function(v){return v.title===selectedTitle||v.title==='Option: '+selectedTitle||v.title.indexOf(selectedTitle)>=0});
        if(match)return match.title;
      }
      return selectedTitle;
    }

    function doAddToCart(buyNow,retryAttempt){
      retryAttempt=retryAttempt||0;
      var btn=buyNow?buyBtn:atcBtn;
      var origText=btn.textContent;
      var origBg=buyNow?'#1a1a1a':'#e53e3e';
      if(retryAttempt===0){btn.textContent='Processing...';btn.disabled=true;btn.style.opacity='0.7';}
      else btn.textContent='Syncing... (attempt '+(retryAttempt+1)+')';

      var variant=getSelectedVariant();
      var qty=parseInt((document.getElementById('sh-qty')||{}).value)||1;
      var activeId=_currentAsin||productId;
      var body={source:store,sourceId:activeId,quantity:qty};
      if(variant)body.selectedVariant=variant;
      if(retryAttempt>0)body.forceResync=true;
      if(_pdpProductData&&retryAttempt===0)body.productData=_pdpProductData;

      fetch(API+'/api/prepare-cart',{
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify(body),signal:AbortSignal.timeout(30000)
      })
      .then(function(r){if(!r.ok)throw new Error('Sync error ('+r.status+')');return r.json()})
      .then(function(data){
        if(!data.shopifyVariantId)throw new Error(data.error||'Sync failed — no variant ID');
        return fetch('/cart/add.js',{method:'POST',headers:{'Content-Type':'application/json'},
          body:JSON.stringify({items:[{id:data.shopifyVariantId,quantity:qty,properties:{_source:store,_source_id:activeId}}]})
        });
      })
      .then(function(r){
        if(!r.ok){
          return r.json().then(function(errData){
            if(r.status===422&&retryAttempt<MAX_RETRIES){
              var nextDelay=RETRY_DELAYS[retryAttempt]||5000;
              btn.textContent='Setting up product...';
              setTimeout(function(){doAddToCart(buyNow,retryAttempt+1)},nextDelay);
              return{_retrying:true};
            }
            throw new Error(errData.description||errData.message||'Could not add to cart ('+r.status+')');
          });
        }
        return r.json();
      })
      .then(function(result){
        if(result&&result._retrying)return;
        btn.textContent='\u2713 Added!';btn.style.background='#22c55e';btn.style.opacity='1';
        if(!buyNow&&stickyAtc){stickyAtc.textContent='\u2713 Added!';stickyAtc.style.background='#22c55e';}
        setTimeout(function(){
          btn.textContent=origText;btn.disabled=false;btn.style.opacity='1';btn.style.background=origBg;
          if(!buyNow&&stickyAtc){stickyAtc.textContent='Add to Cart';stickyAtc.style.background='#e53e3e';}
          if(buyNow)window.location.href='/checkout';
          else fetch('/cart.js').then(function(r){return r.json()}).then(function(cart){
            document.querySelectorAll('#dh-cart-count,.cart-count,.cart-count-bubble,[data-cart-count],.header-cart-count').forEach(function(el){el.textContent=cart.item_count});
          }).catch(function(){});
        },buyNow?500:1800);
      })
      .catch(function(err){
        console.error('Add to cart error:',err);
        btn.textContent='Error — Try Again';btn.style.background='#dc2626';btn.disabled=false;btn.style.opacity='1';
        setTimeout(function(){btn.textContent=origText;btn.style.background=origBg},4000);
      });
    }

    if(atcBtn)atcBtn.addEventListener('click',function(){doAddToCart(false)});
    if(buyBtn)buyBtn.addEventListener('click',function(){doAddToCart(true)});
    if(stickyAtc)stickyAtc.addEventListener('click',function(){doAddToCart(false)});
    if(stickyBuy)stickyBuy.addEventListener('click',function(){doAddToCart(true)});

    // Mobile sticky
    if(window.innerWidth<=768){
      var stickyBar=document.getElementById('dhpdp-sticky');
      if(stickyBar){
        var observer=new IntersectionObserver(function(entries){stickyBar.style.display=entries[0].isIntersecting?'none':'block';},{threshold:0});
        if(atcBtn)observer.observe(atcBtn);
      }
    }

    // Video button
    var vidBtn=container.querySelector('.dhpdp-video-btn');
    if(vidBtn&&p.videos&&p.videos.length){
      vidBtn.addEventListener('click',function(){
        var url=p.videos[0];
        var overlay=document.createElement('div');
        overlay.style.cssText='position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.85);z-index:10000;display:flex;align-items:center;justify-content:center;cursor:pointer';
        overlay.innerHTML='<video src="'+url+'" controls autoplay style="max-width:90%;max-height:80%;border-radius:12px"></video>';
        overlay.addEventListener('click',function(e){if(e.target===overlay)overlay.remove()});
        document.body.appendChild(overlay);
      });
    }
  }

  function renderStars(r){var s='';for(var i=1;i<=5;i++){if(i<=Math.floor(r))s+='\u2605';else if(i-r<1)s+='\u2605';else s+='\u2606'}return s}
  function fmtNum(n){if(!n)return '0';n=parseInt(n);if(isNaN(n)||n<=0)return '0';if(n>=1000000)return(n/1000000).toFixed(1)+'M';if(n>=1000)return(n/1000).toFixed(1)+'K';return String(n)}

  /* ═══ SIZE CHARTS DATA & MODAL ═══ */
  var SIZE_CHARTS={
    shoes:{title:'Shoe Size Chart',tabs:[
      {label:"Men's",headers:['US','EU','UK','CM','Inches'],rows:[['6','39','5.5','24','9.4'],['6.5','39.5','6','24.5','9.6'],['7','40','6.5','25','9.8'],['7.5','40.5','7','25.5','10'],['8','41','7.5','26','10.2'],['8.5','42','8','26.5','10.4'],['9','42.5','8.5','27','10.6'],['9.5','43','9','27.5','10.8'],['10','44','9.5','28','11'],['10.5','44.5','10','28.5','11.2'],['11','45','10.5','29','11.4'],['12','46','11.5','30','11.8'],['13','47.5','12.5','31','12.2'],['14','48.5','13.5','32','12.6']]},
      {label:"Women's",headers:['US','EU','UK','CM','Inches'],rows:[['5','35.5','2.5','22','8.7'],['5.5','36','3','22.5','8.9'],['6','36.5','3.5','23','9.1'],['6.5','37','4','23.5','9.3'],['7','37.5','4.5','24','9.4'],['7.5','38','5','24.5','9.6'],['8','39','5.5','25','9.8'],['8.5','39.5','6','25.5','10'],['9','40','6.5','26','10.2'],['9.5','41','7','26.5','10.4'],['10','41.5','7.5','27','10.6'],['11','42.5','8.5','28','11'],['12','44','9.5','29','11.4']]}
    ],howToMeasure:'Stand on a piece of paper and trace your foot. Measure from the heel to the longest toe in cm or inches.'},
    tops:{title:'Tops Size Chart',tabs:[
      {label:"Men's",headers:['Size','US','Chest (in)','Chest (cm)','Length (in)'],rows:[['XS','34','34-36','86-91','27'],['S','36','36-38','91-97','28'],['M','38-40','38-40','97-102','29'],['L','42-44','42-44','107-112','30'],['XL','46','46-48','117-122','31'],['XXL','48-50','48-50','122-127','32']]},
      {label:"Women's",headers:['Size','US','Bust (in)','Bust (cm)','Waist (in)'],rows:[['XS','0-2','31-33','79-84','24-26'],['S','4-6','33-35','84-89','26-28'],['M','8-10','35-37','89-94','28-30'],['L','12-14','38-40','97-102','31-33'],['XL','16-18','41-43','104-109','34-36'],['XXL','20-22','44-46','112-117','37-39']]}
    ],howToMeasure:'Chest/Bust: Measure around the fullest part. Waist: Measure around your natural waistline.'},
    dresses:{title:'Dress Size Chart',tabs:[
      {label:"Women's",headers:['Size','US','Bust (in)','Waist (in)','Hips (in)'],rows:[['XS','0-2','31-33','24-26','34-36'],['S','4-6','33-35','26-28','36-38'],['M','8-10','35-37','28-30','38-40'],['L','12-14','38-40','31-33','41-43'],['XL','16-18','41-43','34-36','44-46'],['XXL','20-22','44-46','37-39','47-49']]}
    ],howToMeasure:'Bust: Measure around the fullest part. Waist: Measure around your natural waistline. Hips: Measure around the fullest part of your hips.'},
    bottoms:{title:'Pants & Jeans Size Chart',tabs:[
      {label:"Men's",headers:['Size','Waist (in)','Waist (cm)','Hips (in)','Inseam (in)'],rows:[['28','28-29','71-74','35-36','30-32'],['30','30-31','76-79','37-38','30-32'],['32','32-33','81-84','39-40','30-32'],['34','34-35','86-89','41-42','30-32'],['36','36-37','91-94','43-44','30-32'],['38','38-39','97-99','45-46','30-32'],['40','40-41','102-104','47-48','30-32']]},
      {label:"Women's",headers:['Size','US','Waist (in)','Hips (in)','Inseam (in)'],rows:[['XS','0-2','24-26','34-36','28-30'],['S','4-6','26-28','36-38','28-30'],['M','8-10','28-30','38-40','29-31'],['L','12-14','31-33','41-43','29-31'],['XL','16-18','34-36','44-46','30-32']]}
    ],howToMeasure:'Waist: Measure around your natural waistline. Hips: Measure around the fullest part. Inseam: Measure from crotch seam to bottom of leg.'},
    outerwear:{title:'Outerwear Size Chart',tabs:[
      {label:"Men's",headers:['Size','Chest (in)','Chest (cm)','Shoulder (in)'],rows:[['S','36-38','91-97','17-17.5'],['M','38-40','97-102','17.5-18'],['L','42-44','107-112','18-18.5'],['XL','46-48','117-122','18.5-19'],['XXL','50-52','127-132','19-19.5']]},
      {label:"Women's",headers:['Size','Bust (in)','Bust (cm)','Shoulder (in)'],rows:[['XS','31-33','79-84','14-14.5'],['S','33-35','84-89','14.5-15'],['M','35-37','89-94','15-15.5'],['L','38-40','97-102','15.5-16'],['XL','41-43','104-109','16-16.5']]}
    ],howToMeasure:'Chest/Bust: Measure around the fullest part over a thin layer of clothing.'},
    underwear:{title:'Underwear Size Chart',tabs:[
      {label:"Men's",headers:['Size','Waist (in)','Waist (cm)'],rows:[['S','28-30','71-76'],['M','32-34','81-86'],['L','36-38','91-97'],['XL','40-42','102-107'],['XXL','44-46','112-117']]},
      {label:"Women's",headers:['Size','US','Waist (in)','Hips (in)'],rows:[['XS','0-2','24-25','34-35'],['S','4-6','26-27','36-37'],['M','8-10','28-29','38-39'],['L','12-14','30-32','40-42'],['XL','16-18','33-35','43-45']]}
    ],howToMeasure:'Waist: Measure around your natural waistline. Hips: Measure around the fullest part.'},
    kids:{title:'Kids Size Chart',tabs:[
      {label:'Toddler (2-6)',headers:['Size','Age','Height (in)','Weight (lbs)','Chest (in)'],rows:[['2T','2','33-35','27-30','21'],['3T','3','35-38','30-33','22'],['4T','4','38-41','33-37','23'],['5','5','41-44','37-42','24'],['6','6','44-47','42-47','25']]},
      {label:'Kids (7-14)',headers:['Size','Age','Height (in)','Weight (lbs)','Chest (in)'],rows:[['S (6-7)','6-7','47-50','47-55','25-26'],['M (8-10)','8-10','50-55','55-70','27-28.5'],['L (10-12)','10-12','55-59','70-85','28.5-30'],['XL (14-16)','14-16','59-63','85-105','31-32.5']]},
      {label:'Kids Shoes',headers:['US','EU','UK','Age','Foot (in)'],rows:[['10C','27','9','4-5','6.5'],['11C','28','10','4-5','6.8'],['12C','30','11','5-6','7.1'],['13C','31','12','6-7','7.4'],['1Y','32','13','7-8','7.8'],['2Y','33','1','8-9','8.1'],['3Y','35','2','9-10','8.5'],['4Y','36','3','10-11','8.8'],['5Y','37','4','11-12','9.1'],['6Y','38.5','5','12-13','9.5'],['7Y','40','6','13+','9.8']]}
    ],howToMeasure:'Height: Measure standing straight against a wall. For shoes, trace the foot on paper and measure heel to toe.'},
    jewelry:{title:'Ring Size Chart',headers:['US','UK','EU','Diameter (mm)','Circumference (mm)'],rows:[['5','J½','49','15.7','49.3'],['6','L½','51.5','16.5','51.8'],['7','N½','54','17.3','54.4'],['8','P½','57','18.1','57'],['9','R½','59','19','59.5'],['10','T½','62','19.8','62.1'],['11','V½','64','20.6','64.6'],['12','Y','67','21.4','67.2']],howToMeasure:'Wrap a thin strip of paper around your finger. Mark where it overlaps. Measure the length in mm.'},
    accessories:{title:'Belt Size Chart',headers:['Size','Waist (in)','Belt Length (in)'],rows:[['S','28-30','32-34'],['M','32-34','36-38'],['L','36-38','40-42'],['XL','40-42','44-46'],['XXL','44-46','48-50']],howToMeasure:'Measure around where you normally wear your belt. Order a belt 2 inches larger than your waist measurement.'}
  };

  function showSizeChart(category){
    var chart=SIZE_CHARTS[category];
    if(!chart)return;
    var h='<div id="sh-size-chart-overlay" style="position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:10000;display:flex;align-items:center;justify-content:center;padding:20px">';
    h+='<div style="background:#fff;border-radius:12px;max-width:680px;width:100%;max-height:85vh;overflow-y:auto;box-shadow:0 20px 60px rgba(0,0,0,.3)">';
    h+='<div style="display:flex;align-items:center;justify-content:space-between;padding:16px 20px;border-bottom:1px solid #eee">';
    h+='<h3 style="margin:0;font-size:18px;font-weight:700;color:#1a1a1a">'+esc(chart.title)+'</h3>';
    h+='<button id="sh-size-chart-close" style="background:none;border:none;font-size:22px;cursor:pointer;color:#666;padding:4px 8px">\u2715</button>';
    h+='</div>';
    /* Tabs */
    var tabs=chart.tabs||[chart];
    if(chart.tabs&&chart.tabs.length>1){
      h+='<div style="display:flex;gap:0;border-bottom:1px solid #eee;padding:0 20px" class="sh-chart-tabs">';
      tabs.forEach(function(tab,i){
        h+='<button class="sh-chart-tab'+(i===0?' sh-chart-tab-active':'')+'" data-tab="'+i+'" style="padding:10px 16px;font-size:14px;font-weight:'+(i===0?'600':'400')+';color:'+(i===0?'#e53e3e':'#666')+';border:none;background:none;cursor:pointer;border-bottom:2px solid '+(i===0?'#e53e3e':'transparent')+';margin-bottom:-1px">'+esc(tab.label)+'</button>';
      });
      h+='</div>';
    }
    /* Table container */
    h+='<div id="sh-chart-body" style="padding:16px 20px;overflow-x:auto">';
    h+=renderSizeTable(tabs[0]);
    h+='</div>';
    if(chart.howToMeasure){
      h+='<div style="padding:12px 20px;background:#f8fafc;border-top:1px solid #eee;border-radius:0 0 12px 12px;font-size:13px;color:#666"><b>How to measure:</b> '+esc(chart.howToMeasure)+'</div>';
    }
    h+='</div></div>';
    document.body.insertAdjacentHTML('beforeend',h);
    document.body.style.overflow='hidden';
    /* Close handlers */
    document.getElementById('sh-size-chart-close').addEventListener('click',closeSizeChart);
    document.getElementById('sh-size-chart-overlay').addEventListener('click',function(e){if(e.target===this)closeSizeChart()});
    /* Tab handlers */
    document.querySelectorAll('.sh-chart-tab').forEach(function(btn){
      btn.addEventListener('click',function(){
        var idx=parseInt(this.dataset.tab);
        document.querySelectorAll('.sh-chart-tab').forEach(function(t){t.style.fontWeight='400';t.style.color='#666';t.style.borderBottomColor='transparent';t.classList.remove('sh-chart-tab-active')});
        this.style.fontWeight='600';this.style.color='#e53e3e';this.style.borderBottomColor='#e53e3e';this.classList.add('sh-chart-tab-active');
        var body=document.getElementById('sh-chart-body');
        if(body&&tabs[idx])body.innerHTML=renderSizeTable(tabs[idx]);
      });
    });
    document.addEventListener('keydown',function esc_handler(e){if(e.key==='Escape'){closeSizeChart();document.removeEventListener('keydown',esc_handler)}});
  }
  function closeSizeChart(){
    var ov=document.getElementById('sh-size-chart-overlay');
    if(ov)ov.remove();
    document.body.style.overflow='';
  }
  function renderSizeTable(data){
    var h='<table style="width:100%;border-collapse:collapse;font-size:13px"><thead><tr>';
    (data.headers||[]).forEach(function(hdr){h+='<th style="padding:8px 12px;text-align:left;font-weight:600;color:#374151;background:#f9fafb;border-bottom:2px solid #e5e7eb">'+esc(hdr)+'</th>'});
    h+='</tr></thead><tbody>';
    (data.rows||[]).forEach(function(row,ri){
      h+='<tr style="background:'+(ri%2===0?'#fff':'#f9fafb')+'">';
      row.forEach(function(cell,ci){h+='<td style="padding:8px 12px;border-bottom:1px solid #f0f0f0;'+(ci===0?'font-weight:600;color:#1a1a1a':'color:#4b5563')+'">'+esc(cell)+'</td>'});
      h+='</tr>';
    });
    h+='</tbody></table>';
    return h;
  }

  function addToRecentlyViewed(p){
    try{
      var key='dh_recent';var items=JSON.parse(localStorage.getItem(key)||'[]');
      items=items.filter(function(i){return i.id!==p.sourceId});
      items.unshift({id:p.sourceId,store:store,title:p.title,price:p.price,image:p.primaryImage||p.images&&p.images[0]||'',ts:Date.now()});
      if(items.length>12)items=items.slice(0,12);
      localStorage.setItem(key,JSON.stringify(items));
      setTimeout(function(){renderRecentlyViewed(p.sourceId)},100);
    }catch(e){}
  }

  function renderRecentlyViewed(currentId){
    try{
      var items=JSON.parse(localStorage.getItem('dh_recent')||'[]');
      items=items.filter(function(i){return i.id!==currentId});
      if(items.length<1)return;
      items=items.slice(0,6);
      var h='<div class="dhpdp-section"><h2 class="dhpdp-section-title">Recently Viewed</h2>';
      h+='<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:14px">';
      items.forEach(function(item){
        var link='/pages/product?id='+encodeURIComponent(item.id)+'&store='+encodeURIComponent(item.store);
        var prc=typeof item.price==='number'?item.price:parseFloat(String(item.price||'0').replace(/[^0-9.]/g,''));
        h+='<a href="'+link+'" style="text-decoration:none;background:#fff;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;transition:box-shadow .2s">';
        h+='<div style="aspect-ratio:1;background:#f8f9fa;overflow:hidden"><img src="'+esc(item.image||'')+'" alt="" style="width:100%;height:100%;object-fit:contain" loading="lazy" onerror="this.parentElement.style.background=\'#f0f0f0\'"></div>';
        h+='<div style="padding:10px"><div style="font-size:12px;color:#4a5568;line-height:1.3;height:32px;overflow:hidden">'+esc((item.title||'').substring(0,60))+'</div>';
        if(prc>0)h+='<div style="font-size:15px;font-weight:700;color:#e53e3e;margin-top:6px">$'+prc.toFixed(2)+'</div>';
        h+='</div></a>';
      });
      h+='</div></div>';
      container.insertAdjacentHTML('beforeend',h);
    }catch(e){}
  }
})();
