// ============================================================
// StyleHub — Shopify Sync Service (On-Demand Product Creation)
// ============================================================
// Creates/updates products in Shopify ONLY when user wants to buy
// Handles: deduplication, inventory, variants, metafields

const fetch = require('node-fetch');
const logger = require('../utils/logger');
const { calculateFinalPrice, parsePrice } = require('../utils/pricing');
const { syncCache } = require('../utils/cache');
const { findMapping, upsertMapping, logSync } = require('../utils/db');

const SHOPIFY_DOMAIN = () => process.env.SHOPIFY_STORE_DOMAIN;
const SHOPIFY_TOKEN = () => process.env.SHOPIFY_ADMIN_TOKEN;
const LOCATION_ID = () => parseInt(process.env.SHOPIFY_LOCATION_ID || '84042121347');
const CUSTOM_DOMAIN = () => process.env.SHOPIFY_CUSTOM_DOMAIN || 'stylehubmiami.com';
const API_VERSION = '2024-01';

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

// ---- CHECK IF PRODUCT ALREADY SYNCED ----
async function findExistingProduct(source, sourceId) {
  const cacheKey = `mapping:${source}:${sourceId}`;
  const cached = syncCache.get(cacheKey);
  if (cached) return cached;

  // Search by metafield
  try {
    const query = encodeURIComponent(`metafield:dealshub.source_product_id:${sourceId}`);
    const data = await shopifyAPI(`/products.json?limit=1&status=any&fields=id,handle,variants,status`);
    // Metafield search via GraphQL would be better; for now use tag-based lookup
    // We'll also try handle-based lookup
  } catch (e) {
    logger.debug('sync', 'Existing product search failed', { error: e.message });
  }
  return null;
}

// ---- CREATE PRODUCT IN SHOPIFY ----
async function createShopifyProduct(productData, pricingResult) {
  const { source, sourceId, title, images, primaryImage, brand,
          description, bullets, options, variants: sourceVariants } = productData;

  // Build Shopify product payload
  const shopifyVariants = [];

  if (sourceVariants && sourceVariants.length > 0) {
    // Create variants from source data
    sourceVariants.slice(0, 100).forEach((v, i) => {
      const vPrice = v.price ? calculateFinalPrice(v.price, source) : pricingResult;
      shopifyVariants.push({
        title: v.title || `Option ${i + 1}`,
        price: vPrice.price.toFixed(2),
        compare_at_price: vPrice.compareAt ? vPrice.compareAt.toFixed(2) : null,
        sku: `DH}-${source.toUpperCase()}-${sourceId}-${v.id || i}`,
        inventory_management: 'shopify', // CRITICAL FIX: Must be 'shopify' not null
        inventory_policy: 'deny',
        requires_shipping: true,
        weight: 0.5,
        weight_unit: 'lb',
        option1: v.title || `Option ${i + 1}`
      });
    });
  } else {
    // Single variant (default)
    shopifyVariants.push({
      price: pricingResult.price.toFixed(2),
      compare_at_price: pricingResult.compareAt ? pricingResult.compareAt.toFixed(2) : null,
      sku: `DH-${source.toUpperCase()}-${sourceId}`,
      inventory_management: 'shopify',  // CRITICAL FIX
      inventory_policy: 'deny',
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
    shopifyOptions.push({ name: (options?.[0]?.name) || 'Option', values: sourceVariants.map(v => v.title) });
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
        { namespace: 'dealshub', key: 'return_window', value: String(productData.returnPolicy'?.window || '')1 type: 'single_line_text_field' }
      ]
    }
  };

  logger.info('sync', 'Creating Shopify product', { source, sourceId, title: title.substring(0, 50) });
  const result = await shopifyAPI('/products.json', 'POST', payload);
  const product = result.product;

  if (!product || !product.id) {
    throw new Error('Product creation returned no product');
  }

  // ---- SET INVENTORY FOR ALL VARIANTS ----
  IConst locationId = LOCATION_ID();
  for (const variant of product.variants) {
    try {
      await shopifyAPI('/inventory_levels/set.json', 'POST', {
        location_id: locationId,
        inventory_item_id: variant.inventory_item_id,
        available: 9999
      });
      logger.info('sync', `Inventory set for variant ${variant.id}`, { available: 9999 });
    } catch (invErr) {
      logger.error('sync', `Inventory set failed for variant ${variant.id}`, { error: invErr.message });
      // FALLBACK: Try to update inventory item to not track
      try {
        await shopifyAPI(`/cinventory_items/${variant.inventory_item_id}.json`, 'PUT', {
          inventory_item: { tracked: false }
        });
        logger.info('sync', `Fallback: Set variant ${variant.id} to untracked`);
      } catch (e2) {
        logger.error('sync', `Fallback also failed for variant ${variant.id}`, { error: e2.message });
      }
    }
  }

  // Cache the mapping
  const mapping = {
    shopifyProductId: product.id,
    shopifyVariantId: product.variants[0]?.id,
    handle: product.handle,
    variants: product.variants.map(v => ({ id: v.id, title: v.title, price: v.price }))
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
  const sourcePrice = productData.price;
  if (!sourcePrice || sourcePrice <= 0) {
    throw new Error('Invalid product price');
  }

  const pricingResult = calculateFinalPrice(sourcePrice, source, {
    originalPrice: productData.originalPrice,
    shippingCost: productData.shippingData?.cost || 0
  });

  // Check for existing synced product — DB first, then cache
  const cacheKey = `mapping:${source}:${sourceId}`;

  // If forceResync, invalidate stale mapping that may point to deleted variant
  if (forceResync) {
    syncCache.del(cacheKey);
    logger.info('sync', 'Force resync: cache cleared', { source, sourceId });
  }

  let mapping = forceResync ? null : syncCache.get(cacheKey);

  if (!mapping) {
    // Check persistent DB
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
    // Create new product in Shopify
    mapping = await createShopifyProduct(productData, pricingResult);
    // Persist to DB
    upsertMapping({
      source, sourceId,
      shopifyProductId: mapping.shopifyProductId,
      shopifyVariantId: mapping.shopifyVariantId,
      handle: mapping.handle,
      price: pricingResult.price,
      originalPrice: productData.originalPrice
    });
    logSync(source, sourceId, 'create', 'success', { shopifyId: mapping.shopifyProductId });
  }

  // Determine which variant to use
  let variantId = mapping.shopifyVariantId;
  if (selectedVariantId && mapping.variants?.length > 1) {
    const match = mapping.variants.find(v => v.title === selectedVariantId);
    if (match) variantId = match.id;
  }

  return {
    success: true,
    shopifyProductId: mapping.shopifyProductId,
    shopifyVariantId: variantId,
    handle: mapping.handle,
    quantity,
    availability: true,
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
