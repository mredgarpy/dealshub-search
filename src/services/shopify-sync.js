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
const LOCATION_ID  = () => parseInt(process.env.SHOPIFY_LOCATION_ID || '84042121347');
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

  // Try tag-based search in Shopify
  try {
    const tag = `source-id:${sourceId}`;
    const data = await shopifyAPI(`/products.json?limit=1&status=any&tag=${encodeURIComponent(tag)}`);
    if (data.products && data.products.length > 0) {
      const p = data.products[0];
      const mapping = {
        shopifyProductId: p.id,
        shopifyVariantId: p.variants[0]?.id,
        handle: p.handle,
        variants: p.variants.map(v => ({ id: v.id, title: v.title, price: v.price }))
      };
      syncCache.set(cacheKey, mapping, 3600000);
      return mapping;
    }
  } catch (e) {
    logger.debug('sync', 'Existing product search failed', { error: e.message });
  }

  return null;
}

// ---- SAFE PRICE PARSER ----
function safeParsePrice(val) {
  if (val === null || val === undefined) return 0;
  if (typeof val === 'number') return isNaN(val) ? 0 : val;
  const cleaned = String(val).replace(/[^0-9.]/g, '');
  const num = parseFloat(cleaned);
  return isNaN(num) ? 0 : num;
}

