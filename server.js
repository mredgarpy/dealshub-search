const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const app = express();
app.use(cors());
app.use(express.json());

const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY;
const MARKUP_PERCENT = parseFloat(process.env.MARKUP_PERCENT || '12');
const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const SHOPIFY_ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;
const SHOPIFY_CLIENT_ID = '5bcd017d59287f7c9d7ab012b67d4e5b';
const SHOPIFY_CLIENT_SECRET_RAW = process.env.SHOPIFY_CLIENT_SECRET_RAW || '';
const SHOPIFY_CLIENT_SECRET = SHOPIFY_CLIENT_SECRET_RAW.replace(/^shpss_/, '');

// âââ HELPERS ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
const markup = () => 1 + (MARKUP_PERCENT / 100);

const rapidHeaders = (host) => ({
  'x-rapidapi-key': RAPIDAPI_KEY,
  'x-rapidapi-host': host
});

async function searchAmazon(q, limit = 8) {
  try {
    const r = await fetch(
      `https://real-time-amazon-data.p.rapidapi.com/search?query=${encodeURIComponent(q)}&page=1&country=US&sort_by=RELEVANCE`,
      { headers: rapidHeaders('real-time-amazon-data.p.rapidapi.com') }
    );
    const d = await r.json();
    return (d.data?.products || []).slice(0, limit).map(p => ({
      id: p.asin || Math.random().toString(36).slice(2),
      title: p.product_title || 'Amazon Product',
      price: p.product_price ? +(parseFloat(p.product_price.replace(/[^0-9.]/g,'')) * markup()).toFixed(2) : null,
      originalPrice: p.product_price ? parseFloat(p.product_price.replace(/[^0-9.]/g,'')) : null,
      image: p.product_photo || '',
      url: p.product_url || '',
      rating: p.product_star_rating || null,
      reviews: p.product_num_ratings || 0,
      badge: p.is_best_seller ? 'Best Seller' : (p.is_amazon_choice ? 'Amazon\'s Choice' : null),
      source: 'amazon',
      sourceName: 'Amazon'
    })).filter(p => p.price && p.image);
  } catch(e) { console.error('Amazon search error:', e.message); return []; }
}

async function searchShein(query, limit = 20) {
  try {
    const encoded = encodeURIComponent(query);
    const url = 'https://us.shein.com/api/productList/search/v2?keywords=' + encoded + '&limit=' + limit + '&page=1&sort=0&currency=USD&lang=en&country=US&adp=1';
    const resp = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://us.shein.com/search?q=' + encoded,
        'Origin': 'https://us.shein.com',
        'sec-fetch-dest': 'empty',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'same-origin'
      },
      timeout: 12000
    });
    const d = resp.data || {};
    const info = d.info || d.data || {};
    const products = info.products || info.goods || d.products || d.goods || [];
    return products.slice(0, limit).map(p => ({
      title: p.goods_name || p.name || '',
      price: (p.retailPrice && p.retailPrice.amount) ? '$' + p.retailPrice.amount
           : (p.salePrice && p.salePrice.amount) ? '$' + p.salePrice.amount : '',
      image: p.goods_img ? (p.goods_img.startsWith('//') ? 'https:' + p.goods_img : p.goods_img) : '',
      url: 'https://us.shein.com/' + (p.goods_url_name || 'product') + '-p-' + (p.goods_id || '') + '.html',
      store: 'SHEIN'
    }));
  } catch (e) {
    console.error('SHEIN error:', e.message, e.response && e.response.status);
    return [];
  }
}

async function searchAliexpress(q, limit = 8) {
  try {
    const r = await fetch(
      `https://aliexpress-data.p.rapidapi.com/product/search?query=${encodeURIComponent(q)}&page=1`,
      { headers: rapidHeaders('aliexpress-data.p.rapidapi.com') }
    );
    const d = await r.json();
    const items = (d.data?.content || []).filter(p => p.productId).slice(0, limit);
    return items.map(p => {
      const orig = p.prices?.originalPrice?.minPrice || p.prices?.salePrice?.minPrice || 0;
      const sale = p.prices?.salePrice?.minPrice || orig;
      return {
        id: p.productId,
        title: (typeof p.title === 'object' ? (p.title?.displayTitle || p.title?.seoTitle) : p.title) || 'AliExpress Product',
        price: sale > 0 ? +(sale * markup()).toFixed(2) : null,
        originalPrice: orig || null,
        image: p.image?.imgUrl ? 'https:' + p.image.imgUrl : '',
        url: `https://www.aliexpress.com/item/${p.productId}.html`,
        rating: p.evaluation?.starRating || null,
        reviews: p.trade?.realTradeCount || 0,
        badge: null,
        source: 'aliexpress',
        storeName: 'AliExpress'
      };
    }).filter(p => p.price && p.image);
  } catch(e) { console.error('AliExpress search error:', e.message); return []; }
}

async function searchSephora(q, limit = 6) {
  try {
    const r = await fetch(
      `https://sephora.p.rapidapi.com/us/products/v2/search?q=${encodeURIComponent(q)}&pageIndex=0&pageSize=${limit}`,
      { headers: rapidHeaders('sephora.p.rapidapi.com') }
    );
    const d = await r.json();
    const items = d.products || [];
    return items.slice(0, limit).map(p => {
      const priceStr = p.currentSku?.listPrice || '';
      const orig = parseFloat(priceStr.replace(/[^0-9.]/g, '')) || 0;
      return {
        id: p.productId,
        title: p.displayName || p.productName || 'Sephora Product',
        price: orig > 0 ? +(orig * markup()).toFixed(2) : null,
        originalPrice: orig || null,
        image: p.heroImage || p.image450 || p.image250 || '',
        url: p.targetUrl ? 'https://www.sephora.com' + p.targetUrl.split('?')[0] : '',
        rating: parseFloat(p.rating) || null,
        reviews: p.reviews || 0,
        badge: null,
        source: 'sephora',
        storeName: 'Sephora'
      };
    }).filter(p => p.price && p.image);
  } catch(e) { console.error('Sephora search error:', e.message); return []; }
}

async function searchMacys(query, limit = 20) {
  try {
    const url = 'https://www.macys.com/xapi/digital/v1/products/search?keyword=' + encodeURIComponent(query) + '&pageSize=' + limit + '&requestType=search';
    const resp = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Referer': 'https://www.macys.com/shop/search?keyword=' + encodeURIComponent(query),
        'x-macys-webservice-client-id': 'tablet_web',
        'via': '1.1 macys.com'
      },
      timeout: 15000
    });
    const products = (resp.data && resp.data.response && resp.data.response.products)
      ? resp.data.response.products
      : (resp.data && resp.data.products ? resp.data.products : []);
    return products.slice(0, limit).map(p => ({
      title: (p.detail && p.detail.name) ? p.detail.name : (p.name || ''),
      price: (p.pricing && p.pricing.price && p.pricing.price.tieredPrice && p.pricing.price.tieredPrice[0] && p.pricing.price.tieredPrice[0].values && p.pricing.price.tieredPrice[0].values[0])
        ? (p.pricing.price.tieredPrice[0].values[0].formattedValue || ('$' + p.pricing.price.tieredPrice[0].values[0].value))
        : '',
      image: (p.imagery && p.imagery.images && p.imagery.images[0])
        ? 'https://slimages.macysassets.com/is/image/MCY/products/' + p.imagery.images[0].filePath
        : '',
      url: 'https://www.macys.com' + ((p.detail && p.detail.defaultCategoryPath) ? p.detail.defaultCategoryPath : '/shop/product/detail'),
      store: "Macy's"
    }));
  } catch (e) {
    console.error("Macy's error:", e.message, e.response && e.response.status);
    return [];
  }
}



function interleave(arrays, total) {
  const result = [];
  const maxLen = Math.max(...arrays.map(a => a.length), 0);
  for (let i = 0; i < maxLen && result.length < total; i++) {
    for (const arr of arrays) {
      if (arr[i] && result.length < total) result.push(arr[i]);
    }
  }
  return result;
}

// âââ HEALTH ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
app.get('/health', (req, res) => res.json({ status: 'ok', rapidapi: !!RAPIDAPI_KEY, shopify: !!SHOPIFY_ADMIN_TOKEN }));

// âââ DEBUG ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
app.get('/debug-creds', (req, res) => res.json({
  client_id: SHOPIFY_CLIENT_ID,
  client_secret_sent: SHOPIFY_CLIENT_SECRET,
  client_secret_sent_length: SHOPIFY_CLIENT_SECRET.length,
  note: 'shpss_ stripped'
}));

