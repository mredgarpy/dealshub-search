// ============================================================
// DealsHub ÃÂ¢ÃÂÃÂ Shopify Sync Service (On-Demand Product Creation)
// ============================================================
// Creates/updates products in Shopify ONLY when user wants to buy
// Handles: deduplication, inventory, variants, metafields

const fetch = require('node-fetch');
const logger = require('../utils/logger');
const { calculateFinalPrice, parsePrice } = require('../utils/pricing');
const { syncCache } = require('../utils/cache');

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

  try {
    // Strategy 1: Search by title/tag using Shopify's product search
    // The most reliable way is to search all products with our tag and match by source-id tag
    const skuPrefix = `DH-${source.toUpperCase()}-${sourceId}`;
    
    // Use Shopify Admin API product listing with collection_id or search
    // First try: search products that have our source-id tag
    const searchData = await shopifyAPI(`/products.json?limit=10&status=any&fields=id,handle,variants,tags`);
    
    if (searchData && searchData.products) {
      for (const product of searchData.products) {
        // Check tags for source-id match
        const tags = (product.tags || '').split(',').map(t => t.trim());
        if (tags.includes(`source-id:${sourceId}`)) {
          logger.info('sync', `Found existing product by tag: ${product.id} (source-id:${sourceId})`);
          const result = {
            id: product.id,
            handle: product.handle,
            variantId: product.variants && product.variants[0] ? product.variants[0].id : null
          };
          syncCache.set(cacheKey, result);
          return result;
        }
        
        // Also check variant SKUs for our prefix
        if (product.variants) {
          for (const v of product.variants) {
            if (v.sku && v.sku.startsWith(skuPrefix)) {
              logger.info('sync', `Found existing product by SKU: ${product.id} (sku:${v.sku})`);
              const result = {
                id: product.id,
                handle: product.handle,
                variantId: v.id
              };
              syncCache.set(cacheKey, result);
              return result;
            }
          }
        }
      }
    }
    
    // Strategy 2: If not found in first 10, do a broader search with pagination
    // Check up to 250 products (the store won't have many since we create on-demand)
    const allData = await shopifyAPI(`/products.json?limit=250&status=any&fields=id,handle,variants,tags`);
    if (allData && allData.products) {
      for (const product of allData.products) {
        const tags = (product.tags || '').split(',').map(t => t.trim());
        if (tags.includes(`source-id:${sourceId}`)) {
          logger.info('sync', `Found existing product in full scan: ${product.id}`);
          const result = {
            id: product.id,
            handle: product.handle,
            variantId: product.variants && product.variants[0] ? product.variants[0].id : null
          };
          syncCache.set(cacheKey, result);
          return result;
        }
      }
    }
    
    logger.debug('sync', `No existing product found for ${source}:${sourceId}`);
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
        sku: `DH-${source.toUpperCase()}-${sourceId}-${v.id || i}`,
        inventory_management: null, // FIX: null = no tracking, avoids write_inventory scope
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
      inventory_management: null, // FIX: null = no tracking
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
    shopifyOptions.push({ name: (options?.[0]?.name) || 'Option', values: sourceVariants.map(v => v.title) });
  }

  const payload = {
    product: {
      title,
      body_html: formatDescription(description, bullets),
      vendor: brand || 'DealsHub',
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

  // ---- VERIFY PRODUCT AVAILABILITY ----
    // Poll the Shopify storefront to confirm the product is available for checkout
    // Newly created products can take 10-30s to be indexed by Shopify checkout
    const verifyUrl = `https://${CUSTOM_DOMAIN()}/products/${product.handle}.json`;
    let available = false;
    for (let attempt = 1; attempt <= 12; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 5000));
      try {
        const checkResp = await fetch(verifyUrl);
        if (checkResp.ok) {
          const checkData = await checkResp.json();
          const variant = checkData.product && checkData.product.variants && checkData.product.variants[0];
          if (variant && variant.id) {
            available = true;
            logger.info('sync', `Product available on storefront after ${attempt * 5}s (variant ${variant.id})`);
            await new Promise(resolve => setTimeout(resolve, 2000));
            break;
          }
        }
        logger.info('sync', `Availability check attempt ${attempt}/12 - not yet available`);
      } catch (e) {
        logger.info('sync', `Availability check attempt ${attempt}/12 - error: ${e.message}`);
      }
    }
    if (!available) {
      logger.warn('sync', 'Product not confirmed available after 60s, proceeding anyway');
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
async function prepareCart({ source, sourceId, productData, selectedVariantId, quantity = 1 }) {
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

  // Check for existing synced product
  const cacheKey = `mapping:${source}:${sourceId}`;
  let mapping = syncCache.get(cacheKey);

  if (!mapping) {
    // Create new product in Shopify
    mapping = await createShopifyProduct(productData, pricingResult);
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
    checkoutUrl: `https://${CUSTOM_DOMAIN()}/cart/clear?return_to=/cart/${variantId}:${quantity}`,
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
  return html || '<p>Premium quality product from DealsHub Miami.</p>';
}

module.exports = { prepareCart, createShopifyProduct, findExistingProduct, shopifyAPI };
