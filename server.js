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
// Save raw body for webhook HMAC verification before JSON parsing
app.use((req, res, next) => {
  if (req.path.startsWith('/webhooks/')) {
    let rawData = '';
    req.setEncoding('utf8');
    req.on('data', chunk => { rawData += chunk; });
    req.on('end', () => {
      req.rawBody = rawData;
      try { req.body = JSON.parse(rawData); } catch (e) { req.body = {}; }
      next();
    });
  } else {
    next();
  }
});
app.use((req, res, next) => {
  if (req.path.startsWith('/webhooks/')) return next(); // Already parsed above
  express.json({ limit: '1mb' })(req, res, next);
});

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
const { setupWebhooks } = require('./src/webhooks');
const { setupCRMApi } = require('./src/crm-api');
const { setupSubscriptionWebhooks } = require('./src/subscription-webhooks');
const newsletterRouter = require('./src/routes/newsletter');
const productImagesRouter = require('./src/routes/product-images');
const { STORES, getActiveStores, isStoreActive, classifyOrigin } = require('./src/config/stores');

// Initialize adapters
initAdapters({ rapidApiKey: process.env.RAPIDAPI_KEY });

// v1.6: Apply pricing markup to search result arrays so all prices shown are final customer prices
function applySearchPricing(products) {
  if (!Array.isArray(products)) return products;
  return products.map(p => {
    if (!p || !p.price) return p;
    const rawPrice = typeof p.price === 'number' ? p.price : parseFloat(String(p.price).replace(/[^0-9.]/g, ''));
    if (!rawPrice || rawPrice <= 0) return p;
    const source = (p.source || p.sourceName || 'amazon').toLowerCase();
    const rawOrig = p.originalPrice ? (typeof p.originalPrice === 'number' ? p.originalPrice : parseFloat(String(p.originalPrice).replace(/[^0-9.]/g, ''))) : null;
    const pricing = calculateFinalPrice(rawPrice, source, { originalPrice: rawOrig });
    if (pricing.price) {
      p.sourcePrice = rawPrice;
      p.price = pricing.price;
      if (pricing.compareAt) {
        p.sourceOriginalPrice = rawOrig;
        p.originalPrice = pricing.compareAt;
      }
    }
    return p;
  });
}

