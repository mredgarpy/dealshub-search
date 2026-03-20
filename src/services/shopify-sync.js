// ============================================================
// StyleHub — Shopify Sync Service (On-Demand Product Creation)
// ============================================================
// Creates/updates products in Shopify ONLY when user wants to buy
// Handles: deduplication, inventory, variants, metafields
// FIX v1.1: Added storefront propagation wait after new product creation
// FIX v1.3: Blocking inventory set, 15s propagation wait, Admin API fallback

const fetch = require('node-fetch');
const logger = require('../utils/logger');
const { calculateFinalPrice, parsePrice } = require('../utils/pricing');
const { syncCache } = require('../utils/cache');
const { findMapping, upsertMapping, logSync } = require('../utils/db');

const SHOPIFY_DOMAIN = () => process.env.SHOPIFY_STORE_DOMAIN;
const SHOPIFY_TOKEN  = () => process.env.SHOPIFY_ADMIN_TOKEN;
const LOCATION_ID    = () => parseInt(process.env.SHOPIFY_LOCATION_ID || '84042121347');
const CUSTOM_DOMAIN  = () => process.env.SHOPIFY_CUSTOM_DOMAIN || 'stylehubmiami.com';
const API_VERSION    = '2024-01';

// ---- CONCURRENCY LOCK (prevents duplicate product creation) ----
const syncLocks = new Map();
function acquireLock(key) {
  if (syncLocks.has(key)) {
    return syncLocks.get(key); // Return existing promise
  }
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  promise._resolve = resolve;
  syncLocks.set(key, promise);
  return null; // Lock acquired
}
function releaseLock(key) {
  const lock = syncLocks.get(key);
  syncLocks.delete(key);
  if (lock && lock._resolve) lock._resolve();
}
// Clean stale locks every 5 minutes
setInterval(() => {
  if (syncLocks.size > 100) {
    logger.warn('sync', `Clearing ${syncLocks.size} stale sync locks`);
    syncLocks.clear();
  }
}, 300000);

// ---- SHOPIFY API HELPER ----
async function shopifyAPI(endpoint, method = 'GET', body = null) {
  const url = `https://${SHOPIFY_DOMAIN()}/admin/api/${API_VERSION}${endpoint}`;
  const opts = {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': SHOPIFY_TOKEN()
    }
  };
  if (body) opts.body = JSON.stringify(body);
  const resp = await fetch(url, opts);
  const text = await resp.text();
  if (!resp.ok) {
    logger.error('shopify-api', `${method} ${endpoint} failed: ${resp.status}`, { body: text.substring(0, 500) });
    throw new Error(`Shopify API ${resp.status}: ${text.substring(0, 200)}`);
  }
  return text ? JSON.parse(text) : {};
}

// ---- SLEEP UTILITY ----
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ---- WAIT FOR STOREFRONT PROPAGATION (v1.3 — longer wait + admin API fallback) ----
async function waitForStorefrontPropagation(handle, variantId, maxWaitMs = 15000) {
  const startTime = Date.now();
  const interval = 1000;
  let attempts = 0;

  // Phase 1: Check storefront JSON API (faster, but not always immediately available)
  while (Date.now() - startTime < maxWaitMs) {
    attempts++;
    try {
      const resp = await fetch(`https://${CUSTOM_DOMAIN()}/products/${handle}.json`, {
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(3000)
      });
      if (resp.ok) {
        const data = await resp.json();
        const found = data.product && data.product.variants &&
          data.product.variants.some(v => v.id === variantId);
        if (found) {
          logger.info('sync', `Storefront propagation confirmed in ${Date.now() - startTime}ms (${attempts} attempts)`, { handle, variantId });
          return true;
        }
      }
    } catch (e) {
      logger.debug('sync', `Propagation check attempt ${attempts} failed: ${e.message}`);
    }
    await sleep(interval);
  }

  // Phase 2: Verify via Admin API as fallback — product exists even if storefront hasn't propagated
  try {
    const adminCheck = await shopifyAPI(`/products.json?handle=${handle}&fields=id,variants,status`);
    if (adminCheck?.products?.[0]) {
      const adminProduct = adminCheck.products[0];
      const adminVariantFound = adminProduct.variants?.some(v => v.id === variantId);
      if (adminVariantFound && adminProduct.status === 'active') {
        logger.info('sync', `Admin API confirms product exists (storefront not yet propagated) — ${Date.now() - startTime}ms`, { handle, variantId });
        // Give storefront a bit more time since Admin confirms it exists
        await sleep(3000);
        return true;
      }
    }
  } catch (e) {
    logger.warn('sync', `Admin API propagation check failed: ${e.message}`);
  }

  logger.warn('sync', `Storefront propagation not confirmed after ${maxWaitMs}ms (${attempts} attempts)`, { handle, variantId });
  return false;
}

