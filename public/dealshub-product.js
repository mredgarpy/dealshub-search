/* DealsHub PDP v2.0 — Self-contained Product Detail Page */
(function(){
  'use strict';
  var API='https://dealshub-search.onrender.com';
  var container=document.getElementById('dealshub-pdp');
  if(!container)return;

  var params=new URLSearchParams(window.location.search);
  var productId=params.get('id');
  var store=params.get('store')||'amazon';

  if(!productId){
    container.innerHTML='<div style="text-align:center;padding:60px 20px"><h2>Product Not Found</h2><p>No product ID specified.</p><a href="/" style="color:#e53e3e">Back to Home</a></div>';
    return;
  }

  container.innerHTML=skeletonHTML();

  fetch(API+'/api/product/'+encodeURIComponent(productId)+'?store='+encodeURIComponent(store),{signal:AbortSignal.timeout(25000)})
    .then(function(r){if(!r.ok)throw new Error('HTTP '+r.status);return r.json()})
    .then(function(data){
      var p=data;
      if(!p||!p.title){throw new Error('No product data')}
      renderProduct(p);
      addToRecentlyViewed(p);
    })
    .catch(function(err){
      console.error('PDP fetch error:',err);
      container.innerHTML='<div style="text-align:center;padding:60px 20px"><h2 style="color:#333;margin-bottom:12px">Unable to Load Product</h2><p style="color:#666">'+esc(err.message)+'</p><p style="margin-top:16px"><a href="/" style="color:#e53e3e;text-decoration:underline">Back to Home</a> &middot; <a href="javascript:location.reload()" style="color:#e53e3e;text-decoration:underline">Retry</a></p></div>';
    });

  /* ---- Helpers ---- */
  function esc(s){var d=document.createElement('div');d.textContent=s||'';return d.innerHTML}

  function skeletonHTML(){
    return '<div class="dhpdp-skel" style="max-width:1200px;margin:0 auto;padding:20px;display:grid;grid-template-columns:1fr 1fr;gap:40px">'
      +'<div style="aspect-ratio:1;background:#f0f0f0;border-radius:12px;animation:dhpulse 1.5s infinite"></div>'
      +'<div><div style="height:24px;background:#f0f0f0;border-radius:6px;width:60%;margin-bottom:16px;animation:dhpulse 1.5s infinite"></div>'
      +'<div style="height:36px;background:#f0f0f0;border-radius:6px;width:80%;margin-bottom:12px;animation:dhpulse 1.5s infinite"></div>'
      +'<div style="height:28px;background:#f0f0f0;border-radius:6px;width:40%;margin-bottom:24px;animation:dhpulse 1.5s infinite"></div>'
      +'<div style="height:48px;background:#f0f0f0;border-radius:6px;width:100%;margin-bottom:12px;animation:dhpulse 1.5s infinite"></div>'
      +'<div style="height:48px;background:#f0f0f0;border-radius:6px;width:100%;animation:dhpulse 1.5s infinite"></div></div></div>'
      +'<style>@keyframes dhpulse{0%,100%{opacity:1}50%{opacity:.5}}@media(max-width:768px){.dhpdp-skel{grid-template-columns:1fr!important}}</style>';
  }

  function stars(r){
    var full=Math.floor(r),half=r-full>=0.3?1:0,empty=5-full-half,h='';
    for(var i=0;i<full;i++) h+='<span style="color:#f59e0b">&#9733;</span>';
    if(half) h+='<span style="color:#f59e0b">&#9733;</span>';
    for(var j=0;j<empty;j++) h+='<span style="color:#ddd">&#9733;</span>';
    return h;
  }

  function fmtPrice(v){
    var n=typeof v==='number'?v:parseFloat(String(v||'0').replace(/[^0-9.]/g,''));
    return isNaN(n)?'0.00':n.toFixed(2);
  }

  function noImg(){
    return "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 400 400'%3E%3Crect fill='%23f5f5f5' width='400' height='400'/%3E%3Ctext x='200' y='200' text-anchor='middle' fill='%23ccc' font-size='18'%3ENo Image%3C/text%3E%3C/svg%3E";
  }

  /* ---- Main Render ---- */
  function renderProduct(p){
    var imgs=p.images&&p.images.length?p.images:(p.primaryImage?[p.primaryImage]:(p.image?[p.image]:[]));
    var mainImg=imgs[0]||noImg();
    var price=parseFloat(String(p.price||'0').replace(/[^0-9.]/g,''));
    var origPrice=parseFloat(String(p.originalPrice||'0').replace(/[^0-9.]/g,''));
    var discount=origPrice>price?Math.round((1-price/origPrice)*100):0;
    var rating=p.rating?parseFloat(p.rating):0;
    var reviews=p.reviews||p.reviewCount||0;

    var html='<div class="dhpdp" style="max-width:1200px;margin:0 auto;padding:20px">';

    /* Breadcrumbs */
    html+='<nav style="font-size:13px;color:#666;margin-bottom:16px">';
    html+='<a href="/" style="color:#666;text-decoration:none">Home</a>';
    if(p.category) html+=' <span style="margin:0 6px">/</span> <span>'+esc(p.category)+'</span>';
    html+=' <span style="margin:0 6px">/</span> <span style="color:#333">'+esc((p.title||'').substring(0,50))+(p.title&&p.title.length>50?'...':'')+'</span>';
    html+='</nav>';

    html+='<div class="dhpdp-grid" style="display:grid;grid-template-columns:1fr 1fr;gap:40px">';

    /* ===== LEFT: Gallery ===== */
    html+='<div class="dhpdp-gallery">';
    html+='<div style="position:relative;border-radius:12px;overflow:hidden;background:#fafafa;border:1px solid #eee">';
    if(p.badge) html+='<span style="position:absolute;top:12px;left:12px;background:#e53e3e;color:#fff;padding:4px 12px;border-radius:20px;font-size:12px;font-weight:600;z-index:2">'+esc(p.badge)+'</span>';
    if(discount>0) html+='<span style="position:absolute;top:12px;right:12px;background:#ff6b35;color:#fff;padding:4px 10px;border-radius:20px;font-size:12px;font-weight:600;z-index:2">-'+discount+'%</span>';
    html+='<img id="dhpdp-main-img" src="'+esc(mainImg)+'" alt="'+esc(p.title)+'" style="width:100%;aspect-ratio:1;object-fit:contain;display:block" onerror="this.src=\''+noImg()+'\'"></div>';

    /* Thumbnails */
    if(imgs.length>1){
      html+='<div style="display:flex;gap:8px;margin-top:12px;overflow-x:auto;padding-bottom:4px">';
      for(var ti=0;ti<Math.min(imgs.length,8);ti++){
        html+='<img src="'+esc(imgs[ti])+'" data-idx="'+ti+'" class="dhpdp-thumb" style="width:64px;height:64px;object-fit:contain;border-radius:8px;border:2px solid '+(ti===0?'#e53e3e':'#eee')+';cursor:pointer;background:#fafafa;flex-shrink:0" onerror="this.style.display=\'none\'">';
      }
      html+='</div>';
    }
    html+='</div>';

    /* ===== RIGHT: Info ===== */
    html+='<div class="dhpdp-info">';

    /* Brand */
    if(p.brand) html+='<p style="font-size:13px;color:#888;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px">'+esc(p.brand)+'</p>';

    /* Title */
    html+='<h1 style="font-size:22px;font-weight:700;color:#1a1a1a;line-height:1.3;margin:0 0 12px">'+esc(p.title)+'</h1>';

    /* Rating */
    if(rating>0){
      html+='<div style="display:flex;align-items:center;gap:8px;margin-bottom:12px">';
      html+='<span style="font-size:16px">'+stars(rating)+'</span>';
      html+='<span style="font-size:14px;color:#666">'+rating.toFixed(1)+'</span>';
      if(reviews) html+='<span style="font-size:13px;color:#888">('+Number(reviews).toLocaleString()+' reviews)</span>';
      html+='</div>';
    }

    /* Price */
    html+='<div style="display:flex;align-items:baseline;gap:12px;margin-bottom:16px;flex-wrap:wrap">';
    html+='<span style="font-size:28px;font-weight:700;color:#e53e3e">$'+fmtPrice(price)+'</span>';
    if(discount>0){
      html+='<span style="font-size:16px;color:#999;text-decoration:line-through">$'+fmtPrice(origPrice)+'</span>';
      html+='<span style="background:#fff3cd;color:#856404;padding:2px 8px;border-radius:4px;font-size:12px;font-weight:600">Save '+discount+'%</span>';
    }
    html+='</div>';

    /* Availability */
    var avail=p.availability||p.stockSignal||'In Stock';
    var availColor=avail.toLowerCase().indexOf('out')>=0?'#dc3545':'#28a745';
    html+='<p style="font-size:14px;color:'+availColor+';font-weight:600;margin-bottom:16px">'+esc(avail)+'</p>';

    /* Variants/Options */
    if(p.variants&&p.variants.length>1){
      html+='<div style="margin-bottom:16px">';
      html+='<label style="font-size:14px;font-weight:600;color:#333;display:block;margin-bottom:6px">Options</label>';
      html+='<select id="dhpdp-variant" style="width:100%;padding:10px 12px;border:1px solid #ddd;border-radius:8px;font-size:14px;background:#fff">';
      for(var vi=0;vi<p.variants.length;vi++){
        var v=p.variants[vi];
        html+='<option value="'+vi+'">'+esc(v.title||v.name||('Option '+(vi+1)))+(v.price?' - $'+fmtPrice(v.price):'')+'</option>';
      }
      html+='</select></div>';
    }
    if(p.options&&p.options.length&&!(p.variants&&p.variants.length>1)){
      for(var oi=0;oi<p.options.length;oi++){
        var opt=p.options[oi];
        if(opt.values&&opt.values.length>1){
          html+='<div style="margin-bottom:16px">';
          html+='<label style="font-size:14px;font-weight:600;color:#333;display:block;margin-bottom:6px">'+esc(opt.name||'Option')+'</label>';
          html+='<div style="display:flex;gap:8px;flex-wrap:wrap">';
          for(var ovi=0;ovi<opt.values.length;ovi++){
            html+='<button class="dhpdp-opt-btn" data-opt="'+oi+'" data-val="'+ovi+'" style="padding:8px 16px;border:2px solid '+(ovi===0?'#e53e3e':'#ddd')+';border-radius:8px;background:'+(ovi===0?'#fff5f5':'#fff')+';cursor:pointer;font-size:13px;color:#333">'+esc(opt.values[ovi])+'</button>';
          }
          html+='</div></div>';
        }
      }
    }

    /* Quantity */
    html+='<div style="display:flex;align-items:center;gap:12px;margin-bottom:16px">';
    html+='<label style="font-size:14px;font-weight:600;color:#333">Qty:</label>';
    html+='<div style="display:flex;border:1px solid #ddd;border-radius:8px;overflow:hidden">';
    html+='<button id="dhpdp-qty-minus" style="width:36px;height:36px;border:none;background:#f5f5f5;cursor:pointer;font-size:16px">-</button>';
    html+='<input id="dhpdp-qty" type="number" value="1" min="1" max="10" style="width:48px;height:36px;border:none;text-align:center;font-size:14px;-moz-appearance:textfield" onwheel="this.blur()">';
    html+='<button id="dhpdp-qty-plus" style="width:36px;height:36px;border:none;background:#f5f5f5;cursor:pointer;font-size:16px">+</button>';
    html+='</div></div>';

    /* CTA Buttons */
    html+='<div style="display:flex;flex-direction:column;gap:10px;margin-bottom:20px">';
    html+='<button id="dhpdp-atc" style="width:100%;padding:14px;background:#e53e3e;color:#fff;border:none;border-radius:10px;font-size:16px;font-weight:700;cursor:pointer;transition:background .2s" onmouseover="this.style.background=\'#c53030\'" onmouseout="this.style.background=\'#e53e3e\'">Add to Cart</button>';
    html+='<button id="dhpdp-buy" style="width:100%;padding:14px;background:#1a1a1a;color:#fff;border:none;border-radius:10px;font-size:16px;font-weight:700;cursor:pointer;transition:background .2s" onmouseover="this.style.background=\'#333\'" onmouseout="this.style.background=\'#1a1a1a\'">Buy Now</button>';
    html+='</div>';

    /* Trust Strip */
    html+='<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;padding:16px;background:#f8f9fa;border-radius:10px;margin-bottom:16px">';
    html+='<div style="display:flex;align-items:center;gap:8px;font-size:12px;color:#555"><span style="font-size:16px">&#128274;</span> Secure Checkout</div>';
    html+='<div style="display:flex;align-items:center;gap:8px;font-size:12px;color:#555"><span style="font-size:16px">&#128666;</span> Fast Shipping</div>';
    html+='<div style="display:flex;align-items:center;gap:8px;font-size:12px;color:#555"><span style="font-size:16px">&#128260;</span> Easy Returns</div>';
    html+='<div style="display:flex;align-items:center;gap:8px;font-size:12px;color:#555"><span style="font-size:16px">&#9989;</span> Quality Guaranteed</div>';
    html+='</div>';

    /* Shipping & Delivery */
    html+='<div style="border:1px solid #eee;border-radius:10px;padding:14px;margin-bottom:12px">';
    if(p.deliveryEstimate||p.delivery_min_days){
      var minD=p.delivery_min_days||5,maxD=p.delivery_max_days||12;
      html+='<p style="font-size:13px;color:#333;margin:0 0 6px"><strong>Estimated Delivery:</strong> '+minD+'-'+maxD+' business days</p>';
    } else {
      html+='<p style="font-size:13px;color:#333;margin:0 0 6px"><strong>Estimated Delivery:</strong> 5-12 business days</p>';
    }
    if(p.shippingData&&p.shippingData.cost){
      html+='<p style="font-size:13px;color:#666;margin:0">Shipping: $'+fmtPrice(p.shippingData.cost)+'</p>';
    } else {
      html+='<p style="font-size:13px;color:#28a745;margin:0;font-weight:600">Free Shipping</p>';
    }
    html+='</div>';

    /* Return Policy */
    html+='<div style="border:1px solid #eee;border-radius:10px;padding:14px;margin-bottom:12px">';
    var retWin=p.returnPolicy||p.return_window||'30-day';
    html+='<p style="font-size:13px;color:#333;margin:0"><strong>Returns:</strong> '+esc(retWin)+' return policy</p>';
    html+='</div>';

    html+='</div>'; /* end info */
    html+='</div>'; /* end grid */

    /* ===== Description / Features Tabs ===== */
    var desc=p.description||'';
    var bullets=p.bullets||p.features||[];
    if(desc||bullets.length){
      html+='<div style="margin-top:32px;border-top:1px solid #eee;padding-top:24px">';
      html+='<div style="display:flex;gap:0;border-bottom:2px solid #eee;margin-bottom:16px">';
      html+='<button class="dhpdp-tab active" data-tab="desc" style="padding:10px 20px;border:none;background:none;font-size:14px;font-weight:600;cursor:pointer;border-bottom:2px solid #e53e3e;margin-bottom:-2px;color:#e53e3e">Description</button>';
      if(bullets.length) html+='<button class="dhpdp-tab" data-tab="features" style="padding:10px 20px;border:none;background:none;font-size:14px;font-weight:600;cursor:pointer;color:#888;border-bottom:2px solid transparent;margin-bottom:-2px">Features</button>';
      html+='</div>';
      html+='<div id="dhpdp-tab-desc" style="font-size:14px;line-height:1.7;color:#444">'+formatDesc(desc)+'</div>';
      if(bullets.length){
        html+='<div id="dhpdp-tab-features" style="display:none;font-size:14px;line-height:1.7;color:#444"><ul style="padding-left:20px;margin:0">';
        for(var bi=0;bi<bullets.length;bi++) html+='<li style="margin-bottom:8px">'+esc(typeof bullets[bi]==='string'?bullets[bi]:bullets[bi].text||'')+'</li>';
        html+='</ul></div>';
      }
      html+='</div>';
    }

    html+='</div>'; /* end dhpdp */

    /* ===== Responsive CSS ===== */
    html+='<style>';
    html+='.dhpdp-grid{display:grid;grid-template-columns:1fr 1fr;gap:40px}';
    html+='@media(max-width:768px){.dhpdp-grid{grid-template-columns:1fr!important;gap:20px!important}.dhpdp h1{font-size:18px!important}}';
    html+='.dhpdp-thumb:hover{border-color:#e53e3e!important}';
    html+='.dhpdp-opt-btn:hover{border-color:#e53e3e!important;background:#fff5f5!important}';
    html+='#dhpdp-qty::-webkit-inner-spin-button,#dhpdp-qty::-webkit-outer-spin-button{-webkit-appearance:none;margin:0}';
    html+='</style>';

    /* Mobile sticky CTA */
    html+='<div id="dhpdp-sticky" style="display:none;position:fixed;bottom:0;left:0;right:0;background:#fff;padding:12px 16px;box-shadow:0 -2px 10px rgba(0,0,0,.1);z-index:999;border-top:1px solid #eee">';
    html+='<div style="max-width:600px;margin:0 auto;display:flex;gap:10px">';
    html+='<button class="dhpdp-sticky-atc" style="flex:1;padding:12px;background:#e53e3e;color:#fff;border:none;border-radius:8px;font-size:14px;font-weight:700;cursor:pointer">Add to Cart - $'+fmtPrice(price)+'</button>';
    html+='</div></div>';

    container.innerHTML=html;
    bindEvents(p,imgs);
  }

  function formatDesc(d){
    if(!d)return '<p style="color:#888">No description available.</p>';
    return '<p>'+esc(d).replace(/\n/g,'</p><p>')+'</p>';
  }

  /* ---- Event Binding ---- */
  function bindEvents(p,imgs){
    /* Thumbnails */
    var thumbs=container.querySelectorAll('.dhpdp-thumb');
    var mainImgEl=document.getElementById('dhpdp-main-img');
    thumbs.forEach(function(th){
      th.addEventListener('click',function(){
        var idx=parseInt(this.dataset.idx);
        if(mainImgEl&&imgs[idx]){
          mainImgEl.src=imgs[idx];
          thumbs.forEach(function(t){t.style.borderColor='#eee'});
          this.style.borderColor='#e53e3e';
        }
      });
    });

    /* Option buttons */
    var optBtns=container.querySelectorAll('.dhpdp-opt-btn');
    optBtns.forEach(function(btn){
      btn.addEventListener('click',function(){
        var group=this.dataset.opt;
        container.querySelectorAll('.dhpdp-opt-btn[data-opt="'+group+'"]').forEach(function(b){
          b.style.borderColor='#ddd';b.style.background='#fff';
        });
        this.style.borderColor='#e53e3e';this.style.background='#fff5f5';
      });
    });

    /* Quantity */
    var qtyInput=document.getElementById('dhpdp-qty');
    var qMinus=document.getElementById('dhpdp-qty-minus');
    var qPlus=document.getElementById('dhpdp-qty-plus');
    if(qMinus)qMinus.addEventListener('click',function(){var v=parseInt(qtyInput.value)||1;if(v>1)qtyInput.value=v-1;});
    if(qPlus)qPlus.addEventListener('click',function(){var v=parseInt(qtyInput.value)||1;if(v<10)qtyInput.value=v+1;});

    /* Tabs */
    var tabs=container.querySelectorAll('.dhpdp-tab');
    tabs.forEach(function(tab){
      tab.addEventListener('click',function(){
        tabs.forEach(function(t){t.style.borderBottomColor='transparent';t.style.color='#888';t.classList.remove('active')});
        this.style.borderBottomColor='#e53e3e';this.style.color='#e53e3e';this.classList.add('active');
        var target=this.dataset.tab;
        var descPanel=document.getElementById('dhpdp-tab-desc');
        var featPanel=document.getElementById('dhpdp-tab-features');
        if(descPanel)descPanel.style.display=target==='desc'?'block':'none';
        if(featPanel)featPanel.style.display=target==='features'?'block':'none';
      });
    });

    /* Add to Cart */
    var atcBtn=document.getElementById('dhpdp-atc');
    var buyBtn=document.getElementById('dhpdp-buy');
    var stickyAtc=container.querySelector('.dhpdp-sticky-atc');

    function handleAddToCart(goToCheckout){
      var qty=parseInt((document.getElementById('dhpdp-qty')||{}).value)||1;
      var btn=goToCheckout?buyBtn:atcBtn;
      var origText=btn.textContent;
      btn.textContent='Adding...';
      btn.disabled=true;
      btn.style.opacity='0.7';

      fetch(API+'/api/prepare-cart',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({
          source:store,
          sourceId:productId,
          quantity:qty,
          selectedVariant:getSelectedVariant(p)
        })
      })
      .then(function(r){if(!r.ok)throw new Error('Sync failed ('+r.status+')');return r.json()})
      .then(function(data){
        if(!data.shopifyVariantId)throw new Error('No variant ID returned');
        return fetch('/cart/add.js',{
          method:'POST',
          headers:{'Content-Type':'application/json'},
          body:JSON.stringify({
            items:[{
              id:data.shopifyVariantId,
              quantity:qty,
              properties:{
                '_source_store':store,
                '_source_id':productId,
                '_sync_version':data.syncVersion||'1'
              }
            }]
          })
        });
      })
      .then(function(r){
        if(!r.ok)throw new Error('Cart add failed ('+r.status+')');
        return r.json();
      })
      .then(function(){
        btn.textContent='Added!';
        btn.style.background='#28a745';
        setTimeout(function(){
          btn.textContent=origText;
          btn.style.background=goToCheckout?'#1a1a1a':'#e53e3e';
          btn.disabled=false;
          btn.style.opacity='1';
        },1500);
        if(goToCheckout){
          window.location.href='/checkout';
        } else {
          updateCartCount();
        }
      })
      .catch(function(err){
        console.error('Add to cart error:',err);
        btn.textContent='Error - Retry';
        btn.style.background='#dc3545';
        setTimeout(function(){
          btn.textContent=origText;
          btn.style.background=goToCheckout?'#1a1a1a':'#e53e3e';
          btn.disabled=false;
          btn.style.opacity='1';
        },2500);
      });
    }

    if(atcBtn)atcBtn.addEventListener('click',function(){handleAddToCart(false)});
    if(buyBtn)buyBtn.addEventListener('click',function(){handleAddToCart(true)});
    if(stickyAtc)stickyAtc.addEventListener('click',function(){handleAddToCart(false)});

    /* Mobile sticky CTA */
    var sticky=document.getElementById('dhpdp-sticky');
    if(sticky&&window.innerWidth<=768){
      sticky.style.display='block';
      document.body.style.paddingBottom='70px';
    }
    window.addEventListener('resize',function(){
      if(sticky){
        if(window.innerWidth<=768){sticky.style.display='block';document.body.style.paddingBottom='70px';}
        else{sticky.style.display='none';document.body.style.paddingBottom='';}
      }
    });
  }

  function getSelectedVariant(p){
    var sel=document.getElementById('dhpdp-variant');
    if(sel&&p.variants&&p.variants.length>1){
      var idx=parseInt(sel.value);
      return p.variants[idx]||null;
    }
    return null;
  }

  function updateCartCount(){
    fetch('/cart.js').then(function(r){return r.json()}).then(function(cart){
      var badges=document.querySelectorAll('.cart-count-badge, [data-cart-count]');
      badges.forEach(function(b){b.textContent=cart.item_count});
    }).catch(function(){});
  }

  function addToRecentlyViewed(p){
    try{
      var key='dhub_recently_viewed';
      var items=JSON.parse(localStorage.getItem(key)||'[]');
      var entry={id:productId,store:store,title:p.title,price:p.price,image:p.primaryImage||p.image||(p.images&&p.images[0])||'',rating:p.rating};
      items=items.filter(function(it){return it.id!==productId||it.store!==store});
      items.unshift(entry);
      if(items.length>20)items=items.slice(0,20);
      localStorage.setItem(key,JSON.stringify(items));
    }catch(e){}
  }

})();
