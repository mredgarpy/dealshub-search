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
      if(reviews)h+='<a href="#dhpdp-reviews" style="font-size:13px;color:#2563eb;text-decoration:none">('+fmtNum(reviews)+' ratings)</a>';
      if(p.salesVolume)h+='<span style="font-size:12px;color:#6b7280;border-left:1px solid #e5e7eb;padding-left:8px;margin-left:4px">'+esc(p.salesVolume)+'</span>';
      h+='</div>';
    }

    // Price
    h+='<div style="margin-bottom:16px">';
    h+='<span style="font-size:32px;font-weight:700;color:#e53e3e" id="dhpdp-price">$'+price.toFixed(2)+'</span>';
    if(origPrice>price)h+=' <span style="font-size:18px;color:#999;text-decoration:line-through;margin-left:8px">$'+origPrice.toFixed(2)+'</span>';
    if(discount>0)h+=' <span style="background:#fff3e0;color:#e65100;padding:2px 8px;border-radius:4px;font-size:13px;font-weight:600;margin-left:8px">Save '+discount+'%</span>';
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

  // ═══ SECTION 4: VARIANTS ═══
  function renderVariants(p){
    if(!p.options||!p.options.length)return '';
    var h='<div class="dhpdp-variants" style="margin-bottom:20px">';
    for(var oi=0;oi<p.options.length;oi++){
      var opt=p.options[oi];
      h+='<div style="margin-bottom:12px"><label style="font-size:14px;font-weight:600;color:#333;display:block;margin-bottom:6px">'+esc(opt.name)+': <span class="dhpdp-opt-label" data-option="'+oi+'" style="color:#e53e3e;font-weight:700"></span></label>';
      h+='<div style="display:flex;flex-wrap:wrap;gap:8px">';
      for(var vi=0;vi<(opt.values||[]).length;vi++){
        var val=opt.values[vi];
        var isSelected=val.selected||(!opt.values.some(function(v){return v.selected})&&vi===0);
        var sel=isSelected?' dhpdp-opt-sel':'';
        if(val.image){
          h+='<button class="dhpdp-opt'+sel+'" data-option="'+oi+'" data-value="'+vi+'" data-valtitle="'+esc(val.value)+'" style="width:44px;height:44px;border-radius:8px;border:2px solid '+(isSelected?'#e53e3e':'#ddd')+';padding:2px;cursor:pointer;background:#fff"><img src="'+esc(val.image)+'" style="width:100%;height:100%;object-fit:cover;border-radius:6px"></button>';
        }else{
          h+='<button class="dhpdp-opt'+sel+'" data-option="'+oi+'" data-value="'+vi+'" data-valtitle="'+esc(val.value)+'" style="padding:8px 16px;border-radius:8px;border:2px solid '+(isSelected?'#e53e3e':'#ddd')+';cursor:pointer;background:'+(isSelected?'#fef2f2':'#fff')+';font-size:13px;color:#333">'+esc(val.value)+'</button>';
        }
      }
      h+='</div></div>';
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
    var sc=p.shippingCalc||{};
    var pdpIsPlus=false;
    try{pdpIsPlus=localStorage.getItem('stylehub_plus')==='true';}catch(e){}
    var shipCost=pdpIsPlus?0:(sc.cost!=null?sc.cost:(p.shippingData&&p.shippingData.cost!=null?p.shippingData.cost:null));
    var shipMethod=pdpIsPlus?'StyleHub Plus':(sc.method||(p.shippingData&&p.shippingData.method)||'Standard');
    var shipIsFree=pdpIsPlus||sc.isFree||(shipCost===0);
    var shipThreshold=sc.threshold||null;
    var shipRemaining=sc.remaining||null;
    var shipThresholdNote=sc.thresholdNote||null;
    var plusSaves=pdpIsPlus?0:(sc.plusSaves||0);
    var del=sc.delivery||p.deliveryEstimate||{};
    var delFormatted=del.formattedRange||del.label||'5-10 business days';
    var delEarliest=del.earliest||del.earliestDate||'';
    var delLatest=del.latest||del.latestDate||'';
    var ret=sc.returnWindow||p.returnPolicy||{};
    var shipShipsFrom=sc.shipsFrom||(p.shippingData&&p.shippingData.shipsFrom)||null;
    var bestOffer=p.bestOffer||null;
    var retSummary;
    if(pdpIsPlus){retSummary='Extended 60-day returns (Plus benefit)';}else{retSummary=ret.summary||(ret.days?'Returns accepted within '+ret.days+' days':'30-day returns');if(typeof ret==='string')retSummary=ret;}

    var savedZip=null;try{savedZip=localStorage.getItem('stylehub_zip');}catch(e){}

    var h='<div style="border:1px solid '+(pdpIsPlus?'#c4b5fd':'#e2e8f0')+';border-radius:10px;overflow:hidden;margin-bottom:20px">';

    if(pdpIsPlus){h+='<div style="padding:8px 16px;background:linear-gradient(90deg,#6b46c1,#805ad5);color:#fff;font-size:13px;font-weight:700;text-align:center">&#9889; StyleHub Plus Member — FREE Shipping & Extended Returns</div>';}

    // Location
    h+='<div style="padding:12px 16px;background:#f8fafc;display:flex;align-items:center;gap:8px;border-bottom:1px solid #e2e8f0">';
    h+='<svg width="16" height="16" fill="none" stroke="#6b7280" stroke-width="1.5" viewBox="0 0 24 24"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z"/><circle cx="12" cy="10" r="3"/></svg>';
    if(savedZip){
      h+='<span style="font-size:13px;color:#374151">Deliver to <b>'+esc(savedZip)+'</b></span>';
      h+='<a href="#" onclick="event.preventDefault();document.getElementById(\'dh-zip-input\').style.display=\'flex\'" style="font-size:12px;color:#2563eb;margin-left:auto;text-decoration:none">Change</a>';
    }
    h+='<div id="dh-zip-input" style="display:'+(savedZip?'none':'flex')+';align-items:center;gap:6px;'+(savedZip?'':'flex:1;')+'">';
    h+='<input type="text" placeholder="Enter ZIP code" maxlength="5" pattern="[0-9]*" style="width:90px;padding:5px 8px;border:1px solid #d1d5db;border-radius:6px;font-size:13px;outline:none" id="dh-zip-val"'+(savedZip?' value="'+esc(savedZip)+'"':'')+'/>';
    h+='<button onclick="var z=document.getElementById(\'dh-zip-val\').value.trim();if(z.length>=5){try{localStorage.setItem(\'stylehub_zip\',z)}catch(e){}location.reload()}" style="padding:5px 10px;background:#2563eb;color:#fff;border:none;border-radius:6px;font-size:12px;cursor:pointer">Check</button>';
    h+='</div></div>';

    // Shipping cost
    h+='<div style="padding:14px 16px;display:flex;align-items:flex-start;gap:12px;border-bottom:1px solid #f0f0f0">';
    h+='<div style="flex-shrink:0;width:36px;height:36px;background:'+(pdpIsPlus?'#f5f3ff':'#f0fdf4')+';border-radius:8px;display:flex;align-items:center;justify-content:center"><svg width="20" height="20" fill="none" stroke="'+(pdpIsPlus?'#7c3aed':'#16a34a')+'" stroke-width="1.5" viewBox="0 0 24 24"><rect x="1" y="3" width="15" height="13" rx="2"/><path d="M16 8h4l3 3v5h-7V8z"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/></svg></div>';
    h+='<div style="flex:1">';
    if(pdpIsPlus){
      h+='<div style="display:flex;align-items:center;gap:8px;margin-bottom:2px"><span style="font-size:14px;font-weight:600;color:#333">Shipping</span><span style="color:#6b46c1;font-weight:700;font-size:15px">FREE</span><span style="background:#6b46c1;color:#fff;font-size:10px;font-weight:700;padding:2px 6px;border-radius:10px">PLUS</span></div>';
      h+='<div style="font-size:12px;color:#6b7280">StyleHub Plus &middot; All orders ship free</div>';
    }else if(shipIsFree){
      h+='<div style="display:flex;align-items:center;gap:8px;margin-bottom:2px"><span style="font-size:14px;font-weight:600;color:#333">Shipping</span><span style="color:#16a34a;font-weight:700;font-size:15px">FREE</span></div>';
      h+='<div style="font-size:12px;color:#6b7280">'+esc(shipMethod)+'</div>';
    }else if(shipCost!=null&&shipCost>0){
      h+='<div style="display:flex;align-items:center;gap:8px;margin-bottom:2px"><span style="font-size:14px;font-weight:600;color:#333">Shipping</span><span style="font-weight:700;font-size:15px;color:#333">$'+shipCost.toFixed(2)+'</span></div>';
      h+='<div style="font-size:12px;color:#6b7280">'+esc(shipMethod)+'</div>';
    }else{
      h+='<div style="display:flex;align-items:center;gap:8px;margin-bottom:2px"><span style="font-size:14px;font-weight:600;color:#333">Shipping</span><span style="font-size:13px;color:#666">Calculated at checkout</span></div>';
    }
    if(shipShipsFrom){
      var sellerLine='Ships from <b>'+esc(shipShipsFrom)+'</b>';
      if(bestOffer&&bestOffer.sellerRating)sellerLine+=' &#11088; '+esc(bestOffer.sellerRating);
      h+='<div style="font-size:12px;color:#555;margin-top:3px">'+sellerLine+'</div>';
      if(bestOffer&&bestOffer.seller&&bestOffer.seller!==shipShipsFrom)h+='<div style="font-size:11px;color:#888;margin-top:1px">Sold by '+esc(bestOffer.seller)+'</div>';
    }
    // AliExpress shipping options
    var shipOpts=p.shippingOptions||[];
    if(shipOpts.length>1&&p.source==='aliexpress'){
      h+='<div style="margin-top:6px;border-top:1px solid #f0f0f0;padding-top:6px">';
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
      h+='<div style="font-size:12px;color:#555;margin-top:3px">Sold by <b>'+esc(p.sellerData.name)+'</b></div>';
      if(p.shippingData&&p.shippingData.shipsFrom){
        var sf=p.shippingData.shipsFrom.toLowerCase();
        var fromFlag=sf.indexOf('united states')>=0||sf==='us'?' &#127482;&#127480;':(sf.indexOf('china')>=0?' &#127464;&#127475;':'');
        h+='<div style="font-size:11px;color:#888;margin-top:1px">Ships from '+esc(p.shippingData.shipsFrom)+fromFlag+'</div>';
      }
    }
    if(!pdpIsPlus&&shipThresholdNote&&shipRemaining>0)h+='<div style="font-size:12px;color:#d97706;margin-top:4px">&#128161; Add $'+shipRemaining.toFixed(2)+' more for FREE shipping</div>';
    if(!pdpIsPlus&&plusSaves>0)h+='<div style="font-size:12px;color:#7c3aed;margin-top:4px">&#9889; <b>FREE</b> with StyleHub Plus ($7.99/mo) <a href="/pages/plus" style="color:#7c3aed;text-decoration:underline;font-size:11px;margin-left:4px">Try free</a></div>';
    h+='</div></div>';

    // Delivery date
    h+='<div style="padding:14px 16px;display:flex;align-items:center;gap:12px;border-bottom:1px solid #f0f0f0">';
    h+='<div style="flex-shrink:0;width:36px;height:36px;background:#eff6ff;border-radius:8px;display:flex;align-items:center;justify-content:center"><svg width="20" height="20" fill="none" stroke="#2563eb" stroke-width="1.5" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg></div>';
    h+='<div style="flex:1"><div style="font-size:14px;font-weight:600;color:#333">Estimated Delivery</div>';
    if(delEarliest&&delLatest)h+='<div style="font-size:15px;font-weight:700;color:#2563eb;margin-top:2px">'+esc(delEarliest)+' &ndash; '+esc(delLatest)+'</div>';
    else h+='<div style="font-size:13px;color:#555">'+esc(delFormatted)+'</div>';
    h+='</div></div>';

    // Returns
    h+='<div style="padding:14px 16px;display:flex;align-items:center;gap:12px">';
    h+='<div style="flex-shrink:0;width:36px;height:36px;background:#faf5ff;border-radius:8px;display:flex;align-items:center;justify-content:center"><svg width="20" height="20" fill="none" stroke="#7c3aed" stroke-width="1.5" viewBox="0 0 24 24"><path d="M3 12h18M3 12l6-6M3 12l6 6"/></svg></div>';
    h+='<div style="flex:1"><div style="font-size:14px;font-weight:600;color:#333">Easy Returns'+(pdpIsPlus?' <span style="background:#6b46c1;color:#fff;font-size:10px;font-weight:700;padding:2px 6px;border-radius:10px;margin-left:6px">PLUS</span>':'')+'</div>';
    h+='<div style="font-size:13px;color:'+(pdpIsPlus?'#6b46c1':'#555')+'">'+esc(retSummary)+'</div></div></div>';
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
    if(!desc)return '';
    var h='<div class="dhpdp-section">';
    h+='<h2 class="dhpdp-section-title">Product Description</h2>';
    h+='<div style="font-size:15px;line-height:1.8;color:#444;max-width:800px">';
    // Truncate very long descriptions with expand
    var lines=desc.split('\n').filter(function(l){return l.trim()});
    if(lines.length>8){
      h+='<div id="dhpdp-desc-short">'+lines.slice(0,6).map(function(l){return '<p style="margin:0 0 12px">'+esc(l)+'</p>'}).join('')+'</div>';
      h+='<div id="dhpdp-desc-full" style="display:none">'+lines.map(function(l){return '<p style="margin:0 0 12px">'+esc(l)+'</p>'}).join('')+'</div>';
      h+='<button id="dhpdp-desc-toggle" onclick="document.getElementById(\'dhpdp-desc-short\').style.display=\'none\';document.getElementById(\'dhpdp-desc-full\').style.display=\'block\';this.style.display=\'none\'" style="color:#2563eb;background:none;border:none;cursor:pointer;font-size:14px;font-weight:500;padding:0">Read more &#8250;</button>';
    }else{
      h+=lines.map(function(l){return '<p style="margin:0 0 12px">'+esc(l)+'</p>'}).join('');
    }
    h+='</div></div>';
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

    // Variant option clicks
    function findVariantBySelection(){
      var parts=[];
      container.querySelectorAll('.dhpdp-variants > div').forEach(function(group){
        var sel=group.querySelector('.dhpdp-opt-sel');
        if(sel){
          var optIdx=parseInt(sel.dataset.option);
          var valIdx=parseInt(sel.dataset.value);
          if(p.options&&p.options[optIdx]&&p.options[optIdx].values&&p.options[optIdx].values[valIdx])parts.push(p.options[optIdx].values[valIdx]);
        }
      });
      if(parts.length>0&&p.variants&&p.variants.length>0){
        var selectedTitle=parts.map(function(v){return v.value}).join(' / ');
        return p.variants.find(function(v){return v.title===selectedTitle||v.title==='Option: '+selectedTitle||v.title.indexOf(selectedTitle)>=0})||null;
      }
      return null;
    }

    function updatePriceDisplay(variant){
      if(!variant)return;
      var vPrice=variant.price?(typeof variant.price==='number'?variant.price:parseFloat(String(variant.price).replace(/[^0-9.]/g,''))):0;
      if(vPrice<=0)return;
      var priceEl=document.getElementById('dhpdp-price');
      if(priceEl)priceEl.textContent='$'+vPrice.toFixed(2);
    }

    function updateMainImage(variant){
      if(!variant||!variant.image)return;
      var mainImg=document.getElementById('dhpdp-main-img');
      if(mainImg)mainImg.src=variant.image;
    }

    function updateOptionLabels(){
      container.querySelectorAll('.dhpdp-opt-label').forEach(function(label){
        var optIdx=label.dataset.option;
        var sel=container.querySelector('.dhpdp-opt-sel[data-option="'+optIdx+'"]');
        if(sel)label.textContent=sel.dataset.valtitle||'';
      });
    }

    updateOptionLabels();

    container.querySelectorAll('.dhpdp-opt').forEach(function(btn){
      btn.addEventListener('click',function(){
        var optIdx=this.dataset.option;
        container.querySelectorAll('.dhpdp-opt[data-option="'+optIdx+'"]').forEach(function(b){
          b.style.borderColor='#ddd';b.style.background='#fff';b.classList.remove('dhpdp-opt-sel');
        });
        this.style.borderColor='#e53e3e';this.style.background='#fef2f2';this.classList.add('dhpdp-opt-sel');
        updateOptionLabels();
        var variant=findVariantBySelection();
        if(variant){updatePriceDisplay(variant);updateMainImage(variant);}
        if(!variant||!variant.image){
          var btnImg=this.querySelector('img');
          if(btnImg&&btnImg.src){var mainImg=document.getElementById('dhpdp-main-img');if(mainImg)mainImg.src=btnImg.src;}
        }
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
      container.querySelectorAll('.dhpdp-variants > div').forEach(function(group){
        var sel=group.querySelector('.dhpdp-opt-sel');
        if(sel){
          var optIdx=parseInt(sel.dataset.option);
          var valIdx=parseInt(sel.dataset.value);
          if(p.options&&p.options[optIdx]&&p.options[optIdx].values&&p.options[optIdx].values[valIdx])parts.push(p.options[optIdx].values[valIdx].value);
        }
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
      var body={source:store,sourceId:productId,quantity:1};
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
          body:JSON.stringify({items:[{id:data.shopifyVariantId,quantity:1,properties:{_source:store,_source_id:productId}}]})
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
  function fmtNum(n){if(!n)return '0';n=parseInt(n);if(n>=1000000)return(n/1000000).toFixed(1)+'M';if(n>=1000)return(n/1000).toFixed(1)+'K';return String(n)}

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
