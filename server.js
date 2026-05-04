// ============================================================
// DealsHub â Main Server (Hybrid Commerce Backend)
// ============================================================
// Architecture: Live Discovery + On-Demand Sync + Shopify Commerce
// ============================================================

const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const blacklist = require('./src/blacklist');
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
const { prepareCart, shopifyAPI: shopifyAPIDirect } = require('./src/services/shopify-sync');
const { callWizard: callBridgeWizard } = require('./src/services/autods-wizard');
const cartJobs = require('./src/services/cart-job-queue');
const { calculateFinalPrice, parsePrice } = require('./src/utils/pricing');
const { getShippingEstimate, getReturnPolicy, getShippingOptions, getShippingQuote, invalidateShippingCache } = require('./src/services/shipping');
const { invalidatePricingCache } = require('./src/utils/pricing');
const adminRouter = require('./src/routes/admin');
const { setupWebhooks } = require('./src/webhooks');
const { setupCRMApi } = require('./src/crm-api');
const { setupSubscriptionWebhooks } = require('./src/subscription-webhooks');
const newsletterRouter = require('./src/routes/newsletter');
const productImagesRouter = require('./src/routes/product-images');
const { setupTicketsApi } = require('./src/tickets-api');
const { STORES, getActiveStores, isStoreActive, classifyOrigin } = require('./src/config/stores');

// Initialize adapters
initAdapters({ rapidApiKey: process.env.RAPIDAPI_KEY });