// ---- CREATE PRODUCT IN SHOPIFY ----
async function createShopifyProduct(productData, pricingResult) {
  const {
    source, sourceId, title, images, primaryImage, brand,
    description, bullets, options,
    variants: sourceVariants
  } = productData;

  // Build Shopify product payload
  const shopifyVariants = [];

  if (sourceVariants && sourceVariants.length > 0) {
    // Create variants from source data
    sourceVariants.slice(0, 100).forEach((v, i) => {
      const vPriceRaw = safeParsePrice(v.price);
      const vPrice = vPriceRaw > 0
        ? calculateFinalPrice(vPriceRaw, source)
        : pricingResult;
      shopifyVariants.push({
        title: v.title || `Option ${i + 1}`,
        price: (vPrice.price || pricingResult.price).toFixed(2),
        compare_at_price: (vPrice.compareAt || pricingResult.compareAt)
          ? (vPrice.compareAt || pricingResult.compareAt).toFixed(2) : null,
        sku: `DH-${source.toUpperCase()}-${sourceId}-${v.id || i}`,
        // ===== STOCK BUG FIX =====
        // For dropshipping: track inventory for ops visibility,
        // but ALWAYS allow adding to cart (continue selling when out of stock)
        inventory_management: 'shopify',
        inventory_policy: 'continue',  // <<< FIX: was 'deny', now 'continue'
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
      inventory_management: 'shopify',
      inventory_policy: 'continue',  // <<< FIX: was 'deny', now 'continue'
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
      values: sourceVariants.map(v => v.title || `Option`)
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
      images: shopifyImages.length > 0 ? shopifyImages : undefined,
      options: shopifyOptions.length > 0 ? shopifyOptions : undefined,
      metafields: [
        { namespace: 'dealshub', key: 'source_store', value: source, type: 'single_line_text_field' },
        { namespace: 'dealshub', key: 'source_product_id', value: String(sourceId), type: 'single_line_text_field' },
        { namespace: 'dealshub', key: 'source_url', value: productData.sourceUrl || '', type: 'single_line_text_field' },
        { namespace: 'dealshub', key: 'source_brand', value: brand || '', type: 'single_line_text_field' },
        { namespace: 'dealshub', key: 'landed_cost', value: String(pricingResult.landedCost || 0), type: 'single_line_text_field' },
        { namespace: 'dealshub', key: 'margin_rule', value: pricingResult.rule || source, type: 'single_line_text_field' },
        { namespace: 'dealshub', key: 'sync_status', value: 'synced', type: 'single_line_text_field' },
        { namespace: 'dealshub', key: 'delivery_min_days', value: String(productData.deliveryEstimate?.minDays || productData.delivery_min_days || ''), type: 'single_line_text_field' },
        { namespace: 'dealshub', key: 'delivery_max_days', value: String(productData.deliveryEstimate?.maxDays || productData.delivery_max_days || ''), type: 'single_line_text_field' },
        { namespace: 'dealshub', key: 'delivery_label', value: productData.deliveryEstimate?.label || '', type: 'single_line_text_field' },
        { namespace: 'dealshub', key: 'shipping_note', value: productData.shippingData?.note || '', type: 'single_line_text_field' },
        {
          namespace: 'dealshub',
          key: 'return_window',
          value: String(
            typeof productData.returnPolicy === 'object'
              ? (productData.returnPolicy?.window || productData.returnPolicy?.summary || '')
              : (productData.returnPolicy || productData.return_window || '')
          ),
          type: 'single_line_text_field'
        }
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
  // Even though inventory_policy is 'continue' (always allow cart add),
  // we still set a high inventory for operational tracking
  const locationId = LOCATION_ID();
  for (const variant of product.variants) {
    try {
      await shopifyAPI('/inventory_levels/set.json', 'POST', {
        location_id: locationId,
        inventory_item_id: variant.inventory_item_id,
        available: 9999
      });
      logger.info('sync', `Inventory set for variant ${variant.id}`, { available: 9999 });
    } catch (invErr) {
      logger.warn('sync', `Inventory set failed for variant ${variant.id} (non-blocking)`, { error: invErr.message });
      // NOT a critical failure since inventory_policy is 'continue'
      // Cart adds will still work even with 0 inventory
    }
  }

  // Cache the mapping
  const mapping = {
    shopifyProductId: product.id,
    shopifyVariantId: product.variants[0]?.id,
    handle: product.handle,
    variants: product.variants.map(v => ({
      id: v.id,
      title: v.title,
      price: v.price
    }))
  };
  syncCache.set(`mapping:${source}:${sourceId}`, mapping, 3600000);
  return mapping;
}

// ---- PREPARE CART (Main entry point for buy flow) ----
async function prepareCart({ source, sourceId, productData, selectedVariantId, quantity = 1 }) {
  if (!SHOPIFY_TOKEN() || !SHOPIFY_DOMAIN()) {
    throw new Error('Shopify not configured');
  }

  // ===== FIX: Parse the price safely to ensure it's a number =====
  const sourcePrice = safeParsePrice(productData.price);
  if (!sourcePrice || sourcePrice <= 0) {
    throw new Error('Invalid product price: ' + JSON.stringify(productData.price));
  }

  const pricingResult = calculateFinalPrice(sourcePrice, source, {
    originalPrice: safeParsePrice(productData.originalPrice),
    shippingCost: safeParsePrice(productData.shippingData?.cost) || 0
  });

  // ===== FIX: Handle case where pricing returns null =====
  if (!pricingResult || !pricingResult.price || pricingResult.price <= 0) {
    throw new Error('Pricing calculation failed for source price: ' + sourcePrice);
  }

  // Check for existing synced product — DB first, then cache, then Shopify search
  const cacheKey = `mapping:${source}:${sourceId}`;
  let mapping = syncCache.get(cacheKey);

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
    // Try Shopify tag search as last resort before creating
    mapping = await findExistingProduct(source, sourceId);
  }

  if (!mapping) {
    // Create new product in Shopify
    mapping = await createShopifyProduct(productData, pricingResult);

    // Persist to DB
    upsertMapping({
      source,
      sourceId,
      shopifyProductId: mapping.shopifyProductId,
      shopifyVariantId: mapping.shopifyVariantId,
      handle: mapping.handle,
      price: pricingResult.price,
      originalPrice: safeParsePrice(productData.originalPrice)
    });

    logSync(source, sourceId, 'create', 'success', { shopifyId: mapping.shopifyProductId });
  }

  // ===== FIX: Determine which variant to use (handle object or string) =====
  let variantId = mapping.shopifyVariantId;
  if (selectedVariantId && mapping.variants?.length > 1) {
    // selectedVariantId might be: string title, object {title, price, id}, or number index
    let targetTitle = null;
    if (typeof selectedVariantId === 'object' && selectedVariantId !== null) {
      targetTitle = selectedVariantId.title || selectedVariantId.name || null;
    } else if (typeof selectedVariantId === 'string') {
      targetTitle = selectedVariantId;
    }
    if (targetTitle) {
      const match = mapping.variants.find(v =>
        v.title && v.title.toLowerCase() === targetTitle.toLowerCase()
      );
      if (match) variantId = match.id;
    }
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
        _landed_cost_band: String(pricingResult.landedCost || 0)
      }
    },
    syncVersion: Date.now().toString(),
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
    bullets.forEach(b => {
      const text = typeof b === 'string' ? b : (b.text || b.value || '');
      if (text) html += `<li>${text}</li>`;
    });
    html += '</ul>';
  }
  return html || '<p>Premium quality product from StyleHub Miami.</p>';
}

module.exports = { prepareCart, createShopifyProduct, findExistingProduct, shopifyAPI };
