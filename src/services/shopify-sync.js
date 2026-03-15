// ============================================================
// StyleHub — Shopify Sync Service v2.0 (FASE 4)
// ============================================================
// Creates/updates products in Shopify ONLY when user wants to buy
// Handles: deduplication, inventory, variants, metafields
// NEW: Auto-fix old products, price update on re-sync, shipping data
// ============================================================

const fetch = require('node-fetch');
const logger = require('../utils/logger');
const { calculateFinalPrice, parsePrice } = require('../utils/pricing');
const { syncCache } = require('../utils/cache');
const { findMapping, upsertMapping, logSync } = require('../utils/db');
const { calculateDeliveryEstimate, getReturnPolicy, getSupplierShippingCost } = require('./shipping');

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

// ---- AUTO-FIX: Repair old products with bad inventory_policy ----
async function autoFixProduct(product) {
  let needsFix = false;
  const fixes = [];

  for (const variant of product.variants) {
    // Fix 1: inventory_policy should be 'continue' for dropshipping
    if (variant.inventory_policy === 'deny') {
      needsFix = true;
      fixes.push(`variant ${variant.id}: policy deny->continue`);
      try {
        await shopifyAPI(`/variants/${variant.id}.json`, 'PUT', {
          variant: {
            id: variant.id,
            inventory_policy: 'continue'
          }
        });
        logger.info('sync', `Auto-fixed variant ${variant.id} inventory_policy to continue`);
      } catch (e) {
        logger.warn('sync', `Auto-fix variant ${variant.id} failed`, { error: e.message });
      }
    }

    // Fix 2: Set inventory to 9999 if it's 0 or negative
    if (variant.inventory_quantity !== undefined && variant.inventory_quantity <= 0) {
      try {
        await shopifyAPI('/inventory_levels/set.json', 'POST', {
          location_id: LOCATION_ID(),
          inventory_item_id: variant.inventory_item_id,
          available: 9999
        });
        fixes.push(`variant ${variant.id}: inventory 0->9999`);
        logger.info('sync', `Auto-fixed variant ${variant.id} inventory to 9999`);
      } catch (e) {
        // Non-critical — inventory_policy: continue means cart still works
        logger.debug('sync', `Inventory fix non-critical for variant ${variant.id}`);
      }
    }
  }

  if (needsFix) {
    logSync(product.tags?.match(/source:(\w+)/)?.[1] || 'unknown',
            product.tags?.match(/source-id:([^\s,]+)/)?.[1] || product.id,
            'auto-fix', 'success', { fixes });
  }

  return needsFix;
}

