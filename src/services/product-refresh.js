// ============================================================
// StyleHub — Product Refresh Service (Cron Task 8)
// ============================================================
// Periodically refreshes synced products to keep prices, stock,
// and availability up-to-date across Shopify and Google Shopping.
//
// Flow:
//   1. Read all product_mappings from DB
//   2. For each: re-fetch current data from source API
//   3. Compare price/availability vs Shopify
//   4. If changed → update Shopify product/variant
//   5. If unavailable → set product to draft
//   6. Log all changes for monitoring
// ============================================================

const fetch = require('node-fetch');

// ---- CONFIG ----
const SHOPIFY_DOMAIN = () => process.env.SHOPIFY_STORE_DOMAIN;
const SHOPIFY_TOKEN  = () => process.env.SHOPIFY_ADMIN_TOKEN;
const API_VERSION    = '2024-01';
const BATCH_SIZE     = 20;
const PRICE_THRESHOLD = 0.02;
const RAPIDAPI_KEY   = () => process.env.RAPIDAPI_KEY;

// Simple logger fallback
let logger;
try { logger = require('./utils/logger'); } catch(e) {
  try { logger = require('../utils/logger'); } catch(e2) {
    logger = { info: (t,m) => console.log(`[${t}] ${m}`), warn: (t,m) => console.warn(`[${t}] ${m}`), error: (t,m) => console.error(`[${t}] ${m}`), debug: () => {} };
  }
}

// ---- SHOPIFY API HELPER ----
async function shopifyAPI(endpoint, method = 'GET', body = null) {
  const url = `https://${SHOPIFY_DOMAIN()}/admin/api/${API_VERSION}${endpoint}`;
  const opts = {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': SHOPIFY_TOKEN()
    },
    signal: AbortSignal.timeout(15000)
  };
  if (body) opts.body = JSON.stringify(body);
  const resp = await fetch(url, opts);
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Shopify API ${resp.status}: ${text.substring(0, 200)}`);
  }
  const text = await resp.text();
  return text ? JSON.parse(text) : {};
}

// ---- MARKUP CALCULATOR (matches pricing.js logic) ----
function getMarkupPercent(source) {
  const markups = {
    amazon: parseFloat(process.env.MARKUP_AMAZON || '40'),
    aliexpress: parseFloat(process.env.MARKUP_ALIEXPRESS || '50'),
    sephora: parseFloat(process.env.MARKUP_SEPHORA || '35'),
    macys: parseFloat(process.env.MARKUP_MACYS || '35'),
    shein: parseFloat(process.env.MARKUP_SHEIN || '50')
  };
  return markups[source] || 35;
}

function calculatePrice(sourcePrice, source) {
  const markup = getMarkupPercent(source);
  let finalPrice = sourcePrice * (1 + markup / 100);
  finalPrice = Math.floor(finalPrice) + 0.99;
  return Math.max(finalPrice, 1.99);
}

// ---- SOURCE API FETCHERS ----
// Each returns { price, originalPrice, available, title } or null

async function fetchAmazonProduct(sourceId) {
  try {
    const resp = await fetch(`https://real-time-amazon-data.p.rapidapi.com/product-details?asin=${sourceId}&country=US`, {
      headers: { 'x-rapidapi-key': RAPIDAPI_KEY(), 'x-rapidapi-host': 'real-time-amazon-data.p.rapidapi.com' },
      signal: AbortSignal.timeout(12000)
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const p = data?.data;
    if (!p) return null;
    const price = parseFloat(String(p.product_price || '0').replace(/[^0-9.]/g, ''));
    const originalPrice = parseFloat(String(p.product_original_price || p.product_price || '0').replace(/[^0-9.]/g, ''));
    return {
      price: price || null,
      originalPrice: originalPrice || null,
      available: p.product_availability !== 'Currently unavailable' && price > 0,
      title: p.product_title || ''
    };
  } catch (e) {
    logger.debug('product-refresh', `Amazon fetch failed for ${sourceId}: ${e.message}`);
    return null;
  }
}