// ---- SET INVENTORY LEVEL (BACKUP) ----
async function setInventoryAvailable(inventoryItemId, quantity = 999) {
  if (!inventoryItemId) return;
  try {
    const levels = await shopifyAPI(`/inventory_levels.json?inventory_item_ids=${inventoryItemId}`);
    const level = levels?.inventory_levels?.[0];
    if (level && level.available < quantity) {
      await shopifyAPI('/inventory_levels/set.json', 'POST', {
        location_id: LOCATION_ID(),
        inventory_item_id: inventoryItemId,
        available: quantity
      });
      logger.info('sync', `Set inventory to ${quantity} for item ${inventoryItemId}`);
    }
  } catch (e) {
    logger.debug('sync', `Inventory set failed (may be untracked): ${e.message}`);
  }
}

// ---- CHECK IF PRODUCT ALREADY SYNCED ----
async function findExistingProduct(source, sourceId) {
  const cacheKey = `mapping:${source}:${sourceId}`;
  const cached = syncCache.get(cacheKey);
  if (cached) return cached;

  // Strategy 1: Search by tags
  try {
    const tagFilter = encodeURIComponent(`source-id:${sourceId}`);
    const data = await shopifyAPI(
      `/products.json?limit=5&status=any&fields=id,handle,variants,status,tags&tag=${tagFilter}`
    );
    if (data?.products?.length > 0) {
      const match = data.products.find(p => {
        const tags = (p.tags || '').split(',').map(t => t.trim());
        return tags.includes(`source-id:${sourceId}`) && tags.includes(`source:${source}`);
      });
      if (match && match.status !== 'archived') {
        const mapping = {
          shopifyProductId: match.id,
          shopifyVariantId: match.variants?.[0]?.id || null,
          handle: match.handle,
          variants: (match.variants || []).map(v => ({ id: v.id, title: v.title, price: v.price }))
        };
        syncCache.set(cacheKey, mapping, 3600000);
        logger.info('sync', 'Found existing product via tag search', { source, sourceId, shopifyId: match.id });
        return mapping;
      }
    }
  } catch (e) {
    logger.debug('sync', 'Tag-based product search failed', { error: e.message });
  }

  // Strategy 2: Check persistent DB mapping
  try {
    const dbMapping = findMapping(source, sourceId);
    if (dbMapping && dbMapping.shopify_product_id) {
      const check = await shopifyAPI(`/products/${dbMapping.shopify_product_id}.json?fields=id,handle,variants,status`);
      if (check?.product && check.product.status !== 'archived') {
        const mapping = {
          shopifyProductId: check.product.id,
          shopifyVariantId: dbMapping.shopify_variant_id || check.product.variants?.[0]?.id,
          handle: check.product.handle,
          variants: (check.product.variants || []).map(v => ({ id: v.id, title: v.title, price: v.price }))
        };
        syncCache.set(cacheKey, mapping, 3600000);
        logger.info('sync', 'Found existing product via DB mapping', { source, sourceId, shopifyId: check.product.id });
        return mapping;
      } else {
        logger.warn('sync', 'DB mapping points to archived/deleted product', { source, sourceId, shopifyId: dbMapping.shopify_product_id });
      }
    }
  } catch (e) {
    logger.debug('sync', 'DB-based product lookup failed', { error: e.message });
  }

  return null;
}

