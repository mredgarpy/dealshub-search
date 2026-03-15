// ============================================================
// DealsHub Ã¢ÂÂ Main Server (Hybrid Commerce Backend)
// ============================================================
// Architecture: Live Discovery + On-Demand Sync + Shopify Commerce
// ============================================================

const express = require('express');
const cors = require('cors');
const path = require('path');
const app = express();

// ---- MIDDLEWARE ----
app.use(cors({
  origin: [
    'https://stylehubmiami.com',
    'https://1rnmax-5z.myshopify.com',
    /\.myshopify\.com$/,
    'http://localhost:3000'
  ],
  credentials: true
}));
app.use(express.json({ limit: '1mb' }));

// Rate limiting (simple in-memory)
const rateLimits = new Map();
app.use((req, res, next) => {
  const ip = req.ip || req.connection.remoteAddress;
  const now = Date.now();
  const windowMs = 60000; // 1 min
  const maxRequests = 120;
  const key = `${ip}`;
  const record = rateLimits.get(key) || { count: 0, resetAt: now + windowMs };
  if (now > record.resetAt) { record.count = 0; record.resetAt = now + windowMs; }
  record.count++;
  rateLimits.set(key, record);
  if (record.count > maxRequests) {
    return res.status(429).json({ error: 'Too many requests' });
  }
  next();
});

// ---- CONFIG ----
const logger = require('./src/utils/logger');
const { searchCache, productCache } = require('./src/utils/cache');
const { initAdapters, getAdapter, getAllAdapters, VALID_SOURCES } = require('./src/adapters');
const { prepareCart } = require('./src/services/shopify-sync');
const { calculateFinalPrice, parsePrice } = require('./src/utils/pricing');
const { getShippingEstimate, getReturnPolicy, getShippingOptions } = require('./src/services/shipping');

// Initialize adapters
initAdapters({ rapidApiKey: process.env.RAPIDAPI_KEY });

// ---- HEALTH ----
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    version: '2.0.0',
    sources: VALID_SOURCES,
    cacheSize: { search: searchCache.size, product: productCache.size },
    uptime: process.uptime()
  });
});

// ============================================================
// CAPA A Ã¢ÂÂ LIVE DISCOVERY LAYER
// ============================================================

// ---- UNIFIED SEARCH ----
app.get('/api/search', async (req, res) => {
  const { q, store, limit = 20, page = 1 } = req.query;
  if (!q) return res.status(400).json({ error: 'Missing query parameter q' });

  const sources = store ? [store.toLowerCase()] : VALID_SOURCES;
  const limitNum = Math.min(parseInt(limit) || 20, 50);
  const cacheKey = `search:${q}:${sources.join(',')}:${page}:${limitNum}`;

  // Check cache
  const cached = searchCache.get(cacheKey);
  if (cached) return res.json(cached);

  try {
    const results = await Promise.allSettled(
      sources.map(s => {
        const adapter = getAdapter(s);
        return adapter ? adapter.search(q, limitNum) : Promise.resolve([]);
      })
    );

    let allResults = [];
    results.forEach((r, i) => {
      if (r.status === 'fulfilled' && Array.isArray(r.value)) {
        allResults.push(...r.value);
      } else {
        logger.warn('search', `Source ${sources[i]} failed`, { reason: r.reason?.message });
      }
    });

    // Interleave results from different sources for variety
    if (sources.length > 1) {
      allResults = interleaveResults(allResults, sources);
    }

    const response = {
      query: q,
      store: store || 'all',
      page: parseInt(page),
      limit: limitNum,
      total: allResults.length,
      results: allResults.slice(0, limitNum)
    };

    searchCache.set(cacheKey, response);
    res.json(response);
  } catch (e) {
    logger.error('search', 'Search failed', { error: e.message, query: q });
    res.status(500).json({ error: 'Search failed' });
  }
});