// âââ OAUTH CALLBACK âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
app.get('/oauth/callback', async (req, res) => {
  const { code, shop } = req.query;
  if (!code || !shop) return res.status(400).json({ error: 'Missing code or shop' });
  try {
    // Use form-encoded body (more reliable than JSON for Shopify token exchange)
    const params = new URLSearchParams();
    params.append('client_id',     SHOPIFY_CLIENT_ID);
    params.append('client_secret', SHOPIFY_CLIENT_SECRET);
    params.append('code',          code);

    const response = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    params.toString()
    });
    const rawText = await response.text();
    console.log('Status:', response.status, '| Body:', rawText.slice(0, 300));
    let data;
    try { data = JSON.parse(rawText); } catch(e) {
      const esc = rawText.slice(0,20000).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
      return res.send(`<html><body style="font-family:monospace;padding:20px"><h2>OAuth Raw (v4)</h2><p>Status: ${response.status}</p><pre>${esc}</pre></body></html>`);
    }
    res.send(`<html><body style="font-family:monospace;padding:20px">
      <h2>${data.access_token ? 'â TOKEN CAPTURED!' : 'â No Token'}</h2>
      <p><b>Shop:</b> ${shop}</p>
      <p><b>Token:</b> <code style="background:#e8f5e9;padding:8px;display:block;word-break:break-all">${data.access_token || 'NOT FOUND'}</code></p>
      <p><b>Scopes:</b> ${data.scope || 'N/A'}</p>
      <pre>${JSON.stringify(data,null,2)}</pre>
    </body></html>`);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// âââ API: SEARCH âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
app.get('/api/search', async (req, res) => {
  const { q, store = 'all', limit = '24' } = req.query;
  if (!q || q.trim().length < 2) return res.status(400).json({ error: 'Query too short' });
  const maxItems = Math.min(parseInt(limit) || 24, 60);
  const perStore = Math.ceil(maxItems / 5);
  try {
    const target = store.toLowerCase();
    const searches = [];
    if (target === 'all' || target === 'amazon')    searches.push(searchAmazon(q, perStore));
    if (target === 'all' || target === 'shein')     searches.push(searchShein(q, perStore));
    if (target === 'all' || target === 'aliexpress') searches.push(searchAliexpress(q, perStore));
    if (target === 'all' || target === 'sephora')   searches.push(searchSephora(q, perStore));
    if (target === 'all' || target === 'macys')     searches.push(searchMacys(q, perStore));
    const settled = await Promise.allSettled(searches);
    const arrays = settled.filter(r => r.status === 'fulfilled').map(r => r.value);
    const results = interleave(arrays, maxItems);
    res.json({ results, total: results.length, query: q });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// âââ API: TRENDING ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
// Store-specific search routes
app.get('/api/search/shein', async (req, res) => {
  try {
    const { q = '', limit = '20' } = req.query;
    if (!q.trim()) return res.json({ results: [], total: 0, query: q });
    const results = await searchShein(q, parseInt(limit) || 20);
    res.json({ results, total: results.length, query: q });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/search/aliexpress', async (req, res) => {
  try {
    const { q = '', limit = '20' } = req.query;
    if (!q.trim()) return res.json({ results: [], total: 0, query: q });
    const results = await searchAliexpress(q, parseInt(limit) || 20);
    res.json({ results, total: results.length, query: q });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/search/sephora', async (req, res) => {
  try {
    const { q = '', limit = '20' } = req.query;
    if (!q.trim()) return res.json({ results: [], total: 0, query: q });
    const results = await searchSephora(q, parseInt(limit) || 20);
    res.json({ results, total: results.length, query: q });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/search/macys', async (req, res) => {
  try {
    const { q = '', limit = '20' } = req.query;
    if (!q.trim()) return res.json({ results: [], total: 0, query: q });
    const results = await searchMacys(q, parseInt(limit) || 20);
    res.json({ results, total: results.length, query: q });
  } catch(e) { res.status(500).json({ error: e.message }); }
});


app.get('/api/search/amazon', async (req, res) => {
  try {
    const { q = '', limit = '20' } = req.query;
    if (!q.trim()) return res.json({ results: [], total: 0, query: q });
    const results = await searchAmazon(q, parseInt(limit) || 20);
    res.json({ results, total: results.length, query: q });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/trending', async (req, res) => {
  try {
    const queries = ['trending fashion', 'viral products', 'hot deals'];
    const q = queries[Math.floor(Math.random() * queries.length)];
    const [amazon, shein, ali] = await Promise.allSettled([
      searchAmazon(q, 6), searchShein(q, 6), searchAliexpress(q, 6)
    ]);
    const all = interleave(
      [amazon.value||[], shein.value||[], ali.value||[]], 18
    );
    res.json({ results: all, section: 'trending' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// âââ API: BESTSELLERS âââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
app.get('/api/bestsellers', async (req, res) => {
  try {
    const [amazon, shein, ali] = await Promise.allSettled([
      searchAmazon('best sellers women fashion', 6),
      searchShein('popular', 6),
      searchAliexpress('best selling fashion', 6)
    ]);
    const all = interleave([amazon.value||[], shein.value||[], ali.value||[]], 18);
    res.json({ results: all, section: 'bestsellers' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// âââ API: NEW ARRIVALS ââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
app.get('/api/new-arrivals', async (req, res) => {
  try {
    const [amazon, shein, sephora, macys] = await Promise.allSettled([
      searchAmazon('new arrivals women', 5),
      searchShein('new in', 5),
      searchSephora('new arrivals', 4),
      searchMacys('new arrivals', 4)
    ]);
    const all = interleave([amazon.value||[], shein.value||[], sephora.value||[], macys.value||[]], 18);
    res.json({ results: all, section: 'new-arrivals' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// âââ API: FEATURED (categories) âââââââââââââââââââââââââââââââââââââââââââââââ
app.get('/api/featured', async (req, res) => {
  const { category = 'fashion' } = req.query;
  try {
    const [amazon, shein, ali] = await Promise.allSettled([
      searchAmazon(category, 4),
      searchShein(category, 4),
      searchAliexpress(category, 4)
    ]);
    const all = interleave([amazon.value||[], shein.value||[], ali.value||[]], 12);
    res.json({ results: all, section: 'featured', category });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// âââ API: CREATE PRODUCT âââââââââââââââââââââââââââââââââââââââââââââââââââââ
app.post('/api/create-and-add', async (req, res) => {
  const { title, price, originalPrice, image, sourceUrl, sourcePlatform } = req.body;
  if (!title || !price) return res.status(400).json({ error: 'Missing title or price' });
  if (!SHOPIFY_ADMIN_TOKEN || !SHOPIFY_STORE_DOMAIN) return res.status(503).json({ error: 'Shopify admin token not configured yet. Add SHOPIFY_ADMIN_TOKEN to Render env vars.' });
  try {
    const productPayload = {
      product: {
        title, status: 'active', published: true,
        variants: [{ price: parseFloat(price).toFixed(2), inventory_management: null, inventory_policy: 'continue' }],
        images: image ? [{ src: image }] : [],
        metafields: [
          { namespace: 'dealshub', key: 'source_url', value: sourceUrl || '', type: 'single_line_text_field' },
          { namespace: 'dealshub', key: 'source_platform', value: sourcePlatform || '', type: 'single_line_text_field' },
          { namespace: 'dealshub', key: 'original_price', value: String(originalPrice || ''), type: 'single_line_text_field' }
        ]
      }
    };
    const r = await fetch(`https://${SHOPIFY_STORE_DOMAIN}/admin/api/2024-01/products.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': SHOPIFY_ADMIN_TOKEN },
      body: JSON.stringify(productPayload)
    });
    if (!r.ok) { const errText = await r.text(); return res.status(r.status).json({ error: errText }); }
    const data = await r.json();
    const product = data.product;
    res.json({ success: true, variantId: product.variants[0].id, productId: product.id, productHandle: product.handle });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// âââ STORE FRONTEND âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
app.get('/', (req, res) => res.redirect('/store'));
app.get('/store', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(STORE_HTML);
});

// âââ HTML STOREFRONT ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
const STORE_HTML = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>DealsHub Miami â Moda & Lifestyle</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  :root{
    --primary:#0f1923;--secondary:#1a2b3c;--accent:#ff6b35;--accent2:#ffd700;
    --bg:#f5f6fa;--card:#fff;--text:#1a1a2e;--muted:#6c757d;
    --success:#28a745;--border:#e8ecf0;--shadow:0 2px 12px rgba(0,0,0,.08);
  }
  body{font-family:'Inter',sans-serif;background:var(--bg);color:var(--text);min-height:100vh}
  a{color:inherit;text-decoration:none}

  /* ââ NAVBAR ââ */
  .navbar{background:var(--primary);padding:0;position:sticky;top:0;z-index:1000;box-shadow:0 2px 20px rgba(0,0,0,.3)}
  .nav-top{display:flex;align-items:center;gap:12px;padding:10px 16px;max-width:1600px;margin:0 auto}
  .logo{color:#fff;font-size:22px;font-weight:700;white-space:nowrap;flex-shrink:0}
  .logo span{color:var(--accent)}
  .search-wrap{flex:1;display:flex;max-width:800px;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.2)}
  .search-wrap select{background:#f3a847;border:none;padding:0 10px;font-size:13px;font-weight:600;cursor:pointer;color:#111;outline:none}
  .search-wrap input{flex:1;border:none;padding:11px 14px;font-size:15px;outline:none;color:#111}
  .search-wrap button{background:var(--accent);border:none;padding:0 20px;cursor:pointer;color:#fff;font-size:20px;transition:background .2s}
  .search-wrap button:hover{background:#e5522a}
  .nav-icons{display:flex;gap:16px;align-items:center;flex-shrink:0}
  .nav-icon{color:#fff;font-size:13px;text-align:center;cursor:pointer;padding:4px 8px;border-radius:4px;transition:background .15s}
  .nav-icon:hover{background:rgba(255,255,255,.1)}
  .nav-icon .icon{font-size:20px;display:block}
  .cart-badge{position:relative;display:inline-block}
  .cart-count{position:absolute;top:-6px;right:-8px;background:var(--accent);color:#fff;border-radius:50%;width:18px;height:18px;font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center}

  /* ââ CATEGORY BAR ââ */
  .cat-bar{background:var(--secondary);overflow-x:auto;white-space:nowrap;scrollbar-width:none}
  .cat-bar::-webkit-scrollbar{display:none}
  .cat-bar-inner{display:flex;gap:0;max-width:1600px;margin:0 auto;padding:0 8px}
  .cat-btn{background:none;border:none;color:rgba(255,255,255,.85);padding:9px 14px;cursor:pointer;font-size:13.5px;font-weight:500;transition:all .2s;white-space:nowrap;flex-shrink:0}
  .cat-btn:hover,.cat-btn.active{color:#fff;background:rgba(255,255,255,.12);border-radius:4px}

  /* ââ HERO ââ */
  .hero{position:relative;overflow:hidden;background:var(--primary);height:420px;cursor:pointer}
  .hero-slides{display:flex;transition:transform .5s ease;height:100%}
  .hero-slide{min-width:100%;height:100%;background-size:cover;background-position:center;display:flex;align-items:flex-end;flex-shrink:0;position:relative}
  .hero-slide::after{content:'';position:absolute;inset:0;background:linear-gradient(to top,rgba(0,0,0,.7) 0%,rgba(0,0,0,.1) 60%)}
  .hero-text{position:relative;z-index:2;padding:32px 48px;color:#fff}
  .hero-text .tag{background:var(--accent);color:#fff;padding:4px 12px;border-radius:20px;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:1px;display:inline-block;margin-bottom:10px}
  .hero-text h1{font-size:36px;font-weight:800;margin-bottom:8px;text-shadow:0 2px 8px rgba(0,0,0,.5)}
  .hero-text p{font-size:16px;opacity:.9;margin-bottom:16px}
  .hero-text .cta{background:var(--accent);color:#fff;border:none;padding:12px 28px;border-radius:25px;font-size:15px;font-weight:700;cursor:pointer;transition:transform .2s,box-shadow .2s}
  .hero-text .cta:hover{transform:translateY(-2px);box-shadow:0 6px 20px rgba(255,107,53,.4)}
  .hero-dots{position:absolute;bottom:16px;right:24px;z-index:3;display:flex;gap:8px}
  .hero-dot{width:8px;height:8px;border-radius:50%;background:rgba(255,255,255,.4);cursor:pointer;transition:background .2s,width .2s}
  .hero-dot.active{background:#fff;width:24px;border-radius:4px}
  .hero-nav{position:absolute;top:50%;transform:translateY(-50%);z-index:3;background:rgba(255,255,255,.15);border:none;color:#fff;width:40px;height:40px;border-radius:50%;cursor:pointer;font-size:18px;backdrop-filter:blur(4px);transition:background .2s}
  .hero-nav:hover{background:rgba(255,255,255,.3)}
  .hero-prev{left:16px}.hero-next{right:16px}

  /* ââ BANNERS ROW ââ */
  .banners{display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;padding:16px;max-width:1600px;margin:0 auto}
  .banner-card{border-radius:12px;overflow:hidden;position:relative;height:140px;cursor:pointer;background:#ddd}
  .banner-card img{width:100%;height:100%;object-fit:cover;transition:transform .3s}
  .banner-card:hover img{transform:scale(1.04)}
  .banner-card .banner-label{position:absolute;inset:0;display:flex;flex-direction:column;justify-content:center;padding:16px;background:linear-gradient(135deg,rgba(0,0,0,.6),rgba(0,0,0,.2))}
  .banner-label h3{color:#fff;font-size:16px;font-weight:700}
  .banner-label span{color:rgba(255,255,255,.8);font-size:12px;margin-top:4px}

  /* ââ SECTION ââ */
  .section{max-width:1600px;margin:0 auto;padding:16px 16px 8px}
  .section-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:14px}
  .section-title{font-size:20px;font-weight:700;color:var(--text);display:flex;align-items:center;gap:8px}
  .section-title .emoji{font-size:22px}
  .section-link{color:var(--accent);font-size:13px;font-weight:600;cursor:pointer}
  .section-link:hover{text-decoration:underline}

  /* ââ CAROUSEL ââ */
  .carousel{overflow:auto;scrollbar-width:none;-webkit-overflow-scrolling:touch;padding-bottom:8px}
  .carousel::-webkit-scrollbar{display:none}
  .carousel-inner{display:flex;gap:12px;padding:4px 2px}
  .carousel-inner .product-card{min-width:200px;max-width:200px;flex-shrink:0}

  /* ââ PRODUCT GRID ââ */
  .product-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:14px;padding:4px 2px}

  /* ââ PRODUCT CARD ââ */
  .product-card{background:var(--card);border-radius:10px;overflow:hidden;box-shadow:var(--shadow);transition:transform .2s,box-shadow .2s;cursor:pointer;display:flex;flex-direction:column;position:relative}
  .product-card:hover{transform:translateY(-4px);box-shadow:0 8px 24px rgba(0,0,0,.12)}
  .product-card .badge{position:absolute;top:8px;left:8px;z-index:2;background:var(--accent);color:#fff;font-size:10px;font-weight:700;padding:3px 8px;border-radius:10px;text-transform:uppercase}
  .product-card .badge.bestseller{background:#e67e22}
  .product-card .badge.new{background:#27ae60}
  .product-card .source-badge{position:absolute;top:8px;right:8px;z-index:2}
  .source-badge .source-logo{background:var(--primary);color:#fff;font-size:9px;font-weight:700;padding:2px 7px;border-radius:8px;text-transform:uppercase;letter-spacing:.5px}
  .source-logo.amazon{background:#232f3e}
  .source-logo.shein{background:#000}
  .source-logo.aliexpress{background:#e43226}
  .source-logo.sephora{background:#111}
  .source-logo.macys{background:#b22222}
  .product-img{width:100%;height:200px;object-fit:cover;background:#f0f0f5}
  .product-img-placeholder{width:100%;height:200px;background:linear-gradient(135deg,#f0f2f5,#e8ecf0);display:flex;align-items:center;justify-content:center;font-size:40px}
  .product-info{padding:10px;flex:1;display:flex;flex-direction:column}
  .product-title{font-size:13px;font-weight:500;line-height:1.4;margin-bottom:6px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
  .product-rating{display:flex;align-items:center;gap:4px;margin-bottom:6px}
  .stars{color:#f39c12;font-size:11px}
  .review-count{font-size:11px;color:var(--muted)}
  .product-prices{display:flex;align-items:center;gap:8px;margin-bottom:10px;flex-wrap:wrap}
  .price-current{font-size:17px;font-weight:700;color:var(--accent)}
  .price-original{font-size:12px;color:var(--muted);text-decoration:line-through}
  .price-discount{font-size:11px;font-weight:600;color:var(--success)}
  .btn-add{background:var(--primary);color:#fff;border:none;padding:9px;border-radius:7px;cursor:pointer;font-size:13px;font-weight:600;width:100%;transition:background .2s;margin-top:auto}
  .btn-add:hover{background:var(--accent)}
  .btn-add.added{background:var(--success)}

  /* ââ FILTER BAR ââ */
  .filter-bar{background:#fff;border-bottom:1px solid var(--border);padding:12px 16px;display:flex;gap:8px;overflow-x:auto;scrollbar-width:none;position:sticky;top:60px;z-index:100}
  .filter-bar::-webkit-scrollbar{display:none}
  .filter-btn{background:none;border:1.5px solid var(--border);padding:6px 14px;border-radius:20px;font-size:13px;cursor:pointer;white-space:nowrap;transition:all .15s;flex-shrink:0}
  .filter-btn:hover,.filter-btn.active{background:var(--primary);color:#fff;border-color:var(--primary)}

  /* ââ SEARCH RESULTS PAGE ââ */
  #search-view{display:none}
  #home-view{display:block}
  .search-header{background:var(--primary);color:#fff;padding:14px 20px;max-width:1600px;margin:0 auto;border-radius:0 0 8px 8px}
  .search-header h2{font-size:17px;font-weight:600}
  .search-header span{opacity:.7;font-size:13px}
  .no-results{text-align:center;padding:60px 20px;color:var(--muted)}
  .no-results .emoji{font-size:60px;display:block;margin-bottom:16px}

  /* ââ CART SIDEBAR ââ */
  .cart-overlay{position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:2000;opacity:0;pointer-events:none;transition:opacity .3s}
  .cart-overlay.open{opacity:1;pointer-events:all}
  .cart-sidebar{position:fixed;right:-420px;top:0;bottom:0;width:420px;max-width:100vw;background:#fff;z-index:2001;box-shadow:-4px 0 30px rgba(0,0,0,.15);transition:right .3s;display:flex;flex-direction:column}
  .cart-sidebar.open{right:0}
  .cart-head{padding:20px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center}
  .cart-head h3{font-size:18px;font-weight:700}
  .cart-close{background:none;border:none;font-size:22px;cursor:pointer;color:var(--muted)}
  .cart-items{flex:1;overflow-y:auto;padding:16px}
  .cart-item{display:flex;gap:12px;padding:12px 0;border-bottom:1px solid var(--border)}
  .cart-item img{width:64px;height:64px;object-fit:cover;border-radius:6px;flex-shrink:0}
  .cart-item-info{flex:1;min-width:0}
  .cart-item-info h4{font-size:13px;font-weight:600;margin-bottom:4px;white-space:nowraw;overflow:hidden;text-overflow:ellipsis}
  .cart-item-info .ci-source{font-size:11px;color:var(--muted)}
  .cart-item-info .ci-price{font-size:15px;font-weight:700;color:var(--accent);margin-top:4px}
  .cart-item-actions{display:flex;align-items:center;gap:8px;margin-top:6px}
  .qty-btn{background:var(--border);border:none;width:24px;height:24px;border-radius:4px;cursor:pointer;font-size:14px;font-weight:700}
  .qty-num{font-size:14px;font-weight:600;min-width:20px;text-align:center}
  .cart-remove{background:none;border:none;color:var(--muted);cursor:pointer;font-size:16px;padding:2px 6px}
  .cart-remove:hover{color:#e74c3c}
  .cart-footer{padding:20px;border-top:1px solid var(--border)}
  .cart-total{display:flex;justify-content:space-between;margin-bottom:16px;font-size:16px;font-weight:700}
  .cart-total span:last-child{color:var(--accent)}
  .btn-checkout{background:var(--accent);color:#fff;border:none;padding:14px;border-radius:10px;width:100%;font-size:16px;font-weight:700;cursor:pointer;transition:background .2s}
  .btn-checkout:hover{background:#e5522a}
  .empty-cart{text-align:center;padding:40px 20px;color:var(--muted)}
  .empty-cart .ec-icon{font-size:50px;display:block;margin-bottom:12px}

  /* ââ LOADING ââ */
  .skeleton{background:linear-gradient(90deg,#f0f0f0 25%,#e0e0e0 50%,#f0f0f0 75%);background-size:200% 100%;animation:shimmer 1.5s infinite;border-radius:8px}
  @keyframes shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}
  .skeleton-card{height:300px;border-radius:10px}
  .loader-wrap{display:flex;gap:12px;overflow:hidden}
  .loading-spinner{display:flex;align-items:center;justify-content:center;padding:40px;gap:12px;color:var(--muted);font-size:14px}
  .spinner{width:28px;height:28px;border:3px solid var(--border);border-top-color:var(--accent);border-radius:50%;animation:spin .7s linear infinite}
  @keyframes spin{to{transform:rotate(360deg)}}

  /* ââ FOOTER ââ */
  footer{background:var(--primary);color:rgba(255,255,255,.7);padding:32px 16px;margin-top:40px}
  .footer-inner{max-width:1600px;margin:0 auto;display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:24px}
  .footer-col h4{color:#fff;font-size:14px;font-weight:700;margin-bottom:12px;text-transform:uppercase;letter-spacing:.5px}
  .footer-col ul{list-style:none;display:flex;flex-direction:column;gap:6px}
  .footer-col li{font-size:13px;cursor:pointer;transition:color .15s}
  .footer-col li:hover{color:#fff}
  .footer-bottom{max-width:1600px;margin:24px auto 0;padding-top:16px;border-top:1px solid rgba(255,255,255,.1);display:flex;justify-content:space-between;align-items:center;flex-wrap:gap;gap:8px}
  .footer-bottom span{font-size:12px}
  .source-pills{display:flex;gap:6px;flex-wrap:wrap}
  .source-pill{background:rgba(255,255,255,.1);color:rgba(255,255,255,.7);padding:3px 10px;border-radius:10px;font-size:11px;font-weight:600}

  /* ââ TOAST ââ */
  .toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%) translateY(80px);background:#1a1a2e;color:#fff;padding:12px 24px;border-radius:10px;font-size:14px;font-weight:600;z-index:9999;transition:transform .3s;box-shadow:0 4px 20px rgba(0,0,0,.3)}
  .toast.show{transform:translateX(-50%) translateY(0)}
  .toast.success{background:#27ae60}
  .toast.error{background:#e74c3c}

  /* ââ RESPONSIVE ââ */
  @media(max-width:768px){
    .hero{height:280px}.hero-text h1{font-size:24px}.hero-text{padding:20px}
    .banners{grid-template-columns:1fr;padding:10px}
    .nav-icons .nav-icon:not(.cart-badge-wrap){display:none}
    .carousel-inner .product-card{min-width:160px;max-width:160px}
    .product-grid{grid-template-columns:repeat(2,1fr)}
    .cart-sidebar{width:100%;max-width:100vw}
  }
</style>
</head>
<body>

<!-- NAVBAR -->
<nav class="navbar">
  <div class="nav-top">
    <div class="logo">Deals<span>Hub</span></div>
    <div class="search-wrap">
      <select id="storeFilter">
        <option value="all">Todos</option>
        <option value="amazon">Amazon</option>
        <option value="shein">SHEIN</option>
        <option value="aliexpress">AliExpress</option>
        <option value="sephora">Sephora</option>
        <option value="macys">Macy's</option>
      </select>
      <input type="text" id="searchInput" placeholder="Buscar productos, marcas y mÃ¡s..." autocomplete="off">
      <button id="searchBtn" title="Buscar (Enter)">&#128269;</button>
    </div>
    <div class="nav-icons">
      <div class="nav-icon" onclick="showCart()">
        <span class="icon cart-badge-wrap">&#128722;<span class="cart-count" id="cartCount">0</span></span>
        <span>Carrito</span>
      </div>
    </div>
  </div>
</nav>

<!-- CATEGORY BAR -->
<div class="cat-bar">
  <div class="cat-bar-inner">
    <button class="cat-btn active" onclick="filterCat(this,'fashion')">&#128084; Moda</button>
    <button class="cat-btn" onclick="filterCat(this,'women clothing')">&#128149; Mujer</button>
    <button class="cat-btn" onclick="filterCat(this,'men clothing')">&#128084; Hombre</button>
    <button class="cat-btn" onclick="filterCat(this,'shoes')">&#128095; Zapatos</button>
    <button class="cat-btn" onclick="filterCat(this,'beauty makeup')">&#128132; Belleza</button>
    <button class="cat-btn" onclick="filterCat(this,'accessories jewelry')">&#128144; Accesorios</button>
    <button class="cat-btn" onclick="filterCat(this,'electronics')">&#128241; ElectrÃ³nica</button>
    <button class="cat-btn" onclick="filterCat(this,'home decor')">&#127968; Hogar</button>
    <button class="cat-btn" onclick="filterCat(this,'sports')">&#9917; Deportes</button>
    <button class="cat-btn" onclick="filterCat(this,'kids')">&#127874; NiÃ±os</button>
  </div>
</div>

<!-- âââ HOME VIEW âââ -->
<div id="home-view">

  <!-- HERO -->
  <div class="hero" id="heroEl">
    <div class="hero-slides" id="heroSlides">
      <div class="hero-slide" style="background-image:url('https://images.unsplash.com/photo-1441984904996-e0b6ba687e04?w=1400&q=80')">
        <div class="hero-text">
          <span class="tag">&#128293; Tendencia</span>
          <h1>Nueva ColecciÃ³n Primavera</h1>
          <p>Descubre los mejores precios de Amazon, SHEIN y AliExpress</p>
          <button class="cta" onclick="searchProducts('new arrivals women')">Ver ColecciÃ³n</button>
        </div>
      </div>
      <div class="hero-slide" style="background-image:url('https://images.unsplash.com/photo-1490481651871-ab68de25d43d?w=1400&q=80')">
        <div class="hero-text">
          <span class="tag">&#128293; Viral</span>
          <h1>Los MÃ¡s Vendidos</h1>
          <p>Productos virales al mejor precio con entrega internacional</p>
          <button class="cta" onclick="searchProducts('best sellers fashion')">Ver Bestsellers</button>
        </div>
      </div>
      <div class="hero-slide" style="background-image:url('https://images.unsplash.com/photo-1483985988355-763728e1935b?w=1400&q=80')">
        <div class="hero-text">
          <span class="tag">&#127381; Nuevo</span>
          <h1>Belleza & Skincare</h1>
          <p>Lo Ãºltimo de Sephora y las mejores marcas beauty</p>
          <button class="cta" onclick="filterCat(null,'beauty makeup')">Ver Belleza</button>
        </div>
      </div>
      <div class="hero-slide" style="background-image:url('https://images.unsplash.com/photo-1558171813-2a83b23bc7a0?w=1400&q=80')">
        <div class="hero-text">
          <span class="tag">&#9889; Oferta</span>
          <h1>ElectrÃ³nica y Gadgets</h1>
          <p>Los mejores gadgets y electrÃ³nicos del momento</p>
          <button class="cta" onclick="filterCat(null,'electronics')">Ver ElectrÃ³nica</button>
        </div>
      </div>
    </div>
    <button class="hero-nav hero-prev" onclick="moveHero(-1)">&#8249;</button>
    <button class="hero-nav hero-next" onclick="moveHero(1)">&#8250;</button>
    <div class="hero-dots" id="heroDots"></div>
  </div>

  <!-- MINI BANNERS -->
  <div class="banners">
    <div class="banner-card" onclick="filterCat(null,'women fashion')">
      <img src="https://images.unsplash.com/photo-1469334031218-e382a71b716b?w=600&q=80" alt="Moda Mujer">
      <div class="banner-label"><h3>Moda Mujer</h3><span>Ver colecciÃ³n â</span></div>
    </div>
    <div class="banner-card" onclick="filterCat(null,'beauty skincare')">
      <img src="https://images.unsplash.com/photo-1522335789203-aabd1fc54bc9?w=600&q=80" alt="Belleza">
      <div class="banner-label"><h3>Belleza & Skincare</h3><span>Descubrir â</span></div>
    </div>
    <div class="banner-card" onclick="filterCat(null,'shoes sneakers')">
      <img src="https://images.unsplash.com/photo-1542291026-7eec264c27ff?w=600&q=80" alt="Zapatos">
      <div class="banner-label"><h3>Zapatos Trending</h3><span>Explorar â</span></div>
    </div>
  </div>

  <!-- TRENDING NOW -->
  <div class="section">
    <div class="section-header">
      <h2 class="section-title"><span class="emoji">&#128293;</span>Trending Ahora</h2>
      <span class="section-link" onclick="searchProducts('trending fashion')">Ver todo â</span>
    </div>
    <div class="carousel" id="trendingCarousel">
      <div class="loader-wrap">${skeletonCards(8)}</div>
    </div>
  </div>

  <!-- BEST SELLERS -->
  <div class="section">
    <div class="section-header">
      <h2 class="section-title"><span class="emoji">&#127942;</span>MÃ¡s Vendidos</h2>
      <span class="section-link" onclick="searchProducts('best sellers')">Ver todo â</span>
    </div>
    <div class="carousel" id="bestsellersCarousel">
      <div class="loader-wrap">${skeletonCards(8)}</div>
    </div>
  </div>

  <!-- NOVEDADES -->
  <div class="section">
    <div class="section-header">
      <h2 class="section-title"><span class="emoji">&#127381;</span>Novedades</h2>
      <span class="section-link" onclick="searchProducts('new arrivals')">Ver todo â</span>
    </div>
    <div class="carousel" id="newArrivalsCarousel">
      <div class="loader-wrap">${skeletonCards(8)}</div>
    </div>
  </div>

  <!-- FEATURED GRID -->
  <div class="section" id="featuredSection">
    <div class="section-header">
      <h2 class="section-title" id="featuredTitle"><span class="emoji">&#128084;</span>Moda Destacada</h2>
    </div>
    <div class="product-grid" id="featuredGrid">
      ${skeletonCards(12)}
    </div>
  </div>

</div><!-- /home-view -->

<!-- âââ SEARCH VIEW âââ -->
<div id="search-view">
  <div class="search-header">
    <h2 id="searchTitle">Resultados de bÃºsqueda</h2>
    <span id="searchSubtitle"></span>
  </div>

  <!-- FILTER BAR -->
  <div class="filter-bar">
    <button class="filter-btn active" onclick="filterStore(this,'all')">Todos</button>
    <button class="filter-btn" onclick="filterStore(this,'amazon')">Amazon</button>
    <button class="filter-btn" onclick="filterStore(this,'shein')">SHEIN</button>
    <button class="filter-btn" onclick="filterStore(this,'aliexpress')">AliExpress</button>
    <button class="filter-btn" onclick="filterStore(this,'sephora')">Sephora</button>
    <button class="filter-btn" onclick="filterStore(this,'macys')">Macy's</button>
  </div>

  <div class="section">
    <div id="searchResults" class="product-grid"></div>
  </div>
</div><!-- /search-view -->

<!-- CART SIDEBAR -->
<div class="cart-overlay" id="cartOverlay" onclick="hideCart()"></div>
<div class="cart-sidebar" id="cartSidebar">
  <div class="cart-head">
    <h3>&#128722; Mi Carrito</h3>
    <button class="cart-close" onclick="hideCart()">&#10005;</button>
  </div>
  <div class="cart-items" id="cartItems"></div>
  <div class="cart-footer" id="cartFooter"></div>
</div>

<!-- TOAST -->
<div class="toast" id="toast"></div>

<!-- FOOTER -->
<footer>
  <div class="footer-inner">
    <div class="footer-col">
      <h4>DealsHub Miami</h4>
      <ul>
        <li>Sobre Nosotros</li>
        <li>CÃ³mo Funciona</li>
        <li>Blog de Tendencias</li>
        <li>Trabaja con Nosotros</li>
      </ul>
    </div>
    <div class="footer-col">
      <h4>AtenciÃ³n al Cliente</h4>
      <ul>
        <li>Centro de Ayuda</li>
        <li>Seguimiento de Pedido</li>
        <li>Devoluciones</li>
        <li>Contacto</li>
      </ul>
    </div>
    <div class="footer-col">
      <h4>Nuestras Tiendas</h4>
      <div class="source-pills">
        <span class="source-pill">Amazon</span>
        <span class="source-pill">SHEIN</span>
        <span class="source-pill">AliExpress</span>
        <span class="source-pill">Sephora</span>
        <span class="source-pill">Macy's</span>
      </div>
    </div>
    <div class="footer-col">
      <h4>SÃ­guenos</h4>
      <ul>
        <li>&#128247; Instagram</li>
        <li>&#127916; TikTok</li>
        <li>&#127775; Pinterest</li>
        <li>&#128214; Facebook</li>
      </ul>
    </div>
  </div>
  <div class="footer-bottom">
    <span>Â© 2025 DealsHub Miami. Todos los derechos reservados.</span>
    <span>Los precios incluyen markup de distribuciÃ³n.</span>
  </div>
</footer>

<script>
const API = '';  // same-origin

// âââ CART STATE âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
let cart = JSON.parse(localStorage.getItem('dh_cart') || '[]');
let currentQuery = '';
let currentStore = 'all';
let heroIndex = 0;
const totalSlides = 4;

function saveCart(){ localStorage.setItem('dh_cart', JSON.stringify(cart)); updateCartBadge(); }
function updateCartBadge(){ document.getElementById('cartCount').textContent = cart.reduce((s,i)=>s+i.qty,0); }
updateCartBadge();

// âââ HERO âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
(function initHero(){
  const dotsEl = document.getElementById('heroDots');
  for(let i=0;i<totalSlides;i++){
    const d = document.createElement('div');
    d.className = 'hero-dot' + (i===0?' active':'');
    d.onclick = () => goHero(i);
    dotsEl.appendChild(d);
  }
  setInterval(()=>moveHero(1), 5000);
})();

function goHero(i){
  heroIndex = i;
  document.getElementById('heroSlides').style.transform = \`translateX(-\${heroIndex*100}%)\`;
  document.querySelectorAll('.hero-dot').forEach((d,j)=>d.classList.toggle('active',j===heroIndex));
}
function moveHero(dir){
  goHero((heroIndex+dir+totalSlides)%totalSlides);
}

// âââ SEARCH âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
document.getElementById('searchInput').addEventListener('keydown', e => {
  if(e.key === 'Enter') {
    const q = e.target.value.trim();
    if(q.length >= 2) searchProducts(q);
  }
});
document.getElementById('searchBtn').addEventListener('click', () => {
  const q = document.getElementById('searchInput').value.trim();
  if(q.length >= 2) searchProducts(q);
});

async function searchProducts(q, store) {
  currentQuery = q;
  currentStore = store || document.getElementById('storeFilter').value || 'all';
  document.getElementById('searchInput').value = q;
  showSearchView(q);
  const resultsEl = document.getElementById('searchResults');
  resultsEl.innerHTML = '<div class="loading-spinner"><div class="spinner"></div><span>Buscando en Amazon, SHEIN, AliExpress y mÃ¡s...</span></div>';
  try {
    const resp = await fetch(\`\${API}/api/search?q=\${encodeURIComponent(q)}&store=\${currentStore}&limit=48\`);
    const data = await resp.json();
    const subtitle = document.getElementById('searchSubtitle');
    subtitle.textContent = \`\${data.total || 0} productos encontrados\`;
    if(!data.results?.length){
      resultsEl.innerHTML = '<div class="no-results"><span class="emoji">&#128269;</span><h3>Sin resultados</h3><p>Intenta con otras palabras clave</p></div>';
    } else {
      renderGrid(resultsEl, data.results, false);
    }
  } catch(e){
    resultsEl.innerHTML = '<div class="no-results"><span class="emoji">&#9888;&#65039;</span><h3>Error de conexiÃ³n</h3><p>Intenta nuevamente</p></div>';
  }
}

function showSearchView(q){
  document.getElementById('home-view').style.display = 'none';
  document.getElementById('search-view').style.display = 'block';
  document.getElementById('searchTitle').textContent = \`Resultados para "\${q}"\`;
  document.querySelectorAll('.filter-btn').forEach(b=>b.classList.remove('active'));
  document.querySelector('.filter-btn').classList.add('active');
}

function showHomeView(){
  document.getElementById('home-view').style.display = 'block';
  document.getElementById('search-view').style.display = 'none';
  document.getElementById('searchInput').value = '';
  currentQuery = '';
}

function filterStore(btn, store){
  currentStore = store;
  document.querySelectorAll('.filter-btn').forEach(b=>b.classList.remove('active'));
  if(btn) btn.classList.add('active');
  if(currentQuery) searchProducts(currentQuery, store);
}

function filterCat(btn, cat){
  if(btn){
    document.querySelectorAll('.cat-btn').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active');
  }
  showHomeView();
  loadFeatured(cat);
  const titles = {
    'fashion':'&#128084; Moda Destacada','women clothing':'&#128149; Moda Mujer',
    'men clothing':'&#128084; Moda Hombre','shoes':'&#128095; Zapatos Trending',
    'beauty makeup':'&#128132; Belleza & Makeup','accessories jewelry':'&#128144; Accesorios',
    'electronics':'&#128241; ElectrÃ³nica','home decor':'&#127968; Hogar',
    'sports':'&#9917; Deportes','kids':'&#127874; Para NiÃ±os'
  };
  document.getElementById('featuredTitle').innerHTML = \`<span class="emoji"></span>\${titles[cat]||cat}\`;
}

// âââ LOAD SECTIONS ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
async function loadCarousel(endpoint, containerId){
  try {
    const resp = await fetch(\`\${API}\${endpoint}\`);
    const data = await resp.json();
    const container = document.getElementById(containerId);
    if(!container) return;
    if(!data.results?.length){ container.innerHTML = '<p style="padding:16px;color:#999">No hay productos disponibles ahora</p>'; return; }
    container.innerHTML = '<div class="carousel-inner"></div>';
    renderGrid(container.querySelector('.carousel-inner'), data.results, true);
  } catch(e){ console.error(endpoint, e); }
}

async function loadFeatured(category = 'fashion'){
  try {
    const resp = await fetch(\`\${API}/api/featured?category=\${encodeURIComponent(category)}\`);
    const data = await resp.json();
    const grid = document.getElementById('featuredGrid');
    if(!data.results?.length){ grid.innerHTML = '<p style="padding:16px;color:#999">Cargando productos...</p>'; return; }
    renderGrid(grid, data.results, false);
  } catch(e){ console.error('featured', e); }
}

// âââ RENDER PRODUCTS âââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
function renderGrid(container, products, carousel){
  container.innerHTML = '';
  products.forEach(p => {
    container.appendChild(makeProductCard(p));
  });
}

function makeProductCard(p){
  const card = document.createElement('div');
  card.className = 'product-card';
  const disc = p.originalPrice > 0 ? Math.round((1 - p.price / p.originalPrice) * 100) : 0;
  const stars = p.rating ? 'â'.repeat(Math.round(p.rating)) + 'â'.repeat(5-Math.round(p.rating)) : '';
  const badge = p.badge ? \`<div class="badge \${p.badge.toLowerCase().replace(/[^a-z]/g,'')}">\${p.badge}</div>\` : '';
  const srcClass = p.source || 'amazon';
  card.innerHTML = \`
    \${badge}
    <div class="source-badge"><span class="source-logo \${srcClass}">\${p.sourceName || p.source}</span></div>
    \${p.image
      ? \`<img class="product-img" src="\${p.image}" alt="\${esc(p.title)}" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">\`
      : ''}
    <div class="product-img-placeholder" style="\${p.image?'display:none':''}">&#128722;</div>
    <div class="product-info">
      <p class="product-title">\${esc(p.title)}</p>
      \${stars ? \`<div class="product-rating"><span class="stars">\${stars}</span><span class="review-count">(\${p.reviews?.toLocaleString()||0})</span></div>\` : ''}
      <div class="product-prices">
        <span class="price-current">$\${(+p.price).toFixed(2)}</span>
        \${p.originalPrice && disc>0 ? \`<span class="price-original">$\${(+p.originalPrice).toFixed(2)}</span><span class="price-discount">-\${disc}%</span>\` : ''}
      </div>
      <button class="btn-add" onclick='addToCart(\${JSON.stringify(JSON.stringify(p))})'>&#128722; Agregar al Carrito</button>
    </div>\`;
  return card;
}

function esc(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

// âââ CART âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
function addToCart(pJson){
  const p = JSON.parse(pJson);
  const existing = cart.find(i => i.id === p.id);
  if(existing){ existing.qty++; }
  else { cart.push({...p, qty:1}); }
  saveCart();
  renderCart();
  showToast(\`â \${p.title.slice(0,30)}... agregado\`, 'success');
}

function removeFromCart(id){ cart = cart.filter(i=>i.id!==id); saveCart(); renderCart(); }
function updateQty(id, delta){
  const item = cart.find(i=>i.id===id);
  if(item){ item.qty = Math.max(1, item.qty+delta); if(item.qty<=0) return removeFromCart(id); saveCart(); renderCart(); }
}

function renderCart(){
  const el = document.getElementById('cartItems');
  const footer = document.getElementById('cartFooter');
  if(!cart.length){
    el.innerHTML = '<div class="empty-cart"><span class="ec-icon">&#128722;</span><p>Tu carrito estÃ¡ vacÃ­o</p></div>';
    footer.innerHTML = '';
    return;
  }
  el.innerHTML = cart.map(i=>\`
    <div class="cart-item">
      \${i.image ? \`<img src="\${i.image}" alt="" onerror="this.src=''">\` : '<div style="width:64px;height:64px;background:#f0f0f5;border-radius:6px;display:flex;align-items:center;justify-content:center">&#128722;</div>'}
      <div class="cart-item-info" style="flex:1;min-width:0">
        <h4>\${esc(i.title)}</h4>
        <div class="ci-source">\${i.sourceName||i.source}</div>
        <div class="ci-price">$\${(+i.price).toFixed(2)}</div>
        <div class="cart-item-actions">
          <button class="qty-btn" onclick="updateQty('\${i.id}',-1)">-</button>
          <span class="qty-num">\${i.qty}</span>
          <button class="qty-btn" onclick="updateQty('\${i.id}',1)">+</button>
          <button class="cart-remove" onclick="removeFromCart('\${i.id}')">&#128465;</button>
        </div>
      </div>
    </div>\`).join('');
  const total = cart.reduce((s,i)=>s+i.price*i.qty, 0);
  footer.innerHTML = \`
    <div class="cart-total"><span>Total</span><span>$\${total.toFixed(2)}</span></div>
    <button class="btn-checkout" onclick="checkout()">&#9889; Proceder al Pago</button>\`;
}

function showCart(){ document.getElementById('cartOverlay').classList.add('open'); document.getElementById('cartSidebar').classList.add('open'); renderCart(); }
function hideCart(){ document.getElementById('cartOverlay').classList.remove('open'); document.getElementById('cartSidebar').classList.remove('open'); }

async function checkout(){
  if(!cart.length) return;
  showToast('Procesando tu pedido...', '');
  // Create products in Shopify and redirect to checkout
  try {
    const items = [];
    for(const item of cart){
      const resp = await fetch(\`\${API}/api/create-and-add\`, {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ title: item.title, price: item.price, originalPrice: item.originalPrice, image: item.image, sourceUrl: item.url, sourcePlatform: item.source })
      });
      const data = await resp.json();
      if(data.variantId) items.push({ id: data.variantId, quantity: item.qty });
    }
    if(items.length){
      const cartItems = items.map(i=>\`\${i.id}:\${i.quantity}\`).join(',');
      window.location.href = \`/cart/\${cartItems}\`;
    } else {
      showToast('Checkout no disponible temporalmente', 'error');
    }
  } catch(e){ showToast('Error procesando el pedido. IntÃ©ntalo nuevamente.', 'error'); }
}

// âââ TOAST ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
let toastTimer;
function showToast(msg, type=''){
  const t = document.getElementById('toast');
  t.textContent = msg; t.className = \`toast \${type} show\`;
  clearTimeout(toastTimer); toastTimer = setTimeout(()=>t.classList.remove('show'), 2800);
}

// âââ INIT âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
(async function init(){
  await Promise.all([
    loadCarousel('/api/trending', 'trendingCarousel'),
    loadCarousel('/api/bestsellers', 'bestsellersCarousel'),
    loadCarousel('/api/new-arrivals', 'newArrivalsCarousel'),
    loadFeatured('fashion')
  ]);
})();

// ── PRODUCT DETAIL MODAL ──────────────────────────────────────────────
(function initPdModal(){
  var el = document.createElement('div');
  el.id = 'pdModal';
  el.style.cssText = 'display:none;position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.55);overflow-y:auto;padding:20px 10px';
  el.innerHTML = '<div style="background:#fff;max-width:880px;margin:0 auto;border-radius:18px;overflow:hidden;position:relative;display:flex;flex-wrap:wrap;box-shadow:0 20px 60px rgba(0,0,0,.25)">'
    + '<button onclick="closePdModal()" style="position:absolute;top:14px;right:18px;width:36px;height:36px;background:rgba(0,0,0,.08);border:none;border-radius:50%;font-size:22px;cursor:pointer;z-index:2;color:#333">&times;</button>'
    + '<div style="flex:0 0 45%;min-width:260px;background:#f8f8f8;display:flex;align-items:center;justify-content:center;padding:28px">'
    + '<img id="pdImg" src="" alt="" style="max-width:100%;max-height:380px;object-fit:contain;border-radius:10px"></div>'
    + '<div style="flex:1;min-width:260px;padding:36px 28px;display:flex;flex-direction:column;gap:10px">'
    + '<span id="pdStore" style="font-size:11px;font-weight:800;text-transform:uppercase;color:#888;letter-spacing:1.5px"></span>'
    + '<h2 id="pdTitle" style="margin:0;font-size:19px;font-weight:700;line-height:1.35;color:#111"></h2>'
    + '<div id="pdRating" style="font-size:14px;color:#f59e0b;min-height:20px"></div>'
    + '<div id="pdPrice" style="font-size:34px;font-weight:800;color:#111"></div>'
    + '<p id="pdDesc" style="font-size:13px;color:#666;line-height:1.65;margin:0;max-height:110px;overflow-y:auto"></p>'
    + '<div style="display:flex;gap:10px;margin-top:12px;flex-wrap:wrap">'
    + '<button id="pdCartBtn" style="flex:1;min-width:150px;padding:15px;background:#111;color:#fff;border:none;border-radius:10px;font-size:15px;font-weight:700;cursor:pointer" onclick="pdAddToCart()">&#128722; Agregar al carrito</button>'
    + '<a id="pdLink" href="#" target="_blank" rel="noopener" style="padding:15px 18px;border:2px solid #111;border-radius:10px;font-size:13px;font-weight:700;color:#111;text-decoration:none;display:flex;align-items:center">Ver en tienda &#8599;</a>'
    + '</div></div></div>';
  document.body.appendChild(el);
  el.addEventListener('click', function(e){ if(e.target===el) closePdModal(); });
})();

var _pdCur = null;
function showProductDetail(p){
  _pdCur = p;
  var img=document.getElementById('pdImg'), title=document.getElementById('pdTitle'),
      store=document.getElementById('pdStore'), price=document.getElementById('pdPrice'),
      desc=document.getElementById('pdDesc'), link=document.getElementById('pdLink'),
      rat=document.getElementById('pdRating');
  if(img) img.src = p.image||'';
  if(title) title.textContent = p.title||'';
  if(store) store.textContent = p.store||'';
  if(price) price.textContent = p.price ? ('$'+parseFloat(p.price).toFixed(2)) : '';
  if(desc) desc.textContent = p.description||'';
  if(link) link.href = p.url||'#';
  if(rat){
    var r=parseFloat(p.rating)||0, rv=parseInt(p.review_count)||0, s='';
    if(r>0){ for(var i=0;i<5;i++) s+=i<Math.round(r)?'\u2605':'\u2606'; s+=' '+r.toFixed(1); if(rv) s+='  ('+rv.toLocaleString()+' rese\u00f1as)'; }
    rat.textContent=s;
  }
  var modal=document.getElementById('pdModal');
  if(modal){ modal.style.display='block'; document.body.style.overflow='hidden'; }
}
function closePdModal(){
  var modal=document.getElementById('pdModal');
  if(modal) modal.style.display='none';
  document.body.style.overflow=''; _pdCur=null;
}
function pdAddToCart(){ if(_pdCur) addToCart(_pdCur); closePdModal(); }
(function patchMPC(){
  var orig=makeProductCard;
  makeProductCard=function(p){
    var card=orig(p);
    card.style.cursor='pointer';
    card.addEventListener('click',function(e){ if(!e.target.closest('button,a')) showProductDetail(p); });
    return card;
  };
})();
</script>
</body>
</html>`;

function skeletonCards(n){
  return Array(n).fill('<div class="skeleton skeleton-card" style="min-width:200px;flex-shrink:0"></div>').join('');
}

const PORT = process.env.PORT || 3000;
// ─── CART REDIRECT → SHOPIFY CHECKOUT ────────────────────────────────────────────
app.get('/cart/:items', async (req, res) => {
  const itemsStr = req.params.items;
  if (!SHOPIFY_ADMIN_TOKEN || !SHOPIFY_STORE_DOMAIN) {
    return res.status(503).send('Shopify not configured');
  }
  try {
    const lineItems = itemsStr.split(',').map(part => {
      const [id, qty] = part.split(':');
      return { variant_id: parseInt(id), quantity: parseInt(qty) || 1 };
    }).filter(i => i.variant_id);

    // Publish each product so it is available in the storefront
    for (const item of lineItems) {
      const varResp = await fetch(`https://${SHOPIFY_STORE_DOMAIN}/admin/api/2024-01/variants/${item.variant_id}.json`, {
        headers: { 'X-Shopify-Access-Token': SHOPIFY_ADMIN_TOKEN }
      });
      if (varResp.ok) {
        const varData = await varResp.json();
        const productId = varData.variant && varData.variant.product_id;
        if (productId) {
          await fetch(`https://${SHOPIFY_STORE_DOMAIN}/admin/api/2024-01/products/${productId}.json`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': SHOPIFY_ADMIN_TOKEN },
            body: JSON.stringify({ product: { id: productId, status: 'active', published: true } })
          });
        }
      }
    }

    // Create checkout via Admin API
    const chkResp = await fetch(`https://${SHOPIFY_STORE_DOMAIN}/admin/api/2024-01/checkouts.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': SHOPIFY_ADMIN_TOKEN },
      body: JSON.stringify({ checkout: { line_items: lineItems } })
    });
    const chkData = await chkResp.json();
    const webUrl = chkData.checkout && chkData.checkout.web_url;
    if (webUrl) return res.redirect(webUrl);

    // Fallback: direct Shopify cart URL
    return res.redirect(`https://${SHOPIFY_STORE_DOMAIN}/cart/${itemsStr}`);
  } catch (err) {
    console.error('Cart redirect error:', err.message);
    res.status(500).send('Checkout error: ' + err.message);
  }
});




// ============ PRODUCT DETAIL ENDPOINT ============
app.get('/api/product/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const store = (req.query.store || 'amazon').toLowerCase();
    let productData;
    if (store === 'amazon') productData = await getAmazonDetail(id);
    else if (store === 'aliexpress') productData = await getAliexpressDetail(id);
    else if (store === 'sephora') productData = await getSephoraDetail(id, req.query.sku || '');
    else return res.status(400).json({ error: 'Invalid store' });
    if (!productData) return res.status(404).json({ error: 'Product not found' });
    res.json(productData);
  } catch (err) {
    console.error('Product detail error:', err.message);
    res.status(500).json({ error: 'Failed to fetch product details' });
  }
});

async function getAmazonDetail(asin) {
  try {
    const r = await fetch(`https://real-time-amazon-data.p.rapidapi.com/product-details?asin=${encodeURIComponent(asin)}&country=US`, { headers: rapidHeaders('real-time-amazon-data.p.rapidapi.com') });
    const d = await r.json();
    const p = d.data;
    if (!p) return null;
    const price = p.product_price ? parseFloat(p.product_price.replace(/[^0-9.]/g, '')) : null;
    const origPrice = p.product_original_price ? parseFloat(p.product_original_price.replace(/[^0-9.]/g, '')) : price;
    return {
      id: asin, title: p.product_title || '', description: p.product_description || (p.about_product || []).join('\n'), about: p.about_product || [],
      price: price ? '$' + (price * markup()).toFixed(2) : null, originalPrice: origPrice ? '$' + (origPrice * markup()).toFixed(2) : null,
      images: p.product_photos || [p.product_photo], rating: p.product_star_rating || null, reviews: p.product_num_ratings || 0,
      variants: (p.product_variations || []).map(v => ({ name: v.name || '', values: (v.values || []).map(val => ({ value: val.value || val, asin: val.asin || null, image: val.photo || null, selected: val.is_selected || false })) })),
      specifications: p.product_details || {}, features: p.about_product || [], url: `https://www.amazon.com/dp/${asin}`, source: 'amazon', storeName: 'Amazon',
      badge: p.is_best_seller ? 'Best Seller' : (p.is_amazon_choice ? 'Amazon Choice' : null), brand: p.product_byline || null, availability: p.product_availability || null, category: p.product_category || null
    };
  } catch (e) { console.error('Amazon detail error:', e.message); return null; }
}

async function getAliexpressDetail(productId) {
  try {
    const r = await fetch(`https://aliexpress-data.p.rapidapi.com/product/detail?productId=${encodeURIComponent(productId)}`, { headers: rapidHeaders('aliexpress-data.p.rapidapi.com') });
    const d = await r.json();
    const p = d.data || d;
    if (!p) return null;
    const title = p.title || p.product?.title || '';
    const imgs = p.images || p.product?.images || [];
    const desc = p.description || p.product?.description || '';
    const skuProps = p.skuProperties || p.product?.skuProperties || [];
    const variants = skuProps.map(prop => ({ name: prop.skuPropertyName || '', values: (prop.skuPropertyValues || []).map(v => ({ value: v.propertyValueDisplayName || v.propertyValueName || '', image: v.skuPropertyImagePath || null, id: v.propertyValueId || null, selected: false })) }));
    const saleMin = p.salePrice?.min || p.product?.salePrice?.min;
    const origMin = p.originalPrice?.min || p.product?.originalPrice?.min;
    const salePrice = saleMin ? parseFloat(saleMin) : null;
    const originalPrice = origMin ? parseFloat(origMin) : null;
    const specifications = {};
    (p.specs || p.product?.specs || []).forEach(s => { if (s.name && s.value) specifications[s.name] = s.value; });
    return {
      id: productId, title, description: desc, about: [],
      price: salePrice ? '$' + (salePrice * markup()).toFixed(2) : null, originalPrice: originalPrice ? '$' + (originalPrice * markup()).toFixed(2) : null,
      images: imgs.map(img => img.startsWith('//') ? 'https:' + img : img), rating: p.evaluation?.starRating || null, reviews: p.trade?.realTradeCount || 0,
      variants, specifications, features: [], url: `https://www.aliexpress.com/item/${productId}.html`, source: 'aliexpress', storeName: 'AliExpress',
      badge: null, brand: null, availability: null, category: null
    };
  } catch (e) { console.error('AliExpress detail error:', e.message); return null; }
}

async function getSephoraDetail(productId, preferedSku) {
  try {
    let url = `https://sephora.p.rapidapi.com/us/products/v2/detail?productId=${encodeURIComponent(productId)}`;
    if (preferedSku) url += `&preferedSku=${encodeURIComponent(preferedSku)}`;
    const r = await fetch(url, { headers: rapidHeaders('sephora.p.rapidapi.com') });
    const d = await r.json();
    const p = d.data || d;
    if (!p) return null;
    const product = p.productDetails || p;
    const name = product.displayName || product.productName || '';
    const brand = product.brand?.displayName || product.brandName || '';
    const desc = product.longDescription || product.shortDescription || '';
    const imgs = [];
    if (product.heroImage) imgs.push(product.heroImage);
    if (product.altImages) imgs.push(...product.altImages);
    if (product.skuImages) Object.values(product.skuImages).forEach(a => { if (Array.isArray(a)) imgs.push(...a); });
    const sku = product.currentSku || {};
    const listPrice = sku.listPrice ? parseFloat(sku.listPrice.replace(/[^0-9.]/g, '')) : null;
    const salePrice = sku.salePrice ? parseFloat(sku.salePrice.replace(/[^0-9.]/g, '')) : listPrice;
    const variants = [];
    if (product.regularChildSkus && product.regularChildSkus.length > 1) {
      const shades = [], sizes = [];
      product.regularChildSkus.forEach(c => {
        const entry = { value: c.variationValue || c.skuId, image: c.smallImage || null, id: c.skuId, selected: c.skuId === sku.skuId };
        if (c.variationType === 'Shade') shades.push(entry); else if (c.variationType === 'Size') sizes.push(entry);
      });
      if (shades.length) variants.push({ name: 'Shade', values: shades });
      if (sizes.length) variants.push({ name: 'Size', values: sizes });
    }
    const specifications = {};
    if (product.ingredients) specifications['Ingredients'] = product.ingredients;
    if (product.howToUse) specifications['How to Use'] = product.howToUse;
    if (brand) specifications['Brand'] = brand;
    return {
      id: productId, title: name, description: desc, about: [],
      price: salePrice ? '$' + (salePrice * markup()).toFixed(2) : null, originalPrice: listPrice ? '$' + (listPrice * markup()).toFixed(2) : null,
      images: imgs.length > 0 ? imgs : [''], rating: product.rating || null, reviews: product.reviews || 0,
      variants, specifications, features: [], url: `https://www.sephora.com/product/${productId}`, source: 'sephora', storeName: 'Sephora',
      badge: product.isNew ? 'New' : null, brand, availability: null, category: product.parentCategory?.displayName || null
    };
  } catch (e) { console.error('Sephora detail error:', e.message); return null; }
}




app.listen(PORT, () => console.log(`DealsHub store on port ${PORT} â https://dealshub-search.onrender.com/store`));
