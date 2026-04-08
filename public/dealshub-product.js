/* DealsHub PDP v1.3 — Self-contained Product Detail Page
   FIX v1.1: Improved Add to Cart retry logic for newly created products
   FIX v1.2: PDP Variant improvements (pre-select, image/price update)
   FIX v1.3: Cart count selector fix (#dh-cart-count), prepare-cart timeout 60s
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
  if(!productId){container.innerHTML='<div style="text-align:center;padding:60px 20px"><h2>Product Not Found</h2><p>No product ID specified.</p><a href="/" style="color:#e53e3e">Back to Home</a></div>';return}

  // Show skeleton
  container.innerHTML=skeletonHTML();

  // Fetch product
  fetch(API+'/api/product/'+encodeURIComponent(productId)+'?store='+encodeURIComponent(store)+(titleHint?'&title='+encodeURIComponent(titleHint):''),{signal:AbortSignal.timeout(20000)})
    .then(function(r){if(!r.ok)throw new Error('HTTP '+r.status);return r.json()})
    .then(function(data){
      var p=data;
      // Fallback: use URL params if API didn't return title/image
      if(p && !p.title && titleHint) p.title=decodeURIComponent(titleHint);
      if(p && (!p.image && !p.primaryImage) && params.get('image')) p.primaryImage=params.get('image');
      if(!p||!p.title){throw new Error('No product data')}
      renderProduct(p);
      addToRecentlyViewed(p);
    })
    .catch(function(err){
      console.error('PDP fetch error:',err);
      container.innerHTML='<div style="text-align:center;padding:60px 20px"><h2>Unable to Load Product</h2><p>'+escHTML(err.message)+'</p><p style="margin-top:16px"><a href="/" style="color:#e53e3e;text-decoration:underline">Back to Home</a> &middot; <a href="javascript:location.reload()" style="color:#e53e3e;text-decoration:underline">Retry</a></p></div>';
    });

  function escHTML(s){var d=document.createElement('div');d.textContent=s||'';return d.innerHTML}

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
    var stars=renderStars(rating);

    var html='<div class="dhpdp" style="max-width:1200px;margin:0 auto;padding:20px">';

    // Breadcrumbs
    html+='<nav style="font-size:13px;color:#666;margin-bottom:16px"><a href="/" style="color:#666;text-decoration:none">Home</a>';
    if(p.category)html+=' <span style="margin:0 6px">/</span> <span>'+escHTML(p.category)+'</span>';
    html+=' <span style="margin:0 6px">/</span> <span style="color:#333">'+escHTML((p.title||'').substring(0,50))+'</span></nav>';

    html+='<div style="display:grid;grid-template-columns:1fr 1fr;gap:40px" class="dhpdp-grid">';

    // LEFT: Image gallery
    html+='<div class="dhpdp-gallery">';
    html+='<div style="position:relative;border-radius:12px;overflow:hidden;background:#fafafa;border:1px solid #eee">';
    if(p.badge)html+='<span style="position:absolute;top:12px;left:12px;background:#e53e3e;color:#fff;padding:4px 12px;border-radius:20px;font-size:12px;font-weight:600;z-index:2">'+escHTML(p.badge)+'</span>';
    if(discount>0)html+='<span style="position:absolute;top:12px;right:12px;background:#ff6b35;color:#fff;padding:4px 10px;border-radius:20px;font-size:12px;font-weight:600;z-index:2">-'+discount+'%</span>';
    html+='<img id="dhpdp-main-img" src="'+escHTML(mainImg)+'" alt="'+escHTML(p.title)+'" style="width:100%;aspect-ratio:1;object-fit:contain;display:block" onerror="this.src=\'data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 400 400%22><rect fill=%22%23f5f5f5%22 width=%22400%22 height=%22400%22/><text x=%22200%22 y=%22200%22 text-anchor=%22middle%22 fill=%22%23ccc%22 font-size=%2220%22>No Image</text></svg>\'"></div>';

    // Thumbnails
    if(imgs.length>1){
      html+='<div style="display:flex;gap:8px;margin-top:12px;overflow-x:auto;padding-bottom:4px" class="dhpdp-thumbs">';
      for(var i=0;i<Math.min(imgs.length,8);i++){
        html+='<img src="'+escHTML(imgs[i])+'" class="dhpdp-thumb" data-idx="'+i+'" style="width:64px;height:64px;object-fit:contain;border-radius:8px;border:2px solid '+(i===0?'#e53e3e':'#eee')+';cursor:pointer;flex-shrink:0;background:#fafafa" onerror="this.style.display=\'none\'">';
      }
      html+='</div>';
    }
    html+='</div>';

    // RIGHT: Product info
    html+='<div class="dhpdp-info">';

    // Brand
    if(p.brand)html+='<div style="font-size:13px;color:#888;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px">'+escHTML(p.brand)+'</div>';

    // Title
    html+='<h1 style="font-size:24px;font-weight:700;color:#1a1a1a;line-height:1.3;margin:0 0 12px">'+escHTML(p.title)+'</h1>';

    // Rating
    if(rating>0){
      html+='<div style="display:flex;align-items:center;gap:8px;margin-bottom:12px">';
      html+='<span style="color:#f59e0b;font-size:16px">'+stars+'</span>';
      html+='<span style="font-size:14px;color:#666">'+rating.toFixed(1)+'</span>';
      if(reviews)html+='<span style="font-size:13px;color:#999">('+formatNumber(reviews)+' reviews)</span>';
      html+='</div>';
    }

    // Price
    html+='<div style="margin-bottom:16px">';
    html+='<span style="font-size:32px;font-weight:700;color:#e53e3e">$'+price.toFixed(2)+'</span>';
    if(origPrice>price)html+=' <span style="font-size:18px;color:#999;text-decoration:line-through;margin-left:8px">$'+origPrice.toFixed(2)+'</span>';
    if(discount>0)html+=' <span style="background:#fff3e0;color:#e65100;padding:2px 8px;border-radius:4px;font-size:13px;font-weight:600;margin-left:8px">Save '+discount+'%</span>';
    html+='</div>';

    // Availability
    var avail=p.availability||p.stockSignal||'';
    if(avail){
      var isInStock=avail.toLowerCase().indexOf('in stock')>=0||avail==='in_stock';
      html+='<div class="dhpdp-stock-status" style="display:flex;align-items:center;gap:6px;margin-bottom:16px"><span style="width:8px;height:8px;border-radius:50%;background:'+(isInStock?'#22c55e':'#f59e0b')+'"></span><span style="font-size:14px;color:'+(isInStock?'#16a34a':'#d97706')+'">'+(isInStock?'In Stock':'Limited Availability')+'</span></div>';
    }

    // Variant selector — FIX v1.3: Multi-option availability (Color+Size combos)
    // For single-option products: disable values with no available variant
    // For multi-option products: disable values where NO combination is available
    //   and dynamically update when user changes selection

    // Parse variant titles into option parts for combo matching
    var variantParts = []; // [{parts: ['Black','M'], available: true, variant: v}, ...]
    if(p.variants && p.variants.length > 0 && p.options && p.options.length > 0){
      p.variants.forEach(function(v){
        var title = v.title || '';
        var parts;
        // Multi-option: "Black / M" or "Color: Black / Size: M"
        if(title.indexOf(' / ') >= 0){
          parts = title.split(' / ').map(function(s){ return s.replace(/^[^:]+:\s*/, '').trim(); });
        } else {
          // Single option: "TG392 Black" or "Black"
          parts = [title.trim()];
        }
        variantParts.push({ parts: parts, available: v.available !== false, variant: v });
      });
    }

    // Check if an option value has ANY available variant (globally, ignoring other selections)
    function isValueGloballyAvailable(optionIndex, valueName){
      if(variantParts.length === 0) return true;
      for(var i=0;i<variantParts.length;i++){
        var vp = variantParts[i];
        if(!vp.available) continue;
        var part = vp.parts[optionIndex] || '';
        if(part === valueName || part.indexOf(valueName) >= 0 || valueName.indexOf(part) >= 0){
          return true;
        }
      }
      return false;
    }

    // Check if an option value is available GIVEN current selections in other options
    function isValueAvailableWithSelections(optionIndex, valueName){
      if(variantParts.length === 0) return true;
      // Get current selections for all OTHER options
      var otherSelections = {};
      if(container){
        container.querySelectorAll('.dhpdp-variants > div').forEach(function(group){
          var sel = group.querySelector('.dhpdp-opt-sel');
          if(sel){
            var oi = parseInt(sel.dataset.option);
            if(oi !== optionIndex){
              otherSelections[oi] = sel.dataset.valtitle || '';
            }
          }
        });
      }
      var hasOtherSelections = Object.keys(otherSelections).length > 0;
      if(!hasOtherSelections) return isValueGloballyAvailable(optionIndex, valueName);

      for(var i=0;i<variantParts.length;i++){
        var vp = variantParts[i];
        if(!vp.available) continue;
        var part = vp.parts[optionIndex] || '';
        var matchesThis = (part === valueName || part.indexOf(valueName) >= 0 || valueName.indexOf(part) >= 0);
        if(!matchesThis) continue;
        // Check if all other selections match
        var allMatch = true;
        for(var oi in otherSelections){
          var otherPart = vp.parts[parseInt(oi)] || '';
          var otherVal = otherSelections[oi];
          if(otherPart !== otherVal && otherPart.indexOf(otherVal) < 0 && otherVal.indexOf(otherPart) < 0){
            allMatch = false; break;
          }
        }
        if(allMatch) return true;
      }
      return false;
    }

    if(p.options&&p.options.length){
      html+='<div class="dhpdp-variants" style="margin-bottom:20px">';
      for(var oi=0;oi<p.options.length;oi++){
        var opt=p.options[oi];
        html+='<div style="margin-bottom:12px"><label style="font-size:14px;font-weight:600;color:#333;display:block;margin-bottom:6px">'+escHTML(opt.name)+': <span class="dhpdp-opt-label" data-option="'+oi+'" style="color:#e53e3e;font-weight:700"></span></label>';
        html+='<div style="display:flex;flex-wrap:wrap;gap:8px">';
        // Find first globally available index for pre-selection
        var firstAvailIdx = -1;
        for(var fi=0;fi<(opt.values||[]).length;fi++){
          if(isValueGloballyAvailable(oi, opt.values[fi].value)){ firstAvailIdx=fi; break; }
        }
        for(var vi=0;vi<(opt.values||[]).length;vi++){
          var val=opt.values[vi];
          var isAvail = isValueGloballyAvailable(oi, val.value);
          // Pre-select first AVAILABLE value (not first overall)
          var isSelected = isAvail && (val.selected || (firstAvailIdx === vi && !opt.values.some(function(v){return v.selected})));
          var sel=isSelected?' dhpdp-opt-sel':'';
          var unavailCls = !isAvail ? ' dhpdp-opt-unavail' : '';
          var unavailAttr = !isAvail ? ' data-unavailable="1" title="Sold Out"' : '';
          if(val.image){
            html+='<button class="dhpdp-opt'+sel+unavailCls+'"'+unavailAttr+' data-option="'+oi+'" data-value="'+vi+'" data-valtitle="'+escHTML(val.value)+'" style="width:40px;height:40px;border-radius:8px;border:2px solid '+(isSelected?'#e53e3e':'#ddd')+';padding:2px;cursor:'+(isAvail?'pointer':'not-allowed')+';background:#fff;'+(isAvail?'':'opacity:0.4;position:relative;')+'"><img src="'+escHTML(val.image)+'" style="width:100%;height:100%;object-fit:cover;border-radius:6px">'+(isAvail?'':'<span style="position:absolute;top:0;left:0;width:100%;height:100%;display:flex;align-items:center;justify-content:center;background:rgba(255,255,255,0.5)"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#999" stroke-width="2"><line x1="4" y1="4" x2="20" y2="20"/></svg></span>')+'</button>';
          }else{
            html+='<button class="dhpdp-opt'+sel+unavailCls+'"'+unavailAttr+' data-option="'+oi+'" data-value="'+vi+'" data-valtitle="'+escHTML(val.value)+'" style="padding:8px 16px;border-radius:8px;border:2px solid '+(isSelected?'#e53e3e':'#ddd')+';cursor:'+(isAvail?'pointer':'not-allowed')+';background:'+(isSelected?'#fef2f2':'#fff')+';font-size:13px;color:'+(isAvail?'#333':'#bbb')+';'+(isAvail?'':'opacity:0.4;text-decoration:line-through;')+'">'+escHTML(val.value)+'</button>';
          }
        }
        html+='</div></div>';
      }
      html+='</div>';
    }

    // Trust strip
    html+='<div style="display:flex;gap:16px;margin-bottom:20px;padding:12px 16px;background:#f8fafc;border-radius:8px;flex-wrap:wrap">';
    html+='<div style="display:flex;align-items:center;gap:6px;font-size:12px;color:#666"><svg width="16" height="16" fill="none" stroke="#22c55e" stroke-width="2" viewBox="0 0 24 24"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>Secure Checkout</div>';
    html+='<div style="display:flex;align-items:center;gap:6px;font-size:12px;color:#666"><svg width="16" height="16" fill="none" stroke="#3b82f6" stroke-width="2" viewBox="0 0 24 24"><path d="M20 12V8H6a2 2 0 01-2-2c0-1.1.9-2 2-2h12v4"/><path d="M4 6v12c0 1.1.9 2 2 2h14v-4"/><circle cx="18" cy="16" r="2"/></svg>Money-Back Guarantee</div>';
    html+='<div style="display:flex;align-items:center;gap:6px;font-size:12px;color:#666"><svg width="16" height="16" fill="none" stroke="#8b5cf6" stroke-width="2" viewBox="0 0 24 24"><rect x="1" y="3" width="15" height="13" rx="2"/><path d="M16 8h4l3 3v5h-7V8z"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/></svg>Fast Shipping</div>';
    html+='</div>';

    // CTA Buttons
    html+='<div style="display:flex;flex-direction:column;gap:10px;margin-bottom:20px">';
    html+='<button id="dhpdp-atc" style="width:100%;padding:16px;background:#e53e3e;color:#fff;border:none;border-radius:10px;font-size:16px;font-weight:700;cursor:pointer;transition:background 0.2s" onmouseover="this.style.background=\'#c53030\'" onmouseout="this.style.background=\'#e53e3e\'">Add to Cart</button>';
    html+='<button id="dhpdp-buy" style="width:100%;padding:16px;background:#1a1a1a;color:#fff;border:none;border-radius:10px;font-size:16px;font-weight:700;cursor:pointer;transition:background 0.2s" onmouseover="this.style.background=\'#333\'" onmouseout="this.style.background=\'#1a1a1a\'">Buy Now</button>';
    html+='</div>';

    // Shipping info
    var shipNote=p.shippingData&&p.shippingData.note?p.shippingData.note:'Standard Shipping';
    var delLabel=p.deliveryEstimate&&p.deliveryEstimate.label?p.deliveryEstimate.label:'5-10 business days';
    var retSummary='Returns accepted within 30 days';
    if(p.returnPolicy){
      if(typeof p.returnPolicy==='string')retSummary=p.returnPolicy;
      else if(p.returnPolicy.summary&&typeof p.returnPolicy.summary==='string')retSummary=p.returnPolicy.summary;
      else if(p.returnPolicy.window)retSummary='Returns accepted within '+p.returnPolicy.window+' days';
    }

    html+='<div style="border:1px solid #eee;border-radius:10px;overflow:hidden;margin-bottom:20px">';
    html+='<div style="padding:12px 16px;display:flex;align-items:center;gap:10px;border-bottom:1px solid #f0f0f0"><svg width="18" height="18" fill="none" stroke="#666" stroke-width="1.5" viewBox="0 0 24 24"><rect x="1" y="3" width="15" height="13" rx="2"/><path d="M16 8h4l3 3v5h-7V8z"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/></svg><div><div style="font-size:14px;font-weight:600;color:#333">'+escHTML(shipNote)+'</div><div style="font-size:12px;color:#888">Estimated delivery: '+escHTML(delLabel)+'</div></div></div>';
    html+='<div style="padding:12px 16px;display:flex;align-items:center;gap:10px"><svg width="18" height="18" fill="none" stroke="#666" stroke-width="1.5" viewBox="0 0 24 24"><path d="M3 12h18M3 12l6-6M3 12l6 6"/></svg><div><div style="font-size:14px;font-weight:600;color:#333">Easy Returns</div><div style="font-size:12px;color:#888">'+escHTML(retSummary)+'</div></div></div>';
    html+='</div>';

    html+='</div>'; // end info
    html+='</div>'; // end grid

    // Description / Features tabs + A+ images
    var desc=p.description||'';
    var bullets=p.bullets||[];
    var aplusImgs=p.aplusImages||p.descriptionImages||[];
    var hasDesc=desc||bullets.length||aplusImgs.length;
    if(hasDesc){
      html+='<div style="margin-top:40px;border-top:1px solid #eee;padding-top:32px">';
      html+='<div class="dhpdp-tabs" style="display:flex;gap:0;border-bottom:2px solid #eee;margin-bottom:20px">';
      if(desc||aplusImgs.length)html+='<button class="dhpdp-tab dhpdp-tab-active" data-tab="desc" style="padding:12px 24px;background:none;border:none;border-bottom:2px solid #e53e3e;margin-bottom:-2px;font-size:15px;font-weight:600;color:#e53e3e;cursor:pointer">Description</button>';
      if(bullets.length)html+='<button class="dhpdp-tab'+((desc||aplusImgs.length)?'':' dhpdp-tab-active')+'" data-tab="features" style="padding:12px 24px;background:none;border:none;border-bottom:2px solid '+((desc||aplusImgs.length)?'transparent':'#e53e3e')+';margin-bottom:-2px;font-size:15px;font-weight:600;color:'+((desc||aplusImgs.length)?'#888':'#e53e3e')+';cursor:pointer">Features</button>';
      html+='</div>';
      if(desc||aplusImgs.length){
        html+='<div id="dhpdp-tab-desc" class="dhpdp-tabcontent" style="font-size:15px;line-height:1.7;color:#444">';
        if(desc){
          // If description contains HTML tags, render as HTML (sanitized); otherwise escape
          var isHTML = /<[a-z][\s\S]*>/i.test(desc);
          if(isHTML){
            // Sanitize: strip <script>, <iframe>, <object>, <embed>, on* attributes
            var safeDesc = desc.replace(/<script[\s\S]*?<\/script>/gi,'')
              .replace(/<iframe[\s\S]*?<\/iframe>/gi,'')
              .replace(/<object[\s\S]*?<\/object>/gi,'')
              .replace(/<embed[^>]*>/gi,'')
              .replace(/\son\w+\s*=\s*["'][^"']*["']/gi,'')
              .replace(/\son\w+\s*=\s*[^\s>]*/gi,'');
            html+='<div class="dhpdp-desc-html" style="max-width:100%;overflow:hidden">'+safeDesc+'</div>';
          } else {
            html+=escHTML(desc).replace(/\n/g,'<br>');
          }
        }
        if(aplusImgs.length){
          html+='<div style="margin-top:20px">';
          for(var ai=0;ai<aplusImgs.length;ai++){
            html+='<img src="'+escHTML(aplusImgs[ai])+'" style="width:100%;height:auto;display:block;margin-bottom:8px;border-radius:4px" loading="lazy" alt="Product detail '+(ai+1)+'">';
          }
          html+='</div>';
        }
        html+='</div>';
      }
      if(bullets.length){
        html+='<div id="dhpdp-tab-features" class="dhpdp-tabcontent" style="'+((desc||aplusImgs.length)?'display:none':'')+'"><ul style="list-style:none;padding:0;margin:0">';
        for(var bi=0;bi<bullets.length;bi++){
          html+='<li style="padding:8px 0;border-bottom:1px solid #f5f5f5;font-size:14px;color:#444;display:flex;align-items:flex-start;gap:8px"><span style="color:#22c55e;font-weight:700;flex-shrink:0">&#10003;</span>'+escHTML(bullets[bi])+'</li>';
        }
        html+='</ul></div>';
      }
      html+='</div>';
    }

    // Mobile sticky CTA
    html+='<div id="dhpdp-sticky" style="display:none;position:fixed;bottom:0;left:0;right:0;background:#fff;padding:12px 16px;box-shadow:0 -2px 10px rgba(0,0,0,0.1);z-index:1000;border-top:1px solid #eee">';
    html+='<div style="max-width:600px;margin:0 auto;display:flex;gap:10px">';
    html+='<button class="dhpdp-sticky-atc" style="flex:1;padding:14px;background:#e53e3e;color:#fff;border:none;border-radius:10px;font-size:15px;font-weight:700;cursor:pointer">Add to Cart</button>';
    html+='<button class="dhpdp-sticky-buy" style="flex:1;padding:14px;background:#1a1a1a;color:#fff;border:none;border-radius:10px;font-size:15px;font-weight:700;cursor:pointer">Buy Now</button>';
    html+='</div></div>';

    html+='</div>'; // end dhpdp

    // Responsive CSS
    html+='<style>.dhpdp-grid{grid-template-columns:1fr 1fr;gap:40px}@media(max-width:768px){.dhpdp-grid{grid-template-columns:1fr!important;gap:20px!important}.dhpdp h1{font-size:20px!important}#dhpdp-sticky{display:flex!important}}</style>';

    container.innerHTML=html;
    bindEvents(p,imgs);
  }

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

    // Tab clicks
    var tabs=container.querySelectorAll('.dhpdp-tab');
    tabs.forEach(function(tab){
      tab.addEventListener('click',function(){
        tabs.forEach(function(t){t.style.borderBottomColor='transparent';t.style.color='#888';t.classList.remove('dhpdp-tab-active')});
        this.style.borderBottomColor='#e53e3e';this.style.color='#e53e3e';this.classList.add('dhpdp-tab-active');
        container.querySelectorAll('.dhpdp-tabcontent').forEach(function(c){c.style.display='none'});
        var target=document.getElementById('dhpdp-tab-'+this.dataset.tab);
        if(target)target.style.display='block';
      });
    });

    // Option clicks — FIX v1.1: Update image/price on variant change
    function findVariantBySelection(){
      var parts=[];
      container.querySelectorAll('.dhpdp-variants > div').forEach(function(group){
        var sel=group.querySelector('.dhpdp-opt-sel');
        if(sel){
          var optIdx=parseInt(sel.dataset.option);
          var valIdx=parseInt(sel.dataset.value);
          if(p.options&&p.options[optIdx]&&p.options[optIdx].values&&p.options[optIdx].values[valIdx]){
            parts.push(p.options[optIdx].values[valIdx]);
          }
        }
      });
      // Find matching variant
      if(parts.length>0 && p.variants && p.variants.length>0){
        var selectedTitle = parts.map(function(v){return v.value}).join(' / ');
        return p.variants.find(function(v){
          return v.title === selectedTitle ||
                 v.title === 'Option: ' + selectedTitle ||
                 v.title.indexOf(selectedTitle) >= 0;
        }) || null;
      }
      return null;
    }

    function updatePriceDisplay(variant){
      if(!variant) return;
      var vPrice = variant.price ? (typeof variant.price === 'number' ? variant.price : parseFloat(String(variant.price).replace(/[^0-9.]/g,''))) : 0;
      if(vPrice <= 0) return;
      // Find price element - look for the red price span
      var priceEls = container.querySelectorAll('span');
      for(var i=0;i<priceEls.length;i++){
        var s = priceEls[i].style;
        if(s.fontSize === '32px' && s.fontWeight === '700' && s.color){
          priceEls[i].textContent = '$' + vPrice.toFixed(2);
          break;
        }
      }
    }

    function updateMainImage(variant){
      if(!variant || !variant.image) return;
      var mainImg = document.getElementById('dhpdp-main-img');
      if(mainImg) mainImg.src = variant.image;
    }

    function updateOptionLabels(){
      container.querySelectorAll('.dhpdp-opt-label').forEach(function(label){
        var optIdx = label.dataset.option;
        var sel = container.querySelector('.dhpdp-opt-sel[data-option="'+optIdx+'"]');
        if(sel) label.textContent = sel.dataset.valtitle || '';
      });
    }

    // Initialize option labels and availability state for pre-selected variant
    updateOptionLabels();
    var initialVariant = findVariantBySelection();
    if(initialVariant) updatePriceDisplay(initialVariant);

    // FIX v1.3: Update stock status, buttons, and cross-option availability
    function updateAvailabilityUI(variant){
      var atcBtnEl = document.getElementById('dhpdp-atc');
      var buyBtnEl = document.getElementById('dhpdp-buy');
      var stickyAtcEl = container.querySelector('.dhpdp-sticky-atc');
      var stockEl = container.querySelector('.dhpdp-stock-status');
      var isAvail = !variant || variant.available !== false;
      if(stockEl){
        if(isAvail){
          stockEl.innerHTML = '<span style="width:8px;height:8px;border-radius:50%;background:#22c55e;display:inline-block"></span> <span style="font-size:14px;color:#16a34a">In Stock</span>';
        } else {
          stockEl.innerHTML = '<span style="width:8px;height:8px;border-radius:50%;background:#ef4444;display:inline-block"></span> <span style="font-size:14px;color:#ef4444">Sold Out</span>';
        }
      }
      [atcBtnEl, stickyAtcEl].forEach(function(b){
        if(!b) return;
        if(isAvail){
          b.disabled = false; b.style.opacity = '1'; b.style.cursor = 'pointer';
          b.textContent = 'Add to Cart'; b.style.background = '#e53e3e';
        } else {
          b.disabled = true; b.style.opacity = '0.5'; b.style.cursor = 'not-allowed';
          b.textContent = 'Sold Out'; b.style.background = '#999';
        }
      });
      if(buyBtnEl){
        if(isAvail){
          buyBtnEl.disabled = false; buyBtnEl.style.opacity = '1'; buyBtnEl.style.cursor = 'pointer';
          buyBtnEl.textContent = 'Buy Now'; buyBtnEl.style.background = '#1a1a1a';
        } else {
          buyBtnEl.disabled = true; buyBtnEl.style.opacity = '0.5'; buyBtnEl.style.cursor = 'not-allowed';
          buyBtnEl.textContent = 'Unavailable'; buyBtnEl.style.background = '#999';
        }
      }
    }

    // FIX v1.3: After selecting an option, update OTHER option groups to reflect cross-availability
    function refreshOptionAvailability(){
      if(!p.options || p.options.length <= 1) return; // Only needed for multi-option
      container.querySelectorAll('.dhpdp-variants > div').forEach(function(group){
        var btns = group.querySelectorAll('.dhpdp-opt');
        btns.forEach(function(btn){
          var oi = parseInt(btn.dataset.option);
          var vi = parseInt(btn.dataset.value);
          if(!p.options[oi] || !p.options[oi].values[vi]) return;
          var valName = p.options[oi].values[vi].value;
          var isSel = btn.classList.contains('dhpdp-opt-sel');
          var avail = isValueAvailableWithSelections(oi, valName);
          // Update visual state
          if(avail){
            btn.removeAttribute('data-unavailable');
            btn.removeAttribute('title');
            btn.classList.remove('dhpdp-opt-unavail');
            btn.style.opacity = '1';
            btn.style.cursor = 'pointer';
            if(!isSel){ btn.style.color = '#333'; btn.style.textDecoration = 'none'; }
          } else {
            btn.setAttribute('data-unavailable', '1');
            btn.setAttribute('title', 'Sold Out');
            btn.classList.add('dhpdp-opt-unavail');
            btn.style.opacity = '0.4';
            btn.style.cursor = 'not-allowed';
            if(!isSel){ btn.style.color = '#bbb'; btn.style.textDecoration = 'line-through'; }
          }
        });
      });
    }

    container.querySelectorAll('.dhpdp-opt').forEach(function(btn){
      btn.addEventListener('click',function(){
        // Block clicks on unavailable variants
        if(this.dataset.unavailable === '1') return;

        var optIdx=this.dataset.option;
        container.querySelectorAll('.dhpdp-opt[data-option="'+optIdx+'"]').forEach(function(b){
          b.style.borderColor='#ddd';
          if(b.dataset.unavailable !== '1') b.style.background='#fff';
          b.classList.remove('dhpdp-opt-sel');
        });
        this.style.borderColor='#e53e3e';this.style.background='#fef2f2';this.classList.add('dhpdp-opt-sel');

        // Update label, price, image and cross-option availability
        updateOptionLabels();
        refreshOptionAvailability(); // Update other option groups based on new selection
        var variant = findVariantBySelection();
        if(variant){
          updatePriceDisplay(variant);
          updateMainImage(variant);
          updateAvailabilityUI(variant);
        } else {
          // If no exact variant match (happens in multi-option when combo doesn't exist)
          updateAvailabilityUI({ available: false });
        }
        // Fallback image from clicked button
        if(!variant || !variant.image){
          var btnImg = this.querySelector('img');
          if(btnImg && btnImg.src){
            var mainImg = document.getElementById('dhpdp-main-img');
            if(mainImg) mainImg.src = btnImg.src;
          }
        }
      });
    });

    // FIX v1.2: Initialize availability state for pre-selected variant on page load
    if(initialVariant) updateAvailabilityUI(initialVariant);

    // Add to Cart — FIX v1.1: Improved retry logic with exponential backoff
    var atcBtn=document.getElementById('dhpdp-atc');
    var buyBtn=document.getElementById('dhpdp-buy');
    var stickyAtc=container.querySelector('.dhpdp-sticky-atc');
    var stickyBuy=container.querySelector('.dhpdp-sticky-buy');

    // Max retries and backoff delays (ms)
    var MAX_RETRIES = 3;
    var RETRY_DELAYS = [3000, 5000, 8000]; // escalating delays between retries
    var CART_ADD_DELAYS = [0, 2000, 3000, 5000]; // delay before cart/add.js (index = attempt number)

    // FIX v1.1: getSelectedVariant now returns the variant title as the backend expects it
    // The backend matches: mapping.variants.find(v => v.title === selectedVariantId)
    // Shopify variant titles are like "Option: Black" (format: "OptionName: Value")
    function getSelectedVariant(){
      var parts=[];
      container.querySelectorAll('.dhpdp-variants > div').forEach(function(group){
        var sel=group.querySelector('.dhpdp-opt-sel');
        if(sel){
          var optIdx=parseInt(sel.dataset.option);
          var valIdx=parseInt(sel.dataset.value);
          if(p.options&&p.options[optIdx]&&p.options[optIdx].values&&p.options[optIdx].values[valIdx]){
            parts.push(p.options[optIdx].values[valIdx].value);
          }
        }
      });
      if(parts.length === 0) return null;
      // Return the value in the format the backend expects for variant matching
      // Backend creates variants with title like "Option: Black" or "Black" or "S / Red"
      // Try to find exact variant match from product data
      var selectedTitle = parts.join(' / ');
      if(p.variants && p.variants.length > 0){
        var match = p.variants.find(function(v){
          return v.title === selectedTitle ||
                 v.title === 'Option: ' + selectedTitle ||
                 v.title.indexOf(selectedTitle) >= 0;
        });
        if(match) return match.title; // Return the exact variant title for backend matching
      }
      return selectedTitle;
    }

    function setAllBtns(text, bg, disabled, opacity){
      [atcBtn, stickyAtc].forEach(function(b){
        if(!b) return;
        b.textContent = text;
        if(bg) b.style.background = bg;
        b.disabled = disabled;
        b.style.opacity = opacity || '1';
      });
    }

    function doAddToCart(buyNow, retryAttempt){
      retryAttempt = retryAttempt || 0;

      // FIX v1.2: Block add to cart for unavailable variants
      var currentVariant = findVariantBySelection();
      if(currentVariant && currentVariant.available === false){
        alert('This variant is currently sold out. Please select a different option.');
        return;
      }

      var btn = buyNow ? buyBtn : atcBtn;
      var origText = btn.textContent;
      var origBg = buyNow ? '#1a1a1a' : '#e53e3e';

      if(retryAttempt === 0){
        btn.textContent = 'Processing...';
        btn.disabled = true;
        btn.style.opacity = '0.7';
      } else {
        btn.textContent = 'Syncing... (attempt ' + (retryAttempt + 1) + ')';
      }

      var variant = getSelectedVariant();
      var body = {source: store, sourceId: productId, quantity: 1};
      if(variant) body.selectedVariant = variant;
      if(retryAttempt > 0) body.forceResync = true;

      var savedVariantId = null;
      var isNewProduct = false;

      fetch(API + '/api/prepare-cart', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60000) // v1.3: 60s timeout (backend now waits up to 15s for propagation + inventory)
      })
      .then(function(r){
        if(!r.ok) throw new Error('Sync error (' + r.status + ')');
        return r.json();
      })
      .then(function(data){
        if(!data.shopifyVariantId) throw new Error(data.error || 'Sync failed — no variant ID');
        savedVariantId = data.shopifyVariantId;
        isNewProduct = !!data.isNewlyCreated;

        // Determine pre-cart-add delay
        // For newly created products, add extra delay even on first attempt
        var delay = CART_ADD_DELAYS[retryAttempt] || 0;
        if(isNewProduct && retryAttempt === 0) delay = Math.max(delay, 2000);

        var cartFetch = function(){
          return fetch('/cart/add.js', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({items: [{
              id: data.shopifyVariantId,
              quantity: 1,
              properties: {_source: store, _source_id: productId}
            }]})
          });
        };

        if(delay > 0){
          return new Promise(function(res){setTimeout(function(){res(cartFetch())}, delay)});
        }
        return cartFetch();
      })
      .then(function(r){
        if(!r.ok){
          return r.json().then(function(errData){
            // 422 = variant invalid/out of stock — retry with escalating backoff
            if(r.status === 422 && retryAttempt < MAX_RETRIES){
              var nextDelay = RETRY_DELAYS[retryAttempt] || 5000;
              console.warn('Cart 422 on attempt ' + (retryAttempt + 1) + ', retrying in ' + nextDelay + 'ms...');
              btn.textContent = 'Setting up product...';
              setTimeout(function(){doAddToCart(buyNow, retryAttempt + 1)}, nextDelay);
              return {_retrying: true};
            }
            throw new Error(errData.description || errData.message || 'Could not add to cart (' + r.status + ')');
          });
        }
        return r.json();
      })
      .then(function(result){
        if(result && result._retrying) return;
        // SUCCESS
        btn.textContent = '\u2713 Added!';
        btn.style.background = '#22c55e';
        btn.style.opacity = '1';

        // Also update sticky button
        if(!buyNow && stickyAtc){
          stickyAtc.textContent = '\u2713 Added!';
          stickyAtc.style.background = '#22c55e';
        }

        setTimeout(function(){
          btn.textContent = origText;
          btn.disabled = false;
          btn.style.opacity = '1';
          btn.style.background = origBg;
          if(!buyNow && stickyAtc){
            stickyAtc.textContent = 'Add to Cart';
            stickyAtc.style.background = '#e53e3e';
          }

          if(buyNow){
            // Use direct checkout URL with ONLY this variant — bypasses existing cart items
            window.location.href = '/cart/' + savedVariantId + ':1';
          } else {
            // Update cart count in header (includes #dh-cart-count from dealshub header)
            fetch('/cart.js').then(function(r){return r.json()}).then(function(cart){
              var countEls = document.querySelectorAll('#dh-cart-count,.cart-count,.cart-count-bubble,[data-cart-count],.header-cart-count');
              countEls.forEach(function(el){el.textContent = cart.item_count});
            }).catch(function(){});
          }
        }, buyNow ? 500 : 1800);
      })
      .catch(function(err){
        console.error('Add to cart error (attempt ' + (retryAttempt + 1) + '):', err);
        btn.textContent = 'Error — Try Again';
        btn.style.background = '#dc2626';
        btn.disabled = false;
        btn.style.opacity = '1';
        setTimeout(function(){
          btn.textContent = origText;
          btn.style.background = origBg;
        }, 4000);
      });
    }

    if(atcBtn) atcBtn.addEventListener('click', function(){doAddToCart(false)});
    if(buyBtn) buyBtn.addEventListener('click', function(){doAddToCart(true)});
    if(stickyAtc) stickyAtc.addEventListener('click', function(){doAddToCart(false)});
    if(stickyBuy) stickyBuy.addEventListener('click', function(){doAddToCart(true)});

    // Mobile sticky show/hide
    if(window.innerWidth <= 768){
      var stickyBar = document.getElementById('dhpdp-sticky');
      if(stickyBar){
        var observer = new IntersectionObserver(function(entries){
          stickyBar.style.display = entries[0].isIntersecting ? 'none' : 'block';
        }, {threshold: 0});
        if(atcBtn) observer.observe(atcBtn);
      }
    }
  }

  function renderStars(r){
    var s='';for(var i=1;i<=5;i++){if(i<=Math.floor(r))s+='\u2605';else if(i-r<1)s+='\u2605';else s+='\u2606'}return s;
  }

  function formatNumber(n){
    if(!n)return '0';
    n=parseInt(n);
    if(n>=1000000)return (n/1000000).toFixed(1)+'M';
    if(n>=1000)return (n/1000).toFixed(1)+'K';
    return String(n);
  }

  function addToRecentlyViewed(p){
    try{
      var key='dh_recent';
      var items=JSON.parse(localStorage.getItem(key)||'[]');
      items=items.filter(function(i){return i.id!==p.sourceId});
      items.unshift({id:p.sourceId,store:store,title:p.title,price:p.price,image:p.primaryImage||p.images&&p.images[0]||'',ts:Date.now()});
      if(items.length>12)items=items.slice(0,12);
      localStorage.setItem(key,JSON.stringify(items));
    }catch(e){}
  }
})();
