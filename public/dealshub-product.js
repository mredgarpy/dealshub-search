/* DealsHub PDP v1.0 — Self-contained Product Detail Page */
(function(){
'use strict';
var API='https://dealshub-search.onrender.com';
var container=document.getElementById('dealshub-pdp');
if(!container)return;

var params=new URLSearchParams(window.location.search);
var productId=params.get('id');
var store=params.get('store')||'amazon';
if(!productId){container.innerHTML='<div style="text-align:center;padding:60px 20px"><h2>Product Not Found</h2><p>No product ID specified.</p><a href="/" style="color:#e53e3e">Back to Home</a></div>';return}

// Show skeleton
container.innerHTML=skeletonHTML();

// Fetch product
fetch(API+'/api/product/'+encodeURIComponent(productId)+'?store='+encodeURIComponent(store),{signal:AbortSignal.timeout(20000)})
.then(function(r){if(!r.ok)throw new Error('HTTP '+r.status);return r.json()})
.then(function(data){
  var p=data;
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