// ---- UNIFIED PRODUCT DETAIL ----
app.get('/api/product/:id', async (req, res) => {
  const { id } = req.params;
  const { store = 'amazon' } = req.query;
  const source = store.toLowerCase();

  if (!VALID_SOURCES.includes(source)) {
    return res.status(400).json({ error: `Invalid source: ${source}. Valid: ${VALID_SOURCES.join(', ')}` });
  }

  const cacheKey = `product:${source}:${id}`;
  const cached = productCache.get(cacheKey);
  if (cached) return res.json(cached);

  try {
    const adapter = getAdapter(source);
    if (!adapter) return res.status(400).json({ error: `Source ${source} not available` });

    const product = await adapter.getProduct(id);
    if (!product) {
      return res.status(404).json({ error: 'Product not found', source, id });
    }

    // Apply pricing
    if (product.price) {
      const pricing = calculateFinalPrice(product.price, source, {
        originalPrice: product.originalPrice,
        shippingCost: product.shippingData?.cost || 0
      });
      product.displayPrice = `$${pricing.price.toFixed(2)}`;
      product.displayCompareAt = pricing.compareAt ? `$${pricing.compareAt.toFixed(2)}` : null;
      product.pricingMeta = {
        finalPrice: pricing.price,
        compareAt: pricing.compareAt,
        sourcePrice: product.price,
        margin: pricing.marginPct
      };
    }

    productCache.set(cacheKey, product);
    res.json(product);
  } catch (e) {
    logger.error('product', 'Product detail failed', { error: e.message, source, id });
    res.status(500).json({ error: 'Failed to load product' });
  }
});

// ---- SEARCH BY INDIVIDUAL SOURCE (backward compatible) ----
VALID_SOURCES.forEach(source => {
  app.get(`/api/search/${source}`, async (req, res) => {
    const { q, limit = 20 } = req.query;
    if (!q) return res.status(400).json({ error: 'Missing query' });

    const cacheKey = `search:${source}:${q}:${limit}`;
    const cached = searchCache.get(cacheKey);
    if (cached) return res.json(cached);

    try {
      const adapter = getAdapter(source);
      const results = adapter ? await adapter.search(q, parseInt(limit)) : [];
      searchCache.set(cacheKey, results);
      res.json(results);
    } catch (e) {
      logger.error('search', `${source} search failed`, { error: e.message });
      res.json([]);
    }
  });
});

