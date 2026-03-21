// ============================================================
// DealsHub â Main Server (Hybrid Commerce Backend)
// ============================================================
// Architecture: Live Discovery + On-Demand Sync + Shopify Commerce
// ============================================================

const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
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
const { getShippingEstimate, getReturnPolicy, getShippingOptions, getShippingQuote, invalidateShippingCache } = require('./src/services/shipping');
const { invalidatePricingCache } = require('./src/utils/pricing');
const adminRouter = require('./src/routes/admin');

// Initialize adapters
initAdapters({ rapidApiKey: process.env.RAPIDAPI_KEY });

// ---- HEALTH ----
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    version: '2.4.0',
    sources: VALID_SOURCES,
    cacheSize: { search: searchCache.size, product: productCache.size },
    uptime: process.uptime()
  });
});

// ---- ADMIN ROUTES ----
app.use('/api/admin', adminRouter);

// ============================================================
// CAPA A â LIVE DISCOVERY LAYER
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
        // Filter out products with missing/zero prices
        const valid = r.value.filter(p => p && p.title && p.price && p.price !== '$0.00' && p.price !== '$NaN');
        allResults.push(...valid);
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
// Supports both: GET /api/product/:id?source=amazon  AND  GET /api/product?source=amazon&id=XXX
app.get('/api/product', (req, res) => {
  if (req.query.id) {
    req.params = { id: req.query.id };
    return productDetailHandler(req, res);
  }
  return res.status(400).json({ error: 'Missing id parameter' });
});
app.get('/api/product/:id', (req, res) => productDetailHandler(req, res));

async function productDetailHandler(req, res) {
  const id = req.params.id;
  const { store, source: sourceParam } = req.query;
  const source = (sourceParam || store || 'amazon').toLowerCase();

  if (!VALID_SOURCES.includes(source)) {
    return res.status(400).json({ error: `Invalid source: ${source}. Valid: ${VALID_SOURCES.join(', ')}` });
  }

  const cacheKey = `product:${source}:${id}`;
  const cached = productCache.get(cacheKey);
  if (cached) return res.json(cached);

  try {
    const adapter = getAdapter(source);
    if (!adapter) return res.status(400).json({ error: `Source ${source} not available` });

    const product = await adapter.getProduct(id, { title: req.query.title });
    if (!product) {
      return res.status(404).json({ error: 'Product not found', source, id });
    }

    // Apply pricing engine markup
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

      // Also apply markup to variant prices so PDP shows consistent marked-up prices
      if (product.variants && product.variants.length) {
        product.variants = product.variants.map(v => {
          if (v.price && typeof v.price === 'number' && v.price > 0) {
            const vPricing = calculateFinalPrice(v.price, source, {
              shippingCost: product.shippingData?.cost || 0
            });
            v.sourcePrice = v.price;
            v.price = vPricing.price;
          }
          return v;
        });
      }
    }

    // Only cache if returned product matches requested ID (prevent stale fallback pollution)
    const returnedId = String(product.sourceId || '');
    const requestedId = String(id);
    if (returnedId && returnedId !== requestedId) {
      logger.warn('product', `Source returned mismatched product`, { requested: requestedId, returned: returnedId, source });
      product._mismatch = true; // Flag but still return it for transparency
    }
    if (!product._mismatch) {
      productCache.set(cacheKey, product);
    }
    res.json(product);
  } catch (e) {
    logger.error('product', 'Product detail failed', { error: e.message, source, id });
    res.status(500).json({ error: 'Failed to load product' });
  }
}

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