// v3.5: Decode HTML entities in product text fields (titles, descriptions, bullets)
function decodeHtmlEntities(str) {
  if (!str || typeof str !== 'string') return str;
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&#x2F;/g, '/')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

// v3.5: Clean product text fields — decode entities in title, description, bullets
function cleanProductText(p) {
  if (!p) return p;
  if (p.title) {
    p.title = decodeHtmlEntities(p.title);
    // v3.6: Remove store-name prefixes from titles (e.g. "Amazon.com: Blink..." → "Blink...")
    p.title = p.title
      .replace(/^Amazon\.com\s*:\s*/i, '')
      .replace(/^Amazon\.com\s+/i, '')
      .replace(/^AliExpress\s*[-:]\s*/i, '')
      .replace(/^Sephora\s*[-:]\s*/i, '')
      .replace(/^SHEIN\s*[-:]\s*/i, '')
      .replace(/^Macy'?s\s*[-:]\s*/i, '')
      .trim();
  }
  if (p.description && typeof p.description === 'string') p.description = decodeHtmlEntities(p.description);
  if (Array.isArray(p.bullets)) p.bullets = p.bullets.map(b => decodeHtmlEntities(b));
  if (p.brand) p.brand = decodeHtmlEntities(p.brand);
  return p;
}

// v1.6: Apply pricing markup to search result arrays so all prices shown are final customer prices
function applySearchPricing(products) {
  if (!Array.isArray(products)) return products;
  return products.map(p => {
    if (!p || !p.price) return p;
    cleanProductText(p); // v3.5: decode HTML entities
    const rawPrice = typeof p.price === 'number' ? p.price : parseFloat(String(p.price).replace(/[^0-9.]/g, ''));
    if (!rawPrice || rawPrice <= 0) return p;
    const source = (p.source || p.sourceName || 'amazon').toLowerCase();
    const rawOrig = p.originalPrice ? (typeof p.originalPrice === 'number' ? p.originalPrice : parseFloat(String(p.originalPrice).replace(/[^0-9.]/g, ''))) : null;
    // Pass sourceCost (wholesale price) for AliExpress tier-based pricing
    const rawSourceCost = p.sourceCost ? (typeof p.sourceCost === 'number' ? p.sourceCost : parseFloat(String(p.sourceCost).replace(/[^0-9.]/g, ''))) : null;
    const pricing = calculateFinalPrice(rawPrice, source, { originalPrice: rawOrig, sourceCost: rawSourceCost, deliveryInfo: p.deliveryInfo || null });
    if (pricing.price) {
      p.sourcePrice = rawPrice;
      p.sourceCost = rawSourceCost;
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
setupTicketsApi(app);

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

// ---- CATEGORY MAP: dropdown values → API parameters per source ----
const CATEGORY_MAP = {
  'women fashion':  { amazonCatId: 'fashion-womens', aliQuery: 'women clothing fashion' },
  'men fashion':    { amazonCatId: 'fashion-mens',   aliQuery: 'men clothing fashion' },
  'beauty':         { amazonCatId: 'beauty',         aliQuery: 'beauty makeup cosmetics' },
  'skincare':       { amazonCatId: 'beauty',         aliQuery: 'skincare face cream serum' },
  'electronics':    { amazonCatId: 'electronics',    aliQuery: 'electronics gadgets' },
  'phones':         { amazonCatId: 'mobile-apps',    aliQuery: 'phone accessories smartphone' },
  'home garden':    { amazonCatId: 'garden',         aliQuery: 'home decor kitchen garden' },
  'sports':         { amazonCatId: 'sporting',       aliQuery: 'sports fitness outdoor' },
  'kids':           { amazonCatId: 'baby-products',  aliQuery: 'kids toys children' },
  'shoes':          { amazonCatId: 'shoes',          aliQuery: 'shoes sneakers boots' },
  'accessories':    { amazonCatId: 'fashion',        aliQuery: 'accessories watch sunglasses' },
  'bags':           { amazonCatId: 'fashion',        aliQuery: 'bags purses backpack' },
  'jewelry':        { amazonCatId: 'jewelry',        aliQuery: 'jewelry necklace ring bracelet' },
};

// ---- UNIFIED SEARCH ----
app.get('/api/search', async (req, res) => {
  // Prevent browsers/CDNs from caching stale prices
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');

  const { q, store, limit = 20, page = 1, origin, category } = req.query;
  if (!q) return res.status(400).json({ error: 'Missing query parameter q' });

  // Resolve category config
  const catKey = (category || '').toLowerCase().trim();
  const catConfig = CATEGORY_MAP[catKey] || null;

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
  const cacheKey = `search:${q}:${sources.join(',')}:${page}:${limitNum}:${catKey || 'all'}`;

  // Check cache
  const cached = searchCache.get(cacheKey);
  if (cached) return res.json(cached);

  const pageNum = parseInt(page) || 1;
  try {
    const results = await Promise.allSettled(
      sources.map(s => {
        const adapter = getAdapter(s);
        if (!adapter) return Promise.resolve([]);
        // Pass category-specific params and page per source
        if (s === 'amazon' && catConfig) {
          return adapter.search(q, limitNum, { categoryId: catConfig.amazonCatId, page: pageNum });
        }
        if (s === 'aliexpress' && catConfig && catConfig.aliQuery) {
          return adapter.search(q + ' ' + catConfig.aliQuery, limitNum, { page: pageNum });
        }
        return adapter.search(q, limitNum, { page: pageNum });
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

    const pricedResults = applySearchPricing(allResults.slice(0, limitNum));

    // ── BLACKLIST FILTER — Remove DMCA blocked products ──
    const filteredResults = blacklist.filterProducts(pricedResults);
    if (filteredResults.length < pricedResults.length) {
      logger.info('search', `Blacklist filtered ${pricedResults.length - filteredResults.length} products from "${q}"`);
    }

    const response = {
      query: q,
      store: store || 'all',
      page: pageNum,
      limit: limitNum,
      total: filteredResults.length,
      hasMore: filteredResults.length >= Math.floor(limitNum * 0.5),
      results: filteredResults
    };

    searchCache.set(cacheKey, response);

    // v3.1: Cache individual search results by source+id for product detail fallback
    // This solves AliExpress ID mismatch where search returns IDs that item_detail doesn't recognize
    if (Array.isArray(filteredResults)) {
      filteredResults.forEach(p => {
        if (p && p.id && p.source) {
          const itemKey = `searchitem:${p.source}:${p.id}`;
          productCache.set(itemKey, p, 1800000); // 30min TTL
        }
      });
    }

    res.json(response);
  } catch (e) {
    logger.error('search', 'Search failed', { error: e.message, query: q });
    res.status(500).json({ error: 'Search failed' });
  }
});

// ---- BLACKLIST CHECK (PDP pre-flight) ----
app.get('/api/product/check', (req, res) => {
  const { source, id } = req.query;
  if (!source || !id) return res.status(400).json({ error: 'source and id required' });
  const result = blacklist.checkProduct({ store: source, id });
  res.json({ source, id, allowed: !result.blocked, reason: result.reason });
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
  // Prevent browsers/CDNs from caching stale prices
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');

  const id = req.params.id;
  const { store, source: sourceParam } = req.query;
  const source = (sourceParam || store || 'amazon').toLowerCase();

  if (!VALID_SOURCES.includes(source)) {
    return res.status(400).json({ error: `Invalid source: ${source}. Valid: ${VALID_SOURCES.join(', ')}` });
  }

  // ── BLACKLIST CHECK — Block DMCA products from loading ──
  if (blacklist.isProductBlocked(source, id)) {
    logger.info('product', `Blocked DMCA product: ${source}:${id}`);
    return res.status(403).json({ error: 'This product is not available', blocked: true });
  }

  const cacheKey = `product:${source}:${id}`;
  const cached = productCache.get(cacheKey);
  if (cached) return res.json(cached);

  let step = 'init';
  try {
    step = 'adapter';
    const adapter = getAdapter(source);
    if (!adapter) return res.status(400).json({ error: `Source ${source} not available` });

    step = 'getProduct';
    let product = await adapter.getProduct(id, { title: req.query.title });

    // v3.1: If adapter returned null, try search result cache fallback
    // This handles AliExpress new-format IDs (3256...) that item_detail doesn't recognize
    if (!product) {
      const searchItemKey = `searchitem:${source}:${id}`;
      const cachedSearchItem = productCache.get(searchItemKey);
      if (cachedSearchItem) {
        logger.info('product', 'Using cached search item as fallback', { source, id });
        // Convert search result card to full product shape
        const { emptyProduct } = require('./src/adapters/base');
        product = emptyProduct();
        product.source = source;
        product.sourceName = cachedSearchItem.sourceName || source;
        product.sourceId = String(cachedSearchItem.id || id);
        product.title = cachedSearchItem.title || '';
        product.price = typeof cachedSearchItem.price === 'number' ? cachedSearchItem.price : null;
        product.originalPrice = typeof cachedSearchItem.originalPrice === 'number' ? cachedSearchItem.originalPrice : null;
        product.images = cachedSearchItem.image ? [cachedSearchItem.image] : [];
        product.primaryImage = product.images[0] || '';
        product.rating = cachedSearchItem.rating || null;
        product.reviews = cachedSearchItem.reviews || 0;
        product.badge = cachedSearchItem.badge || null;
        product.availability = 'In Stock';
        product.stockSignal = 'in_stock';
        product.sourceUrl = cachedSearchItem.url || '';
        product.normalizedHandle = (product.title || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').substring(0, 100);
        product._fromSearchCache = true;
        // Origin data from search cache
        product.originType = cachedSearchItem.originType || 'INTL';
        product.originBadge = cachedSearchItem.originBadge || "Int'l";
        product.originFlag = cachedSearchItem.originFlag || '🌍';
        product.originDelivery = cachedSearchItem.originDelivery || '10-25 days';
      }
    }

    // v3.1: Last resort — build minimal product from URL params (title, image, price hints)
    if (!product && req.query.title) {
      logger.info('product', 'Building minimal product from URL params', { source, id, title: req.query.title });
      const { emptyProduct } = require('./src/adapters/base');
      product = emptyProduct();
      product.source = source;
      product.sourceName = source === 'aliexpress' ? 'AliExpress' : source;
      product.sourceId = String(id);
      product.title = decodeURIComponent(req.query.title);
      product.primaryImage = req.query.image ? decodeURIComponent(req.query.image) : '';
      product.images = product.primaryImage ? [product.primaryImage] : [];
      const hintPrice = parseFloat(req.query.price);
      product.price = !isNaN(hintPrice) && hintPrice > 0 ? hintPrice : null;
      product.availability = 'In Stock';
      product.stockSignal = 'in_stock';
      product._fromUrlParams = true;
    }

    if (!product) {
      // FIX: Return helpful 404 with suggested alternatives
      let alternatives = [];
      try {
        const adapter = getAdapter(source);
        if (adapter) {
          // Search using the product ID as query (works for ASINs and sometimes AliExpress IDs)
          const altResults = await adapter.search(id, 6);
          if (altResults && altResults.length > 0) {
            alternatives = applySearchPricing(altResults.slice(0, 6));
          }
        }
      } catch (altErr) {
        // Non-critical — just return empty alternatives
      }

      // 2026-04-24: Self-healing dead-product filter.
      // When /api/product can't resolve, mark the id as dead so future home
      // feeds (/api/trending, /api/bestsellers, /api/new-arrivals, /api/featured,
      // /api/search) skip it via blacklist.filterProducts(). Also purge cached
      // feeds so the fix takes effect on the next request instead of waiting
      // for TTL (1h) to expire.
      try {
        const added = blacklist.addProduct(source, id, 'dead_listing:404 - auto-detected by /api/product');
        if (added) {
          logger.info('product', `Auto-blacklisted dead product`, { source, id });
          // Invalidate home-feed caches so this product disappears immediately
          ['trending', 'bestsellers', 'new-arrivals'].forEach(k => searchCache.del && searchCache.del(k));
          // featured is cached per category; nuke common ones
          ['featured:fashion','featured:beauty','featured:electronics','featured:home','featured:sports',
           'featured:moda','featured:belleza','featured:electronica','featured:hogar','featured:deportes']
            .forEach(k => searchCache.del && searchCache.del(k));
        }
      } catch (blErr) {
        logger.warn('product', 'Auto-blacklist failed (non-fatal)', { error: blErr.message, source, id });
      }

      return res.status(404).json({
        error: 'Product not found',
        message: 'This product may no longer be available.',
        source,
        id,
        alternatives
      });
    }

    // v3.2: Price recovery cascade — multiple fallback sources
    step = 'priceRecovery';
    if (!product.price || product.price <= 0) {
      const { parsePrice: pp } = require('./src/utils/pricing');

      // SOURCE 1: bestOffer/allOffers from adapter raw data
      if (product.bestOffer?.offerPrice) {
        const bp = pp(product.bestOffer.offerPrice);
        if (bp && bp > 0) { product.price = bp; logger.info('product', 'Price recovered from bestOffer', { id, price: bp }); }
      }
      if ((!product.price || product.price <= 0) && Array.isArray(product.allOffers)) {
        for (const o of product.allOffers) {
          const op = pp(o.price);
          if (op && op > 0) { product.price = op; logger.info('product', 'Price recovered from allOffers', { id, price: op }); break; }
        }
      }

      // SOURCE 2: Search result cache (user came from search which had prices)
      if (!product.price || product.price <= 0) {
        const searchItemKey = `searchitem:${source}:${id}`;
        const cachedSearchItem = productCache.get(searchItemKey);
        if (cachedSearchItem && cachedSearchItem.price && cachedSearchItem.price > 0) {
          product.price = cachedSearchItem.price;
          if (!product.originalPrice && cachedSearchItem.originalPrice) product.originalPrice = cachedSearchItem.originalPrice;
          logger.info('product', 'Price recovered from search cache', { id, price: product.price });
        }
      }

      // SOURCE 3: Price hint from URL params (passed from search result cards)
      if (!product.price || product.price <= 0) {
        const hintPrice = parseFloat(req.query.price);
        if (!isNaN(hintPrice) && hintPrice > 0) {
          product.price = hintPrice;
          const hintOrig = parseFloat(req.query.originalPrice);
          if (!isNaN(hintOrig) && hintOrig > product.price) product.originalPrice = hintOrig;
          logger.info('product', 'Price recovered from URL hint', { id, price: product.price });
        }
      }

      // If still no price after all fallbacks, mark as unavailable
      if (!product.price || product.price <= 0) {
        product.priceUnavailable = true;
        product.displayPrice = 'Price unavailable';
        logger.warn('product', 'No price available after all fallbacks', { id, source });
      } else {
        // Price WAS recovered by the cascade — clear any priceUnavailable flag set by the adapter
        if (product.priceUnavailable) {
          delete product.priceUnavailable;
          delete product.displayPrice;
          logger.info('product', 'Price recovered via cascade, cleared priceUnavailable', { id, source, price: product.price });
        }
      }
    }

    // Apply pricing engine markup
    step = 'pricingEngine';
    if (product.price && product.price > 0) {
      const pricing = calculateFinalPrice(product.price, source, {
        originalPrice: product.originalPrice,
        sourceCost: product.sourceCost || null,
        deliveryInfo: product.deliveryInfo || product.shippingData || null
      });
      // Save original source prices before overwriting
      product.sourcePrice = product.price;
      product.sourceOriginalPrice = product.originalPrice;
      product.sourceCostRaw = product.sourceCost || null;
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
        sourceCost: product.sourceCostRaw,
        multiplier: pricing.multiplier,
        margin: pricing.marginPct,
        ruleType: pricing.ruleType
      };

      // Also apply markup to variant prices so PDP shows consistent marked-up prices
      step = 'variantPricing';
      if (product.variants && product.variants.length) {
        product.variants = product.variants.map(v => {
          if (v.price && typeof v.price === 'number' && v.price > 0) {
            const vPricing = calculateFinalPrice(v.price, source, {
              sourceCost: v.sourceCost || product.sourceCostRaw || null,
              deliveryInfo: product.deliveryInfo || product.shippingData || null
            });
            v.sourcePrice = v.price;
            v.price = vPricing.price;
          }
          return v;
        });
      }
    }

    // v2.0: Calculate shipping using new shipping-rules engine
    step = 'shippingCalc';
    try {
      const { calculateShipping: calcShip } = require('./src/services/shipping-rules');
      const shipResult = calcShip(source, product.sourcePrice || product.price, product, false);
      product.shippingCalc = shipResult;
      product.shippingData = {
        cost: shipResult.cost,
        method: shipResult.method,
        note: shipResult.label === 'FREE' ? `FREE ${shipResult.method}` : `Shipping: $${(shipResult.cost || 0).toFixed(2)}`,
        isFBA: shipResult.isFBA || false,
        shipsFrom: shipResult.shipsFrom || null,
        isFree: shipResult.isFree || false,
        seller: shipResult.seller || null
      };
      if (shipResult.shippingOptions?.length > 0) {
        product.shippingOptions = shipResult.shippingOptions;
      }
      product.deliveryEstimate = shipResult.delivery;
      product.returnPolicy = shipResult.returnWindow;
    } catch (shipErr) {
      logger.warn('product', 'Shipping calc failed, using defaults', { error: shipErr.message, source, id });
      // Fallback: keep whatever shippingData the adapter already set
      if (!product.shippingData) product.shippingData = { cost: 0, method: 'Standard', note: 'Standard shipping' };
      if (!product.deliveryEstimate) product.deliveryEstimate = { label: '7-21 business days', minDays: 7, maxDays: 21 };
      if (!product.returnPolicy) product.returnPolicy = { window: 30, summary: '30-day returns' };
    }

    // v3.0: Add origin classification (USA vs International)
    step = 'originClassification';
    try {
      const originInfo = classifyOrigin(product);
      product.originType = originInfo.origin;
      product.originBadge = originInfo.badge;
      product.originFlag = originInfo.flag;
      product.originDelivery = originInfo.deliveryEstimate;

      // Fix return policy based on origin: USA warehouse = 30 days, International = 15 days
      if (originInfo.origin === 'USA' && product.source === 'aliexpress') {
        const rpDays = product.returnPolicy?.window || product.returnPolicy?.days || 15;
        if (rpDays < 30) {
          product.returnPolicy = { window: 30, days: 30, summary: 'Returns accepted within 30 days' };
        }
      }
    } catch (originErr) {
      logger.warn('product', 'Origin classification failed', { error: originErr.message, source, id });
      product.originType = 'UNKNOWN';
      product.originBadge = '—';
    }

    // Only cache if returned product matches requested ID (prevent stale fallback pollution)
    step = 'cacheAndReturn';
    const returnedId = String(product.sourceId || '');
    const requestedId = String(id);
    if (returnedId && returnedId !== requestedId) {
      logger.warn('product', `Source returned mismatched product`, { requested: requestedId, returned: returnedId, source });
      product._mismatch = true; // Flag but still return it for transparency
    }
    cleanProductText(product); // v3.5: decode HTML entities
    if (!product._mismatch) {
      productCache.set(cacheKey, product, 1800000); // 30min TTL
    }
    res.json(product);

    // ── PDP PRE-WARM (Fase 2) ──
    // Fire-and-forget: kick off the AutoDS Single Product wizard so by the
    // time the customer clicks Add to Cart (avg 60-180s on PDP), the product
    // is already Connected and /api/prepare-cart hits the cache → instant
    // auto-fulfill. No-op if feature flag disabled or bridge not configured.
    // Dedup: cartJobs.findLiveJob prevents concurrent calls for the same ASIN.
    try {
      if (
        process.env.USE_ASYNC_WIZARD_PREPARE_CART === 'true' &&
        process.env.AUTODS_BRIDGE_URL &&
        !product._mismatch &&
        !product.priceUnavailable
      ) {
        // Skip if a Shopify mapping already exists (cache or DB) — wizard
        // would just create a duplicate.
        const { syncCache } = require('./src/utils/cache');
        const { findMapping } = require('./src/utils/db');
        const existingMapping = syncCache.get(`mapping:${source}:${id}`) || findMapping(source, id);
        if (!existingMapping) {
          _kickoffWizardPrewarm({
            source,
            sourceId: id,
            productData: product,
            selectedVariant: null,
            sourceUrl: product.sourceUrl || product.url || null,
            smid: product?.bestOffer?.sellerId || product?.rawSourceMeta?.bestOfferSellerId || null,
            userAgent: req.headers['user-agent'] || null
          });
        }
      }
    } catch (e) {
      // Pre-warm errors must NEVER affect the PDP response
      logger.warn('product', `[prewarm] non-fatal: ${e.message}`);
    }
  } catch (e) {
    logger.error('product', 'Product detail failed', { error: e.message, step, source, id, stack: e.stack?.split('\n').slice(0, 3).join(' | ') });
    res.status(500).json({ error: 'Failed to load product', step, detail: e.message });
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
      const filtered = blacklist.filterProducts(priced);
      searchCache.set(cacheKey, filtered);
      res.json(filtered);
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
    const response = { results: blacklist.filterProducts(applySearchPricing(all)), section: 'trending' };
    searchCache.set(cacheKey, response, 3600000); // 1 hour
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
    const response = { results: blacklist.filterProducts(applySearchPricing(all)), section: 'bestsellers' };
    searchCache.set(cacheKey, response, 3600000); // 1 hour
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
    searchCache.set(cacheKey, response, type === 'BEST_SELLERS' ? 3600000 : 3600000); // 1 hour
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
    searchCache.set(cacheKey, response, 3600000); // 1 hour
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
    const response = { results: blacklist.filterProducts(applySearchPricing(all)), section: 'new-arrivals' };
    searchCache.set(cacheKey, response, 3600000); // 1 hour
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
    const response = { results: blacklist.filterProducts(applySearchPricing(all)), section: 'featured', category };
    searchCache.set(cacheKey, response, 3600000); // 1 hour
    res.json(response);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- RECOMMENDATIONS ----
app.get('/api/recommendations', async (req, res) => {
  const { id, title = '', category = '', source: sourceParam = 'amazon' } = req.query;
  if (!id) return res.status(400).json({ error: 'Missing product id' });

  function extractKeywords(t) {
    const stopWords = new Set(['for','the','and','with','in','of','a','an','to','by','men','mens',"men's",'women','womens',"women's",'pack','set','pcs','piece','1','2','3','4','5','6','7','8','9','10','new','from','all']);
    var words = t.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/)
      .filter(w => w.length > 2 && !stopWords.has(w));
    return words.slice(0, 4).join(' ');
  }

  let keywords = extractKeywords(title);

  // FIX: If no keywords from title, try to recover from product cache
  if (!keywords) {
    const source = (sourceParam).toLowerCase();
    const cachedProduct = productCache.get(`product:${source}:${id}`);
    if (cachedProduct && cachedProduct.title) {
      keywords = extractKeywords(cachedProduct.title);
      console.log(`[recommendations] Recovered keywords from product cache for ${id}: "${keywords}"`);
    }
  }

  // FIX: If still no keywords, use the product ID as search query (works for Amazon ASINs)
  if (!keywords) {
    keywords = id;
    console.log(`[recommendations] Using product ID as search query: "${id}"`);
  }

  const cacheKey = `recs:${id}:${keywords}`;
  const cached = searchCache.get(cacheKey);
  if (cached) return res.json(cached);

  try {
    // FIX: Use the correct source adapter instead of always Amazon
    const source = (sourceParam).toLowerCase();
    const adapter = getAdapter(source) || getAdapter('amazon');
    if (!adapter) throw new Error('No adapter available');

    const [similarRes, dealsRes] = await Promise.allSettled([
      adapter.search(keywords, 15),
      category ? adapter.search(category + ' deals best sellers', 15) : adapter.search(keywords + ' best rated', 15)
    ]);

    const similar = (similarRes.status === 'fulfilled' ? similarRes.value || [] : [])
      .filter(p => (p.sourceId || p.asin || p.id) !== id)
      .slice(0, 12);

    const deals = (dealsRes.status === 'fulfilled' ? dealsRes.value || [] : [])
      .filter(p => (p.sourceId || p.asin || p.id) !== id)
      .filter(p => !similar.find(s => (s.sourceId||s.id) === (p.sourceId||p.id)))
      .slice(0, 12);

    const response = { similar: applySearchPricing(similar), deals: applySearchPricing(deals) };
    searchCache.set(cacheKey, response, 1800000); // 30 min
    res.json(response);
  } catch (e) {
    console.error('Recommendations error:', e.message);
    res.json({ similar: [], deals: [], error: e.message });
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

// ---- AUTO BANNERS (event-driven hero carousel) ----
const BANNER_CALENDAR = [
  { event:'Big Spring Sale', start:'Mar 20', end:'Mar 31', gradient:'linear-gradient(135deg,#667eea 0%,#764ba2 100%)', emoji:'\uD83C\uDF38', heading:'Big Spring Sale', subheading:'Up to 50% off spring favorites', cta:'Shop Spring Deals', ctaLink:'/pages/search-results?q=spring+deals', queries:['spring fashion deals','spring home decor','outdoor furniture'], type:'sale' },
  { event:'Easter', start:'Mar 25', end:'Apr 05', gradient:'linear-gradient(135deg,#a18cd1 0%,#fbc2eb 100%)', emoji:'\uD83D\uDC23', heading:'Easter Essentials', subheading:'Everything for the perfect Easter', cta:'Shop Easter', ctaLink:'/pages/search-results?q=easter', queries:['easter gifts','easter decoration','spring clothing'], type:'holiday' },
  { event:"Mother's Day", start:'Apr 25', end:'May 10', gradient:'linear-gradient(135deg,#f093fb 0%,#f5576c 100%)', emoji:'\uD83D\uDC90', heading:"Mother's Day Gifts", subheading:'Show her you care \u2014 curated gift ideas', cta:'Shop Gifts for Mom', ctaLink:'/pages/search-results?q=gifts+for+mom', queries:['gifts for mom','jewelry women','skincare gift set','perfume women'], type:'holiday' },
  { event:'Memorial Day', start:'May 18', end:'May 25', gradient:'linear-gradient(135deg,#0c3483 0%,#a2b6df 100%)', emoji:'\uD83C\uDDFA\uD83C\uDDF8', heading:'Memorial Day Deals', subheading:'Huge savings across all categories', cta:'Shop the Sale', ctaLink:'/pages/search-results?q=memorial+day+deals', queries:['outdoor grill','patio furniture','american flag'], type:'sale' },
  { event:"Father's Day", start:'Jun 10', end:'Jun 21', gradient:'linear-gradient(135deg,#434343 0%,#000000 100%)', emoji:'\uD83D\uDC54', heading:"Father's Day", subheading:"Top gifts Dad will actually use", cta:'Shop Gifts for Dad', ctaLink:'/pages/search-results?q=gifts+for+dad', queries:['gifts for dad','mens watch','tools set','grill accessories'], type:'holiday' },
  { event:'4th of July', start:'Jun 27', end:'Jul 04', gradient:'linear-gradient(135deg,#c31432 0%,#240b36 100%)', emoji:'\uD83C\uDF86', heading:'4th of July Sale', subheading:'Celebrate with huge savings', cta:'Shop the Sale', ctaLink:'/pages/search-results?q=summer+deals', queries:['4th of july','outdoor party','summer deals'], type:'sale' },
  { event:'Plus Day', start:'Jul 10', end:'Jul 16', gradient:'linear-gradient(135deg,#6b46c1 0%,#9333ea 100%)', emoji:'\u26A1', heading:'Plus Day \u2014 Biggest Deals', subheading:'Exclusive deals for Plus members', cta:'Shop Plus Deals', ctaLink:'/pages/search-results?q=best+deals', queries:['best deals','electronics deals','fashion deals'], type:'sale' },
  { event:'Back to School', start:'Jul 20', end:'Aug 15', gradient:'linear-gradient(135deg,#11998e 0%,#38ef7d 100%)', emoji:'\uD83D\uDCDA', heading:'Back to School', subheading:'Gear up for the new school year', cta:'Shop School Supplies', ctaLink:'/pages/search-results?q=back+to+school', queries:['backpack','laptop deals','school supplies','kids clothing'], type:'sale' },
  { event:'Halloween', start:'Oct 10', end:'Oct 31', gradient:'linear-gradient(135deg,#fc4a1a 0%,#f7b733 100%)', emoji:'\uD83C\uDF83', heading:'Halloween Deals', subheading:'Costumes, candy & creepy decor', cta:'Shop Halloween', ctaLink:'/pages/search-results?q=halloween', queries:['halloween costume','halloween decoration','candy'], type:'holiday' },
  { event:'Black Friday', start:'Nov 20', end:'Nov 28', gradient:'linear-gradient(135deg,#000000 0%,#434343 100%)', emoji:'\uD83C\uDFF7\uFE0F', heading:'BLACK FRIDAY', subheading:'The biggest deals of the year are HERE', cta:'Shop Black Friday', ctaLink:'/pages/search-results?q=black+friday', queries:['black friday deals','electronics sale','fashion sale'], type:'sale' },
  { event:'Cyber Monday', start:'Nov 29', end:'Dec 02', gradient:'linear-gradient(135deg,#00c6ff 0%,#0072ff 100%)', emoji:'\uD83D\uDCBB', heading:'CYBER MONDAY', subheading:'Online-only deals \u2014 save up to 70%', cta:'Shop Cyber Monday', ctaLink:'/pages/search-results?q=cyber+monday', queries:['cyber monday deals','tech deals','gadgets'], type:'sale' },
  { event:'Christmas', start:'Dec 01', end:'Dec 25', gradient:'linear-gradient(135deg,#c31432 0%,#2c3e50 100%)', emoji:'\uD83C\uDF84', heading:'Holiday Gift Guide', subheading:'Perfect gifts for everyone on your list', cta:'Shop Gifts', ctaLink:'/pages/search-results?q=christmas+gifts', queries:['christmas gifts','gift ideas','holiday deals'], type:'holiday' },
  { event:"Valentine's Day", start:'Feb 01', end:'Feb 14', gradient:'linear-gradient(135deg,#ee0979 0%,#ff6a00 100%)', emoji:'\u2764\uFE0F', heading:"Valentine's Day", subheading:'Gifts they will love', cta:"Shop Valentine's", ctaLink:'/pages/search-results?q=valentines+gifts', queries:['valentines gifts','jewelry','chocolate gift','perfume'], type:'holiday' }
];

const CATEGORY_BANNERS = [
  { heading:'Top picks in Fashion', subheading:"Today's best sellers in fashion", gradient:'linear-gradient(135deg,#1a1a2e 0%,#e94560 100%)', query:'trending fashion', cta:'Shop Fashion', ctaLink:'/pages/search-results?q=fashion', type:'category' },
  { heading:'Tech Deals', subheading:'Latest gadgets at best prices', gradient:'linear-gradient(135deg,#0f0c29 0%,#302b63 50%,#24243e 100%)', query:'electronics deals', cta:'Shop Electronics', ctaLink:'/pages/search-results?q=electronics', type:'category' },
  { heading:'Beauty Favorites', subheading:'Skincare & makeup top picks', gradient:'linear-gradient(135deg,#f093fb 0%,#f5576c 100%)', query:'beauty skincare trending', cta:'Shop Beauty', ctaLink:'/pages/search-results?q=beauty', type:'category' },
  { heading:'Home Refresh', subheading:'Upgrade your space for less', gradient:'linear-gradient(135deg,#11998e 0%,#38ef7d 100%)', query:'home decor trending', cta:'Shop Home', ctaLink:'/pages/search-results?q=home+decor', type:'category' },
  { heading:'Sports & Outdoors', subheading:'Gear up for your next adventure', gradient:'linear-gradient(135deg,#fc4a1a 0%,#f7b733 100%)', query:'sports outdoors', cta:'Shop Sports', ctaLink:'/pages/search-results?q=sports', type:'category' }
];

function getActiveEvents() {
  const now = new Date();
  const month = now.getMonth();
  const day = now.getDate();
  const mmdd = (month + 1) * 100 + day;
  const months = {Jan:1,Feb:2,Mar:3,Apr:4,May:5,Jun:6,Jul:7,Aug:8,Sep:9,Oct:10,Nov:11,Dec:12};
  return BANNER_CALENDAR.filter(e => {
    const sp = e.start.split(' '), ep = e.end.split(' ');
    const s = months[sp[0]] * 100 + parseInt(sp[1]);
    const en = months[ep[0]] * 100 + parseInt(ep[1]);
    return mmdd >= s && mmdd <= en;
  });
}

function getDailyCategoryBanners() {
  const day = Math.floor(Date.now() / 86400000);
  const selected = [];
  for (let i = 0; i < 3; i++) {
    selected.push(CATEGORY_BANNERS[(day + i) % CATEGORY_BANNERS.length]);
  }
  return selected;
}

app.get('/api/banners', async (req, res) => {
  const cacheKey = 'hero-banners';
  const cached = searchCache.get(cacheKey);
  if (cached) return res.json(cached);

  try {
    const activeEvents = getActiveEvents();
    const catBanners = getDailyCategoryBanners();
    const dayNum = Math.floor(Date.now() / 86400000);
    const banners = [];
    const amazonAdapter = getAdapter('amazon');

    // Build banner list: events first, then fill with categories
    const sources = [];
    activeEvents.slice(0, 2).forEach(ev => sources.push({ ...ev, _isEvent: true }));
    // Plus promo banner (always)
    sources.push({ heading:'Get it Tomorrow', subheading:'FREE fast delivery + exclusive deals with StyleHub Plus', gradient:'linear-gradient(135deg,#6b46c1 0%,#9333ea 100%)', emoji:'\u26A1', cta:'Try Plus Free for 7 Days', ctaLink:'/pages/plus', type:'plus', queries:['best deals electronics'], _isPlus: true });
    // Fill remaining with category banners
    catBanners.forEach(cb => { if (sources.length < 5) sources.push(cb); });

    for (const src of sources.slice(0, 5)) {
      try {
        let products = [];
        const query = src.queries
          ? src.queries[dayNum % src.queries.length]
          : (src.query || 'best deals');

        if (amazonAdapter) {
          const results = await amazonAdapter.search(query, 8);
          products = (results || []).slice(0, 8);
        }

        // Fallback: try any active adapter
        if (products.length < 3) {
          const activeStores = ['aliexpress', 'sephora', 'shein', 'macys'];
          for (const store of activeStores) {
            if (products.length >= 3) break;
            const ad = getAdapter(store);
            if (!ad) continue;
            try {
              const r = await ad.search(query, 5);
              products = products.concat(r || []);
            } catch (_) {}
          }
        }

        const priced = applySearchPricing(products);
        const featured = priced.slice(0, 5).map(p => {
          const price = typeof p.price === 'number' ? p.price : parseFloat(String(p.price || '0').replace(/[^0-9.]/g, ''));
          const orig = typeof p.originalPrice === 'number' ? p.originalPrice : parseFloat(String(p.originalPrice || '0').replace(/[^0-9.]/g, ''));
          const disc = orig > price && price > 0 ? Math.round((1 - price / orig) * 100) : 0;
          return {
            image: p.image || p.primaryImage || '',
            title: (p.title || '').substring(0, 50),
            price: price > 0 ? price.toFixed(2) : '',
            originalPrice: orig > price ? orig.toFixed(2) : '',
            discount: disc,
            link: '/pages/product?id=' + encodeURIComponent(p.id || p.sourceId || '') + '&store=' + encodeURIComponent(p.source || p.sourceName || 'amazon')
          };
        });

        banners.push({
          event: src.event || src.heading || 'Deals',
          heading: src.heading || "Today's Top Deals",
          subheading: src.subheading || 'Fresh deals updated daily',
          cta: src.cta || 'Shop Now',
          ctaLink: src.ctaLink || '/pages/search-results?q=deals',
          gradient: src.gradient || 'linear-gradient(135deg,#1a1a2e 0%,#16213e 100%)',
          emoji: src.emoji || '',
          type: src.type || 'sale',
          featuredProducts: featured,
          heroImage: featured[0] ? featured[0].image : ''
        });
      } catch (err) {
        console.error('Banner build error for', src.event || src.heading, err.message);
      }
    }

    // Always have at least 1 banner
    if (!banners.length) {
      banners.push({
        event: 'default', heading: "Today's Top Deals", subheading: 'Fresh deals updated daily',
        cta: 'Shop Now', ctaLink: '/pages/search-results?q=deals',
        gradient: 'linear-gradient(135deg,#1a1a2e 0%,#16213e 100%)',
        type: 'sale', featuredProducts: [], heroImage: '', emoji: '\uD83D\uDD25'
      });
    }

    const response = { banners };
    searchCache.set(cacheKey, response, 3600000); // 1 hour
    res.set('Cache-Control', 'public, max-age=21600');
    res.json(response);
  } catch (e) {
    console.error('Banners endpoint error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ---- HOME CARDS (Amazon-style 2x2 grid cards) ----
const HOME_CARD_POOL = [
  { title:'Shop by category', type:'static', items:[
    {label:'Fashion',img:'https://images.unsplash.com/photo-1483985988355-763728e1935b?w=400&auto=format&fit=crop&q=80',q:'fashion'},
    {label:'Home',img:'https://images.unsplash.com/photo-1513694203232-719a280e022f?w=400&auto=format&fit=crop&q=80',q:'home decor'},
    {label:'Beauty',img:'https://images.unsplash.com/photo-1596462502278-27bfdc403348?w=400&auto=format&fit=crop&q=80',q:'beauty'},
    {label:'Electronics',img:'https://images.unsplash.com/photo-1498049794561-7780e7231661?w=400&auto=format&fit=crop&q=80',q:'electronics'}
  ], link:'/collections/all', linkText:'See all categories' },
  { title:'Deals under $10', type:'search', query:'deals under 10 dollars', maxPrice:10, link:'/pages/search-results?q=deals+under+10', linkText:'Shop all' },
  { title:'Deals under $25', type:'search', query:'deals under 25 dollars', maxPrice:25, link:'/pages/search-results?q=deals+under+25', linkText:'Shop all' },
  { title:'New arrivals', type:'search', query:'new releases 2026', link:'/pages/search-results?q=new+arrivals', linkText:'See more' },
  { title:'Best sellers', type:'search', query:'best sellers', link:'/pages/search-results?q=best+sellers', linkText:'See more' },
  { title:'Most wished for', type:'search', query:'most popular products', link:'/pages/search-results?q=popular', linkText:'See more' },
  { title:'Top rated', type:'search', query:'top rated products', link:'/pages/search-results?q=top+rated', linkText:'See more' },
  { title:'Gift ideas', type:'search', query:'gift ideas', link:'/pages/search-results?q=gifts', linkText:'Shop gifts' },
  { title:'Trending in Fashion', type:'search', query:'trending fashion 2026', link:'/pages/search-results?q=fashion', linkText:'See more' },
  { title:'Trending in Electronics', type:'search', query:'best electronics deals', link:'/pages/search-results?q=electronics', linkText:'See more' },
  { title:'Trending in Beauty', type:'search', query:'trending beauty skincare', link:'/pages/search-results?q=beauty', linkText:'See more' },
  { title:'Trending in Home', type:'search', query:'home decor trending', link:'/pages/search-results?q=home+decor', linkText:'See more' }
];

app.get('/api/home-cards', async (req, res) => {
  const cacheKey = 'home-cards';
  const cached = searchCache.get(cacheKey);
  if (cached) return res.json(cached);

  try {
    const dayNum = Math.floor(Date.now() / 86400000);
    const indices = HOME_CARD_POOL.map((_, i) => i);
    const selected = [];
    const used = new Set();
    for (let i = 0; i < 5 && indices.length; i++) {
      const idx = (dayNum * 7 + i * 13) % indices.length;
      selected.push(HOME_CARD_POOL[indices[idx]]);
      used.add(indices[idx]);
      indices.splice(idx, 1);
    }

    const amazonAdapter = getAdapter('amazon');
    const results = await Promise.allSettled(
      selected.map(async (card) => {
        let products = [];
        if (card.type === 'static') {
          return { title: card.title, link: card.link, linkText: card.linkText, products: card.items.map(it => ({ image: it.img || '', title: it.label, link: '/pages/search-results?q=' + encodeURIComponent(it.q), isCategory: !it.img })) };
        }
        if (amazonAdapter) {
          const raw = await amazonAdapter.search(card.query || 'deals', 6);
          products = (raw || []).slice(0, 6);
          if (card.maxPrice) {
            products = products.filter(p => {
              const pr = typeof p.price === 'number' ? p.price : parseFloat(String(p.price || '999').replace(/[^0-9.]/g, ''));
              return pr > 0 && pr <= card.maxPrice;
            });
          }
        }
        const priced = applySearchPricing(products.slice(0, 4));
        return {
          title: card.title,
          link: card.link,
          linkText: card.linkText,
          products: priced.map(p => ({
            image: p.image || p.primaryImage || '',
            title: (p.title || '').substring(0, 30),
            price: typeof p.price === 'number' ? p.price : parseFloat(String(p.price || '0').replace(/[^0-9.]/g, '')),
            link: '/pages/product?id=' + encodeURIComponent(p.id || p.sourceId || '') + '&store=' + encodeURIComponent(p.source || p.sourceName || 'amazon')
          }))
        };
      })
    );

    const cards = results
      .filter(r => r.status === 'fulfilled')
      .map(r => r.value)
      .filter(c => c.products && c.products.length >= 2);

    // First card is the side card, rest are grid cards
    const sideCard = cards[0] || null;
    const gridCards = cards.slice(1, 5);

    const response = { sideCard, gridCards };
    searchCache.set(cacheKey, response, 3600000); // 1 hour
    res.set('Cache-Control', 'public, max-age=21600');
    res.json(response);
  } catch (e) {
    console.error('Home cards error:', e.message);
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

// ─────────────────────────────────────────────────────────────────────
// ASYNC WIZARD PIPELINE (Fase 2 — backend-only async cart preparation)
// ─────────────────────────────────────────────────────────────────────
// Goal: 90%+ of Add to Cart requests are auto-fulfilled by AutoDS, with
// zero perceived wait, AND zero frontend changes.
//
// Strategy:
//   1. /api/product (PDP load) fires a fire-and-forget bridge wizard call
//      for cache-miss ASINs. By the time the customer clicks Add to Cart
//      (avg 60-180s on PDP), the wizard usually completed → cache hit on
//      /api/prepare-cart → instant auto-fulfill.
//
//   2. /api/prepare-cart on cache miss waits for an in-flight wizard up to
//      WIZARD_WAIT_MS (default 60s). If the wizard finishes in time, returns
//      the wizard mapping (auto-fulfill ON). If it's still running OR there's
//      no in-flight wizard, falls back to Admin API path (current behaviour,
//      manual CSV email fulfill).
//
//   3. When the wizard eventually completes (even after the customer left),
//      its mapping replaces the Admin API mapping in cache + DB. FUTURE
//      customers for the same ASIN get auto-fulfill on cache hit.
//
// Feature flag: USE_ASYNC_WIZARD_PREPARE_CART=true  (default OFF)
// Wait timeout: WIZARD_WAIT_MS=60000                 (default 60s)
// ─────────────────────────────────────────────────────────────────────

function _normaliseSelectedVariant(s) {
  return (s || '').toString().trim().toLowerCase().replace(/^option:\s*/i, '');
}

function _resolveVariantId(variants, selectedVariant) {
  if (!Array.isArray(variants) || variants.length === 0) return null;
  const first = variants[0];
  if (variants.length === 1 || !selectedVariant) return String(first.id);

  const rawInput = String(selectedVariant).trim();
  const svNorm = _normaliseSelectedVariant(rawInput);

  let match = variants.find(v => {
    if (!v.sku) return false;
    const parts = String(v.sku).split('-');
    const last = parts[parts.length - 1];
    return last === rawInput || String(last).toLowerCase() === svNorm;
  });

  if (!match) {
    match = variants.find(v => {
      const vt = _normaliseSelectedVariant(v.title);
      return vt === svNorm || vt.includes(svNorm) || svNorm.includes(vt);
    });
  }
  if (!match && svNorm.includes(' / ')) {
    const fragments = svNorm.split(' / ').map(s => s.trim()).filter(Boolean);
    for (const frag of fragments) {
      const hits = variants.filter(v => _normaliseSelectedVariant(v.title).includes(frag));
      if (hits.length === 1) { match = hits[0]; break; }
    }
  }
  return String((match || first).id);
}

/**
 * Run a wizard job to completion. Updates cartJobs status + persists mapping
 * to syncCache and DB on success. Always settles the job (ready or failed).
 *
 * Caller must have already created the job via cartJobs.createJob.
 */
async function _processWizardJob({ jobId, source, sourceId, productData, selectedVariant, sourceUrl, smid }) {
  try {
    logger.info('cart-wizard', `[${jobId}] start ${source}:${sourceId} smid=${smid || '-'}`);

    const wizardRes = await callBridgeWizard({ source, sourceId, sourceUrl, smid });

    if (wizardRes.ok && wizardRes.shopifyProductId) {
      logger.info('cart-wizard', `[${jobId}] wizard OK shopify=${wizardRes.shopifyProductId} importJob=${wizardRes.autodsImportJobId || '-'}`);

      let product = null;
      try {
        const resp = await shopifyAPIDirect(`/products/${wizardRes.shopifyProductId}.json?fields=id,handle,title,variants,status`);
        product = resp && resp.product;
      } catch (e) {
        logger.warn('cart-wizard', `[${jobId}] shopify fetch failed after wizard: ${e.message}`);
      }

      if (product && Array.isArray(product.variants) && product.variants.length > 0) {
        // ── REPAIR variants for buyability ──
        // AutoDS creates products with inventory_management:shopify + inventory_policy:deny,
        // and inventory_item.tracked:true with quantity 0. /cart/add.js then rejects with
        // 422 "already sold out". To make the variant always buyable instantly:
        //   1. variant.inventory_policy:continue + inventory_management:null
        //   2. inventory_item.tracked:false  (THE source-of-truth flag at runtime)
        // Without (2) the storefront keeps treating it as sold out for ~30min until
        // the cache invalidates.
        await Promise.allSettled(product.variants.map(async (v) => {
          // Variant-level fix
          if (!(v.inventory_policy === 'continue' && !v.inventory_management)) {
            try {
              await shopifyAPIDirect(`/variants/${v.id}.json`, 'PUT', {
                variant: { id: v.id, inventory_policy: 'continue', inventory_management: null }
              });
            } catch (e) {
              logger.warn('cart-wizard', `[${jobId}] variant ${v.id} repair failed: ${e.message}`);
            }
          }
          // Inventory-item level fix — requires write_inventory scope
          if (v.inventory_item_id) {
            try {
              await shopifyAPIDirect(`/inventory_items/${v.inventory_item_id}.json`, 'PUT', {
                inventory_item: { id: v.inventory_item_id, tracked: false }
              });
            } catch (e) {
              logger.warn('cart-wizard', `[${jobId}] inventory_item ${v.inventory_item_id} untrack failed: ${e.message}`);
            }
          }
        }));

        const variants = product.variants.map(v => ({
          id: String(v.id),
          title: v.title,
          sku: v.sku || null,
          price: v.price || null,
          inventory_item_id: v.inventory_item_id || null
        }));
        const variantId = _resolveVariantId(variants, selectedVariant);
        const mapping = {
          shopifyProductId: String(product.id),
          shopifyVariantId: variantId,
          handle: product.handle,
          variants
        };

        try {
          const { syncCache } = require('./src/utils/cache');
          syncCache.set(`mapping:${source}:${sourceId}`, mapping);
        } catch (e) { /* non-fatal */ }
        try {
          const { upsertMapping } = require('./src/utils/db');
          upsertMapping({
            source,
            sourceId,
            sourceVariantId: selectedVariant ? String(selectedVariant) : null,
            shopifyProductId: mapping.shopifyProductId,
            shopifyVariantId: mapping.shopifyVariantId,
            handle: mapping.handle,
            price: variants[0].price || null,
            originalPrice: null,
            syncHash: 'wizard-' + Date.now()
          });
        } catch (e) {
          logger.warn('cart-wizard', `[${jobId}] db.upsertMapping failed (non-fatal): ${e.message}`);
        }

        try {
          const autodsService = require('./src/services/autods');
          autodsService.registerProduct({
            source, sourceId,
            sourceUrl: sourceUrl || '',
            shopifyProductId: mapping.shopifyProductId,
            shopifyVariantId: mapping.shopifyVariantId,
            shopifyHandle: mapping.handle,
            sourceSellerId: smid || null,
            sourceVariantId: selectedVariant ? String(selectedVariant).trim() : null
          });
        } catch (e) { /* non-fatal */ }

        cartJobs.updateJob(jobId, {
          status: 'ready',
          autoFulfill: true,
          result: {
            success: true,
            shopifyProductId: mapping.shopifyProductId,
            shopifyVariantId: mapping.shopifyVariantId,
            handle: mapping.handle,
            quantity: 1,
            availability: true,
            isNewlyCreated: true,
            autodsConnected: true,
            autodsImportJobId: wizardRes.autodsImportJobId || null,
            priceSnapshot: { price: parseFloat(variants[0].price || 0), compareAt: null, currency: 'USD' },
            shippingSummary: { note: 'Standard shipping', deliveryLabel: null }
          }
        });
        logger.info('cart-wizard', `[${jobId}] ready (wizard) variant=${variantId}`);
        return;
      }

      logger.warn('cart-wizard', `[${jobId}] wizard returned shopifyProductId but Shopify lookup empty`);
    } else {
      logger.warn('cart-wizard', `[${jobId}] wizard not-ok: ${wizardRes.reason || 'unknown'}`);
    }

    // Wizard didn't yield a usable product — mark job failed so callers know to fall back.
    cartJobs.updateJob(jobId, { status: 'failed', error: wizardRes.reason || 'wizard returned no product' });
  } catch (e) {
    logger.error('cart-wizard', `[${jobId}] crashed: ${e.message}`);
    cartJobs.updateJob(jobId, { status: 'failed', error: e.message });
  }
}

// ─── Pre-warm safeguards (anti-runaway) ───
// Each wizard call consumes 1 of AutoDS' 500-product cap, so we have to be
// strict about who triggers a pre-warm. The wizard must only fire for
// REAL HUMAN visits to the PDP, not crawlers, and only at a sustainable rate.
const PREWARM_RATE_LIMIT_PER_MIN = parseInt(process.env.PREWARM_RATE_LIMIT_PER_MIN || '4', 10);
const PREWARM_DAILY_CAP = parseInt(process.env.PREWARM_DAILY_CAP || '40', 10);
const AUTODS_PRODUCT_CAP_THRESHOLD = parseInt(process.env.AUTODS_PRODUCT_CAP_THRESHOLD || '450', 10);
const AUTODS_HEALTH_CACHE_MS = 60000; // re-check bridge /health at most once a minute

const _prewarmBudget = {
  recentKickoffs: [],   // timestamps in ms within the last minute
  dailyCount: 0,
  dailyDate: null,      // YYYY-MM-DD
  capCheck: { lastChecked: 0, productsCount: null, error: null }
};

const _BOT_UA_RE = /bot\b|crawl|spider|slurp|bingbot|googlebot|facebookexternalhit|whatsapp|telegrambot|linkedinbot|twitterbot|pinterest|baiduspider|yandex|duckduckbot|applebot|semrushbot|ahrefsbot|mj12bot|ia_archiver|httpclient|python-requests|curl\/|wget\/|scrapy|headlesschrome|phantomjs|puppeteer|playwright/i;

function _isLikelyBot(userAgent) {
  if (!userAgent) return true; // No UA = treat as bot/script
  return _BOT_UA_RE.test(String(userAgent).toLowerCase());
}

function _checkPrewarmBudget() {
  const now = Date.now();

  // Slide the per-minute window
  _prewarmBudget.recentKickoffs = _prewarmBudget.recentKickoffs.filter(t => now - t < 60000);

  // Reset daily counter at UTC midnight
  const today = new Date().toISOString().slice(0, 10);
  if (_prewarmBudget.dailyDate !== today) {
    _prewarmBudget.dailyDate = today;
    _prewarmBudget.dailyCount = 0;
  }

  if (_prewarmBudget.recentKickoffs.length >= PREWARM_RATE_LIMIT_PER_MIN) {
    return { allowed: false, reason: `rate-limit-min:${PREWARM_RATE_LIMIT_PER_MIN}` };
  }
  if (_prewarmBudget.dailyCount >= PREWARM_DAILY_CAP) {
    return { allowed: false, reason: `rate-limit-day:${PREWARM_DAILY_CAP}` };
  }
  if (
    _prewarmBudget.capCheck.productsCount !== null &&
    _prewarmBudget.capCheck.productsCount >= AUTODS_PRODUCT_CAP_THRESHOLD
  ) {
    return { allowed: false, reason: `autods-cap:${_prewarmBudget.capCheck.productsCount}/${AUTODS_PRODUCT_CAP_THRESHOLD}` };
  }
  return { allowed: true };
}

function _recordPrewarmKickoff() {
  _prewarmBudget.recentKickoffs.push(Date.now());
  _prewarmBudget.dailyCount += 1;
}

async function _refreshAutoDSCapCache() {
  if (Date.now() - _prewarmBudget.capCheck.lastChecked < AUTODS_HEALTH_CACHE_MS) return;
  try {
    const { checkBridgeHealth } = require('./src/services/autods-wizard');
    const r = await checkBridgeHealth(8000);
    _prewarmBudget.capCheck = {
      lastChecked: Date.now(),
      productsCount: typeof r.productsCount === 'number' ? r.productsCount : null,
      error: r.ok ? null : (r.reason || null)
    };
  } catch (e) {
    _prewarmBudget.capCheck = { lastChecked: Date.now(), productsCount: null, error: e.message };
  }
}

/**
 * Fire-and-forget pre-warm: ensure a wizard call is in flight for source+sourceId.
 * Returns the (possibly already existing) job. Safe to call repeatedly.
 *
 * Skips silently if:
 *   - feature flag off / bridge not configured
 *   - user-agent looks like a bot
 *   - per-minute or daily rate limit exceeded
 *   - AutoDS product count is at/over the threshold
 */
function _kickoffWizardPrewarm({ source, sourceId, productData, selectedVariant, sourceUrl, smid, userAgent }) {
  if (process.env.USE_ASYNC_WIZARD_PREPARE_CART !== 'true') return null;
  if (!process.env.AUTODS_BRIDGE_URL) return null;

  // Bot guard — bots crawling product pages must NEVER trigger a wizard call.
  if (_isLikelyBot(userAgent)) {
    logger.debug && logger.debug('cart-wizard', `[prewarm] skip bot ${source}:${sourceId} ua=${(userAgent || '').substring(0, 80)}`);
    return null;
  }

  // ── Mapping guard — never fire the wizard when we ALREADY have a Shopify
  // product mapped to this ASIN (in syncCache OR persisted in SQLite). This
  // prevents duplicate wizard runs after a Render restart wipes syncCache.
  try {
    const { syncCache } = require('./src/utils/cache');
    if (syncCache.get(`mapping:${source}:${sourceId}`)) {
      logger.info('cart-wizard', `[prewarm] skip ${source}:${sourceId} — mapping already in syncCache`);
      return null;
    }
    const { findMapping } = require('./src/utils/db');
    const dbm = findMapping(source, sourceId);
    if (dbm && dbm.shopify_variant_id) {
      logger.info('cart-wizard', `[prewarm] skip ${source}:${sourceId} — mapping in DB shopify=${dbm.shopify_product_id}`);
      // Opportunistically seed syncCache so the next FAST PATH hits it
      syncCache.set(`mapping:${source}:${sourceId}`, {
        shopifyProductId: String(dbm.shopify_product_id),
        shopifyVariantId: String(dbm.shopify_variant_id),
        handle: dbm.shopify_handle,
        variants: [{ id: String(dbm.shopify_variant_id), title: null, sku: null, price: dbm.last_price || null }]
      });
      return null;
    }
  } catch (e) { /* non-fatal — fall through to normal flow */ }

  // Dedup — same ASIN already in flight or recently completed
  const existing = cartJobs.findLiveJob(source, sourceId);
  if (existing) return existing;

  // Refresh AutoDS cap cache async (don't block); the budget check below
  // uses whatever value was last cached.
  _refreshAutoDSCapCache().catch(() => {});

  // Budget check (rate limit + AutoDS cap)
  const budget = _checkPrewarmBudget();
  if (!budget.allowed) {
    logger.info('cart-wizard', `[prewarm] skip ${source}:${sourceId} reason=${budget.reason}`);
    return null;
  }

  _recordPrewarmKickoff();

  const job = cartJobs.createJob({
    source, sourceId,
    productPreview: {
      title: productData?.title || null,
      image: productData?.primaryImage || (productData?.images && productData.images[0]) || null,
      price: productData?.price || null,
      handle: productData?.normalizedHandle || null
    }
  });
  // fire and forget — let the worker run in the background
  setImmediate(() => {
    _processWizardJob({
      jobId: job.jobId,
      source, sourceId, productData, selectedVariant,
      sourceUrl: sourceUrl || productData?.sourceUrl || productData?.url || null,
      smid: smid || productData?.bestOffer?.sellerId || productData?.rawSourceMeta?.bestOfferSellerId || null
    }).catch(e => {
      logger.error('cart-wizard', `[${job.jobId}] unhandled: ${e.message}`);
      cartJobs.updateJob(job.jobId, { status: 'failed', error: e.message });
    });
  });
  return job;
}

/**
 * Block until an in-flight wizard finishes OR timeout elapses.
 * Returns the latest job state (ready/failed) or pending if timed out.
 */
async function _awaitWizardJob(jobId, maxWaitMs) {
  const start = Date.now();
  const pollMs = 1000;
  while (Date.now() - start < maxWaitMs) {
    const job = cartJobs.getJob(jobId);
    if (!job) return null;
    if (job.status === 'ready' || job.status === 'failed') return job;
    await new Promise(r => setTimeout(r, pollMs));
  }
  return cartJobs.getJob(jobId);
}

// ---- PREPARE CART (Sync + Add to Cart) ----
app.post('/api/prepare-cart', async (req, res) => {
  const { source, sourceId, selectedVariant, quantity = 1, forceResync = false, productData: clientProductData } = req.body;

  if (!source || !sourceId) {
    return res.status(400).json({ error: 'Missing source or sourceId' });
  }

  if (!VALID_SOURCES.includes(source.toLowerCase())) {
    return res.status(400).json({ error: `Invalid source: ${source}` });
  }

  // ── BLACKLIST CHECK — Block DMCA products from cart sync ──
  if (blacklist.isProductBlocked(source.toLowerCase(), String(sourceId))) {
    logger.info('prepare-cart', `Blocked DMCA product from cart: ${source}:${sourceId}`);
    return res.status(403).json({ error: 'This product is not available for purchase', blocked: true });
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
        const rawInput = String(selectedVariant).trim();
        const svNorm = norm(rawInput);

        // Strategy 1 (v2.7): Match by SKU suffix (source variant ID / ASIN).
        // SKU format: DH-<SOURCE>-<sourceId>-<sourceVariantId>. Frontend can send
        // the raw child ASIN (e.g. "B0B4PLR1K5") as selectedVariant — this is
        // now the preferred path from Amazon PDP to avoid the " / "-join bug.
        const skuMatch = cachedMapping.variants.find(v => {
          if (!v.sku) return false;
          const parts = String(v.sku).split('-');
          const last = parts[parts.length - 1];
          return last === rawInput || String(last).toLowerCase() === svNorm;
        });

        let match = skuMatch;
        if (!match) {
          // Strategy 2: Exact title, or unambiguous contains in either direction
          match = cachedMapping.variants.find(v => {
            const vt = norm(v.title);
            return vt === svNorm || vt.includes(svNorm) || svNorm.includes(vt);
          });
        }
        if (!match && svNorm.includes(' / ')) {
          // Strategy 3: Frontend may have sent concatenated labels like
          // "Tropical / 3 Count (Pack of 1)". Split and look for a UNIQUE
          // variant whose title contains any one fragment.
          const fragments = svNorm.split(' / ').map(s => s.trim()).filter(Boolean);
          for (const frag of fragments) {
            const hits = cachedMapping.variants.filter(v => norm(v.title).includes(frag));
            if (hits.length === 1) { match = hits[0]; break; }
          }
        }
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

    // ── ASYNC WIZARD PATH (Fase 2) ──
    // If the wizard pipeline is enabled and the bridge is configured, try the
    // AutoDS Single Product wizard first so the resulting Shopify product is
    // already Connected (auto-fulfill). If a wizard job is in flight (likely
    // pre-warmed when the customer hit the PDP), wait up to WIZARD_WAIT_MS for
    // it. If it finishes in time, return the wizard mapping. Otherwise fall
    // through to the existing Admin API path (manual fulfill via CSV email,
    // current behaviour).
    if (
      process.env.USE_ASYNC_WIZARD_PREPARE_CART === 'true' &&
      process.env.AUTODS_BRIDGE_URL
    ) {
      const wizardWaitMs = parseInt(process.env.WIZARD_WAIT_MS || '60000', 10);
      // Either reuse an in-flight job (PDP pre-warm) or kick off a new one.
      // Note: in /api/prepare-cart we DO want to allow bots / scripts that POST
      // here (they're rare — Shopify cart endpoints aren't crawled). But if the
      // request has a bot UA it's almost certainly a real customer's request
      // (they don't crawl /api/prepare-cart). We pass UA anyway so the budget
      // and bot guard still apply consistently.
      const job = _kickoffWizardPrewarm({
        source: srcLower,
        sourceId: srcId,
        productData,
        selectedVariant,
        sourceUrl: productData.sourceUrl || productData.url || null,
        smid: productData?.bestOffer?.sellerId || productData?.rawSourceMeta?.bestOfferSellerId || null,
        userAgent: req.headers['user-agent'] || null
      });
      if (job) {
        const settled = await _awaitWizardJob(job.jobId, wizardWaitMs);
        if (settled && settled.status === 'ready' && settled.result) {
          logger.info('cart', `wizard hit (job=${job.jobId}, autoFulfill=true) → ${srcLower}:${srcId}`);
          return res.json(settled.result);
        }
        if (settled && settled.status === 'failed') {
          logger.warn('cart', `wizard failed (job=${job.jobId}): ${settled.error || '?'} — falling back to Admin API`);
        } else {
          logger.info('cart', `wizard still pending after ${wizardWaitMs}ms (job=${job.jobId}) — falling back to Admin API. Future hits will benefit when wizard completes.`);
        }
      }
    }

    // 2. Sync to Shopify and get cart-ready data (Admin API path — fallback / default)
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

    // ── AUTODS REACTIVE TRACKING ──
    // Register product in local autods_products table so AutoDS platform can
    // pick it up (via CSV bulk import or API). Reactive tracking aligned with
    // plan limit 500 — only consumes variations when product is actually added to cart.
    // Seller/variant capture mirrors the inline registerProduct inside prepareCart —
    // required so the eventual CSV BuyId gets `?smid=` for Amazon.
    try {
      const autodsService = require('./src/services/autods');
      const sellerId =
        productData?.bestOffer?.sellerId ||
        productData?.rawSourceMeta?.bestOfferSellerId ||
        productData?.sellerData?.id ||
        null;
      autodsService.registerProduct({
        source: srcLower,
        sourceId: srcId,
        sourceUrl: productData.sourceUrl || productData.url || '',
        shopifyProductId: result.shopifyProductId,
        shopifyVariantId: result.shopifyVariantId,
        shopifyHandle: result.handle,
        sourceSellerId: sellerId,
        sourceVariantId: selectedVariant ? String(selectedVariant).trim() : null
      });
    } catch (autodsErr) {
      // Non-blocking — never fail cart prep due to tracking
      logger.warn('cart', `[AutoDS] registerProduct failed (non-blocking): ${autodsErr.message}`);
    }

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

    // ── AUTODS REACTIVE TRACKING (legacy endpoint) ──
    try {
      const autodsService = require('./src/services/autods');
      autodsService.registerProduct({
        source: productData.source,
        sourceId: productData.sourceId,
        sourceUrl: productData.sourceUrl || '',
        shopifyProductId: result.shopifyProductId,
        shopifyVariantId: result.shopifyVariantId,
        shopifyHandle: result.handle
      });
    } catch (autodsErr) {
      logger.warn('legacy-cart', `[AutoDS] registerProduct failed (non-blocking): ${autodsErr.message}`);
    }

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

// ---- DEBUG: Test adapter.getProduct with step logging ----
app.get('/api/debug/adapter-test', async (req, res) => {
  const { id, store } = req.query;
  const source = (store || 'aliexpress').toLowerCase();
  if (!id) return res.status(400).json({ error: 'Missing id param' });
  try {
    const adapter = getAdapter(source);
    if (!adapter) return res.json({ error: 'No adapter for ' + source });
    // Call _fetchDetailEndpoint directly to test
    const detail2 = await adapter._fetchDetailEndpoint('/item_detail_2', id);
    const detail2Info = detail2 ? {
      hasItem: !!detail2.item, hasItemId: !!detail2.itemId,
      title: (detail2.item?.title || detail2.title || '?').substring(0, 80),
      statusCode: detail2.status?.code, statusData: detail2.status?.data,
      keys: Object.keys(detail2).join(',')
    } : null;
    // Also test the full getProduct
    const product = await adapter.getProduct(id, {});
    const productInfo = product ? {
      sourceId: product.sourceId, title: (product.title || '?').substring(0, 80),
      price: product.price, images: (product.images || []).length,
      variants: (product.variants || []).length
    } : null;
    res.json({ id, source, detail2: detail2Info, product: productInfo });
  } catch (e) {
    res.json({ id, source, error: e.message, stack: e.stack?.split('\n').slice(0, 3) });
  }
});

// ---- DEBUG: Raw product API response (for shipping field discovery) ----
// ---- DEBUG: Test multiple AliExpress detail endpoints for ID compatibility ----
app.get('/api/debug/aliexpress-endpoints', async (req, res) => {
  const { id } = req.query;
  if (!id) return res.status(400).json({ error: 'Missing id param' });
  const fetch = require('node-fetch');
  const rapidApiKey = process.env.RAPIDAPI_KEY;
  const host = 'aliexpress-datahub.p.rapidapi.com';
  const headers = { 'x-rapidapi-key': rapidApiKey, 'x-rapidapi-host': host };
  const endpoints = [
    '/item_detail', '/item_detail_2', '/item_detail_3',
    '/item_detail_4', '/item_detail_5', '/item_detail_6', '/item_detail_7'
  ];
  const results = {};
  await Promise.allSettled(endpoints.map(async (ep) => {
    const start = Date.now();
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 12000);
      const url = `https://${host}${ep}?itemId=${encodeURIComponent(id)}&language=en&currency=USD`;
      const resp = await fetch(url, { headers, signal: controller.signal });
      clearTimeout(timer);
      const text = await resp.text();
      let json = null;
      try { json = JSON.parse(text); } catch(e) {}
      const statusCode = json?.result?.status?.code;
      const statusMsg = json?.result?.status?.msg || '';
      const hasItem = !!(json?.result?.item);
      const hasTitle = !!(json?.result?.item?.title);
      results[ep] = {
        httpStatus: resp.status, latencyMs: Date.now() - start,
        apiStatusCode: statusCode, apiStatusMsg: statusMsg?.substring(0, 100),
        hasItem, hasTitle,
        topKeys: json?.result ? Object.keys(json.result).join(',') : null,
        title: json?.result?.item?.title?.substring(0, 80) || null
      };
    } catch(e) {
      results[ep] = { error: e.message, latencyMs: Date.now() - start };
    }
  }));
  res.json({ id, results });
});

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

// ---- DEBUG: Product pipeline step-by-step ----
app.get('/api/debug/product-pipeline', async (req, res) => {
  const { store, id } = req.query;
  const source = (store || 'amazon').toLowerCase();
  if (!id) return res.status(400).json({ error: 'Missing id param' });
  const steps = {};
  try {
    steps.adapter = 'ok';
    const adapter = getAdapter(source);
    if (!adapter) return res.json({ steps, error: 'adapter not available' });

    steps.getProduct = 'starting';
    const product = await adapter.getProduct(id, { title: req.query.title });
    steps.getProduct = product ? 'ok' : 'null';
    if (!product) return res.json({ steps, error: 'getProduct returned null' });
    steps.productFields = {
      hasTitle: !!product.title,
      hasPrice: !!product.price,
      priceValue: product.price,
      hasImages: (product.images || []).length,
      hasVariants: (product.variants || []).length,
      hasSpecifications: Array.isArray(product.specifications),
      hasVideos: Array.isArray(product.videos),
      hasShippingData: !!product.shippingData,
      sourceId: product.sourceId
    };

    steps.pricingEngine = 'starting';
    const pricing = calculateFinalPrice(product.price || 0, source, {
      originalPrice: product.originalPrice,
      sourceCost: product.sourceCost || null,
      deliveryInfo: product.deliveryInfo || product.shippingData || null
    });
    steps.pricingEngine = pricing ? 'ok' : 'null';

    steps.shippingCalc = 'starting';
    const { calculateShipping: calcShip } = require('./src/services/shipping-rules');
    const shipResult = calcShip(source, product.price || 0, product, false);
    steps.shippingCalc = shipResult ? 'ok' : 'null';

    steps.originClassification = 'starting';
    const originInfo = classifyOrigin(product);
    steps.originClassification = originInfo ? 'ok' : 'null';

    steps.allPassed = true;
    res.json({ steps, pricing, shipping: shipResult, origin: originInfo });
  } catch (e) {
    steps.error = e.message;
    steps.stack = e.stack?.split('\n').slice(0, 5);
    res.json({ steps });
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

// ═══ ADMIN: Theme asset upload (for deploying JS/CSS to Shopify theme) ═══
app.put('/api/admin/theme-asset', async (req, res) => {
  const token = req.query.token || req.headers['x-admin-token'];
  if (token !== 'stylehub-admin-2026') return res.status(401).json({ error: 'Unauthorized' });
  try {
    const { key, value } = req.body;
    if (!key || !value) return res.status(400).json({ error: 'Missing key or value' });
    const { shopifyAdmin } = require('./src/shopify-admin');
    const themeId = req.body.themeId || '157178462339';
    const result = await shopifyAdmin('PUT', `/themes/${themeId}/assets.json`, {
      asset: { key, value }
    });
    res.json({ success: true, asset: result.asset?.key });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ═══ ADMIN: Generic Shopify Admin API proxy (for SEO scripts etc.) ═══
app.post('/api/admin/shopify-proxy', async (req, res) => {
  const token = req.query.token || req.headers['x-admin-token'];
  if (token !== 'stylehub-admin-2026') return res.status(401).json({ error: 'Unauthorized' });
  try {
    const { method, path, body } = req.body;
    if (!method || !path) return res.status(400).json({ error: 'Missing method or path' });
    const { shopifyAdmin } = require('./src/shopify-admin');
    const result = await shopifyAdmin(method, path, body || null);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
// AUTODS INTEGRATION — Webhooks, Admin, CSV Export
// ============================================================

const autods = require('./src/services/autods');
// Initialize AutoDS DB schema on startup
try { autods.initAutodsSchema(); } catch (e) { logger.warn('server', `AutoDS schema init: ${e.message}`); }

// NOTE: Order webhooks are handled in src/webhooks.js (order-created, order-fulfilled, order-cancelled)
// AutoDS processing is hooked into the existing order-created handler there.
// The endpoint below is a REDUNDANT, TOKEN-AUTH'D second channel that fires the
// same pipeline (processOrderWebhook + sendAutodsOrderEmail). It exists because
// the HMAC-protected webhook in src/webhooks.js can silently fail if
// SHOPIFY_WEBHOOK_SECRET drifts out of sync with the API client's "API secret key".
// Register this URL in Shopify with `?token=<WEBHOOK_TOKEN>` in the address. The
// token in the query string plays the same role as HMAC: anyone without the
// token gets 401, so the endpoint is equally safe in practice.
const WEBHOOK_TOKEN_FALLBACK = 'wh-FB5yKxpOVwFeIwhXZd5o8YUZnmOvbwF6';
app.post('/webhooks/orders/create', async (req, res) => {
  // ── AUTH: token in query OR valid HMAC ──
  const expected = process.env.WEBHOOK_TOKEN || WEBHOOK_TOKEN_FALLBACK;
  const provided = req.query.token || req.headers['x-webhook-token'];
  const tokenOk = provided && provided === expected;
  if (!tokenOk) {
    // Fall back to HMAC verification path (same rules as src/webhooks.js).
    const hmac = req.headers['x-shopify-hmac-sha256'];
    const secret = process.env.SHOPIFY_WEBHOOK_SECRET || process.env.SHOPIFY_CLIENT_SECRET;
    let hmacOk = false;
    if (secret && hmac && req.rawBody) {
      try {
        const crypto = require('crypto');
        const hash = crypto.createHmac('sha256', secret).update(req.rawBody, 'utf8').digest('base64');
        hmacOk = crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(hash));
      } catch (e) { hmacOk = false; }
    }
    if (!hmacOk) {
      logger.warn('webhook', 'orders/create rejected — no valid token or HMAC');
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  // Ack Shopify immediately so it doesn't retry on slow downstreams.
  res.status(200).json({ received: true });

  const order = req.body;
  if (!order || !order.id) return;

  // ── FULL ORDER PIPELINE (fire-and-forget) ──
  // Mirrors src/webhooks.js order-created but without HMAC coupling.
  (async () => {
    const orderRef = order.name || `#${order.order_number || order.id}`;
    try {
      const result = await autods.processOrderWebhook(order);
      logger.info('webhook', `[orders/create:token] ${orderRef} → autods status=${result?.status}, items=${result?.items?.length}`);
    } catch (e) {
      logger.error('webhook', `[orders/create:token] ${orderRef} autods failed: ${e.message}`);
    }

    try {
      const { sendAutodsOrderEmail } = require('./src/services/autods-order-email');
      const emailResult = await sendAutodsOrderEmail(order);
      logger.info('webhook', `[orders/create:token] ${orderRef} CSV email → ok=${emailResult?.ok}, reason=${emailResult?.reason || 'sent'}, mapped=${emailResult?.rows?.length}`);
    } catch (e) {
      logger.error('webhook', `[orders/create:token] ${orderRef} CSV email failed: ${e.message}`);
    }
  })();
});

// ─────────────────────────────────────────────────────────────────────
// AUTODS BRIDGE WEBHOOK — checkouts/create
// ─────────────────────────────────────────────────────────────────────
// When a Shopify customer reaches the checkout page, this fires. We extract
// each line item's source product info (Amazon ASIN / AliExpress URL) and
// fire-and-forget a Connect call to the AutoDS Bridge running on Edgar's PC
// (via Cloudflare Tunnel). By the time the customer pays, the product is
// already Connected in AutoDS and Orders Processor auto-fulfills.
//
// Required env vars:
//   AUTODS_BRIDGE_URL    — e.g., https://xxx.trycloudflare.com
//   AUTODS_BRIDGE_TOKEN  — must match BRIDGE_TOKEN in autods-local-bridge.js
//
// Optional:
//   AUTODS_BRIDGE_DEDUP_TTL_MS — default 86400000 (24h)
//
// Auth: same ?token=<WEBHOOK_TOKEN> as orders/create.

// Dedup map: key = `${source}:${sourceId}`, value = timestamp
const _bridgeDedupCache = new Map();
const BRIDGE_DEDUP_TTL_MS = parseInt(process.env.AUTODS_BRIDGE_DEDUP_TTL_MS || '86400000', 10);

function _bridgeDedupCheck(key) {
  const now = Date.now();
  const last = _bridgeDedupCache.get(key);
  if (last && (now - last) < BRIDGE_DEDUP_TTL_MS) return true; // still valid
  _bridgeDedupCache.set(key, now);
  // Opportunistic prune
  if (_bridgeDedupCache.size > 5000) {
    for (const [k, t] of _bridgeDedupCache) {
      if ((now - t) > BRIDGE_DEDUP_TTL_MS) _bridgeDedupCache.delete(k);
    }
  }
  return false;
}

function _readLineItemProperty(lineItem, key) {
  if (!lineItem || !lineItem.properties) return null;
  const props = lineItem.properties;
  if (Array.isArray(props)) {
    const found = props.find(p => p && p.name === key);
    return found ? found.value : null;
  }
  if (typeof props === 'object') return props[key] || null;
  return null;
}

function _extractSourceFromLineItem(lineItem) {
  // Properties our prepareCart attaches: _source_store, _source_id, _source_smid,
  // _source_variant_id, _source_url, _shopify_product_id (the live Shopify id we created).
  const source = _readLineItemProperty(lineItem, '_source_store');
  const sourceId = _readLineItemProperty(lineItem, '_source_id');
  if (!source || !sourceId) return null;
  return {
    source: String(source).toLowerCase(),
    sourceId: String(sourceId),
    smid: _readLineItemProperty(lineItem, '_source_smid') || null,
    sourceUrl: _readLineItemProperty(lineItem, '_source_url') || null,
    shopifyProductId: lineItem.product_id ? String(lineItem.product_id) : null
  };
}

async function _callBridgeConnect(payload) {
  const bridgeUrl = process.env.AUTODS_BRIDGE_URL;
  const bridgeToken = process.env.AUTODS_BRIDGE_TOKEN || 'dev-token-change-me-in-production';
  if (!bridgeUrl) throw new Error('AUTODS_BRIDGE_URL not configured');

  const fetch = require('node-fetch');
  const url = bridgeUrl.replace(/\/$/, '') + '/connect-product';
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 180000); // 3 min hard cap
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Bridge-Token': bridgeToken
      },
      body: JSON.stringify(payload),
      signal: ctrl.signal
    });
    const json = await r.json().catch(() => ({}));
    return { httpStatus: r.status, body: json };
  } finally {
    clearTimeout(t);
  }
}

app.post('/webhooks/checkouts/create', async (req, res) => {
  // Same auth pattern as /webhooks/orders/create
  const expected = process.env.WEBHOOK_TOKEN || WEBHOOK_TOKEN_FALLBACK;
  const provided = req.query.token || req.headers['x-webhook-token'];
  const tokenOk = provided && provided === expected;
  if (!tokenOk) {
    const hmac = req.headers['x-shopify-hmac-sha256'];
    const secret = process.env.SHOPIFY_WEBHOOK_SECRET || process.env.SHOPIFY_CLIENT_SECRET;
    let hmacOk = false;
    if (secret && hmac && req.rawBody) {
      try {
        const crypto = require('crypto');
        const hash = crypto.createHmac('sha256', secret).update(req.rawBody, 'utf8').digest('base64');
        hmacOk = crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(hash));
      } catch (e) { hmacOk = false; }
    }
    if (!hmacOk) {
      logger.warn('webhook', 'checkouts/create rejected — no valid token or HMAC');
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  // Ack Shopify immediately
  res.status(200).json({ received: true });

  const checkout = req.body;
  if (!checkout || !checkout.id) return;
  const checkoutRef = checkout.token || checkout.id;
  const lineItems = Array.isArray(checkout.line_items) ? checkout.line_items : [];
  if (lineItems.length === 0) return;

  // Fire-and-forget Connect calls for each line item
  (async () => {
    for (const item of lineItems) {
      const src = _extractSourceFromLineItem(item);
      if (!src || !src.shopifyProductId) {
        logger.debug('bridge', `[checkouts/create:${checkoutRef}] skip line item ${item.id || '?'} — no source props`);
        continue;
      }
      const dedupKey = `${src.source}:${src.sourceId}`;
      if (_bridgeDedupCheck(dedupKey)) {
        logger.info('bridge', `[checkouts/create:${checkoutRef}] dedup skip ${dedupKey} (already requested in last ${BRIDGE_DEDUP_TTL_MS/1000/3600}h)`);
        continue;
      }
      logger.info('bridge', `[checkouts/create:${checkoutRef}] dispatch connect ${dedupKey} → shopify=${src.shopifyProductId}`);
      try {
        const result = await _callBridgeConnect(src);
        logger.info('bridge', `[checkouts/create:${checkoutRef}] connect result ${dedupKey}: http=${result.httpStatus} ok=${result.body?.ok} reason=${result.body?.reason || 'ok'}`);
      } catch (e) {
        logger.error('bridge', `[checkouts/create:${checkoutRef}] connect call failed ${dedupKey}: ${e.message}`);
        // On failure remove from dedup so a retry can happen
        _bridgeDedupCache.delete(dedupKey);
      }
    }
  })();
});

// Diagnostic: GET to verify bridge connectivity from Render
app.get('/api/admin/bridge-health', async (req, res) => {
  const token = req.query.token || req.headers['x-admin-token'];
  if (token !== 'stylehub-admin-2026') return res.status(401).json({ error: 'Unauthorized' });
  const bridgeUrl = process.env.AUTODS_BRIDGE_URL;
  if (!bridgeUrl) return res.status(503).json({ ok: false, reason: 'AUTODS_BRIDGE_URL not configured' });
  try {
    const fetch = require('node-fetch');
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 30000);
    const r = await fetch(bridgeUrl.replace(/\/$/, '') + '/health', { signal: ctrl.signal });
    clearTimeout(t);
    const body = await r.json().catch(() => ({}));
    res.json({ ok: r.ok, httpStatus: r.status, bridgeResponse: body, bridgeUrl, dedupCacheSize: _bridgeDedupCache.size });
  } catch (e) {
    res.status(503).json({ ok: false, reason: e.message, bridgeUrl });
  }
});

// ---- ADMIN: AutoDS Dashboard ----
app.get('/api/admin/autods/stats', (req, res) => {
  const token = req.query.token || req.headers['x-admin-token'];
  if (token !== 'stylehub-admin-2026') return res.status(401).json({ error: 'Unauthorized' });
  try {
    res.json(autods.getAutodsStats());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- ADMIN: AutoDS Orders ----
app.get('/api/admin/autods/orders', (req, res) => {
  const token = req.query.token || req.headers['x-admin-token'];
  if (token !== 'stylehub-admin-2026') return res.status(401).json({ error: 'Unauthorized' });
  try {
    const { limit = 50, status } = req.query;
    res.json(autods.getAutodsOrders(parseInt(limit), status || null));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- ADMIN: AutoDS Pending Products (not yet linked in AutoDS) ----
app.get('/api/admin/autods/pending', (req, res) => {
  const token = req.query.token || req.headers['x-admin-token'];
  if (token !== 'stylehub-admin-2026') return res.status(401).json({ error: 'Unauthorized' });
  try {
    const { limit = 100, source } = req.query;
    res.json(autods.getPendingProducts(parseInt(limit), source || null));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- ADMIN: AutoDS CSV Export (for bulk import into AutoDS) ----
app.get('/api/admin/autods/csv', (req, res) => {
  const token = req.query.token || req.headers['x-admin-token'];
  if (token !== 'stylehub-admin-2026') return res.status(401).json({ error: 'Unauthorized' });
  try {
    const { status, source, limit, download } = req.query;
    const result = autods.generateAutodsCSV({
      status: status || 'pending',
      source: source || null,
      limit: limit ? parseInt(limit) : null
    });

    if (download === 'true') {
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="autods-import-${Date.now()}.csv"`);
      return res.send(result.csv);
    }

    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- ADMIN: AutoDS Variant Mapping CSV ----
app.get('/api/admin/autods/mapping-csv', (req, res) => {
  const token = req.query.token || req.headers['x-admin-token'];
  if (token !== 'stylehub-admin-2026') return res.status(401).json({ error: 'Unauthorized' });
  try {
    const { source, unlinkedOnly, download } = req.query;
    const result = autods.generateVariantMappingCSV({
      source: source || null,
      unlinkedOnly: unlinkedOnly !== 'false'
    });

    if (download === 'true') {
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="autods-mapping-${Date.now()}.csv"`);
      return res.send(result.csv);
    }

    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- ADMIN: Resend AutoDS CSV Email for an existing order ----
// Fetches the order from Shopify Admin and triggers the same email path
// the order-created webhook would take. Use for: (1) re-delivering a lost
// email, (2) testing the mailer with Order #1009 after deploy.
// Example: GET/POST /api/admin/autods/resend-csv?token=...&order=1009
//      or: GET/POST /api/admin/autods/resend-csv?token=...&orderId=<numeric-shopify-id>
// Accepts GET (for quick browser testing) and POST (for scripts/automation).
app.all('/api/admin/autods/resend-csv', async (req, res) => {
  if (!['GET', 'POST'].includes(req.method)) {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const token = req.query.token || req.headers['x-admin-token'];
  if (token !== 'stylehub-admin-2026') return res.status(401).json({ error: 'Unauthorized' });

  const { order: orderNumber, orderId, to } = req.query;
  if (!orderNumber && !orderId) {
    return res.status(400).json({ error: 'Missing ?order=<number> or ?orderId=<shopify-id>' });
  }

  try {
    const { shopifyAdmin } = require('./src/shopify-admin');
    let shopifyOrder = null;

    if (orderId) {
      const resp = await shopifyAdmin('GET', `/orders/${orderId}.json`);
      shopifyOrder = resp?.order;
    } else {
      // Search by name (Shopify stores the "#1009" form in `name` and numeric in `order_number`).
      const clean = String(orderNumber).replace(/[^\d]/g, '');
      const resp = await shopifyAdmin('GET', `/orders.json?name=%23${clean}&status=any&limit=1`);
      shopifyOrder = (resp?.orders || [])[0];
      if (!shopifyOrder) {
        // Fallback: search by order_number
        const resp2 = await shopifyAdmin('GET', `/orders.json?status=any&limit=50&fields=id,name,order_number`);
        const match = (resp2?.orders || []).find(o => String(o.order_number) === clean || String(o.name).replace('#','') === clean);
        if (match) {
          const full = await shopifyAdmin('GET', `/orders/${match.id}.json`);
          shopifyOrder = full?.order;
        }
      }
    }

    if (!shopifyOrder) {
      return res.status(404).json({ error: 'Order not found in Shopify', orderNumber, orderId });
    }

    const { sendAutodsOrderEmail } = require('./src/services/autods-order-email');
    const result = await sendAutodsOrderEmail(shopifyOrder, to ? { to } : {});

    return res.json({
      orderName: shopifyOrder.name,
      orderId: shopifyOrder.id,
      result,
      mappedItems: result.rows?.length || 0,
      unmappedItems: result.unmapped?.length || 0
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// ---- ADMIN: Preview AutoDS CSV for an order (no email sent) ----
app.get('/api/admin/autods/preview-order-csv', async (req, res) => {
  const token = req.query.token || req.headers['x-admin-token'];
  if (token !== 'stylehub-admin-2026') return res.status(401).json({ error: 'Unauthorized' });

  const { order: orderNumber, orderId, download } = req.query;
  if (!orderNumber && !orderId) {
    return res.status(400).json({ error: 'Missing ?order=<number> or ?orderId=<shopify-id>' });
  }

  try {
    const { shopifyAdmin } = require('./src/shopify-admin');
    let shopifyOrder = null;

    if (orderId) {
      const resp = await shopifyAdmin('GET', `/orders/${orderId}.json`);
      shopifyOrder = resp?.order;
    } else {
      const clean = String(orderNumber).replace(/[^\d]/g, '');
      const resp = await shopifyAdmin('GET', `/orders.json?name=%23${clean}&status=any&limit=1`);
      shopifyOrder = (resp?.orders || [])[0];
    }

    if (!shopifyOrder) return res.status(404).json({ error: 'Order not found' });

    const { buildOrderCsv } = require('./src/services/autods-order-email');
    const { csv, rows, unmapped } = buildOrderCsv(shopifyOrder);

    if (download === 'true') {
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="order-${shopifyOrder.name.replace(/[^\w.-]/g, '_')}.csv"`);
      return res.send(csv);
    }

    return res.json({
      orderName: shopifyOrder.name,
      orderId: shopifyOrder.id,
      csv,
      rows,
      unmapped,
      mappedCount: rows.length,
      unmappedCount: unmapped.length
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// ---- ADMIN: SMTP / Mailer health check ----
app.get('/api/admin/autods/mailer-health', async (req, res) => {
  const token = req.query.token || req.headers['x-admin-token'];
  if (token !== 'stylehub-admin-2026') return res.status(401).json({ error: 'Unauthorized' });

  try {
    const mailer = require('./src/services/mailer');
    const cfg = mailer.getConfig();
    const verify = await mailer.verifyConnection();
    return res.json({
      enabled: cfg.enabled,
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      user: cfg.user ? `${cfg.user.slice(0, 3)}…@${cfg.user.split('@')[1] || '?'}` : '(unset)',
      fromName: cfg.fromName,
      fromAddress: cfg.fromAddress,
      verify
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// ---- ADMIN: Mark product(s) as linked in AutoDS ----
app.post('/api/admin/autods/mark-linked', (req, res) => {
  const token = req.query.token || req.headers['x-admin-token'];
  if (token !== 'stylehub-admin-2026') return res.status(401).json({ error: 'Unauthorized' });
  try {
    const { source, sourceId, autodsProductId, ids } = req.body;

    // Bulk mode
    if (ids && Array.isArray(ids)) {
      const count = autods.bulkMarkLinked(ids);
      return res.json({ success: true, markedCount: count });
    }

    // Single mode
    if (!source || !sourceId) return res.status(400).json({ error: 'Missing source or sourceId' });
    const success = autods.markProductLinked(source, sourceId, autodsProductId);
    res.json({ success });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- ADMIN: Seed source_seller_id onto an existing autods_products row ----
// Use when the RapidAPI adapter couldn't capture sellerId (e.g. Amazon-sold
// products where /product-offers returns no seller_id), and we know the
// canonical smid from a manual check. After seeding, resend-csv will emit
// /gp/product/ASIN/?smid=SID&th=1 via the DB fallback path.
//
// Example:
//   POST /api/admin/autods/seed-seller?token=...
//   body: { source: "amazon", sourceId: "B00IFWO8PI", sellerId: "A2Q1LRYTXHYQ2K" }
app.post('/api/admin/autods/seed-seller', (req, res) => {
  const token = req.query.token || req.headers['x-admin-token'];
  if (token !== 'stylehub-admin-2026') return res.status(401).json({ error: 'Unauthorized' });
  try {
    const { source, sourceId, sellerId, variantId } = req.body || {};
    if (!source || !sourceId || !sellerId) {
      return res.status(400).json({ error: 'Missing source, sourceId, or sellerId' });
    }
    const { getDb } = require('./src/utils/db');
    const db = getDb();
    if (!db) return res.status(503).json({ error: 'Database unavailable' });

    // Look up existing mapping in autods_products first, falling back to
    // product_mappings (which tracks every Shopify sync even when autods_products
    // was never hit — e.g. when prepareCart ran pre-fix). This lets us seed
    // smid for orders whose products predate the autods registration path.
    let existing = db.prepare(
      'SELECT shopify_product_id, shopify_variant_id, shopify_handle, source_url FROM autods_products WHERE source_store = ? AND source_product_id = ?'
    ).get(source.toLowerCase(), String(sourceId));

    if (!existing) {
      try {
        const mapping = db.prepare(
          'SELECT shopify_product_id, shopify_variant_id, shopify_handle FROM product_mappings WHERE source_store = ? AND source_product_id = ? LIMIT 1'
        ).get(source.toLowerCase(), String(sourceId));
        if (mapping) {
          existing = { ...mapping, source_url: null };
        }
      } catch (_) { /* product_mappings may have different schema */ }
    }

    // If no mapping exists anywhere (e.g. ephemeral disk wiped DB but the
    // original Shopify order still carries line item properties), seed with
    // nulls for Shopify fields. extractSourceInfo's DB fallback only needs
    // source_seller_id — shopify IDs aren't read from autods_products at
    // CSV generation time. This unblocks seeding for "orphan" products.
    if (!existing) {
      existing = { shopify_product_id: null, shopify_variant_id: null, shopify_handle: null, source_url: null };
    }

    autods.registerProduct({
      source,
      sourceId,
      sourceUrl: existing.source_url,
      shopifyProductId: existing.shopify_product_id,
      shopifyVariantId: existing.shopify_variant_id,
      shopifyHandle: existing.shopify_handle,
      sourceSellerId: sellerId,
      sourceVariantId: variantId || null,
    });

    const after = db.prepare(
      'SELECT buy_id, source_seller_id, source_variant_id FROM autods_products WHERE source_store = ? AND source_product_id = ?'
    ).get(source.toLowerCase(), String(sourceId));

    res.json({ success: true, source, sourceId, seeded: after });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- ADMIN: Register existing products to AutoDS tracking ----
// Scans product_mappings table and registers any untracked products
app.post('/api/admin/autods/sync-existing', (req, res) => {
  const token = req.query.token || req.headers['x-admin-token'];
  if (token !== 'stylehub-admin-2026') return res.status(401).json({ error: 'Unauthorized' });
  try {
    const { getAllMappings } = require('./src/utils/db');
    const mappings = getAllMappings(500, 0);
    let registered = 0;

    for (const m of mappings) {
      try {
        autods.registerProduct({
          source: m.source_store,
          sourceId: m.source_product_id,
          sourceUrl: '', // Will use URL builder
          shopifyProductId: m.shopify_product_id,
          shopifyVariantId: m.shopify_variant_id,
          shopifyHandle: m.shopify_handle
        });
        registered++;
      } catch (e) {
        logger.debug('autods', `Failed to register mapping ${m.id}: ${e.message}`);
      }
    }

    res.json({ success: true, total: mappings.length, registered });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- ADMIN: Webhook setup helper ----
// Returns the webhook URLs that need to be configured in Shopify
app.get('/api/admin/autods/webhook-info', (req, res) => {
  const token = req.query.token || req.headers['x-admin-token'];
  if (token !== 'stylehub-admin-2026') return res.status(401).json({ error: 'Unauthorized' });

  const baseUrl = process.env.RENDER_EXTERNAL_URL || `https://dealshub-search.onrender.com`;

  res.json({
    info: 'Register these webhooks in Shopify Admin → Settings → Notifications → Webhooks',
    webhooks: [
      {
        event: 'Order creation',
        url: `${baseUrl}/webhooks/orders/create`,
        format: 'JSON',
        apiVersion: '2024-01'
      },
      {
        event: 'Order update',
        url: `${baseUrl}/webhooks/orders/updated`,
        format: 'JSON',
        apiVersion: '2024-01'
      }
    ],
    envVars: {
      SHOPIFY_WEBHOOK_SECRET: 'Set this to the webhook signing secret from Shopify',
      AUTODS_API_KEY: '(Optional) Set when AutoDS API is activated',
      AUTODS_STORE_ID: '(Optional) Your AutoDS store ID',
      AUTODS_ENABLED: '(Optional) Set to "true" to enable API calls'
    }
  });
});

// ---- PUBLIC: Webhook test endpoint ----
app.get('/webhooks/health', (req, res) => {
  res.json({ status: 'ok', webhooks: ['orders/create', 'orders/updated'], timestamp: new Date().toISOString() });
});

// ============================================================
// CRON JOBS — re-enabled with cron-resync service (2026-04-27)
// Endpoints live in src/routes/admin.js (cron/run, cron/status, cron/stop).
// Auto-scheduler armed in app.listen handler below.
// ============================================================

app.get('/api/admin/cron/history', (req, res) => {
  res.json([]);
});

// ---- ADMIN: Backfill missing products from order items into autods_products ----
app.post('/api/admin/autods/backfill-products', (req, res) => {
  const token = req.query.token || req.headers['x-admin-token'];
  if (token !== 'stylehub-admin-2026') return res.status(401).json({ error: 'Unauthorized' });

  try {
    const { getDb } = require('./src/utils/db');
    const autods = require('./src/services/autods');
    const localDb = getDb();
    if (!localDb) return res.status(500).json({ error: 'DB not available' });

    const orphanItems = localDb.prepare(`
      SELECT DISTINCT oi.source_store, oi.source_product_id, oi.source_url,
             oi.shopify_product_id, oi.shopify_variant_id, oi.buy_id
      FROM autods_order_items oi
      WHERE oi.source_store IS NOT NULL
        AND oi.source_product_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM autods_products ap
          WHERE ap.source_store = oi.source_store
            AND ap.source_product_id = oi.source_product_id
        )
    `).all();

    let registered = 0;
    for (const item of orphanItems) {
      try {
        autods.registerProduct({
          source: item.source_store,
          sourceId: item.source_product_id,
          sourceUrl: item.source_url || item.buy_id || '',
          shopifyProductId: item.shopify_product_id,
          shopifyVariantId: item.shopify_variant_id,
          shopifyHandle: ''
        });
        registered++;
      } catch (e) {
        logger.warn('admin', `Backfill failed: ${item.source_store}/${item.source_product_id}: ${e.message}`);
      }
    }

    res.json({ success: true, orphanItems: orphanItems.length, registered });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- ADMIN: Force-update order status from Shopify ----
app.post('/api/admin/autods/sync-order-status', async (req, res) => {
  const token = req.query.token || req.headers['x-admin-token'];
  if (token !== 'stylehub-admin-2026') return res.status(401).json({ error: 'Unauthorized' });

  try {
    const { getDb } = require('./src/utils/db');
    const localDb = getDb();
    if (!localDb) return res.status(500).json({ error: 'DB not available' });

    const shopifyDomain = process.env.SHOPIFY_STORE_DOMAIN;
    const shopifyToken = process.env.SHOPIFY_ADMIN_TOKEN;
    if (!shopifyDomain || !shopifyToken) return res.status(500).json({ error: 'Shopify not configured' });

    const localOrders = localDb.prepare('SELECT shopify_order_id, autods_status, financial_status FROM autods_orders').all();
    let updated = 0;
    const updates = [];

    for (const local of localOrders) {
      try {
        const resp = await fetch(
          `https://${shopifyDomain}/admin/api/2024-01/orders/${local.shopify_order_id}.json?fields=id,name,financial_status,fulfillment_status,cancelled_at`,
          { headers: { 'X-Shopify-Access-Token': shopifyToken, 'Content-Type': 'application/json' } }
        );
        if (!resp.ok) continue;
        const { order } = await resp.json();

        let newStatus = local.autods_status;
        if (order.cancelled_at || order.financial_status === 'refunded' || order.financial_status === 'voided') {
          newStatus = 'cancelled';
        }

        if (newStatus !== local.autods_status || order.financial_status !== local.financial_status) {
          localDb.prepare(`
            UPDATE autods_orders
            SET autods_status = ?, financial_status = ?, fulfillment_status = ?, updated_at = datetime('now')
            WHERE shopify_order_id = ?
          `).run(newStatus, order.financial_status, order.fulfillment_status || '', local.shopify_order_id);
          updated++;
          updates.push({ orderId: local.shopify_order_id, name: order.name, oldStatus: local.autods_status, newStatus, financialStatus: order.financial_status });
        }
      } catch (e) {
        logger.warn('admin', `Failed to sync order ${local.shopify_order_id}: ${e.message}`);
      }
    }

    res.json({ success: true, checked: localOrders.length, updated, updates });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  logger.info('server', `StyleHub backend v2.5 running on port ${PORT}`);
  logger.info('server', `Sources: ${VALID_SOURCES.join(', ')}`);
  logger.info('server', `Shopify: ${process.env.SHOPIFY_STORE_DOMAIN ? 'configured' : 'NOT configured'}`);

  // ---- POSTGRES BACKUP RESTORE ----
  // Render Free Tier wipes the SQLite filesystem on every deploy. If a
  // DATABASE_URL is configured (Render Postgres), pull all persisted product
  // mappings back into the in-process SQLite so the wizard pipeline never
  // re-creates a duplicate Shopify product after a deploy.
  if (process.env.DATABASE_URL) {
    (async () => {
      try {
        const restored = await db.restoreMappingsFromBackup();
        logger.info('server', `Postgres restore: ${restored} mapping(s) re-seeded into SQLite`);
      } catch (e) {
        logger.error('server', `Postgres restore failed: ${e.message}`);
      }
    })();
  }

  // Warm up cache after server starts (don't await â let it run in background)
  setTimeout(warmUpCache, 2000);

  // ---- AUTO-RESYNC SCHEDULER ----
  // Daily refresh of Shopify products from source APIs (price, stock, variants, images).
  // First run 30min after boot; recurs every 24h. Manual trigger via POST /api/admin/cron/run.
  try {
    const cronResync = require('./src/services/cron-resync');
    cronResync.startScheduler();
  } catch (e) {
    logger.warn('server', `cron-resync scheduler failed to start: ${e.message}`);
  }

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

// v2.6 forced rebuild