// ---- CREATE PRODUCT IN SHOPIFY ----
async function createShopifyProduct(productData, pricingResult) {
  const {
    source, sourceId, title, images, primaryImage,
    brand, description, bullets, options,
    variants: sourceVariants
  } = productData;

  // Build Shopify product payload
  const shopifyVariants = [];
  if (sourceVariants && sourceVariants.length > 0) {
    sourceVariants.slice(0, 100).forEach((v, i) => {
      const vPrice = v.price ? calculateFinalPrice(v.price, source) : pricingResult;
      shopifyVariants.push({
        title: v.title || `Option ${i + 1}`,
        price: vPrice.price.toFixed(2),
        compare_at_price: vPrice.compareAt ? vPrice.compareAt.toFixed(2) : null,
        sku: `DH-${source.toUpperCase()}-${sourceId}-${v.id || i}`,
        inventory_management: null,
        inventory_policy: 'continue',
        requires_shipping: true,
        weight: 0.5,
        weight_unit: 'lb',
        option1: v.title || `Option ${i + 1}`
      });
    });
  } else {
    shopifyVariants.push({
      price: pricingResult.price.toFixed(2),
      compare_at_price: pricingResult.compareAt ? pricingResult.compareAt.toFixed(2) : null,
      sku: `DH-${source.toUpperCase()}-${sourceId}`,
      inventory_management: null,
      inventory_policy: 'continue',
      requires_shipping: true,
      weight: 0.5,
      weight_unit: 'lb'
    });
  }

  // Build images array
  const shopifyImages = [];
  const allImages = [primaryImage, ...(images || [])].filter(Boolean);
  const uniqueImages = [...new Set(allImages)];
  uniqueImages.slice(0, 10).forEach(src => {
    shopifyImages.push({ src });
  });

  // Product options
  const shopifyOptions = [];
  if (sourceVariants && sourceVariants.length > 0) {
    shopifyOptions.push({
      name: (options?.[0]?.name) || 'Option',
      values: sourceVariants.map(v => v.title)
    });
  }

  // Shopify title max 255 characters
  const safeTitle = title && title.length > 255 ? title.substring(0, 252) + '...' : title;

  const payload = {
    product: {
      title: safeTitle,
      body_html: formatDescription(description, bullets),
      vendor: brand || 'StyleHub',
      product_type: productData.category || 'General',
      status: 'active',
      published: true,
      tags: [
        `source:${source}`,
        `source-id:${sourceId}`,
        'dealshub-synced',
        brand ? `brand:${brand}` : null
      ].filter(Boolean).join(', '),
      variants: shopifyVariants,
      images: shopifyImages,
      options: shopifyOptions.length > 0 ? shopifyOptions : undefined,
      metafields: [
        { namespace: 'dealshub', key: 'source_store', value: source, type: 'single_line_text_field' },
        { namespace: 'dealshub', key: 'source_product_id', value: String(sourceId), type: 'single_line_text_field' },
        { namespace: 'dealshub', key: 'source_url', value: productData.sourceUrl || '', type: 'single_line_text_field' },
        { namespace: 'dealshub', key: 'source_brand', value: brand || '', type: 'single_line_text_field' },
        { namespace: 'dealshub', key: 'landed_cost', value: String(pricingResult.landedCost), type: 'single_line_text_field' },
        { namespace: 'dealshub', key: 'margin_rule', value: pricingResult.rule || source, type: 'single_line_text_field' },
        { namespace: 'dealshub', key: 'sync_status', value: 'synced', type: 'single_line_text_field' },
        { namespace: 'dealshub', key: 'delivery_min_days', value: String(productData.deliveryEstimate?.minDays || ''), type: 'single_line_text_field' },
        { namespace: 'dealshub', key: 'delivery_max_days', value: String(productData.deliveryEstimate?.maxDays || ''), type: 'single_line_text_field' },
        { namespace: 'dealshub', key: 'delivery_label', value: productData.deliveryEstimate?.label || '', type: 'single_line_text_field' },
        { namespace: 'dealshub', key: 'shipping_note', value: productData.shippingData?.note || '', type: 'single_line_text_field' },
        { namespace: 'dealshub', key: 'return_window', value: String(productData.returnPolicy?.window || ''), type: 'single_line_text_field' }
      ]
    }
  };

  logger.info('sync', 'Creating Shopify product', { source, sourceId, title: title.substring(0, 50) });
  const result = await shopifyAPI('/products.json', 'POST', payload);
  const product = result.product;

  if (!product || !product.id) {
    throw new Error('Product creation returned no product');
  }

  // v1.3: Ensure inventory is properly set BEFORE returning (blocking, not fire-and-forget)
  logger.info('sync', 'Product created — setting inventory for all variants', {
    productId: product.id,
    variantCount: product.variants.length
  });

  // Set inventory for ALL variants (not just first), and AWAIT the result
  for (const variant of product.variants) {
    if (variant.inventory_item_id) {
      try {
        await setInventoryAvailable(variant.inventory_item_id, 999);
        logger.info('sync', `Inventory set for variant ${variant.id}`, { inventoryItemId: variant.inventory_item_id });
      } catch (invErr) {
        // If inventory set fails, force the variant to untracked mode as final fallback
        logger.warn('sync', `Inventory set failed for variant ${variant.id}, forcing untracked mode`, { error: invErr.message });
        try {
          await shopifyAPI(`/variants/${variant.id}.json`, 'PUT', {
            variant: { id: variant.id, inventory_management: null, inventory_policy: 'continue' }
          });
          logger.info('sync', `Forced variant ${variant.id} to untracked/continue`);
        } catch (varErr) {
          logger.error('sync', `Failed to force untracked mode for variant ${variant.id}`, { error: varErr.message });
        }
      }
    }
  }

  // ============================================================
  // FIX v1.3: Wait for storefront propagation (increased to 15s + admin API fallback)
  // This prevents the 422 race condition where cart/add.js
  // is called before Shopify's storefront knows about the variant
  // ============================================================
  const propagated = await waitForStorefrontPropagation(
    product.handle,
    product.variants[0].id,
    15000 // v1.3: increased from 5s, plus admin API fallback
  );

  if (!propagated) {
    logger.warn('sync', 'Product created but storefront propagation uncertain — client may need to retry', {
      productId: product.id,
      handle: product.handle
    });
  }

  // Cache the mapping
  const mapping = {
    shopifyProductId: product.id,
    shopifyVariantId: product.variants[0]?.id,
    handle: product.handle,
    variants: product.variants.map(v => ({ id: v.id, title: v.title, price: v.price })),
    isNewlyCreated: true // Signal to frontend that this is new
  };
  syncCache.set(`mapping:${source}:${sourceId}`, mapping, 3600000);
  return mapping;
}

