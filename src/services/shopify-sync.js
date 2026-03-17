// ============================================================
// StyleHub — Shopify Sync Service (On-Demand Product Creation)
// =============================================================
// Creates/updates products in Shopify ONLY when user wants to buy
// Handles: deduplication, inventory, variants, metafields
// FIX v1.1: Added storefront propagation wait after new product creation

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

// ---- WAIT FOR STOREFRONT PROPAGATION (NEW — fixes 422 race condition) ----
async function waitForStorefrontPropagation(handle, variantId, maxWaitMs = 10000) {
  const startTime = Date.now();
  const interval = 1500;
  let attempts = 0;

  while (Date.now() - startTime < maxWaitMs) {
    attempts++;
    try {
      const resp = await fetch(`https://${CUSTOM_DOMAIN()}/products/${handle}.json`, {
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(5000)
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
      // keep trying — storefront may not be ready yet
      logger.debug('sync', `Propagation check attempt ${attempts} failed: ${e.message}`);
    }
    await sleep(interval);
  }

  // Final fallback: even if storefront check fails, add a minimum safety delay
  logger.warn('sync', `Storefront propagation not confirmed after ${maxWaitMs}ms (${attempts} attempts) — proceeding with safety delay`, { handle, variantId });
  await sleep(3000);
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
        logger.warn('sync', 'DB mapping points to archived/deleted product', { source, sourceId, shopifyId: dbMapping.shopify_product,
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

  const payload = {
    product: {
      title,
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

  // Force-verify inventory settings on each variant after creation
  for (const v of product.variants) {
    try {
      await shopifyAPI(`/variants/${v.id}.json`, 'PUT', {
        variant: { id: v.id, inventory_policy: 'continue', inventory_management: null }
      });
      await setInventoryAvailable(v.inventory_item_id, 999);
    } catch (invErr) {
      logger.warn('sync', `Post-create inventory fix for variant ${v.id} failed`, { error: invErr.message });
    }
  }

  logger.info('sync', 'Product created with forced untracked inventory (dropship model)', {
    productId: product.id,
    variantCount: product.variants.length
  });

  // ============================================================
  // FIX v1.1: Wait for storefront propagation before returning
  // This prevents the 422 race condition where cart/add.js
  // is called before Shopify's storefront knows about the variant
  // ============================================================
  const propagated = await waitForStorefrontPropagation(
    product.handle,
    product.variants[0].id,
    10000 // max 10 seconds
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
  if (!SHOPIFY_TOKEN() || !SHOPIFY_DOMAIN()) {
    throw new Error('Shopify not configured');
  }

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

  if (!mapping) {
    // Create new product — includes propagation wait (FIX v1.1)
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

  return {
    success: true,
    shopifyProductId: mapping.shopifyProductId,
    shopifyVariantId: variantId,
    handle: mapping.handle,
    quantity,
    availability: true,
    isNewlyCreated: !!mapping.isNewlyCreated, // FIX v1.1: signal to frontend
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