// ---- CRM CORS ----
app.use(['/api/customer', '/api/crm'], (req, res, next) => {
  const origin = req.headers.origin;
  const allowed = ['https://stylehubmiami.com', 'https://dealshub-search.onrender.com', 'http://localhost:3000'];
  if (allowed.includes(origin)) res.header('Access-Control-Allow-Origin', origin);
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type,X-Admin-Token');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ---- ADMIN DASHBOARD (static) ----
app.use('/admin', express.static(path.join(__dirname, 'public', 'admin')));

// ---- CRM MODULES ----
setupWebhooks(app);
setupCRMApi(app);
setupSubscriptionWebhooks(app);

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
app.use(newsletterRouter);
app.use(productImagesRouter);

// ============================================================
// CAPA A â LIVE DISCOVERY LAYER
// ============================================================

// ---- UNIFIED SEARCH ----
app.get('/api/search', async (req, res) => {
  const { q, store, limit = 20, page = 1, origin } = req.query;
  if (!q) return res.status(400).json({ error: 'Missing query parameter q' });

  // Only search active stores; if specific store requested, verify it's active
  let sources;
  if (store) {
    const s = store.toLowerCase();
    if (!isStoreActive(s)) {
      return res.status(400).json({ error: `Store ${s} is currently paused` });
    }
    sources = [s];
  } else {
    sources = getActiveStores();
  }
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

    // Add origin classification to each result
    allResults = allResults.map(p => {
      const o = classifyOrigin(p);
      p.originBadge = o.badge;
      p.originFlag = o.flag;
      p.originDelivery = o.deliveryEstimate;
      p.originType = o.origin; // 'USA' or 'INTL'
      return p;
    });

    // Filter by origin if requested (usa, intl, all)
    if (origin && origin !== 'all') {
      const oFilter = origin.toLowerCase();
      allResults = allResults.filter(p => {
        if (oFilter === 'usa') return p.originType === 'USA';
        if (oFilter === 'intl') return p.originType === 'INTL';
        return true;
      });
    }

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
      results: applySearchPricing(allResults.slice(0, limitNum))
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

    // Apply pricing engine markup — v1.6: overwrite product.price so frontend always shows final price
    // v1.8: Do NOT include shippingCost in landed cost for displayed price —
    // shipping is shown as a separate line on PDP, so including it here would double-charge.
    // The shipping cost is still stored in shippingData for display and for prepareCart landed cost.
    if (product.price) {
      const pricing = calculateFinalPrice(product.price, source, {
        originalPrice: product.originalPrice
      });
      // Save original source prices before overwriting
      product.sourcePrice = product.price;
      product.sourceOriginalPrice = product.originalPrice;
      // Overwrite with final marked-up prices so PDP displays what customer pays
      product.price = pricing.price;
      product.originalPrice = pricing.compareAt || product.originalPrice;
      product.displayPrice = `$${pricing.price.toFixed(2)}`;
      product.displayCompareAt = pricing.compareAt ? `$${pricing.compareAt.toFixed(2)}` : null;
      product.pricingMeta = {
        finalPrice: pricing.price,
        compareAt: pricing.compareAt,
        sourcePrice: product.sourcePrice,
        sourceOriginalPrice: product.sourceOriginalPrice,
        margin: pricing.marginPct
      };

      // Also apply markup to variant prices so PDP shows consistent marked-up prices
      // v1.8: No shippingCost in variant pricing either (shown separately on PDP)
      if (product.variants && product.variants.length) {
        product.variants = product.variants.map(v => {
          if (v.price && typeof v.price === 'number' && v.price > 0) {
            const vPricing = calculateFinalPrice(v.price, source, {});
            v.sourcePrice = v.price;
            v.price = vPricing.price;
          }
          return v;
        });
      }
    }

    // v2.0: Calculate shipping using new shipping-rules engine
    const { calculateShipping: calcShip } = require('./src/services/shipping-rules');
    const shipResult = calcShip(source, product.sourcePrice || product.price, product, false);
    product.shippingCalc = shipResult;
    // Also update legacy shippingData/deliveryEstimate/returnPolicy for backward compat
    product.shippingData = {
      cost: shipResult.cost,
      method: shipResult.method,
      note: shipResult.label === 'FREE' ? `FREE ${shipResult.method}` : `Shipping: $${shipResult.cost.toFixed(2)}`,
      isFBA: shipResult.isFBA || false,
      shipsFrom: shipResult.shipsFrom || null,
      isFree: shipResult.isFree || false,
      seller: shipResult.seller || null
    };
    // Pass through shipping options for AliExpress (carrier-level data)
    if (shipResult.shippingOptions?.length > 0) {
      product.shippingOptions = shipResult.shippingOptions;
    }
    product.deliveryEstimate = shipResult.delivery;
    product.returnPolicy = shipResult.returnWindow;

    // v3.0: Add origin classification (USA vs International)
    const originInfo = classifyOrigin(product);
    product.originType = originInfo.origin;
    product.originBadge = originInfo.badge;
    product.originFlag = originInfo.flag;
    product.originDelivery = originInfo.deliveryEstimate;

    // Fix return policy based on origin: USA warehouse = 30 days, International = 15 days
    if (originInfo.origin === 'USA' && product.source === 'aliexpress') {
      if (!product.returnPolicy || product.returnPolicy.window < 30) {
        product.returnPolicy = { window: 30, summary: 'Returns accepted within 30 days' };
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

// ---- SHIPPING CALCULATOR ----
const { calculateShipping } = require('./src/services/shipping-rules');

app.get('/api/shipping', async (req, res) => {
  const { store, productId, price, mode, plus } = req.query;
  if (!store) {
    return res.status(400).json({ error: 'Missing store parameter' });
  }
  try {
    const srcLower = store.toLowerCase();
    const sourcePrice = parseFloat(price) || 0;
    const isPlus = plus === 'true' || plus === '1';

    let productData = {};

    // "rules" mode: skip product fetch, use store rules only (fast, for cart)
    // "full" mode or default with productId: fetch product for Amazon delivery parsing
    if (mode !== 'rules' && productId) {
      const cacheKey = `product:${srcLower}:${productId}`;
      productData = productCache.get(cacheKey) || {};

      if (!productData.title) {
        try {
          const adapter = getAdapter(srcLower);
          if (adapter) {
            productData = await adapter.getProduct(productId);
          }
        } catch (fetchErr) {
          logger.warn('shipping', 'Product fetch failed, using rules only', { error: fetchErr.message, store, productId });
        }
      }
    }

    const result = calculateShipping(srcLower, sourcePrice, productData || {}, isPlus);

    const response = {
      store: srcLower,
      productId,
      isPlus,
      shipping: {
        cost: result.cost,
        label: result.label,
        method: result.method,
        isFree: result.isFree,
        isPlus: result.isPlus || false,
        isFBA: result.isFBA || false,
        shipsFrom: result.shipsFrom || null,
        seller: result.seller || null
      },
      delivery: result.delivery,
      threshold: result.threshold,
      remaining: result.remaining,
      thresholdNote: result.thresholdNote,
      plusSaves: result.plusSaves,
      plusNote: isPlus ? null : (result.plusSaves > 0 ? 'FREE with StyleHub Plus' : null),
      returnWindow: result.returnWindow
    };
    // Include carrier-level shipping options for AliExpress
    if (result.shippingOptions?.length > 0) {
      response.shippingOptions = result.shippingOptions;
    }
    res.json(response);
  } catch (e) {
    logger.error('shipping', 'Shipping calculation failed', { error: e.message, store, productId });
    res.status(500).json({ error: 'Failed to calculate shipping' });
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
      const priced = applySearchPricing(results);
      searchCache.set(cacheKey, priced);
      res.json(priced);
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
    const queries = { amazon: 'trending deals', aliexpress: 'hot products', sephora: 'trending beauty', macys: 'trending now', shein: 'trending' };
    const results = await Promise.allSettled(
      Object.entries(queries).filter(([source]) => isStoreActive(source)).map(([source, q]) => {
        const adapter = getAdapter(source);
        return adapter ? adapter.search(q, 6) : Promise.resolve([]);
      })
    );
    const all = interleaveFromSettled(results, 20);
    const response = { results: applySearchPricing(all), section: 'trending' };
    searchCache.set(cacheKey, response, 21600000); // 6 hours
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
    const queries = { amazon: 'best sellers', aliexpress: 'best selling products', sephora: 'best sellers beauty', macys: 'top rated', shein: 'best sellers' };
    const results = await Promise.allSettled(
      Object.entries(queries).filter(([source]) => isStoreActive(source)).map(([source, q]) => {
        const adapter = getAdapter(source);
        return adapter ? adapter.search(q, 6) : Promise.resolve([]);
      })
    );
    const raw = interleaveFromSettled(results, 30);
    // Filter: bestsellers should have meaningful reviews (>= 50)
    const filtered = raw.filter(p => {
      const revCount = parseInt(p.reviews) || 0;
      return revCount >= 50;
    });
    const all = filtered.length >= 5 ? filtered.slice(0, 20) : raw.slice(0, 20);
    const response = { results: applySearchPricing(all), section: 'bestsellers' };
    searchCache.set(cacheKey, response, 21600000); // 6 hours
    res.json(response);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- AMAZON BEST SELLERS (real /best-sellers endpoint) ----
// Types: BEST_SELLERS, NEW_RELEASES, MOST_WISHED_FOR, GIFT_IDEAS
// Categories: aps, electronics, beauty, fashion, garden, sporting, videogames, baby-products
app.get('/api/amazon-bestsellers', async (req, res) => {
  const type = req.query.type || 'BEST_SELLERS';
  const category = req.query.category || 'aps';
  const limit = Math.min(parseInt(req.query.limit) || 20, 50);
  const cacheKey = `amazon-bs:${type}:${category}`;
  const cached = searchCache.get(cacheKey);
  if (cached) return res.json(cached);

  try {
    const amazon = getAdapter('amazon');
    if (!amazon) throw new Error('Amazon adapter not available');
    const results = await amazon.getBestSellers(type, category, limit);
    const enriched = applySearchPricing(results);
    const response = { results: enriched, section: type.toLowerCase().replace(/_/g, '-'), category };
    searchCache.set(cacheKey, response, type === 'BEST_SELLERS' ? 21600000 : 43200000); // 6h or 12h
    res.json(response);
  } catch (e) {
    logger.error('api', `amazon-bestsellers error: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// ---- BEST VALUE INTERNATIONAL (AliExpress popular cheap items) ----
app.get('/api/best-value-intl', async (req, res) => {
  const maxPrice = parseFloat(req.query.maxPrice) || 15;
  const limit = Math.min(parseInt(req.query.limit) || 20, 30);
  const cacheKey = `best-value-intl:${maxPrice}`;
  const cached = searchCache.get(cacheKey);
  if (cached) return res.json(cached);

  try {
    const aliexpress = getAdapter('aliexpress');
    if (!aliexpress) throw new Error('AliExpress adapter not available');
    const results = await aliexpress.search('trending popular', 30);
    const filtered = results
      .filter(p => {
        const price = parseFloat(String(p.price || '0').replace(/[^0-9.]/g, ''));
        return price > 0 && price <= maxPrice;
      })
      .slice(0, limit);
    const enriched = applySearchPricing(filtered);
    const response = { results: enriched, section: 'best-value-intl' };
    searchCache.set(cacheKey, response, 21600000); // 6 hours
    res.json(response);
  } catch (e) {
    logger.error('api', `best-value-intl error: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// ---- NEW ARRIVALS ----
app.get('/api/new-arrivals', async (req, res) => {
  const cacheKey = 'new-arrivals';
  const cached = searchCache.get(cacheKey);
  if (cached) return res.json(cached);

  try {
    const queries = { amazon: 'new arrivals', aliexpress: 'new arrivals 2024', shein: 'new in', sephora: 'new arrivals', macys: 'new arrivals' };
    const results = await Promise.allSettled(
      Object.entries(queries).filter(([source]) => isStoreActive(source)).map(([source, q]) => {
        const adapter = getAdapter(source);
        return adapter ? adapter.search(q, 5) : Promise.resolve([]);
      })
    );
    const all = interleaveFromSettled(results, 20);
    const response = { results: applySearchPricing(all), section: 'new-arrivals' };
    searchCache.set(cacheKey, response, 21600000); // 6 hours
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
      getActiveStores().map(source => {
        const adapter = getAdapter(source);
        return adapter ? adapter.search(query, 4) : Promise.resolve([]);
      })
    );
    const all = interleaveFromSettled(results, 12);
    const response = { results: applySearchPricing(all), section: 'featured', category };
    searchCache.set(cacheKey, response, 21600000); // 6 hours
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
      getActiveStores().map(source => {
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
    const response = { results: applySearchPricing(all.length > 0 ? all : raw.slice(0, 12)), section: 'flash-deals' };
    searchCache.set(cacheKey, response, 3600000); // 1 hour
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
      // If store is paused, skip health check and report as paused
      if (!isStoreActive(name)) {
        health[name] = { status: 'paused', latencyMs: 0, note: 'Temporarily paused' };
        return;
      }
      const start = Date.now();
      try {
        const results = await adapter.search('test', 1);
        health[name] = { status: 'ok', latencyMs: Date.now() - start, resultCount: results.length };
      } catch (e) {
        health[name] = { status: 'error', latencyMs: Date.now() - start, error: e.message };
      }
    })
  );
  res.json({ sources: health, activeStores: getActiveStores(), timestamp: new Date().toISOString() });
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
  const { source, sourceId, selectedVariant, quantity = 1, forceResync = false, productData: clientProductData } = req.body;

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

    // v1.5: Use product data sent by frontend (PDP already fetched it) to skip redundant source API call
    let productData = null;

    if (clientProductData && clientProductData.title && clientProductData.price) {
      // Frontend sent the product data it already had from the PDP — use it directly
      productData = clientProductData;
      logger.info('cart', 'Using client-provided product data (skipping source API)', { source: srcLower, sourceId: srcId, title: (productData.title || '').substring(0, 50) });
    }

    if (!productData) {
      // Fallback 1: productCache (data from when PDP loaded via /api/product)
      const cachedProduct = productCache.get(`product:${srcLower}:${srcId}`);
      if (cachedProduct) {
        productData = cachedProduct;
        logger.info('cart', 'Using productCache (no API call needed)', { source: srcLower, sourceId: srcId });
      }
    }

    if (!productData) {
      // Fallback 2: actual source API call (only if nothing else available)
      logger.info('cart', 'No cached/client data — calling source API', { source: srcLower, sourceId: srcId });
      const adapter = getAdapter(srcLower);
      productData = await adapter.getProduct(sourceId);
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

// ---- DEBUG: Raw product API response (for shipping field discovery) ----
app.get('/api/debug/raw-product', async (req, res) => {
  const { store, id } = req.query;
  const source = (store || 'amazon').toLowerCase();
  if (!id) return res.status(400).json({ error: 'Missing id param' });
  if (!VALID_SOURCES.includes(source)) return res.status(400).json({ error: `Invalid source: ${source}` });

  const fetch = require('node-fetch');
  const rapidApiKey = process.env.RAPIDAPI_KEY;
  const hosts = {
    amazon: 'real-time-amazon-data.p.rapidapi.com',
    aliexpress: 'aliexpress-datahub.p.rapidapi.com',
    macys: 'macys4.p.rapidapi.com',
    sephora: 'sephora.p.rapidapi.com',
    shein: 'unofficial-shein.p.rapidapi.com'
  };
  const urls = {
    amazon: `https://${hosts.amazon}/product-details?asin=${encodeURIComponent(id)}&country=US`,
    aliexpress: `https://${hosts.aliexpress}/item_detail_2?itemId=${encodeURIComponent(id)}&language=en&currency=USD`,
    macys: `https://${hosts.macys}/api/products/${encodeURIComponent(id)}`,
    sephora: `https://${hosts.sephora}/us/products/v2/detail?productId=${encodeURIComponent(id)}`,
    shein: `https://${hosts.shein}/products/detail?goods_id=${encodeURIComponent(id)}&language=en&country=US&currency=USD`
  };
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    const start = Date.now();
    const resp = await fetch(urls[source], {
      headers: { 'x-rapidapi-key': rapidApiKey, 'x-rapidapi-host': hosts[source] },
      signal: controller.signal
    });
    clearTimeout(timer);
    const text = await resp.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) {}

    // Extract shipping-related fields from the raw response
    const shippingFields = {};
    function findShippingFields(obj, path = '') {
      if (!obj || typeof obj !== 'object') return;
      for (const [k, v] of Object.entries(obj)) {
        const fp = path ? `${path}.${k}` : k;
        if (/ship|deliver|freight|prime|fulfil|carrier|tracking|dispatch|transit/i.test(k)) {
          shippingFields[fp] = v;
        }
        if (typeof v === 'object' && v !== null && !Array.isArray(v) && fp.split('.').length < 4) {
          findShippingFields(v, fp);
        }
      }
    }
    if (json) findShippingFields(json);

    res.json({
      source, id,
      status: resp.status,
      latencyMs: Date.now() - start,
      shippingRelatedFields: shippingFields,
      topLevelKeys: json ? Object.keys(json) : null,
      dataKeys: json?.data ? Object.keys(json.data) : null,
      fullResponse: json ? JSON.stringify(json).substring(0, 8000) : text.substring(0, 5000)
    });
  } catch (e) {
    res.json({ source, id, error: e.message });
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

// ---- CUSTOMER ORDERS (via Admin API — includes cancelled/refunded) ----
app.get('/api/customer-orders', async (req, res) => {
  const { email } = req.query;
  if (!email) return res.status(400).json({ error: 'Missing email' });

  const shopifyDomain = process.env.SHOPIFY_STORE_DOMAIN;
  const shopifyToken = process.env.SHOPIFY_ADMIN_TOKEN;
  if (!shopifyDomain || !shopifyToken) {
    return res.status(503).json({ error: 'Shopify not configured' });
  }

  try {
    const fetch = require('node-fetch');
    // Fetch ALL orders for this customer email (any status)
    const url = `https://${shopifyDomain}/admin/api/2024-01/orders.json?email=${encodeURIComponent(email)}&status=any&limit=50`;
    const response = await fetch(url, {
      headers: { 'X-Shopify-Access-Token': shopifyToken, 'Content-Type': 'application/json' }
    });
    const data = await response.json();

    if (!data.orders) {
      return res.json({ orders: [], total: 0 });
    }

    // Collect unique product IDs to fetch images
    const productIds = new Set();
    data.orders.forEach(o => {
      (o.line_items || []).forEach(item => {
        if (item.product_id) productIds.add(item.product_id);
      });
    });

    // Fetch product images in batch (up to 250 per request)
    const imageMap = {};
    if (productIds.size > 0) {
      try {
        const idsStr = Array.from(productIds).join(',');
        const imgUrl = `https://${shopifyDomain}/admin/api/2024-01/products.json?ids=${idsStr}&fields=id,image,images`;
        const imgResp = await fetch(imgUrl, {
          headers: { 'X-Shopify-Access-Token': shopifyToken, 'Content-Type': 'application/json' }
        });
        const imgData = await imgResp.json();
        (imgData.products || []).forEach(p => {
          if (p.image && p.image.src) {
            imageMap[p.id] = p.image.src;
          } else if (p.images && p.images.length > 0) {
            imageMap[p.id] = p.images[0].src;
          }
        });
      } catch (imgErr) {
        logger.error('customer-orders', 'Failed to fetch product images', { error: imgErr.message });
      }
    }

    const orders = data.orders.map(o => ({
      id: o.id,
      name: o.name,
      order_number: o.order_number,
      created_at: o.created_at,
      financial_status: o.financial_status,
      fulfillment_status: o.fulfillment_status || 'unfulfilled',
      cancelled_at: o.cancelled_at || null,
      total_price: o.total_price,
      subtotal_price: o.subtotal_price,
      total_tax: o.total_tax,
      currency: o.currency,
      line_items: (o.line_items || []).map(item => ({
        product_id: item.product_id || null,
        variant_id: item.variant_id || null,
        title: item.title,
        variant_title: item.variant_title || null,
        quantity: item.quantity,
        price: item.price,
        sku: item.sku || null,
        image: imageMap[item.product_id] || null
      })),
      tracking_number: o.fulfillments?.[0]?.tracking_number || null,
      tracking_url: o.fulfillments?.[0]?.tracking_url || null,
      order_status_url: o.order_status_url || null
    }));

    res.json({ orders, total: orders.length });
  } catch (err) {
    logger.error('customer-orders', 'Failed to fetch customer orders', { error: err.message });
    res.status(500).json({ error: 'Failed to fetch orders' });
  }
});

// ---- UPDATE CUSTOMER PROFILE (via Admin API) ----
app.post('/api/update-customer', async (req, res) => {
  const { customer_id, first_name, last_name } = req.body;
  if (!customer_id) return res.status(400).json({ error: 'Missing customer_id' });

  const shopifyDomain = process.env.SHOPIFY_STORE_DOMAIN;
  const shopifyToken = process.env.SHOPIFY_ADMIN_TOKEN;
  if (!shopifyDomain || !shopifyToken) {
    return res.status(503).json({ error: 'Shopify not configured' });
  }

  try {
    const fetch = require('node-fetch');
    const url = `https://${shopifyDomain}/admin/api/2024-01/customers/${customer_id}.json`;
    const payload = { customer: { id: parseInt(customer_id) } };
    if (first_name !== undefined) payload.customer.first_name = first_name;
    if (last_name !== undefined) payload.customer.last_name = last_name;

    const response = await fetch(url, {
      method: 'PUT',
      headers: { 'X-Shopify-Access-Token': shopifyToken, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await response.json();

    if (data.customer) {
      res.json({
        success: true,
        customer: {
          id: data.customer.id,
          first_name: data.customer.first_name,
          last_name: data.customer.last_name,
          email: data.customer.email
        }
      });
    } else {
      res.status(400).json({ error: data.errors || 'Failed to update customer' });
    }
  } catch (err) {
    logger.error('update-customer', 'Failed to update customer', { error: err.message });
    res.status(500).json({ error: 'Failed to update customer' });
  }
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
// ---- THEME MANAGEMENT (list + duplicate) ----
app.get('/api/admin/themes', async (req, res) => {
  const shopifyDomain = process.env.SHOPIFY_STORE_DOMAIN;
  const shopifyToken = process.env.SHOPIFY_ADMIN_TOKEN;
  if (!shopifyDomain || !shopifyToken) return res.status(503).json({ error: 'Shopify not configured' });
  try {
    const fetch = require('node-fetch');
    const response = await fetch(`https://${shopifyDomain}/admin/api/2024-01/themes.json`, {
      headers: { 'X-Shopify-Access-Token': shopifyToken }
    });
    const data = await response.json();
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/theme-duplicate', express.json(), async (req, res) => {
  const shopifyDomain = process.env.SHOPIFY_STORE_DOMAIN;
  const shopifyToken = process.env.SHOPIFY_ADMIN_TOKEN;
  const sourceThemeId = req.body.source_theme_id || process.env.SHOPIFY_THEME_ID || '157178462339';
  const newName = req.body.name || 'BACKUP v2.0 - PRE REBRAND - NO TOCAR';
  if (!shopifyDomain || !shopifyToken) return res.status(503).json({ error: 'Shopify not configured' });

  try {
    const fetch = require('node-fetch');
    // Step 1: Get all assets from source theme
    const assetsUrl = `https://${shopifyDomain}/admin/api/2024-01/themes/${sourceThemeId}/assets.json`;
    const assetsResp = await fetch(assetsUrl, { headers: { 'X-Shopify-Access-Token': shopifyToken } });
    const assetsData = await assetsResp.json();
    if (!assetsResp.ok) return res.status(assetsResp.status).json({ error: 'Failed to list source assets', detail: assetsData });

    // Step 2: Create new empty theme
    const createUrl = `https://${shopifyDomain}/admin/api/2024-01/themes.json`;
    const createResp = await fetch(createUrl, {
      method: 'POST',
      headers: { 'X-Shopify-Access-Token': shopifyToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme: { name: newName, role: 'unpublished' } })
    });
    const createData = await createResp.json();
    if (!createResp.ok) return res.status(createResp.status).json({ error: 'Failed to create theme', detail: createData });

    const newThemeId = createData.theme.id;

    // Step 3: Copy each asset from source to new theme
    let copied = 0, failed = 0;
    const assetKeys = assetsData.assets.map(a => a.key);
    for (const key of assetKeys) {
      try {
        // Get asset content
        const getUrl = `https://${shopifyDomain}/admin/api/2024-01/themes/${sourceThemeId}/assets.json?asset[key]=${encodeURIComponent(key)}`;
        const getResp = await fetch(getUrl, { headers: { 'X-Shopify-Access-Token': shopifyToken } });
        if (!getResp.ok) { failed++; continue; }
        const assetData = await getResp.json();
        const asset = assetData.asset;
        // Put asset to new theme
        const putUrl = `https://${shopifyDomain}/admin/api/2024-01/themes/${newThemeId}/assets.json`;
        const putBody = asset.value != null
          ? { asset: { key: asset.key, value: asset.value } }
          : asset.attachment != null
            ? { asset: { key: asset.key, attachment: asset.attachment } }
            : null;
        if (!putBody) { failed++; continue; }
        const putResp = await fetch(putUrl, {
          method: 'PUT',
          headers: { 'X-Shopify-Access-Token': shopifyToken, 'Content-Type': 'application/json' },
          body: JSON.stringify(putBody)
        });
        if (putResp.ok) copied++; else failed++;
        // Rate limit: small delay
        await new Promise(r => setTimeout(r, 250));
      } catch (e) { failed++; }
    }

    res.json({ success: true, newThemeId, name: newName, totalAssets: assetKeys.length, copied, failed });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

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

// ---- ADMIN: Create/Update Shopify Page ----
app.post('/api/admin/create-page', async (req, res) => {
  const { title, handle, template_suffix, body_html } = req.body;
  if (!title) return res.status(400).json({ error: 'Missing title' });

  const shopifyDomain = process.env.SHOPIFY_STORE_DOMAIN;
  const shopifyToken = process.env.SHOPIFY_ADMIN_TOKEN;
  if (!shopifyDomain || !shopifyToken) {
    return res.status(503).json({ error: 'Shopify not configured' });
  }

  try {
    const fetch = require('node-fetch');
    // Check if page with handle already exists
    const listUrl = `https://${shopifyDomain}/admin/api/2024-01/pages.json?handle=${encodeURIComponent(handle || '')}`;
    const listResp = await fetch(listUrl, { headers: { 'X-Shopify-Access-Token': shopifyToken } });
    const listData = await listResp.json();
    const existing = (listData.pages || []).find(p => p.handle === handle);

    if (existing) {
      // Update existing page template if needed
      const updateUrl = `https://${shopifyDomain}/admin/api/2024-01/pages/${existing.id}.json`;
      const updateResp = await fetch(updateUrl, {
        method: 'PUT',
        headers: { 'X-Shopify-Access-Token': shopifyToken, 'Content-Type': 'application/json' },
        body: JSON.stringify({ page: { id: existing.id, template_suffix: template_suffix || handle, published: true } })
      });
      const updateData = await updateResp.json();
      logger.info('admin', 'Page updated', { handle, id: existing.id });
      return res.json({ success: true, action: 'updated', page: updateData.page });
    }

    // Create new page
    const createUrl = `https://${shopifyDomain}/admin/api/2024-01/pages.json`;
    const createResp = await fetch(createUrl, {
      method: 'POST',
      headers: { 'X-Shopify-Access-Token': shopifyToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        page: {
          title,
          handle: handle || title.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
          template_suffix: template_suffix || handle || '',
          body_html: body_html || '',
          published: true
        }
      })
    });

    if (!createResp.ok) {
      const errText = await createResp.text();
      return res.status(createResp.status).json({ error: 'Page creation failed', detail: errText.substring(0, 500) });
    }

    const createData = await createResp.json();
    logger.info('admin', 'Page created', { handle, id: createData.page.id });
    res.json({ success: true, action: 'created', page: createData.page });
  } catch (e) {
    logger.error('admin', 'Page creation error', { error: e.message });
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
    const scopes = 'read_all_orders,read_customers,write_customers,read_fulfillments,write_fulfillments,read_orders,write_orders,read_products,write_products,read_content,write_content,read_themes,write_themes';
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
    const tokenUrl = 'https://' + shop + '/admin/oauth/access_tokens.json';
    // Try form-urlencoded format (some Shopify setups require this)
    const tokenBody = new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code: code }).toString();
    logger.info('oauth', 'Exchanging code for token', { shop, clientId: clientId ? clientId.substring(0, 8) + '...' : 'MISSING', secretSet: !!clientSecret, secretPrefix: clientSecret ? clientSecret.substring(0, 10) : 'NONE' });
    const tokenResp = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
        'User-Agent': 'DealsHub-Backend/2.3'
      },
      body: tokenBody
    });
    const rawText = await tokenResp.text();
    let tokenData;
    try { tokenData = JSON.parse(rawText); } catch (e) {
      logger.error('oauth', 'Non-JSON response from Shopify', { status: tokenResp.status, body: rawText.substring(0, 500) });
      return res.status(500).send('<h2>Token Exchange Error</h2><p>Status: ' + tokenResp.status + '</p><pre>' + rawText.substring(0, 1000) + '</pre><p>Client ID: ' + (clientId || 'MISSING') + '</p><p>Client Secret set: ' + (!!clientSecret) + '</p>');
    }
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
// SHOPIFY WEBHOOKS + CRM — Moved to src/webhooks.js & src/crm-api.js
// ============================================================

// (Old inline webhooks + CRM code removed — now in src/webhooks.js & src/crm-api.js)

// (Old order-created webhook removed — now in src/webhooks.js)

// (Old order-fulfilled webhook removed — now in src/webhooks.js)

// (Old order-cancelled webhook removed — now in src/webhooks.js)

// (Old refund-created webhook removed — now in src/webhooks.js)

// (Old CRM API endpoints removed — now in src/crm-api.js)

// (Old customer update endpoint removed — now in src/crm-api.js as /api/customer/update-profile)

// ============================================================
// START
// ============================================================
// ---- WARM-UP: Pre-populate cache on startup to reduce perceived cold start ----
async function warmUpCache() {
  logger.info('server', 'Warming up cache (aggressive)...');
  const http = require('http');
  const selfBase = `http://localhost:${PORT}`;

  // Endpoints to pre-warm (same ones the home page loads)
  const endpoints = [
    '/api/trending',
    '/api/bestsellers',
    '/api/new-arrivals',
    '/api/flash-deals',
    '/api/featured?category=fashion',
    '/api/featured?category=beauty',
    '/api/featured?category=electronics',
  ];

  const fetchLocal = (urlPath) => new Promise((resolve) => {
    const url = selfBase + urlPath;
    const req = http.get(url, { timeout: 45000 }, (res) => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => resolve({ path: urlPath, status: res.statusCode, size: body.length }));
    });
    req.on('error', (e) => resolve({ path: urlPath, status: 'error', error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ path: urlPath, status: 'timeout' }); });
  });

  try {
    // Run all warm-ups in parallel for speed
    const results = await Promise.allSettled(endpoints.map(fetchLocal));
    let ok = 0, fail = 0;
    results.forEach(r => {
      if (r.status === 'fulfilled' && r.value.status === 200) {
        ok++;
        logger.info('server', `Warm-up OK: ${r.value.path} (${r.value.size} bytes)`);
      } else {
        fail++;
        const detail = r.status === 'fulfilled' ? r.value : r.reason;
        logger.warn('server', `Warm-up MISS: ${JSON.stringify(detail)}`);
      }
    });
    logger.info('server', `Warm-up complete: ${ok}/${endpoints.length} cached, ${fail} missed`);
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

  // ---- KEEP-ALIVE SELF-PING ----
  // Render free tier spins down after ~15min of inactivity.
  // This pings /health every 12 minutes to prevent cold starts.
  const KEEP_ALIVE_INTERVAL = 12 * 60 * 1000; // 12 minutes
  setInterval(async () => {
    try {
      const url = `http://localhost:${PORT}/health`;
      const resp = await fetch(url);
      if (resp.ok) {
        logger.info('server', `Keep-alive ping OK (uptime: ${Math.floor(process.uptime())}s)`);
      }
    } catch (e) {
      logger.warn('server', 'Keep-alive ping failed', { error: e.message });
    }
  }, KEEP_ALIVE_INTERVAL);
  logger.info('server', `Keep-alive enabled: self-ping every ${KEEP_ALIVE_INTERVAL / 60000}min`);
});