// ---- PREPARE CART (Main entry point for buy flow) ----
async function prepareCart({ source, sourceId, productData, selectedVariantId, quantity = 1, forceResync = false }) {
  const _startTime = Date.now();
  const _timing = {};
  if (!SHOPIFY_TOKEN() || !SHOPIFY_DOMAIN()) {
    throw new Error('Shopify not configured');
  }

  // Concurrency lock: if another request is already syncing the same product, wait for it
  const lockKey = `${source}:${sourceId}`;
  const existingLock = acquireLock(lockKey);
  if (existingLock) {
    logger.info('sync', 'Waiting for concurrent sync to complete', { source, sourceId });
    await existingLock;
    // After waiting, the product should be in cache — retry lookup
    const cached = syncCache.get(`mapping:${source}:${sourceId}`);
    if (cached) {
      logger.info('sync', 'Using result from concurrent sync', { source, sourceId });
      let variantId = cached.shopifyVariantId;
      if (selectedVariantId && cached.variants?.length > 1) {
        const match = cached.variants.find(v => (v.title || '').toLowerCase().includes(String(selectedVariantId).toLowerCase()));
        if (match) variantId = match.id;
      }
      return {
        shopifyProductId: cached.shopifyProductId,
        shopifyVariantId: variantId,
        handle: cached.handle,
        available: true,
        price: cached.variants?.[0]?.price,
        timing: { total: Date.now() - _startTime, waitedForLock: true }
      };
    }
  }

  // Everything below is protected by concurrency lock — release in finally
  try {

  // Calculate final pricing
  let sourcePrice = productData.price;
  if (typeof sourcePrice === 'string') {
    sourcePrice = parseFloat(sourcePrice.replace(/[^0-9.]/g, ''));
  }
  if ((!sourcePrice || sourcePrice <= 0) && productData.displayPrice) {
    sourcePrice = parseFloat(String(productData.displayPrice).replace(/[^0-9.]/g, ''));
  }
  if ((!sourcePrice || sourcePrice <= 0) && productData.pricingMeta?.sourcePrice) {
    sourcePrice = productData.pricingMeta.sourcePrice;
  }
  if (!sourcePrice || sourcePrice <= 0) {
    throw new Error('Invalid product price');
  }

  const pricingResult = calculateFinalPrice(sourcePrice, source, {
    originalPrice: productData.originalPrice,
    shippingCost: productData.shippingData?.cost || 0
  });

  _timing.pricing = Date.now() - _startTime;
  const cacheKey = `mapping:${source}:${sourceId}`;

  if (forceResync) {
    syncCache.del(cacheKey);
    logger.info('sync', 'Force resync: cache cleared', { source, sourceId });
  }

  let mapping = forceResync ? null : syncCache.get(cacheKey);

  if (!mapping) {
    const dbMapping = findMapping(source, sourceId);
    if (dbMapping && dbMapping.shopify_product_id && dbMapping.shopify_variant_id) {
      mapping = {
        shopifyProductId: dbMapping.shopify_product_id,
        shopifyVariantId: dbMapping.shopify_variant_id,
        handle: dbMapping.shopify_handle,
        variants: [{ id: dbMapping.shopify_variant_id, title: 'Default', price: String(dbMapping.last_price || pricingResult.price) }]
      };
      syncCache.set(cacheKey, mapping, 3600000);
      logger.info('sync', 'Found existing mapping in DB', { source, sourceId, shopifyId: dbMapping.shopify_product_id });
    }
  }

  if (!mapping) {
    mapping = await findExistingProduct(source, sourceId);
    if (mapping) {
      logger.info('sync', 'Found existing product via Shopify tag search (DB was empty)', { source, sourceId, shopifyId: mapping.shopifyProductId });
      upsertMapping({
        source, sourceId,
        shopifyProductId: mapping.shopifyProductId,
        shopifyVariantId: mapping.shopifyVariantId,
        handle: mapping.handle,
        price: pricingResult.price,
        originalPrice: productData.originalPrice
      });
      forceResync = true;
    }
  }

  _timing.lookup = Date.now() - _startTime;

  if (!mapping) {
    // Create new product — includes propagation wait
    mapping = await createShopifyProduct(productData, pricingResult);
    upsertMapping({
      source, sourceId,
      shopifyProductId: mapping.shopifyProductId,
      shopifyVariantId: mapping.shopifyVariantId,
      handle: mapping.handle,
      price: pricingResult.price,
      originalPrice: productData.originalPrice
    });
    logSync(source, sourceId, 'create', 'success', { shopifyId: mapping.shopifyProductId });
  } else if (forceResync && mapping.shopifyProductId) {
    // Repair existing product
    try {
      const productResp = await shopifyAPI(`/products/${mapping.shopifyProductId}.json?fields=id,variants`);
      const variants = productResp?.product?.variants || [];
      for (const v of variants) {
        logger.info('sync', `Force-repairing variant ${v.id}`, { currentPolicy: v.inventory_policy, currentMgmt: v.inventory_management });
        await shopifyAPI(`/variants/${v.id}.json`, 'PUT', {
          variant: { id: v.id, inventory_policy: 'continue', inventory_management: null }
        });
        await setInventoryAvailable(v.inventory_item_id, 999);
        logger.info('sync', `Repaired variant ${v.id}: forced untracked + 999 stock backup`);
      }
      mapping.variants = variants.map(v => ({ id: v.id, title: v.title, price: v.price }));
      syncCache.set(cacheKey, mapping, 3600000);
      logSync(source, sourceId, 'repair', 'success', { shopifyId: mapping.shopifyProductId });
    } catch (repairErr) {
      logger.error('sync', 'Product repair failed, recreating', { error: repairErr.message });
      mapping = await createShopifyProduct(productData, pricingResult);
      upsertMapping({
        source, sourceId,
        shopifyProductId: mapping.shopifyProductId,
        shopifyVariantId: mapping.shopifyVariantId,
        handle: mapping.handle,
        price: pricingResult.price,
        originalPrice: productData.originalPrice
      });
      logSync(source, sourceId, 'recreate', 'success', { shopifyId: mapping.shopifyProductId });
    }
  }

  // Determine which variant to use — FIX v1.1: Flexible variant matching
  let variantId = mapping.shopifyVariantId;
  if (selectedVariantId && mapping.variants?.length > 1) {
    const normalizedInput = String(selectedVariantId).trim().toLowerCase();
    const match = mapping.variants.find(v => {
      const vTitle = (v.title || '').trim().toLowerCase();
      // Exact match
      if (vTitle === normalizedInput) return true;
      // "Option: Black" matches "Black"
      if (vTitle === 'option: ' + normalizedInput) return true;
      // "Black" matches "Option: Black"
      if ('option: ' + vTitle === normalizedInput) return true;
      // Partial contains
      if (vTitle.includes(normalizedInput) || normalizedInput.includes(vTitle)) return true;
      // Strip "Option: " prefix from both and compare
      const stripPrefix = s => s.replace(/^option:\s*/i, '');
      if (stripPrefix(vTitle) === stripPrefix(normalizedInput)) return true;
      return false;
    });
    if (match) {
      variantId = match.id;
      logger.info('sync', `Variant matched: "${selectedVariantId}" → variant ${match.id} ("${match.title}")`);
    } else {
      logger.warn('sync', `No variant match for "${selectedVariantId}" among: ${mapping.variants.map(v => v.title).join(', ')}`);
    }
  }

  _timing.total = Date.now() - _startTime;
  logger.info('sync', `prepareCart completed in ${_timing.total}ms`, { source, sourceId, timing: _timing, isNew: !!mapping.isNewlyCreated });

  return {
    success: true,
    shopifyProductId: mapping.shopifyProductId,
    shopifyVariantId: variantId,
    handle: mapping.handle,
    quantity,
    availability: true,
    isNewlyCreated: !!mapping.isNewlyCreated,
    priceSnapshot: {
      price: pricingResult.price,
      compareAt: pricingResult.compareAt,
      currency: 'USD'
    },
    shippingSummary: {
      note: productData.shippingData?.note || 'Standard shipping',
      deliveryLabel: productData.deliveryEstimate?.label || null
    },
    checkoutUrl: `https://${CUSTOM_DOMAIN()}/cart/${variantId}:${quantity}`,
    cartAddPayload: {
      id: variantId,
      quantity,
      properties: {
        _source_store: source,
        _source_id: String(sourceId),
        _sync_version: Date.now().toString(),
        _landed_cost_band: String(pricingResult.landedCost)
      }
    },
    _internal: {
      landedCost: pricingResult.landedCost,
      margin: pricingResult.margin,
      marginPct: pricingResult.marginPct,
      source,
      sourceId
    }
  };

  } finally {
    // Always release concurrency lock, even on errors
    releaseLock(lockKey);
  }
}

// ---- FORMAT DESCRIPTION ----
function formatDescription(description, bullets) {
  let html = '';
  if (description) {
    html += `<div class="product-description">${description.replace(/\n/g, '<br>')}</div>`;
  }
  if (bullets && bullets.length > 0) {
    html += '<ul class="product-features">';
    bullets.forEach(b => { html += `<li>${b}</li>`; });
    html += '</ul>';
  }
  return html || '<p>Premium quality product from StyleHub Miami.</p>';
}

module.exports = { prepareCart, createShopifyProduct, findExistingProduct, shopifyAPI };