async function fetchAliExpressProduct(sourceId) {
  try {
    const resp = await fetch(`https://aliexpress-datahub.p.rapidapi.com/item_detail_2?itemId=${sourceId}`, {
      headers: { 'x-rapidapi-key': RAPIDAPI_KEY(), 'x-rapidapi-host': 'aliexpress-datahub.p.rapidapi.com' },
      signal: AbortSignal.timeout(12000)
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const item = data?.result?.item;
    if (!item) return null;
    const price = parseFloat(String(item.sku?.def?.promotionPrice || item.sku?.def?.price || '0').replace(/[^0-9.]/g, ''));
    const originalPrice = parseFloat(String(item.sku?.def?.price || '0').replace(/[^0-9.]/g, ''));
    return {
      price: price || null,
      originalPrice: originalPrice || null,
      available: price > 0,
      title: item.title || ''
    };
  } catch (e) {
    logger.debug('product-refresh', `AliExpress fetch failed for ${sourceId}: ${e.message}`);
    return null;
  }
}

async function fetchSephoraProduct(sourceId) {
  try {
    const resp = await fetch(`https://sephora33.p.rapidapi.com/product-detail?productId=${sourceId}&country=us`, {
      headers: { 'x-rapidapi-key': RAPIDAPI_KEY(), 'x-rapidapi-host': 'sephora33.p.rapidapi.com' },
      signal: AbortSignal.timeout(12000)
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const p = data?.data;
    if (!p) return null;
    const price = parseFloat(String(p.currentSku?.listPrice || p.currentSku?.salePrice || '0').replace(/[^0-9.]/g, ''));
    return {
      price: price || null,
      originalPrice: price,
      available: price > 0,
      title: p.displayName || ''
    };
  } catch (e) {
    logger.debug('product-refresh', `Sephora fetch failed for ${sourceId}: ${e.message}`);
    return null;
  }
}

async function fetchMacysProduct(sourceId) {
  try {
    const resp = await fetch(`https://macys4.p.rapidapi.com/products/detail?id=${sourceId}`, {
      headers: { 'x-rapidapi-key': RAPIDAPI_KEY(), 'x-rapidapi-host': 'macys4.p.rapidapi.com' },
      signal: AbortSignal.timeout(12000)
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const p = data?.data?.product;
    if (!p) return null;
    const price = parseFloat(String(p.pricing?.price?.tieredPrice?.[0]?.values?.[0]?.value || p.price || '0').replace(/[^0-9.]/g, ''));
    return {
      price: price || null,
      originalPrice: price,
      available: price > 0,
      title: p.detail?.name || ''
    };
  } catch (e) {
    logger.debug('product-refresh', `Macys fetch failed for ${sourceId}: ${e.message}`);
    return null;
  }
}

async function fetchSheinProduct(sourceId) {
  try {
    const resp = await fetch(`https://unofficial-shein.p.rapidapi.com/products/detail?goods_id=${sourceId}&language=en&country=US&currency=USD`, {
      headers: { 'x-rapidapi-key': RAPIDAPI_KEY(), 'x-rapidapi-host': 'unofficial-shein.p.rapidapi.com' },
      signal: AbortSignal.timeout(12000)
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const p = data?.info;
    if (!p) return null;
    const price = parseFloat(String(p.salePrice?.amount || p.retailPrice?.amount || '0').replace(/[^0-9.]/g, ''));
    const originalPrice = parseFloat(String(p.retailPrice?.amount || '0').replace(/[^0-9.]/g, ''));
    return {
      price: price || null,
      originalPrice: originalPrice || null,
      available: p.is_on_sale !== 0 && price > 0,
      title: p.goods_name || ''
    };
  } catch (e) {
    logger.debug('product-refresh', `Shein fetch failed for ${sourceId}: ${e.message}`);
    return null;
  }
}

const SOURCE_FETCHERS = {
  amazon: fetchAmazonProduct,
  aliexpress: fetchAliExpressProduct,
  sephora: fetchSephoraProduct,
  macys: fetchMacysProduct,
  shein: fetchSheinProduct
};

// ---- MAIN REFRESH LOGIC ----
async function refreshProducts(batchSize = BATCH_SIZE) {
  if (!SHOPIFY_DOMAIN() || !SHOPIFY_TOKEN()) {
    logger.warn('product-refresh', 'Shopify not configured, skipping');
    return { skipped: true, reason: 'no-shopify-config' };
  }
  if (!RAPIDAPI_KEY()) {
    logger.warn('product-refresh', 'RAPIDAPI_KEY not configured, skipping');
    return { skipped: true, reason: 'no-rapidapi-key' };
  }

  // Get DB module
  let getDb, logSync;
  try {
    const db = require('./utils/db');
    getDb = db.getDb;
    logSync = db.logSync;
  } catch(e) {
    try {
      const db = require('../utils/db');
      getDb = db.getDb;
      logSync = db.logSync;
    } catch(e2) {
      logger.error('product-refresh', 'Cannot load db module');
      return { skipped: true, reason: 'no-db-module' };
    }
  }

  const db = getDb();
  if (!db) {
    logger.warn('product-refresh', 'No DB available');
    return { skipped: true, reason: 'no-db' };
  }

  // Get products to refresh — oldest checked first
  let mappings;
  try {
    try {
      db.exec(`ALTER TABLE product_mappings ADD COLUMN refresh_checked_at TEXT`);
    } catch(e) { /* column already exists */ }
    try {
      db.exec(`ALTER TABLE product_mappings ADD COLUMN refresh_status TEXT DEFAULT 'ok'`);
    } catch(e) { /* column already exists */ }

    mappings = db.prepare(`
      SELECT source_store, source_product_id, shopify_product_id, shopify_variant_id,
             last_price, last_original_price, shopify_handle, sync_status,
             refresh_checked_at, refresh_status
      FROM product_mappings
      WHERE sync_status = 'synced'
      ORDER BY refresh_checked_at ASC NULLS FIRST, updated_at ASC
      LIMIT ?
    `).all(batchSize);
  } catch(e) {
    mappings = db.prepare(`
      SELECT source_store, source_product_id, shopify_product_id, shopify_variant_id,
             last_price, last_original_price, shopify_handle, sync_status
      FROM product_mappings
      WHERE sync_status = 'synced'
      ORDER BY updated_at ASC
      LIMIT ?
    `).all(batchSize);
  }

  if (!mappings || mappings.length === 0) {
    logger.info('product-refresh', 'No products to refresh');
    return { checked: 0 };
  }

  logger.info('product-refresh', `Refreshing ${mappings.length} products...`);

  const stats = {
    checked: 0,
    priceUpdated: 0,
    setUnavailable: 0,
    unchanged: 0,
    fetchFailed: 0,
    updateFailed: 0,
    details: []
  };

  for (const mapping of mappings) {
    stats.checked++;
    const { source_store, source_product_id, shopify_product_id, shopify_variant_id, last_price } = mapping;

    try {
      // 1. Fetch current data from source API
      const fetcher = SOURCE_FETCHERS[source_store];
      if (!fetcher) {
        logger.debug('product-refresh', `No fetcher for source: ${source_store}`);
        stats.fetchFailed++;
        continue;
      }

      const sourceData = await fetcher(source_product_id);

      // Mark as checked regardless
      try {
        db.prepare(`UPDATE product_mappings SET refresh_checked_at = datetime('now') WHERE source_store = ? AND source_product_id = ?`)
          .run(source_store, source_product_id);
      } catch(e) { /* refresh column might not exist */ }

      if (!sourceData || sourceData.price === null) {
        stats.fetchFailed++;
        logger.debug('product-refresh', `No data for ${source_store}:${source_product_id}`);
        try {
          db.prepare(`UPDATE product_mappings SET refresh_status = 'fetch-failed' WHERE source_store = ? AND source_product_id = ?`)
            .run(source_store, source_product_id);
        } catch(e) { /* ok */ }
        continue;
      }

      // 2. Check availability
      if (!sourceData.available) {
        try {
          await shopifyAPI(`/products/${shopify_product_id}.json`, 'PUT', {
            product: { id: shopify_product_id, status: 'draft' }
          });
          stats.setUnavailable++;
          logger.info('product-refresh', `Set DRAFT: ${source_store}:${source_product_id} (shopify:${shopify_product_id}) — unavailable at source`);
          try {
            db.prepare(`UPDATE product_mappings SET sync_status = 'unavailable', refresh_status = 'unavailable', refresh_checked_at = datetime('now') WHERE source_store = ? AND source_product_id = ?`)
              .run(source_store, source_product_id);
          } catch(e) { /* ok */ }
          if (logSync) logSync(source_store, source_product_id, 'refresh-unavailable', shopify_product_id);
          stats.details.push({ source: source_store, id: source_product_id, action: 'set-draft' });
        } catch (e) {
          stats.updateFailed++;
          logger.warn('product-refresh', `Failed to set draft for ${shopify_product_id}: ${e.message}`);
        }
        continue;
      }

      // 3. Check price change
      const currentShopifyPrice = parseFloat(last_price || '0');
      const newSourcePrice = sourceData.price;
      const newFinalPrice = calculatePrice(newSourcePrice, source_store);

      const priceDiff = currentShopifyPrice > 0
        ? Math.abs(newFinalPrice - currentShopifyPrice) / currentShopifyPrice
        : 1;

      if (priceDiff > PRICE_THRESHOLD) {
        const compareAt = sourceData.originalPrice && sourceData.originalPrice > newSourcePrice
          ? calculatePrice(sourceData.originalPrice, source_store)
          : null;

        try {
          if (shopify_variant_id) {
            await shopifyAPI(`/variants/${shopify_variant_id}.json`, 'PUT', {
              variant: {
                id: parseInt(shopify_variant_id),
                price: newFinalPrice.toFixed(2),
                compare_at_price: compareAt ? compareAt.toFixed(2) : null
              }
            });
          }

          try {
            await shopifyAPI(`/products/${shopify_product_id}/metafields.json`, 'POST', {
              metafield: {
                namespace: 'dealshub',
                key: 'landed_cost',
                value: String(newSourcePrice),
                type: 'single_line_text_field'
              }
            });
          } catch(e) { /* metafield update is non-critical */ }

          try {
            db.prepare(`
              UPDATE product_mappings
              SET last_price = ?, last_original_price = ?, refresh_checked_at = datetime('now'), refresh_status = 'price-updated', updated_at = datetime('now')
              WHERE source_store = ? AND source_product_id = ?
            `).run(newFinalPrice.toFixed(2), (compareAt || newFinalPrice).toFixed(2), source_store, source_product_id);
          } catch(e) {
            db.prepare(`
              UPDATE product_mappings
              SET last_price = ?, last_original_price = ?, updated_at = datetime('now')
              WHERE source_store = ? AND source_product_id = ?
            `).run(newFinalPrice.toFixed(2), (compareAt || newFinalPrice).toFixed(2), source_store, source_product_id);
          }

          if (logSync) logSync(source_store, source_product_id, 'refresh-price-update', shopify_product_id);
          stats.priceUpdated++;
          stats.details.push({
            source: source_store,
            id: source_product_id,
            action: 'price-updated',
            oldPrice: currentShopifyPrice.toFixed(2),
            newPrice: newFinalPrice.toFixed(2),
            change: `${(priceDiff * 100).toFixed(1)}%`
          });
          logger.info('product-refresh', `Price updated: ${source_store}:${source_product_id} $${currentShopifyPrice.toFixed(2)} → $${newFinalPrice.toFixed(2)} (${(priceDiff * 100).toFixed(1)}%)`);
        } catch (e) {
          stats.updateFailed++;
          logger.warn('product-refresh', `Failed to update price for ${shopify_product_id}: ${e.message}`);
        }
      } else {
        stats.unchanged++;
        try {
          db.prepare(`UPDATE product_mappings SET refresh_checked_at = datetime('now'), refresh_status = 'ok' WHERE source_store = ? AND source_product_id = ?`)
            .run(source_store, source_product_id);
        } catch(e) { /* ok */ }
      }

      // Small delay between API calls to avoid rate limits
      await new Promise(r => setTimeout(r, 500));

    } catch (e) {
      stats.fetchFailed++;
      logger.warn('product-refresh', `Error processing ${source_store}:${source_product_id}: ${e.message}`);
    }
  }

  logger.info('product-refresh', `Refresh complete: ${stats.checked} checked, ${stats.priceUpdated} price updates, ${stats.setUnavailable} unavailable, ${stats.unchanged} unchanged, ${stats.fetchFailed} fetch fails`);
  return stats;
}

module.exports = { refreshProducts };
