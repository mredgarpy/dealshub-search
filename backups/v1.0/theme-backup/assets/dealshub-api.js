/* DealsHub API v3 - Internal Links */
(function(){
'use strict';
var API='https://dealshub-search.onrender.com/api',CACHE_TTL=3e5,cache={};
function getCached(k){var e=cache[k];if(e&&Date.now()-e.ts<CACHE_TTL)return e.data;return null}
function setCache(k,d){cache[k]={data:d,ts:Date.now()}}
function apiFetch(ep,retries){
  retries=retries||3;var c=getCached(ep);if(c)return Promise.resolve(c);
  function attempt(i){return new Promise(function(ok,fail){
    var ctrl=new AbortController();var to=setTimeout(function(){ctrl.abort()},60000);
    fetch(API+ep,{signal:ctrl.signal}).then(function(r){clearTimeout(to);if(!r.ok)throw new Error('HTTP '+r.status);return r.json()})
    .then(function(d){setCache(ep,d);ok(d)}).catch(function(e){if(i<retries)setTimeout(function(){attempt(i+1).then(ok).catch(fail)},5e3*(i+1));else fail(e)});
  })}
  return attempt(0);
}
function dec(h){var t=document.createElement('textarea');t.innerHTML=h;return t.value}
function card(p,o){p.price=parseFloat(String(p.price).replace(/[^0-9.]/g,''))||0;p.originalPrice=p.originalPrice?parseFloat(String(p.originalPrice).replace(/[^0-9.]/g,'')):0;
  o=o||{};
  var dis=p.originalPrice&&p.originalPrice>p.price?Math.round((1-p.price/p.originalPrice)*100):0;
  var s=parseFloat(p.rating||0),f=Math.floor(s),hf=s%1>=.3,sh='';
  for(var i=0;i<5;i++){if(i<f)sh+='★';else if(i===f&&hf)sh+='☆';else sh+='☆'}
  var sc={amazon:'#ff9900',aliexpress:'#e62e04',sephora:'#000',shein:'#222',macys:'#e21a2c'};
  var col=sc[p.source]||'#666',ti=dec(p.title);
  var bdg=p.badge?'<span style="position:absolute;top:8px;left:8px;background:#e53e3e;color:#fff;font-size:11px;padding:2px 8px;border-radius:4px;font-weight:600;z-index:2">'+dec(p.badge)+'</span>':'';
  var src='<span style="position:absolute;top:8px;right:8px;background:'+col+';color:#fff;font-size:10px;padding:2px 8px;border-radius:4px;font-weight:700;text-transform:uppercase;z-index:2">'+(p.sourceName||p.source)+'</span>';
  var dsc=dis>0?'<span style="position:absolute;bottom:8px;left:8px;background:#e53e3e;color:#fff;font-size:12px;padding:2px 6px;border-radius:4px;font-weight:700;z-index:2">-'+dis+'%</span>':'';
  var fl=o.flash?'<span style="position:absolute;top:40px;left:8px;background:linear-gradient(135deg,#f59e0b,#e53e3e);color:#fff;font-size:11px;padding:2px 8px;border-radius:4px;font-weight:700;z-index:2">⚡ FLASH</span>':'';
  var pr=dis>0?'<span style="color:#e53e3e;font-weight:700;font-size:18px">$'+p.price.toFixed(2)+'</span> <span style="text-decoration:line-through;color:#999;font-size:13px">$'+p.originalPrice.toFixed(2)+'</span>':'<span style="color:#e53e3e;font-weight:700;font-size:18px">$'+p.price.toFixed(2)+'</span>';
  var rv=p.reviews?'('+Number(p.reviews).toLocaleString()+')':'';
  var href='/pages/product?id='+p.id+'&store='+p.source;
  var btn=o.flash?'⚡ Grab Deal':'🛒 View Deal';
  var bg=o.flash?'#e53e3e':'#1a1a2e';
  return '<div style="background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.08);transition:all .3s;position:relative" onmouseenter="this.style.transform=\'translateY(-4px)\';this.style.boxShadow=\'0 8px 24px rgba(0,0,0,.15)\'" onmouseleave="this.style.transform=\'none\';this.style.boxShadow=\'0 2px 8px rgba(0,0,0,.08)\'">'
    +'<a href="'+href+'" style="text-decoration:none;color:inherit">'
    +'<div style="position:relative;padding-top:100%;background:#f7f7f7;overflow:hidden">'
    +'<img src="'+p.image+'" alt="'+ti.replace(/"/g,'')+'" loading="lazy" style="position:absolute;top:0;left:0;width:100%;height:100%;object-fit:contain;transition:transform .3s" onerror="this.src=\'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 200 200%22%3E%3Crect fill=%22%23f0f0f0%22 width=%22200%22 height=%22200%22/%3E%3Ctext x=%22100%22 y=%22105%22 text-anchor=%22middle%22 fill=%22%23999%22 font-size=%2214%22%3ENo Image%3C/text%3E%3C/svg%3E\'">'
    +bdg+src+dsc+fl+'</div>'
    +'<div style="padding:12px"><h3 style="font-size:13px;font-weight:500;line-height:1.3;height:34px;overflow:hidden;margin:0 0 6px;color:#1a1a2e">'+ti.substring(0,65)+(ti.length>65?'...':'')+'</h3>'
    +'<div style="margin-bottom:4px;color:#f59e0b;font-size:13px">'+sh+' <span style="font-size:11px;color:#666">'+rv+'</span></div>'
    +'<div>'+pr+'</div></div></a>'
    +'<div style="padding:0 12px 12px"><a href="'+href+'" style="display:block;text-align:center;background:'+bg+';color:#fff;padding:10px;border-radius:8px;font-size:13px;font-weight:600;text-decoration:none;transition:opacity .2s" onmouseenter="this.style.opacity=\'0.85\'" onmouseleave="this.style.opacity=\'1\'">'+btn+'</a></div></div>';
}
function grid(prods,id,o){var c=document.getElementById(id);if(c)c.innerHTML=prods.map(function(p){return card(p,o)}).join('')}
function loading(id,n){n=n||4;var c=document.getElementById(id);if(!c)return;var h='';for(var i=0;i<n;i++)h+='<div style="background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.08)"><div style="padding-top:100%;background:linear-gradient(90deg,#f0f0f0 25%,#e0e0e0 50%,#f0f0f0 75%);background-size:200%;animation:shimmer 1.5s infinite"></div><div style="padding:12px"><div style="height:14px;background:#f0f0f0;border-radius:4px;margin-bottom:8px;width:80%"></div><div style="height:14px;background:#f0f0f0;border-radius:4px;width:50%"></div></div></div>';c.innerHTML=h}
function error(id,msg){var c=document.getElementById(id);if(c)c.innerHTML='<div style="grid-column:1/-1;text-align:center;padding:40px;color:#666"><p style="font-size:16px;margin-bottom:8px">😞 '+msg+'</p><button onclick="location.reload()" style="background:#e53e3e;color:#fff;border:none;padding:8px 20px;border-radius:8px;cursor:pointer">Try Again</button></div>'}
window.DealsHub={
  search:function(q,s,l){return apiFetch('/search?q='+encodeURIComponent(q)+'&store='+(s||'all')+'&limit='+(l||48))},
  trending:function(){return apiFetch('/trending')},
  bestsellers:function(){return apiFetch('/bestsellers')},
  buildGrid:grid,buildProductCard:card,showLoading:loading,showError:error,
  loadSection:function(ep,id,o){o=o||{};loading(id,o.count||8);apiFetch(ep).then(function(d){var p=d.results||[];if(!p.length)error(id,'No products found');else grid(p.slice(0,o.count||12),id,o)}).catch(function(){error(id,'Loading error. The server may be waking up...')})},
  searchAndDisplay:function(q,id,s,l){loading(id,8);apiFetch('/search?q='+encodeURIComponent(q)+'&store='+(s||'all')+'&limit='+(l||48)).then(function(d){var p=d.results||[];if(!p.length)error(id,'No results found for "'+q+'"');else{grid(p,id);var c=document.getElementById(id+'-count');if(c)c.textContent=p.length+' results for "'+q+'"'}}).catch(function(){error(id,'Search error. Please try again.')})}
};
})();