// ---- SEARCH SUGGESTIONS (lightweight, fast) ----
app.get('/api/search-suggest', async (req, res) => {
  const { q } = req.query;
  if (!q || q.length < 2) return res.json({ suggestions: [] });

  const cacheKey = `suggest:${q}`;
  const cached = searchCache.get(cacheKey);
  if (cached) return res.json(cached);

  try {
    // Quick search across Amazon and one fast source for suggestions
    const results = await Promise.allSettled([
      getAdapter('amazon')?.search(q, 4) || Promise.resolve([]),
      getAdapter('aliexpress')?.search(q, 3) || Promise.resolve([])
    ]);

    const suggestions = [];
    results.forEach(r => {
      if (r.status === 'fulfilled' && Array.isArray(r.value)) {
        r.value.forEach(p => {
          if (p && p.title && suggestions.length < 6) {
            suggestions.push({
              title: p.title.substring(0, 80),
              price: p.price,
              image: p.image,
              source: p.source,
              id: p.id
            });
          }
        });
      }
    });

    const response = { query: q, suggestions };
    searchCache.set(cacheKey, response, 600000); // 10 min cache
    res.json(response);
  } catch (e) {
    logger.error('suggest', 'Search suggest failed', { error: e.message, query: q });
    res.json({ suggestions: [] });
  }
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
      ['amazon', 'aliexpress', 'sephora', 'macys', 'shein'].map(source => {
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
      ['amazon', 'aliexpress', 'sephora', 'macys', 'shein'].map(source => {
        const adapter = getAdapter(source);
        const q = source === 'amazon' ? 'deals best price'
          : source === 'aliexpress' ? 'sale hot products discount'
          : source === 'sephora' ? 'sale value set'
          : source === 'macys' ? 'clearance sale'
          : 'sale clearance';
        return adapter ? adapter.search(q, 5) : Promise.resolve([]);
      })
    );
    const raw = interleaveFromSettled(results, 30);
    // Filter: only products with real discounts, cap at 80%
    const all = raw.filter(p => {
      if (!p.originalPrice || !p.price) return true;
      const orig = parseFloat(String(p.originalPrice).replace(/[^0-9.]/g, ''));
      const curr = parseFloat(String(p.price).replace(/[^0-9.]/g, ''));
      if (!orig || !curr || orig <= curr) return false;
      return true;
    }).slice(0, 15);
    const response = { results: all.length > 0 ? all : raw.slice(0, 12), section: 'flash-deals' };
    searchCache.set(cacheKey, response, 300000); // 5 min
    res.json(response);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- RELATED PRODUCTS ----
app.get('/api/related', async (req, res) => {
  const { source, id, title, limit = 6 } = req.query;
  if (!source || !id) return res.status(400).json({ error: 'Missing source and id' });

  const cacheKey = `related:${source}:${id}`;
  const cached = searchCache.get(cacheKey);
  if (cached) return res.json(cached);

  try {
    // Use product title as search query to find similar items
    const searchQuery = title ? title.split(' ').slice(0, 3).join(' ') : id;
    const adapter = getAdapter(source);
    if (!adapter) return res.json({ results: [] });

    const results = await adapter.search(searchQuery, parseInt(limit) + 2);
    // Filter out the current product
    const filtered = (results || []).filter(r => String(r.id) !== String(id)).slice(0, parseInt(limit));
    const response = { results: filtered, source, relatedTo: id };
    searchCache.set(cacheKey, response, 1800000); // 30 min
    res.json(response);
  } catch (e) {
    logger.error('related', 'Related products failed', { error: e.message, source, id });
    res.json({ results: [] });
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



// ---- PRODUCT REVIEWS ----
app.get('/api/reviews/:id', async (req, res) => {
  const { id } = req.params;
  const { store, source: sourceParam, limit = 10 } = req.query;
  const source = (sourceParam || store || 'amazon').toLowerCase();

  if (!VALID_SOURCES.includes(source)) {
    return res.status(400).json({ error: 'Invalid source' });
  }

  const cacheKey = `reviews:${source}:${id}:${limit}`;
  const cached = productCache.get(cacheKey);
  if (cached) return res.json(cached);

  try {
    const adapter = getAdapter(source);
    if (!adapter || typeof adapter.getReviews !== 'function') {
      return res.status(404).json({ error: 'Reviews not available for this source', source });
    }

    const reviews = await adapter.getReviews(id, parseInt(limit) || 10);
    if (reviews) {
      productCache.set(cacheKey, reviews);
    }
    res.json(reviews || { reviews: [], summary: null });
  } catch (e) {
    logger.error('reviews', 'Reviews fetch failed', { error: e.message, source, id });
    res.status(500).json({ error: 'Failed to load reviews' });
  }
});

// ============================================================
// CAPA B â ON-DEMAND SYNC LAYER
// ============================================================

// ---- PREPARE CART (Sync + Add to Cart) ----
app.post('/api/prepare-cart', async (req, res) => {
  const { source, sourceId, selectedVariant, quantity = 1, forceResync = false } = req.body;

  if (!source || !sourceId) {
    return res.status(400).json({ error: 'Missing source or sourceId' });
  }

  if (!VALID_SOURCES.includes(source.toLowerCase())) {
    return res.status(400).json({ error: `Invalid source: ${source}` });
  }

  try {
    const srcLower = source.toLowerCase();
    const srcId = String(sourceId);

    // v1.2 FAST PATH: Check if mapping already exists before fetching from source API
    const { syncCache } = require('./src/utils/cache');
    const { findMapping } = require('./src/utils/db');
    const cacheKey = `mapping:${srcLower}:${srcId}`;
    const cachedMapping = !forceResync && syncCache.get(cacheKey);
    const dbMapping = !cachedMapping && !forceResync && findMapping(srcLower, srcId);

    if (cachedMapping && cachedMapping.shopifyVariantId) {
      // FAST PATH: Already synced, skip source API entirely
      let variantId = cachedMapping.shopifyVariantId;
      if (selectedVariant && cachedMapping.variants?.length > 1) {
        const norm = s => (s || '').trim().toLowerCase().replace(/^option:\s*/i, '');
        const match = cachedMapping.variants.find(v => {
          const vt = norm(v.title), sv = norm(selectedVariant);
          return vt === sv || vt.includes(sv) || sv.includes(vt);
        });
        if (match) variantId = match.id;
      }
      logger.info('cart', 'FAST PATH: cache hit, skipping source fetch', { source: srcLower, sourceId: srcId, variantId });
      return res.json({
        success: true,
        shopifyProductId: cachedMapping.shopifyProductId,
        shopifyVariantId: variantId,
        handle: cachedMapping.handle,
        quantity: parseInt(quantity) || 1,
        availability: true,
        isNewlyCreated: false,
        priceSnapshot: { price: cachedMapping.variants?.[0]?.price || 0, compareAt: null, currency: 'USD' },
        shippingSummary: { note: 'Standard shipping', deliveryLabel: null }
      });
    }

    // 1. Get full product data from source (needed for new product creation)
    const adapter = getAdapter(srcLower);
    let productData = await adapter.getProduct(sourceId);

    // Fallback: try productCache if source adapter failed (e.g. SHEIN detail API down)
    if (!productData) {
      const cachedProduct = productCache.get(`product:${srcLower}:${srcId}`);
      if (cachedProduct) {
        logger.info('cart', 'Source adapter failed, using productCache fallback', { source: srcLower, sourceId: srcId });
        productData = cachedProduct;
      }
    }

    if (!productData) {
      return res.status(404).json({ error: 'Product not found on source' });
    }

    // 2. Sync to Shopify and get cart-ready data
    const result = await prepareCart({
      source: srcLower,
      sourceId: srcId,
      productData,
      selectedVariantId: selectedVariant,
      quantity: parseInt(quantity) || 1,
      forceResync
    });

    logger.info('cart', 'Cart prepared', {
      source: srcLower, sourceId: srcId,
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
// CAPA D â OPERATIONS LAYER (Admin endpoints)
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

// ---- DEBUG: Raw API Response Diagnostic ----
app.get('/api/debug/raw-search', async (req, res) => {
  const { store, q = 'shoes' } = req.query;
  const source = (store || 'aliexpress').toLowerCase();
  if (!VALID_SOURCES.includes(source)) {
    return res.status(400).json({ error: `Invalid source: ${source}` });
  }

  const fetch = require('node-fetch');
  const rapidApiKey = process.env.RAPIDAPI_KEY;

  const hosts = {
    aliexpress: 'aliexpress-datahub.p.rapidapi.com',
    macys: 'macys4.p.rapidapi.com',
    amazon: 'real-time-amazon-data.p.rapidapi.com',
    sephora: 'sephora.p.rapidapi.com',
    shein: 'unofficial-shein.p.rapidapi.com'
  };

  const urls = {
    aliexpress: `https://${hosts.aliexpress}/item_search_3?q=${encodeURIComponent(q)}&page=1&sort=default`,
    macys: `https://${hosts.macys}/search?keyword=${encodeURIComponent(q)}&pageSize=3&requestType=search`,
    amazon: `https://${hosts.amazon}/search?query=${encodeURIComponent(q)}&page=1&country=US&sort_by=RELEVANCE`,
    sephora: `https://${hosts.sephora}/us/products/v2/search?q=${encodeURIComponent(q)}&pageIndex=0&pageSize=3`,
    shein: `https://${hosts.shein}/products/search?keywords=${encodeURIComponent(q)}&language=en&country=US&currency=USD&page=1&limit=3&_t=${Date.now()}`
  };

  const url = urls[source];
  const host = hosts[source];

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    const start = Date.now();
    const resp = await fetch(url, {
      headers: { 'x-rapidapi-key': rapidApiKey, 'x-rapidapi-host': host },
      signal: controller.signal
    });
    clearTimeout(timer);
    const latency = Date.now() - start;
    const text = await resp.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) { /* not json */ }

    res.json({
      source,
      query: q,
      url: url.replace(rapidApiKey, 'REDACTED'),
      status: resp.status,
      statusText: resp.statusText,
      latencyMs: latency,
      headers: Object.fromEntries([...resp.headers.entries()].filter(([k]) =>
        ['content-type', 'x-ratelimit-remaining', 'x-ratelimit-limit', 'x-ratelimit-reset',
         'x-rapidapi-proxy-response', 'x-rapidapi-subscription'].some(h => k.toLowerCase().includes(h))
      )),
      responsePreview: json ? {
        topLevelKeys: Object.keys(json),
        hasProducts: !!(json.data?.products || json.products || json.result?.resultList ||
                       json.searchresultgroups || json.info?.products || json.items),
        sampleData: JSON.stringify(json).substring(0, 3000)
      } : {
        rawText: text.substring(0, 2000)
      }
    });
  } catch (e) {
    res.json({ source, error: e.message, type: e.name });
  }
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

// ---- SHIPPING QUOTE (for PDP — merges source data with rules) ----
app.get('/api/shipping-quote', async (req, res) => {
  const { source, id } = req.query;
  if (!source || !id) return res.status(400).json({ error: 'Missing source and id' });
  if (!VALID_SOURCES.includes(source.toLowerCase())) {
    return res.status(400).json({ error: 'Invalid source' });
  }

  const cacheKey = `shipquote:${source}:${id}`;
  const cached = productCache.get(cacheKey);
  if (cached) return res.json(cached);

  try {
    // Try to get product data for source-specific shipping info
    let productData = productCache.get(`product:${source}:${id}`);
    if (!productData) {
      const adapter = getAdapter(source.toLowerCase());
      if (adapter) {
        productData = await adapter.getProduct(id);
      }
    }
    const quote = getShippingQuote(source.toLowerCase(), productData || {});
    productCache.set(cacheKey, quote, 3600000); // 1hr
    res.json(quote);
  } catch (e) {
    // Fallback to basic estimate
    const quote = getShippingQuote(source.toLowerCase(), {});
    res.json(quote);
  }
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
  const advanced = db.getAdvancedStats();
  const recentSyncCount = Array.isArray(advanced.recentSyncs)
    ? advanced.recentSyncs.reduce((sum, r) => sum + (r.count || 0), 0)
    : 0;
  res.json({
    totalProducts: advanced.mappingCount || 0,
    totalMappings: advanced.mappingCount || 0,
    totalOrders: advanced.orderCount || 0,
    recentSyncs: recentSyncCount,
    unresolvedFailures: advanced.failureCount || 0,
    mappingsBySource: advanced.mappingsBySource || [],
    ordersBySource: advanced.ordersBySource || [],
    cache: { search: searchCache.size, product: productCache.size },
    sources: VALID_SOURCES,
    uptime: process.uptime(),
    version: '2.3.0'
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
      const errText = await response.text();
      return res.status(response.status).json({ error: 'Asset not found', status: response.status, detail: errText.substring(0, 300) });
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
    if (!response.ok) {
      const errText = await response.text();
      return res.status(response.status).json({ error: `Shopify API ${response.status}`, detail: errText.substring(0, 500), domain: shopifyDomain, themeId });
    }
    const data = await response.json();
    if (!data || !data.assets) {
      return res.status(500).json({ error: 'Unexpected response format', data: JSON.stringify(data).substring(0, 500) });
    }
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
  const arrays = results.map(r => (r.status === 'fulfilled' && Array.isArray(r.value))
    ? r.value.filter(p => p && p.title && p.price && p.price !== '$0.00' && p.price !== '$NaN')
    : []);
  const interleaved = [];
  const seen = new Set(); // Deduplicate by id+source
  const maxLen = Math.max(...arrays.map(a => a.length), 0);
  for (let i = 0; i < maxLen && interleaved.length < maxTotal; i++) {
    for (const arr of arrays) {
      if (arr[i] && interleaved.length < maxTotal) {
        const key = `${arr[i].source || arr[i].sourceName || ''}:${arr[i].id || arr[i].title || ''}`;
        if (!seen.has(key)) {
          seen.add(key);
          interleaved.push(arr[i]);
        }
      }
    }
  }
  return interleaved;
}

// ---- SHOPIFY OAUTH: App install/reinstall flow for scope approval ----
app.get('/', (req, res) => {
  const { shop, hmac, host } = req.query;
  if (shop) {
    const clientId = process.env.SHOPIFY_CLIENT_ID;
    const scopes = 'read_all_orders,read_customers,read_fulfillments,write_fulfillments,read_orders,write_orders,read_products,write_products,read_content,write_content,read_themes,write_themes';
    const redirectUri = 'https://dealshub-search.onrender.com/oauth/callback';
    const authUrl = 'https://' + shop + '/admin/oauth/authorize?client_id=' + clientId + '&scope=' + scopes + '&redirect_uri=' + encodeURIComponent(redirectUri);
    return res.redirect(authUrl);
  }
  res.json({ status: 'DealsHub Backend v2.3', endpoints: ['/api/search', '/api/trending', '/api/bestsellers', '/api/new-arrivals', '/api/featured', '/api/product', '/api/prepare-cart'] });
});

app.get('/oauth/callback', async (req, res) => {
  const { code, shop, hmac } = req.query;
  if (!code || !shop) return res.status(400).send('Missing code or shop parameter');
  try {
    const clientId = process.env.SHOPIFY_CLIENT_ID;
    const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;
    const tokenResp = await fetch('https://' + shop + '/admin/oauth/access_tokens.json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code: code })
    });
    const tokenData = await tokenResp.json();
    if (tokenData.access_token) {
      logger.info('oauth', 'New access token obtained for ' + shop + ': ' + tokenData.access_token.substring(0, 15) + '...');
      res.send('<h2>DealsHub App Installed Successfully</h2><p>Access token obtained. First 15 chars: <code>' + tokenData.access_token.substring(0, 15) + '...</code></p><p>Full token (update in Render env vars): <code>' + tokenData.access_token + '</code></p><p>Scopes: ' + (tokenData.scope || 'unknown') + '</p><p><a href="https://admin.shopify.com/store/' + shop.replace('.myshopify.com', '') + '">Back to Shopify Admin</a></p>');
    } else {
      logger.error('oauth', 'Token exchange failed', tokenData);
      res.status(500).send('<h2>Token Exchange Failed</h2><pre>' + JSON.stringify(tokenData, null, 2) + '</pre>');
    }
  } catch (err) {
    logger.error('oauth', 'OAuth callback error', { error: err.message });
    res.status(500).send('OAuth error: ' + err.message);
  }
});

// ---- ADMIN: THEME FILE UPDATE (temporary) ----
app.post('/api/admin/theme-update', express.json(), async (req, res) => {
  try {
    const adminToken = process.env.SHOPIFY_ADMIN_TOKEN;
    const storeDomain = process.env.SHOPIFY_STORE_DOMAIN;
    const themeId = '157178462339';
    if (!adminToken || !storeDomain) return res.status(500).json({ error: 'Missing Shopify credentials' });
    const { key, replacements } = req.body;
    if (!key || !replacements || !Array.isArray(replacements)) return res.status(400).json({ error: 'Need key and replacements array [{from, to}]' });
    const getUrl = 'https://' + storeDomain + '/admin/api/2024-01/themes/' + themeId + '/assets.json?asset[key]=' + encodeURIComponent(key);
    const getResp = await fetch(getUrl, { headers: { 'X-Shopify-Access-Token': adminToken, 'Content-Type': 'application/json' } });
    if (!getResp.ok) { const e = await getResp.text(); return res.status(getResp.status).json({ error: 'GET failed', detail: e.substring(0, 300) }); }
    const assetData = await getResp.json();
    let value = assetData.asset.value;
    const applied = [];
    for (const r of replacements) { const b = value; value = value.split(r.from).join(r.to); if (value !== b) applied.push(r.from + ' -> ' + r.to); }
    if (applied.length === 0) return res.json({ message: 'No changes needed', key });
    const putUrl = 'https://' + storeDomain + '/admin/api/2024-01/themes/' + themeId + '/assets.json';
    const putResp = await fetch(putUrl, { method: 'PUT', headers: { 'X-Shopify-Access-Token': adminToken, 'Content-Type': 'application/json' }, body: JSON.stringify({ asset: { key, value } }) });
    if (!putResp.ok) { const e = await putResp.text(); return res.status(putResp.status).json({ error: 'PUT failed', detail: e.substring(0, 300) }); }
    res.json({ success: true, key, applied });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
// SHOPIFY WEBHOOKS (CRM)
// ============================================================

// Verify Shopify webhook HMAC signature
function verifyShopifyWebhook(req) {
  const hmac = req.headers['x-shopify-hmac-sha256'];
  const secret = process.env.SHOPIFY_WEBHOOK_SECRET || process.env.SHOPIFY_CLIENT_SECRET;
  if (!hmac || !secret) return false;
  const body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
  const hash = crypto.createHmac('sha256', secret)
    .update(body, 'utf8').digest('base64');
  return crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(hash));
}

// In-memory CRM store (replace with DB in production)
const crmOrders = new Map();

// Webhook: New order created
app.post('/webhooks/order-created', express.raw({ type: 'application/json' }), (req, res) => {
  try {
    // Parse body (may be Buffer from express.raw or object from express.json)
    const body = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : JSON.stringify(req.body);
    const hmac = req.headers['x-shopify-hmac-sha256'];

    const webhookSecret = process.env.SHOPIFY_WEBHOOK_SECRET || process.env.SHOPIFY_CLIENT_SECRET;
    if (hmac && webhookSecret) {
      const hash = crypto.createHmac('sha256', webhookSecret)
        .update(body, 'utf8').digest('base64');
      if (!crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(hash))) {
        logger.warn('webhook', 'HMAC verification failed for order-created');
        return res.status(401).send('Unauthorized');
      }
    }

    const order = JSON.parse(body);
    const orderData = {
      id: order.id,
      name: order.name || `#${order.order_number}`,
      email: order.customer?.email || order.email,
      totalPrice: order.total_price,
      currency: order.currency,
      lineItems: (order.line_items || []).map(li => ({
        title: li.title,
        quantity: li.quantity,
        price: li.price,
        vendor: li.vendor,
        sku: li.sku,
        properties: li.properties
      })),
      status: 'created',
      createdAt: order.created_at,
      fulfillmentStatus: order.fulfillment_status || 'unfulfilled',
      financialStatus: order.financial_status,
      shippingAddress: order.shipping_address,
      trackingNumbers: [],
      events: [{ type: 'created', at: new Date().toISOString() }]
    };

    crmOrders.set(order.id, orderData);
    logger.info('webhook', `[CRM] New order: ${orderData.name} - $${order.total_price} ${order.currency} - ${orderData.lineItems.length} items`);

    res.status(200).send('OK');
  } catch (err) {
    logger.error('webhook', 'Error processing order-created webhook', { error: err.message });
    res.status(200).send('OK'); // Always return 200 to prevent Shopify retries
  }
});

// Webhook: Order fulfilled (AutoDS synced tracking)
app.post('/webhooks/order-fulfilled', express.raw({ type: 'application/json' }), (req, res) => {
  try {
    const body = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : JSON.stringify(req.body);
    const hmac = req.headers['x-shopify-hmac-sha256'];

    const webhookSecret = process.env.SHOPIFY_WEBHOOK_SECRET || process.env.SHOPIFY_CLIENT_SECRET;
    if (hmac && webhookSecret) {
      const hash = crypto.createHmac('sha256', webhookSecret)
        .update(body, 'utf8').digest('base64');
      if (!crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(hash))) {
        return res.status(401).send('Unauthorized');
      }
    }

    const order = JSON.parse(body);
    const tracking = order.fulfillments?.[0]?.tracking_number || 'N/A';
    const carrier = order.fulfillments?.[0]?.tracking_company || 'N/A';
    const trackingUrl = order.fulfillments?.[0]?.tracking_url || null;

    // Update CRM record
    const existing = crmOrders.get(order.id);
    if (existing) {
      existing.status = 'fulfilled';
      existing.fulfillmentStatus = 'fulfilled';
      existing.trackingNumbers = order.fulfillments?.map(f => ({
        number: f.tracking_number,
        company: f.tracking_company,
        url: f.tracking_url
      })) || [];
      existing.events.push({ type: 'fulfilled', at: new Date().toISOString(), tracking, carrier });
    }

    logger.info('webhook', `[CRM] Order fulfilled: ${order.name || order.id} - ${carrier}: ${tracking}`);
    res.status(200).send('OK');
  } catch (err) {
    logger.error('webhook', 'Error processing order-fulfilled webhook', { error: err.message });
    res.status(200).send('OK');
  }
});

// Webhook: Order cancelled
app.post('/webhooks/order-cancelled', express.raw({ type: 'application/json' }), (req, res) => {
  try {
    const body = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : JSON.stringify(req.body);
    const hmac = req.headers['x-shopify-hmac-sha256'];

    const webhookSecret = process.env.SHOPIFY_WEBHOOK_SECRET || process.env.SHOPIFY_CLIENT_SECRET;
    if (hmac && webhookSecret) {
      const hash = crypto.createHmac('sha256', webhookSecret)
        .update(body, 'utf8').digest('base64');
      if (!crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(hash))) {
        return res.status(401).send('Unauthorized');
      }
    }

    const order = JSON.parse(body);
    const existing = crmOrders.get(order.id);
    if (existing) {
      existing.status = 'cancelled';
      existing.events.push({ type: 'cancelled', at: new Date().toISOString(), reason: order.cancel_reason });
    }

    logger.info('webhook', `[CRM] Order cancelled: ${order.name || order.id} - Reason: ${order.cancel_reason || 'N/A'}`);
    res.status(200).send('OK');
  } catch (err) {
    logger.error('webhook', 'Error processing order-cancelled webhook', { error: err.message });
    res.status(200).send('OK');
  }
});

// Webhook: Refund created
app.post('/webhooks/refund-created', express.raw({ type: 'application/json' }), (req, res) => {
  try {
    const body = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : JSON.stringify(req.body);
    const hmac = req.headers['x-shopify-hmac-sha256'];

    const webhookSecret = process.env.SHOPIFY_WEBHOOK_SECRET || process.env.SHOPIFY_CLIENT_SECRET;
    if (hmac && webhookSecret) {
      const hash = crypto.createHmac('sha256', webhookSecret)
        .update(body, 'utf8').digest('base64');
      if (!crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(hash))) {
        return res.status(401).send('Unauthorized');
      }
    }

    const refund = JSON.parse(body);
    const orderId = refund.order_id;
    const existing = crmOrders.get(orderId);
    if (existing) {
      existing.events.push({
        type: 'refund',
        at: new Date().toISOString(),
        refundId: refund.id,
        amount: refund.transactions?.reduce((sum, t) => sum + parseFloat(t.amount || 0), 0) || 0
      });
    }

    logger.info('webhook', `[CRM] Refund created for order: ${orderId} - Refund ID: ${refund.id}`);
    res.status(200).send('OK');
  } catch (err) {
    logger.error('webhook', 'Error processing refund-created webhook', { error: err.message });
    res.status(200).send('OK');
  }
});

// CRM API: Get order data (for admin panel)
app.get('/api/crm/orders', (req, res) => {
  const orders = Array.from(crmOrders.values()).sort((a, b) =>
    new Date(b.createdAt) - new Date(a.createdAt)
  );
  res.json({ orders, total: orders.length });
});

app.get('/api/crm/orders/:id', (req, res) => {
  const order = crmOrders.get(parseInt(req.params.id));
  if (!order) return res.status(404).json({ error: 'Order not found in CRM' });
  res.json(order);
});

// ============================================================
// START
// ============================================================
// ---- WARM-UP: Pre-populate cache on startup to reduce perceived cold start ----
async function warmUpCache() {
  logger.info('server', 'Warming up cache...');
  try {
    const adapter = getAdapter('amazon');
    if (adapter) {
      const results = await adapter.search('trending deals', 6);
      if (results.length > 0) {
        const valid = results.filter(p => p && p.title && p.price && p.price !== '$0.00');
        searchCache.set('trending', { results: valid, section: 'trending' }, 600000);
        logger.info('server', `Warm-up: cached ${valid.length} trending results`);
      }
    }
  } catch (e) {
    logger.warn('server', 'Warm-up failed (non-critical)', { error: e.message });
  }
}

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  logger.info('server', `StyleHub backend v2.3 running on port ${PORT}`);
  logger.info('server', `Sources: ${VALID_SOURCES.join(', ')}`);
  logger.info('server', `Shopify: ${process.env.SHOPIFY_STORE_DOMAIN ? 'configured' : 'NOT configured'}`);
  // Warm up cache after server starts (don't await â let it run in background)
  setTimeout(warmUpCache, 2000);
});