// ---- TRENDING ----
app.get('/api/trending', async (req, res) => {
  const cacheKey = 'trending';
  const cached = searchCache.get(cacheKey);
  if (cached) return res.json(cached);

  try {
    const queries = { amazon: 'trending deals', aliexpress: 'hot products', shein: 'trending' };
    const results = await Promise.allSettled(
      Object.entries(queries).map(([source, q]) => {
        const adapter = getAdapter(source);
        return adapter ? adapter.search(q, 6) : Promise.resolve([]);
      })
    );
    const all = interleaveFromSettled(results, 18);
    const response = { results: all, section: 'trending' };
    searchCache.set(cacheKey, response, 600000); // 10 min
    res.json(response);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- BESTSELLERS ----
app.get('/api/bestsellers', async (req, res) => {
  const cacheKey = 'bestsellers';
  const cached = searchCache.get(cacheKey);
  if (cached) return res.json(cached);

  try {
    const queries = { amazon: 'best sellers', sephora: 'best sellers beauty', macys: 'top rated' };
    const results = await Promise.allSettled(
      Object.entries(queries).map(([source, q]) => {
        const adapter = getAdapter(source);
        return adapter ? adapter.search(q, 6) : Promise.resolve([]);
      })
    );
    const all = interleaveFromSettled(results, 18);
    const response = { results: all, section: 'bestsellers' };
    searchCache.set(cacheKey, response, 600000);
    res.json(response);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- NEW ARRIVALS ----
app.get('/api/new-arrivals', async (req, res) => {
  const cacheKey = 'new-arrivals';
  const cached = searchCache.get(cacheKey);
  if (cached) return res.json(cached);

  try {
    const queries = { amazon: 'new arrivals', shein: 'new in', sephora: 'new arrivals', macys: 'new arrivals' };
    const results = await Promise.allSettled(
      Object.entries(queries).map(([source, q]) => {
        const adapter = getAdapter(source);
        return adapter ? adapter.search(q, 5) : Promise.resolve([]);
      })
    );
    const all = interleaveFromSettled(results, 18);
    const response = { results: all, section: 'new-arrivals' };
    searchCache.set(cacheKey, response, 600000);
    res.json(response);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- FEATURED BY CATEGORY ----
app.get('/api/featured', async (req, res) => {
  const { category = 'fashion' } = req.query;
  const cacheKey = `featured:${category}`;
  const cached = searchCache.get(cacheKey);
  if (cached) return res.json(cached);

  const categoryQueries = {
    fashion: 'women fashion', moda: 'women fashion',
    belleza: 'beauty skincare', beauty: 'beauty skincare',
    electronica: 'electronics gadgets', electronics: 'electronics gadgets',
    hogar: 'home decor', home: 'home decor',
    deportes: 'sports fitness', sports: 'sports fitness'
  };
  const query = categoryQueries[category.toLowerCase()] || category;

  try {
    const results = await Promise.allSettled(
      ['amazon', 'aliexpress', 'shein'].map(source => {
        const adapter = getAdapter(source);
        return adapter ? adapter.search(query, 4) : Promise.resolve([]);
      })
    );
    const all = interleaveFromSettled(results, 12);
    const response = { results: all, section: 'featured', category };
    searchCache.set(cacheKey, response, 600000);
    res.json(response);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- FLASH DEALS ----
app.get('/api/flash-deals', async (req, res) => {
  const cacheKey = 'flash-deals';
  const cached = searchCache.get(cacheKey);
  if (cached) return res.json(cached);

  try {
    const results = await Promise.allSettled(
      ['amazon', 'aliexpress', 'shein'].map(source => {
        const adapter = getAdapter(source);
        const q = source === 'amazon' ? 'deals under 20' : source === 'aliexpress' ? 'flash deals' : 'flash sale';
        return adapter ? adapter.search(q, 6) : Promise.resolve([]);
      })
    );
    const all = interleaveFromSettled(results, 12);
    const response = { results: all, section: 'flash-deals' };
    searchCache.set(cacheKey, response, 300000); // 5 min
    res.json(response);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- SOURCE HEALTH ----
app.get('/api/source-health', async (req, res) => {
  const health = {};
  const adapters = getAllAdapters();
  await Promise.allSettled(
    Object.entries(adapters).map(async ([name, adapter]) => {
      const start = Date.now();
      try {
        const results = await adapter.search('test', 1);
        health[name] = { status: 'ok', latencyMs: Date.now() - start, resultCount: results.length };
      } catch (e) {
        health[name] = { status: 'error', latencyMs: Date.now() - start, error: e.message };
      }
    })
  );
  res.json({ sources: health, timestamp: new Date().toISOString() });
});

// ============================================================
// CAPA B Ã¢ÂÂ ON-DEMAND SYNC LAYER
// ============================================================

// ---- PREPARE CART (Sync + Add to Cart) ----
app.post('/api/prepare-cart', async (req, res) => {
  const { source, sourceId, selectedVariant, quantity = 1 } = req.body;

  if (!source || !sourceId) {
    return res.status(400).json({ error: 'Missing source or sourceId' });
  }

  if (!VALID_SOURCES.includes(source.toLowerCase())) {
    return res.status(400).json({ error: `Invalid source: ${source}` });
  }

  try {
    // 1. Get full product data from source
    const adapter = getAdapter(source.toLowerCase());
    const productData = await adapter.getProduct(sourceId);

    if (!productData) {
      return res.status(404).json({ error: 'Product not found on source' });
    }

    // 2. Sync to Shopify and get cart-ready data
    const result = await prepareCart({
      source: source.toLowerCase(),
      sourceId: String(sourceId),
      productData,
      selectedVariantId: selectedVariant,
      quantity: parseInt(quantity) || 1
    });

    logger.info('cart', 'Cart prepared', {
      source, sourceId,
      variantId: result.shopifyVariantId,
      price: result.priceSnapshot.price
    });

    res.json(result);
  } catch (e) {
    logger.error('cart', 'Prepare cart failed', { error: e.message, source, sourceId });
    res.status(500).json({ error: 'Failed to prepare product for cart', detail: e.message });
  }
});

// ---- LEGACY: create-and-add (backward compatible) ----
app.post('/api/create-and-add', async (req, res) => {
  const { title, price, originalPrice, image, source, source_url, sourcePlatform, sourceUrl, product_id, variant_title } = req.body;

  if (!title || !price) {
    return res.status(400).json({ error: 'Missing title or price' });
  }

  const actualSource = sourcePlatform || source || 'amazon';
  const actualSourceUrl = sourceUrl || source_url || '';

  try {
    // Build minimal product data for sync
    const productData = {
      source: actualSource.toLowerCase(),
      sourceId: String(product_id || Date.now()),
      title,
      price: parsePrice(price),
      originalPrice: parsePrice(originalPrice),
      images: image ? [image] : [],
      primaryImage: image || '',
      brand: null,
      description: '',
      bullets: [],
      category: null,
      options: [],
      variants: [],
      sourceUrl: actualSourceUrl,
      shippingData: { note: 'Standard Shipping' },
      deliveryEstimate: { minDays: 5, maxDays: 14, label: '5-14 business days' },
      returnPolicy: { window: 30, summary: '30-day returns' },
      normalizedHandle: title.toLowerCase().replace(/[^a-z0-9]+/g, '-').substring(0, 100)
    };

    const result = await prepareCart({
      source: productData.source,
      sourceId: productData.sourceId,
      productData,
      selectedVariantId: variant_title,
      quantity: 1
    });

    res.json({
      success: true,
      variantId: result.shopifyVariantId,
      productId: result.shopifyProductId,
      productHandle: result.handle,
      checkout_url: result.checkoutUrl
    });
  } catch (e) {
    logger.error('legacy-cart', 'create-and-add failed', { error: e.message });
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
// CAPA D Ã¢ÂÂ OPERATIONS LAYER (Admin endpoints)
// ============================================================

// ---- ADMIN: Source Health Dashboard ----
app.get('/api/admin/source-health', async (req, res) => {
  // Same as public but with more detail
  const health = {};
  const adapters = getAllAdapters();
  await Promise.allSettled(
    Object.entries(adapters).map(async ([name, adapter]) => {
      const start = Date.now();
      try {
        const results = await adapter.search('test', 1);
        health[name] = {
          status: 'ok', latencyMs: Date.now() - start,
          resultCount: results.length,
          lastChecked: new Date().toISOString()
        };
      } catch (e) {
        health[name] = { status: 'error', latencyMs: Date.now() - start, error: e.message };
      }
    })
  );
  res.json({ sources: health, cache: { search: searchCache.size, product: productCache.size } });
});

// ---- SHIPPING & RETURNS ----
app.get('/api/shipping/:source', (req, res) => {
  const source = req.params.source.toLowerCase();
  if (!VALID_SOURCES.includes(source)) {
    return res.status(400).json({ error: 'Invalid source' });
  }
  const estimate = getShippingEstimate(source);
  const returnPolicy = getReturnPolicy(source);
  const options = getShippingOptions(source);
  res.json({ source, shipping: estimate, returnPolicy, allOptions: options });
});

// ---- ORDER STATUS (proxy to Shopify) ----
app.get('/api/order-status', async (req, res) => {
  const { order } = req.query;
  if (!order) return res.status(400).json({ error: 'Missing order number' });

  const shopifyDomain = process.env.SHOPIFY_STORE_DOMAIN;
  const shopifyToken = process.env.SHOPIFY_ADMIN_TOKEN;

  if (!shopifyDomain || !shopifyToken) {
    return res.status(503).json({ error: 'Shopify not configured' });
  }

  try {
    const fetch = require('node-fetch');
    const cleanOrder = order.replace('#', '');
    const url = `https://${shopifyDomain}/admin/api/2024-01/orders.json?name=%23${cleanOrder}&status=any&limit=1`;
    const response = await fetch(url, {
      headers: { 'X-Shopify-Access-Token': shopifyToken, 'Content-Type': 'application/json' }
    });
    const data = await response.json();

    if (data.orders && data.orders.length > 0) {
      const o = data.orders[0];
      res.json({
        order: {
          order_number: o.order_number,
          name: o.name,
          created_at: o.created_at,
          financial_status: o.financial_status,
          fulfillment_status: o.fulfillment_status || 'unfulfilled',
          total_price: o.total_price,
          currency: o.currency,
          line_items: (o.line_items || []).map(item => ({
            title: item.title,
            quantity: item.quantity,
            price: item.price
          })),
          tracking: o.fulfillments?.[0]?.tracking_number || null,
          tracking_url: o.fulfillments?.[0]?.tracking_url || null
        }
      });
    } else {
      res.status(404).json({ error: 'Order not found' });
    }
  } catch (e) {
    logger.error('order', 'Order lookup failed', { error: e.message });
    res.status(500).json({ error: 'Failed to look up order' });
  }
});

// ---- STATIC: Public assets (served with CORS for Shopify storefront) ----

// Proxy PDP JS from jsDelivr CDN (bypasses Render static caching issue)
const https = require('https');
app.get('/static/dealshub-product.js', (req, res) => {
  const cdnUrl = 'https://cdn.jsdelivr.net/gh/mredgarpy/dealshub-search@main/public/dealshub-product.js';
  https.get(cdnUrl, (cdnRes) => {
    if (cdnRes.statusCode >= 300 && cdnRes.statusCode < 400 && cdnRes.headers.location) {
      https.get(cdnRes.headers.location, (finalRes) => {
        res.set('Content-Type', 'application/javascript');
        res.set('Access-Control-Allow-Origin', '*');
        res.set('Cache-Control', 'public, max-age=300');
        finalRes.pipe(res);
      }).on('error', () => res.status(500).send('// CDN error'));
    } else {
      res.set('Content-Type', 'application/javascript');
      res.set('Access-Control-Allow-Origin', '*');
      res.set('Cache-Control', 'public, max-age=300');
      cdnRes.pipe(res);
    }
  }).on('error', () => res.status(500).send('// CDN error'));
});

app.use('/static', express.static(path.join(__dirname, 'public'), {
  maxAge: '1h',
  setHeaders: (res) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Cache-Control', 'public, max-age=3600');
  }
}));

// ---- ADMIN: Dashboard ----
app.use('/admin', express.static(path.join(__dirname, 'admin')));

// ---- ADMIN: Cache management ----
app.post('/api/admin/cache/clear', (req, res) => {
  searchCache.clear();
  productCache.clear();
  res.json({ success: true, message: 'All caches cleared' });
});

// ---- ADMIN: Product Mappings ----
const db = require('./src/utils/db');

app.get('/api/admin/mappings', (req, res) => {
  const { limit = 100, offset = 0 } = req.query;
  const mappings = db.getAllMappings(parseInt(limit), parseInt(offset));
  const count = db.getMappingCount();
  res.json({ mappings, total: count });
});

app.get('/api/admin/sync-logs', (req, res) => {
  const { limit = 50 } = req.query;
  const logs = db.getRecentSyncLogs(parseInt(limit));
  res.json({ logs });
});

app.get('/api/admin/stats', (req, res) => {
  const mappingCount = db.getMappingCount();
  res.json({
    mappings: mappingCount,
    cache: { search: searchCache.size, product: productCache.size },
    sources: VALID_SOURCES,
    uptime: process.uptime(),
    version: '2.1.0'
  });
});

// ---- ADMIN: Push Theme Asset (server-side Shopify API call) ----
app.put('/api/admin/theme-asset', async (req, res) => {
  const { key, value } = req.body;
  if (!key || !value) return res.status(400).json({ error: 'Missing key or value' });

  const shopifyDomain = process.env.SHOPIFY_STORE_DOMAIN;
  const shopifyToken = process.env.SHOPIFY_ADMIN_TOKEN;
  const themeId = process.env.SHOPIFY_THEME_ID || '157178462339';

  if (!shopifyDomain || !shopifyToken) {
    return res.status(503).json({ error: 'Shopify not configured' });
  }

  try {
    const fetch = require('node-fetch');
    const url = `https://${shopifyDomain}/admin/api/2024-01/themes/${themeId}/assets.json`;
    const response = await fetch(url, {
      method: 'PUT',
      headers: {
        'X-Shopify-Access-Token': shopifyToken,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ asset: { key, value } })
    });

    if (!response.ok) {
      const errText = await response.text();
      logger.error('theme', 'Theme asset push failed', { key, status: response.status });
      return res.status(response.status).json({ error: 'Shopify API error', detail: errText.substring(0, 500) });
    }

    const data = await response.json();
    logger.info('theme', 'Theme asset pushed', { key });
    res.json({ success: true, key: data.asset.key, size: data.asset.size });
  } catch (e) {
    logger.error('theme', 'Theme asset push error', { error: e.message, key });
    res.status(500).json({ error: e.message });
  }
});

// ---- ADMIN: Read Theme Asset ----
app.get('/api/admin/theme-asset', async (req, res) => {
  const { key } = req.query;
  if (!key) return res.status(400).json({ error: 'Missing key' });

  const shopifyDomain = process.env.SHOPIFY_STORE_DOMAIN;
  const shopifyToken = process.env.SHOPIFY_ADMIN_TOKEN;
  const themeId = process.env.SHOPIFY_THEME_ID || '157178462339';

  if (!shopifyDomain || !shopifyToken) {
    return res.status(503).json({ error: 'Shopify not configured' });
  }

  try {
    const fetch = require('node-fetch');
    const url = `https://${shopifyDomain}/admin/api/2024-01/themes/${themeId}/assets.json?asset[key]=${encodeURIComponent(key)}`;
    const response = await fetch(url, {
      headers: { 'X-Shopify-Access-Token': shopifyToken }
    });

    if (!response.ok) {
      return res.status(response.status).json({ error: 'Asset not found' });
    }

    const data = await response.json();
    res.json({ asset: data.asset });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- ADMIN: List Theme Assets ----
app.get('/api/admin/theme-assets', async (req, res) => {
  const shopifyDomain = process.env.SHOPIFY_STORE_DOMAIN;
  const shopifyToken = process.env.SHOPIFY_ADMIN_TOKEN;
  const themeId = process.env.SHOPIFY_THEME_ID || '157178462339';

  if (!shopifyDomain || !shopifyToken) {
    return res.status(503).json({ error: 'Shopify not configured' });
  }

  try {
    const fetch = require('node-fetch');
    const url = `https://${shopifyDomain}/admin/api/2024-01/themes/${themeId}/assets.json`;
    const response = await fetch(url, {
      headers: { 'X-Shopify-Access-Token': shopifyToken }
    });
    const data = await response.json();
    const keys = data.assets.map(a => a.key).sort();
    res.json({ total: keys.length, assets: keys });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
// HELPERS
// ============================================================

function interleaveResults(results, sources) {
  const grouped = {};
  results.forEach(r => {
    const s = r.source || 'unknown';
    if (!grouped[s]) grouped[s] = [];
    grouped[s].push(r);
  });
  const interleaved = [];
  const arrays = Object.values(grouped);
  const maxLen = Math.max(...arrays.map(a => a.length), 0);
  for (let i = 0; i < maxLen; i++) {
    for (const arr of arrays) {
      if (arr[i]) interleaved.push(arr[i]);
    }
  }
  return interleaved;
}

function interleaveFromSettled(results, maxTotal = 18) {
  const arrays = results.map(r => (r.status === 'fulfilled' && Array.isArray(r.value)) ? r.value : []);
  const interleaved = [];
  const maxLen = Math.max(...arrays.map(a => a.length), 0);
  for (let i = 0; i < maxLen && interleaved.length < maxTotal; i++) {
    for (const arr of arrays) {
      if (arr[i] && interleaved.length < maxTotal) interleaved.push(arr[i]);
    }
  }
  return interleaved;
}

// ============================================================
// START
// ============================================================
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  logger.info('server', `StyleHub backend v2.0 running on port ${PORT}`);
  logger.info('server', `Sources: ${VALID_SOURCES.join(', ')}`);
  logger.info('server', `Shopify: ${process.env.SHOPIFY_STORE_DOMAIN ? 'configured' : 'NOT configured'}`);
});