// ---- CHECK IF PRODUCT ALREADY SYNCED ----
async function findExistingProduct(source, sourceId) {
  const cacheKey = `mapping:${source}:${sourceId}`;
  const cached = syncCache.get(cacheKey);
  if (cached) return cached;

  // Try tag-based search in Shopify
  try {
    const tag = `source-id:${sourceId}`;
    const data = await shopifyAPI(`/products.json?limit=5&status=any&tag=${encodeURIComponent(tag)}`);
    if (data.products && data.products.length > 0) {
      // Find the exact match (tag search is fuzzy, might return similar IDs)
      const exactMatch = data.products.find(p => {
        const tags = (p.tags || '').split(',').map(t => t.trim());
        return tags.includes(`source-id:${sourceId}`) && tags.includes(`source:${source}`);
      }) || data.products[0];

      const p = exactMatch;

      // Auto-fix old products with bad inventory_policy
      const wasFixed = await autoFixProduct(p);
      if (wasFixed) {
        logger.info('sync', `Auto-fixed existing product ${p.id} for ${source}:${sourceId}`);
      }

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

// ---- UPDATE EXISTING PRODUCT PRICE ----
async function updateProductPrice(mapping, pricingResult, productData) {
  try {
    const variant = mapping.variants[0];
    if (!variant) return;

    const currentPrice = parseFloat(variant.price);
    const newPrice = pricingResult.price;

    // Only update if price changed by more than 1%
    if (Math.abs(currentPrice - newPrice) / currentPrice > 0.01) {
      await shopifyAPI(`/variants/${variant.id}.json`, 'PUT', {
        variant: {
          id: variant.id,
          price: newPrice.toFixed(2),
          compare_at_price: pricingResult.compareAt ? pricingResult.compareAt.toFixed(2) : null
        }
      });
      logger.info('sync', `Price updated for variant ${variant.id}: ${currentPrice} -> ${newPrice}`);
      logSync(productData.source || 'unknown', productData.sourceId || '', 'price-update', 'success', {
        oldPrice: currentPrice, newPrice, variantId: variant.id
      });
    }
  } catch (e) {
    logger.warn('sync', 'Price update failed (non-blocking)', { error: e.message });
  }
}

// ---- CREATE PRODUCT IN SHOPIFY ----
async function createShopifyProduct(productData, pricingResult) {
  const {
    source, sourceId, title, images, primaryImage, brand,
    description, bullets, options,
    variants: sourceVariants
  } = productData;

  // Get shipping data for metafields
  const deliveryEstimate = calculateDeliveryEstimate(source, productData);
  const returnPolicy = getReturnPolicy(source);

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
        inventory_management: 'shopify',
        inventory_policy: 'continue',
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
        { namespace: 'dealshub', key: 'margin_pct', value: String(pricingResult.marginPct || 0), type: 'single_line_text_field' },
        { namespace: 'dealshub', key: 'sync_status', value: 'synced', type: 'single_line_text_field' },
        { namespace: 'dealshub', key: 'delivery_min_days', value: String(deliveryEstimate.minDays || ''), type: 'single_line_text_field' },
        { namespace: 'dealshub', key: 'delivery_max_days', value: String(deliveryEstimate.maxDays || ''), type: 'single_line_text_field' },
        { namespace: 'dealshub', key: 'delivery_label', value: deliveryEstimate.label || '', type: 'single_line_text_field' },
        { namespace: 'dealshub', key: 'shipping_note', value: deliveryEstimate.note || '', type: 'single_line_text_field' },
        { namespace: 'dealshub', key: 'return_window', value: String(returnPolicy.window || ''), type: 'single_line_text_field' },
        { namespace: 'dealshub', key: 'return_summary', value: returnPolicy.summary || '', type: 'single_line_text_field' }
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

  // ===== Parse the price safely =====
  const sourcePrice = safeParsePrice(productData.price);
  if (!sourcePrice || sourcePrice <= 0) {
    throw new Error('Invalid product price: ' + JSON.stringify(productData.price));
  }

  // ===== Get supplier shipping cost for landed cost calc =====
  const apiShippingCost = safeParsePrice(productData.shippingData?.cost);
  const supplierShipping = getSupplierShippingCost(source, sourcePrice, apiShippingCost > 0 ? apiShippingCost : null);

  const pricingResult = calculateFinalPrice(sourcePrice, source, {
    originalPrice: safeParsePrice(productData.originalPrice),
    shippingCost: supplierShipping,
    sourceId: sourceId
  });

  if (!pricingResult || !pricingResult.price || pricingResult.price <= 0) {
    throw new Error('Pricing calculation failed for source price: ' + sourcePrice);
  }

  // Check for existing synced product — DB first, then cache, then Shopify search
  const cacheKey = `mapping:${source}:${sourceId}`;
  let mapping = syncCache.get(cacheKey);

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
  }

  if (mapping) {
    // Update price if changed
    await updateProductPrice(mapping, pricingResult, { source, sourceId });
  }

  if (!mapping) {
    // Create new product in Shopify
    mapping = await createShopifyProduct(productData, pricingResult);

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

  // ===== Determine which variant to use =====
  let variantId = mapping.shopifyVariantId;
  if (selectedVariantId && mapping.variants?.length > 1) {
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

  // ===== Build delivery estimate =====
  const deliveryEstimate = calculateDeliveryEstimate(source, productData);
  const returnPolicy = getReturnPolicy(source);

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
      note: deliveryEstimate.note,
      deliveryLabel: deliveryEstimate.label,
      minDays: deliveryEstimate.minDays,
      maxDays: deliveryEstimate.maxDays,
      freeShipping: deliveryEstimate.freeShipping,
      returnPolicy: returnPolicy.label
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
      totalSourceCost: pricingResult.totalSourceCost,
      margin: pricingResult.margin,
      marginPct: pricingResult.marginPct,
      effectiveShipping: pricingResult.effectiveShipping,
      absorbedShipping: pricingResult.absorbedShipping,
      markupApplied: pricingResult.markupApplied,
      source,
      sourceId
    }
  };
}

// ---- ADMIN: Fix all old products ----
async function fixAllOldProducts() {
  const results = { fixed: 0, errors: 0, checked: 0 };
  let page = null;
  let hasMore = true;

  while (hasMore) {
    try {
      const endpoint = page
        ? `/products.json?limit=50&tag=dealshub-synced&page_info=${page}`
        : '/products.json?limit=50&tag=dealshub-synced';
      const data = await shopifyAPI(endpoint);

      if (!data.products || data.products.length === 0) break;

      for (const product of data.products) {
        results.checked++;
        try {
          const wasFixed = await autoFixProduct(product);
          if (wasFixed) results.fixed++;
        } catch (e) {
          results.errors++;
        }
      }

      hasMore = data.products.length === 50;
      // Simple pagination — Shopify cursor pagination would be better but this works for now
      if (hasMore && data.products.length > 0) {
        page = null; // Break to avoid infinite loop on non-cursor pagination
        hasMore = false;
      }
    } catch (e) {
      logger.error('sync', 'fixAllOldProducts failed', { error: e.message });
      results.errors++;
      break;
    }
  }

  return results;
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

module.exports = { prepareCart, createShopifyProduct, findExistingProduct, shopifyAPI, fixAllOldProducts, autoFixProduct };