/* DealsHub Cart v2.5 — Grouped by Store + Real Shipping + Plus Integration
   Features:
   - Groups cart items by source store
   - Shows shipping cost per store group (from /api/shipping)
   - Threshold hints (e.g., "Add $X more for FREE shipping")
   - StyleHub Plus: FREE shipping when member, upsell when not
   - Quantity controls
   - Remove items
   - Mobile responsive
*/
(function(){
  'use strict';
  var API='https://dealshub-search.onrender.com';
  var container=document.getElementById('dealshub-cart');
  if(!container)return;

  var cartData=null;
  var shippingByStore={};
  var zip=localStorage.getItem('stylehub_zip')||'';
  var isPlus=localStorage.getItem('stylehub_plus')==='true';

  init();

  function init(){
    container.innerHTML=cartSkeleton();
    fetch('/cart.js',{headers:{'Accept':'application/json'}})
      .then(function(r){return r.json()})
      .then(function(data){
        cartData=data;
        if(!data.items||data.items.length===0){
          renderEmpty();
          return;
        }
        renderCart(data);
        fetchShippingForStores(data.items);
      })
      .catch(function(err){
        console.error('Cart fetch error:',err);
        container.innerHTML='<div style="text-align:center;padding:60px 20px"><h2>Unable to load cart</h2><p>Please try refreshing the page.</p></div>';
      });
  }

  function getSource(item){
    var props=item.properties||{};
    // Subscription / digital products (no shipping) get their own group
    if(!item.requires_shipping&&item.product_type==='subscription') return '_subscription';
    return props._source||props._source_store||'unknown';
  }

  function getSourceId(item){
    var props=item.properties||{};
    return props._source_id||'';
  }

  function groupByStore(items){
    var groups={};
    items.forEach(function(item){
      var src=getSource(item);
      if(!groups[src])groups[src]=[];
      groups[src].push(item);
    });
    return groups;
  }

  function storeLabel(src){
    var map={amazon:'Amazon',aliexpress:'AliExpress',shein:'SHEIN',macys:"Macy's",sephora:'Sephora',_subscription:'Subscriptions',unknown:'StyleHub'};
    return map[src]||src.charAt(0).toUpperCase()+src.slice(1);
  }

  function fetchShippingForStores(items){
    var groups=groupByStore(items);
    var stores=Object.keys(groups);
    // Skip shipping fetch for subscription/digital groups
    stores.forEach(function(src){
      if(src==='_subscription'){
        shippingByStore[src]={shipping:{cost:0,isFree:true,isDigital:true,label:'No shipping required'},delivery:{label:'Digital product'}};
      }
    });
    stores=stores.filter(function(src){return src!=='_subscription'});
    var promises=stores.map(function(src){
      // Calculate total source price per store for threshold logic
      var storeTotal=groups[src].reduce(function(sum,item){
        return sum+(item.price/100)*item.quantity;
      },0);
      // Use first item's source_id as productId for shipping lookup
      var firstItem=groups[src][0];
      var productId=getSourceId(firstItem)||'';
      var url=API+'/api/shipping?store='+encodeURIComponent(src)+'&price='+storeTotal.toFixed(2)+'&mode=rules';
      if(productId)url+='&productId='+encodeURIComponent(productId);
      if(zip)url+='&zip='+encodeURIComponent(zip);
      if(isPlus)url+='&plus=true';
      return fetch(url,{signal:AbortSignal.timeout(15000)})
        .then(function(r){return r.json()})
        .then(function(d){if(!d.error)shippingByStore[src]=d;else shippingByStore[src]=null;})
        .catch(function(){shippingByStore[src]=null;});
    });
    Promise.all(promises).then(function(){updateShippingUI();});
  }

  function renderEmpty(){
    container.innerHTML='<div class="dh-cart-empty">'+
      '<div class="dh-cart-empty-icon">🛒</div>'+
      '<h2>Your cart is empty</h2>'+
      '<p>Looks like you haven\'t added anything to your cart yet.</p>'+
      '<a href="/" class="dh-cart-continue">Continue Shopping</a>'+
    '</div>';
  }

  function renderCart(data){
    var groups=groupByStore(data.items);
    var storeKeys=Object.keys(groups);
    var totalItems=data.item_count;
    var storeCount=storeKeys.length;

    var html='<div class="dh-cart-header">'+
      '<h1>Shopping Cart <span class="dh-cart-header-count">('+totalItems+' item'+(totalItems!==1?'s':'')+' from '+storeCount+' store'+(storeCount!==1?'s':'')+')</span></h1>';
    // ZIP location bar
    html+='<div class="dh-cart-location" id="dh-cart-location">';
    if(zip){
      html+='<span>📍 Delivering to <strong>'+escHTML(zip)+'</strong></span> <a href="#" onclick="document.getElementById(\'dh-cart-zip-input\').style.display=\'inline-flex\';this.style.display=\'none\';return false" class="dh-cart-change-zip">Change</a>';
      html+='<span id="dh-cart-zip-input" style="display:none;margin-left:8px"><input type="text" id="dh-cart-zip-field" placeholder="ZIP code" maxlength="5" value="'+escHTML(zip)+'" style="width:80px;padding:4px 8px;border:1px solid #ddd;border-radius:4px;font-size:13px"> <button onclick="saveZip()" style="padding:4px 10px;background:#2d3748;color:#fff;border:none;border-radius:4px;font-size:12px;cursor:pointer">Update</button></span>';
    } else {
      html+='<span>📍 Enter your ZIP for shipping estimates</span> ';
      html+='<input type="text" id="dh-cart-zip-field" placeholder="ZIP code" maxlength="5" style="width:80px;padding:4px 8px;border:1px solid #ddd;border-radius:4px;font-size:13px"> <button onclick="saveZip()" style="padding:4px 10px;background:#2d3748;color:#fff;border:none;border-radius:4px;font-size:12px;cursor:pointer">Check</button>';
    }
    html+='</div></div>';

    // Store groups
    html+='<div class="dh-cart-body"><div class="dh-cart-items">';
    storeKeys.forEach(function(src){
      var items=groups[src];
      html+='<div class="dh-cart-store-group" data-store="'+escHTML(src)+'">';
      var storeName=storeLabel(src);
      var storeIcon=src==='_subscription'?'⚡ ':'';
      html+='<div class="dh-cart-store-header"><span class="dh-cart-store-name">'+storeIcon+storeName+'</span> <span class="dh-cart-store-count">('+items.length+' item'+(items.length!==1?'s':'')+')</span></div>';
      // Items
      items.forEach(function(item){
        html+=renderCartItem(item,src);
      });
      // Shipping row per store (placeholder updated later)
      html+='<div class="dh-cart-store-shipping" id="dh-ship-'+escHTML(src)+'">'+
        '<span class="dh-ship-loading">Calculating shipping...</span>'+
      '</div>';
      html+='</div>'; // store-group
    });
    html+='</div>'; // cart-items

    // Summary sidebar
    html+='<div class="dh-cart-summary">'+
      '<h3>Order Summary</h3>'+
      '<div class="dh-cart-summary-row"><span>Subtotal ('+totalItems+' item'+(totalItems!==1?'s':'')+')</span><span>'+formatMoney(data.total_price)+'</span></div>'+
      '<div class="dh-cart-summary-row" id="dh-cart-shipping-total"><span>Shipping</span><span class="dh-ship-loading">Calculating...</span></div>'+
      '<div class="dh-cart-summary-divider"></div>'+
      '<div class="dh-cart-summary-row dh-cart-total" id="dh-cart-total"><span>Estimated Total</span><span>'+formatMoney(data.total_price)+'</span></div>'+
      '<div id="dh-cart-plus-upsell"></div>'+
      '<a href="/checkout" class="dh-cart-checkout-btn">Proceed to Checkout</a>'+
      '<a href="/" class="dh-cart-continue-link">← Continue Shopping</a>'+
    '</div>';

    html+='</div>'; // cart-body
    container.innerHTML=html;
  }

  function renderCartItem(item,src){
    var img=item.image||item.featured_image?.url||'';
    var title=item.product_title||item.title||'';
    var variant=item.variant_title&&item.variant_title!=='Default Title'?item.variant_title:'';
    var price=item.price;
    var origPrice=item.original_price&&item.original_price>item.price?item.original_price:0;
    var qty=item.quantity;
    var key=item.key;

    var html='<div class="dh-cart-item" data-key="'+escHTML(key)+'">';
    html+='<div class="dh-cart-item-img"><img src="'+escHTML(img)+'" alt="'+escHTML(title)+'" loading="lazy"></div>';
    html+='<div class="dh-cart-item-info">';
    html+='<div class="dh-cart-item-title">'+escHTML(title)+'</div>';
    if(variant)html+='<div class="dh-cart-item-variant">'+escHTML(variant)+'</div>';
    html+='<div class="dh-cart-item-price">';
    html+='<span class="dh-cart-item-current">'+formatMoney(price)+'</span>';
    if(origPrice)html+=' <span class="dh-cart-item-orig">'+formatMoney(origPrice)+'</span>';
    html+='</div>';
    html+='<div class="dh-cart-item-qty">';
    html+='<button class="dh-qty-btn" onclick="updateQty(\''+escHTML(key)+'\',-1)">−</button>';
    html+='<span class="dh-qty-val">'+qty+'</span>';
    html+='<button class="dh-qty-btn" onclick="updateQty(\''+escHTML(key)+'\',1)">+</button>';
    html+='<a href="#" class="dh-cart-remove" onclick="removeItem(\''+escHTML(key)+'\');return false">Remove</a>';
    html+='</div>';
    html+='</div></div>';
    return html;
  }

  function updateShippingUI(){
    var totalShipping=0;
    var totalPlusSaves=0;
    var storeKeys=Object.keys(shippingByStore);

    storeKeys.forEach(function(src){
      var el=document.getElementById('dh-ship-'+src);
      if(!el)return;
      var d=shippingByStore[src];
      if(!d){
        el.innerHTML='<span style="color:#999">Shipping info unavailable</span>';
        return;
      }
      // API returns nested: d.shipping.cost, d.delivery, d.plusSaves etc.
      var ship=d.shipping||d;
      var cost=ship.cost||0;
      var isFree=ship.isFree||cost===0;
      var method=ship.method||'';
      var label=ship.label||'';
      var delivery=d.delivery||{};
      var shipIsPlus=ship.isPlus||false;
      totalShipping+=cost;
      if(!isPlus)totalPlusSaves+=(d.plusSaves||0);

      var html='<div class="dh-ship-row">';
      html+='<span class="dh-ship-icon">🚚</span> ';
      if(shipIsPlus){
        // Plus member: always FREE with Plus badge
        html+='<strong style="color:#6b46c1">FREE Shipping</strong> · <span style="color:#6b46c1;font-weight:600">⚡ Plus</span>';
      } else if(isFree){
        html+='<strong style="color:#38a169">FREE Shipping</strong>';
        if(method)html+=' · '+escHTML(method);
      } else {
        if(ship.isDigital){
        html+='<strong style="color:#6b46c1">No shipping required</strong> · <span style="color:#718096">Digital subscription</span>';
      } else {
        html+='<strong>Shipping '+escHTML(label||'$'+cost.toFixed(2))+'</strong>';
        if(method)html+=' · '+escHTML(method);
      }
      }
      var dLabel=delivery.formattedRange||delivery.label||'';
      if(dLabel)html+=' · <span style="color:#2b6cb0">'+escHTML(dLabel)+'</span>';
      html+='</div>';

      // Threshold hint (only for non-Plus)
      if(!isPlus&&d.remaining&&d.remaining>0&&d.thresholdNote){
        html+='<div class="dh-ship-threshold">💡 Add $'+d.remaining.toFixed(2)+' more from '+storeLabel(src)+' for FREE shipping</div>';
      }

      // Plus upsell per store (only for non-Plus members with shipping cost)
      if(!isPlus&&cost>0){
        html+='<div class="dh-ship-plus">⚡ <strong style="color:#6b46c1">FREE</strong> with StyleHub Plus</div>';
      }

      el.innerHTML=html;
    });

    // Update shipping total in summary
    var shipTotalEl=document.getElementById('dh-cart-shipping-total');
    if(shipTotalEl){
      if(totalShipping===0){
        var freeLabel=isPlus?'<span style="color:#6b46c1;font-weight:700">FREE ⚡ Plus</span>':'<span style="color:#38a169;font-weight:700">FREE</span>';
        shipTotalEl.innerHTML='<span>Shipping</span>'+freeLabel;
      } else {
        shipTotalEl.innerHTML='<span>Shipping</span><span>'+formatMoney(totalShipping*100)+'</span>';
      }
    }

    // Update total
    var totalEl=document.getElementById('dh-cart-total');
    if(totalEl&&cartData){
      var grandTotal=cartData.total_price+(totalShipping*100);
      totalEl.innerHTML='<span>Estimated Total</span><span>'+formatMoney(grandTotal)+'</span>';
    }

    // Plus badge in cart header (if Plus member)
    if(isPlus){
      var header=document.querySelector('.dh-cart-header h1');
      if(header&&!header.querySelector('.dh-plus-badge')){
        header.insertAdjacentHTML('beforeend',' <span class="dh-plus-badge" style="display:inline-block;background:linear-gradient(90deg,#6b46c1,#805ad5);color:#fff;font-size:12px;font-weight:700;padding:3px 10px;border-radius:20px;vertical-align:middle">⚡ PLUS</span>');
      }
    }

    // Plus upsell banner (only for non-Plus members)
    var plusEl=document.getElementById('dh-cart-plus-upsell');
    if(plusEl){
      if(!isPlus&&totalPlusSaves>0){
        plusEl.innerHTML='<div class="dh-cart-plus-banner">'+
          '<div class="dh-plus-title">⚡ Save $'+totalPlusSaves.toFixed(2)+' on shipping this order</div>'+
          '<div class="dh-plus-body">Try StyleHub Plus FREE for 7 days<br><span style="color:#999;font-size:12px">Then $7.99/mo · Cancel anytime</span></div>'+
          '<a href="/pages/plus" class="dh-plus-cta">Start free trial →</a>'+
        '</div>';
      } else if(isPlus){
        plusEl.innerHTML='<div class="dh-cart-plus-member" style="background:linear-gradient(135deg,#f5f3ff,#ede9fe);border:1px solid #c4b5fd;border-radius:12px;padding:16px;text-align:center;margin-top:16px">'+
          '<div style="font-size:15px;font-weight:700;color:#6b46c1">⚡ StyleHub Plus Member</div>'+
          '<div style="font-size:13px;color:#718096;margin-top:4px">FREE shipping on all orders · 60-day returns</div>'+
        '</div>';
      }
    }
  }

  // Global functions for onclick handlers
  window.updateQty=function(key,delta){
    var items=cartData?.items||[];
    var item=items.find(function(i){return i.key===key});
    if(!item)return;
    var newQty=Math.max(0,item.quantity+delta);
    fetch('/cart/change.js',{
      method:'POST',
      headers:{'Content-Type':'application/json','Accept':'application/json'},
      body:JSON.stringify({id:key,quantity:newQty})
    }).then(function(r){return r.json()}).then(function(){init()});
  };

  window.removeItem=function(key){
    fetch('/cart/change.js',{
      method:'POST',
      headers:{'Content-Type':'application/json','Accept':'application/json'},
      body:JSON.stringify({id:key,quantity:0})
    }).then(function(r){return r.json()}).then(function(){
      init();
      // Update header cart count
      var badge=document.getElementById('dh-cart-count');
      if(badge)fetch('/cart.js').then(function(r){return r.json()}).then(function(d){badge.textContent=d.item_count});
    });
  };

  window.saveZip=function(){
    var field=document.getElementById('dh-cart-zip-field');
    if(!field)return;
    var v=field.value.trim();
    if(v&&/^\d{5}$/.test(v)){
      localStorage.setItem('stylehub_zip',v);
      zip=v;
      init();
    }
  };

  function formatMoney(cents){
    return '$'+(cents/100).toFixed(2);
  }

  function escHTML(s){var d=document.createElement('div');d.textContent=s||'';return d.innerHTML}

  function cartSkeleton(){
    return '<div style="max-width:1200px;margin:0 auto;padding:40px 20px">'+
      '<div style="height:32px;width:250px;background:#f0f0f0;border-radius:6px;margin-bottom:30px"></div>'+
      '<div style="display:flex;gap:30px;flex-wrap:wrap">'+
        '<div style="flex:1;min-width:300px">'+
          '<div style="height:120px;background:#f0f0f0;border-radius:8px;margin-bottom:16px"></div>'+
          '<div style="height:120px;background:#f0f0f0;border-radius:8px;margin-bottom:16px"></div>'+
        '</div>'+
        '<div style="width:340px">'+
          '<div style="height:280px;background:#f0f0f0;border-radius:8px"></div>'+
        '</div>'+
      '</div></div>';
  }
})();
