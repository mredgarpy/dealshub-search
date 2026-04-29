// ============================================================
// DealsHub — Admin Operations Router
// Pricing, Shipping, Orders, Sync Management, Logs
// ============================================================

const express = require('express');
const router = express.Router();
const logger = require('../utils/logger');
const {
  getPricingRules,
  getPricingRuleById,
  upsertPricingRule,
  deletePricingRule,
  getMarkupTiers,
  getMarkupTiersGrouped,
  bulkUpsertMarkupTiers,
  getTierMultiplier,
  getShippingRules,
  getShippingRuleById,
  upsertShippingRule,
  deleteShippingRule,
  getOrderRouting,
  getOrderRoutingById,
  createOrderRouting,
  updateOrderRouting,
  logSourceFailure,
  getSourceFailures,
  getSourceFailureById,
  resolveSourceFailure,
  deleteMapping,
  upsertMapping,
  getAllMappings,
  getMappingCount,
  getRecentSyncLogs,
  getAdvancedStats,
  findMapping
} = require('../utils/db');
const { getAdapter } = require('../adapters');
const { prepareCart } = require('../services/shopify-sync');
const { invalidatePricingCache } = require('../utils/pricing');
const { invalidateShippingCache } = require('../services/shipping');

// ============================================================
// PRICING RULES
// ============================================================

/**
 * GET /admin/pricing-rules
 * List all pricing rules with optional filtering
 */
router.get('/pricing-rules', (req, res) => {
  try {
    const rules = getPricingRules();
    res.json({
      success: true,
      data: rules,
      count: rules.length
    });
  } catch (e) {
    logger.error('admin', 'GET /pricing-rules failed', { error: e.message });
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve pricing rules'
    });
  }
});

/**
 * POST /admin/pricing-rules
 * Create or update a pricing rule
 */
router.post('/pricing-rules', (req, res) => {
  try {
    const { id, source_store, category, brand, markup_pct, min_margin_pct, round_to, price_floor, is_active } = req.body;

    if (!source_store || markup_pct === undefined || min_margin_pct === undefined) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: source_store, markup_pct, min_margin_pct'
      });
    }

    const result = upsertPricingRule({
      id,
      source_store,
      category,
      brand,
      markup_pct,
      min_margin_pct,
      round_to: round_to || 0.99,
      price_floor,
      is_active
    });

    if (!result) {
      return res.status(500).json({
        success: false,
        error: 'Failed to save pricing rule'
      });
    }

    logger.info('admin', id ? 'Updated pricing rule' : 'Created pricing rule', { source_store });
    invalidatePricingCache();

    res.json({
      success: true,
      message: id ? 'Pricing rule updated' : 'Pricing rule created',
      id: id || result.lastInsertRowid
    });
  } catch (e) {
    logger.error('admin', 'POST /pricing-rules failed', { error: e.message });
    res.status(500).json({
      success: false,
      error: 'Failed to save pricing rule'
    });
  }
});

/**
 * DELETE /admin/pricing-rules/:id
 * Delete a pricing rule
 */
router.delete('/pricing-rules/:id', (req, res) => {
  try {
    const { id } = req.params;
    const rule = getPricingRuleById(id);

    if (!rule) {
      return res.status(404).json({
        success: false,
        error: 'Pricing rule not found'
      });
    }

    const deleted = deletePricingRule(id);

    if (!deleted) {
      return res.status(500).json({
        success: false,
        error: 'Failed to delete pricing rule'
      });
    }

    logger.info('admin', 'Deleted pricing rule', { id });
    invalidatePricingCache();

    res.json({
      success: true,
      message: 'Pricing rule deleted'
    });
  } catch (e) {
    logger.error('admin', 'DELETE /pricing-rules/:id failed', { error: e.message });
    res.status(500).json({
      success: false,
      error: 'Failed to delete pricing rule'
    });
  }
});

// ============================================================
// MARKUP TIERS (Multiplier by Source & Price Range)
// ============================================================

/**
 * GET /admin/markup-tiers
 * Get all markup tiers grouped for the admin UI table
 */
router.get('/markup-tiers', (req, res) => {
  try {
    const grouped = getMarkupTiersGrouped();
    res.json({
      success: true,
      data: grouped
    });
  } catch (e) {
    logger.error('admin', 'GET /markup-tiers failed', { error: e.message });
    res.status(500).json({ success: false, error: 'Failed to retrieve markup tiers' });
  }
});

/**
 * POST /admin/markup-tiers
 * Bulk update all markup tiers from admin UI
 * Body: { tiers: [{max, amazon, aliexpress, sephora, macys, shein, default}, ...] }
 */
router.post('/markup-tiers', (req, res) => {
  try {
    const { tiers } = req.body;
    if (!tiers || !Array.isArray(tiers) || tiers.length === 0) {
      return res.status(400).json({ success: false, error: 'tiers array required' });
    }

    const result = bulkUpsertMarkupTiers(tiers);
    if (!result) {
      return res.status(500).json({ success: false, error: 'Failed to save markup tiers' });
    }

    // Invalidate pricing cache so changes take effect immediately
    invalidatePricingCache();

    logger.info('admin', 'Updated markup tiers', { tierCount: tiers.length });
    res.json({ success: true, message: 'Markup tiers updated successfully' });
  } catch (e) {
    logger.error('admin', 'POST /markup-tiers failed', { error: e.message });
    res.status(500).json({ success: false, error: 'Failed to save markup tiers' });
  }
});

/**
 * GET /admin/markup-tiers/preview
 * Preview pricing with current tiers for sample products
 */
router.get('/markup-tiers/preview', (req, res) => {
  try {
    const { calculateFinalPrice } = require('../utils/pricing');
    const samples = [
      { name: 'iPhone Case', source: 'aliexpress', cost: 2.20 },
      { name: 'Leggings', source: 'shein', cost: 5.50 },
      { name: 'CeraVe Moisturizer', source: 'amazon', cost: 12.99 },
      { name: 'Lipstick', source: 'sephora', cost: 22 },
      { name: 'AirPods Pro', source: 'amazon', cost: 109 },
      { name: 'Dyson Vacuum', source: 'amazon', cost: 450 }
    ];
    const previews = samples.map(s => {
      const result = calculateFinalPrice(s.cost, s.source, { sourceCost: s.cost });
      return { ...s, finalPrice: result.price, margin: result.margin, marginPct: result.marginPct, multiplier: result.multiplier };
    });
    res.json({ success: true, data: previews });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ============================================================
// SHIPPING RULES
// ============================================================

/**
 * GET /admin/shipping-rules
 * List all shipping rules
 */
router.get('/shipping-rules', (req, res) => {
  try {
    const rules = getShippingRules();
    res.json({
      success: true,
      data: rules,
      count: rules.length
    });
  } catch (e) {
    logger.error('admin', 'GET /shipping-rules failed', { error: e.message });
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve shipping rules'
    });
  }
});

/**
 * POST /admin/shipping-rules
 * Create or update a shipping rule
 */
router.post('/shipping-rules', (req, res) => {
  try {
    const { id, source_store, region, method, cost, min_days, max_days, label, is_active } = req.body;

    if (!source_store || cost === undefined || min_days === undefined || max_days === undefined) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: source_store, cost, min_days, max_days'
      });
    }

    const result = upsertShippingRule({
      id,
      source_store,
      region: region || 'domestic',
      method: method || 'standard',
      cost,
      min_days,
      max_days,
      label,
      is_active
    });

    if (!result) {
      return res.status(500).json({
        success: false,
        error: 'Failed to save shipping rule'
      });
    }

    logger.info('admin', id ? 'Updated shipping rule' : 'Created shipping rule', { source_store });
    invalidateShippingCache();

    res.json({
      success: true,
      message: id ? 'Shipping rule updated' : 'Shipping rule created',
      id: id || result.lastInsertRowid
    });
  } catch (e) {
    logger.error('admin', 'POST /shipping-rules failed', { error: e.message });
    res.status(500).json({
      success: false,
      error: 'Failed to save shipping rule'
    });
  }
});

/**
 * DELETE /admin/shipping-rules/:id
 * Delete a shipping rule
 */
router.delete('/shipping-rules/:id', (req, res) => {
  try {
    const { id } = req.params;
    const rule = getShippingRuleById(id);

    if (!rule) {
      return res.status(404).json({
        success: false,
        error: 'Shipping rule not found'
      });
    }

    const deleted = deleteShippingRule(id);

    if (!deleted) {
      return res.status(500).json({
        success: false,
        error: 'Failed to delete shipping rule'
      });
    }

    logger.info('admin', 'Deleted shipping rule', { id });
    invalidateShippingCache();

    res.json({
      success: true,
      message: 'Shipping rule deleted'
    });
  } catch (e) {
    logger.error('admin', 'DELETE /shipping-rules/:id failed', { error: e.message });
    res.status(500).json({
      success: false,
      error: 'Failed to delete shipping rule'
    });
  }
});

// ============================================================
// ORDER ROUTING
// ============================================================

/**
 * GET /admin/orders
 * List order routing entries with optional filtering
 * Query params: status, limit, page
 */
router.get('/orders', (req, res) => {
  try {
    const { status, limit = 50, page = 1 } = req.query;
    const limitNum = Math.min(parseInt(limit) || 50, 200);
    const offset = (parseInt(page) - 1) * limitNum;

    const orders = getOrderRouting(limitNum, status || null, offset);

    res.json({
      success: true,
      data: orders,
      count: orders.length,
      page: parseInt(page),
      limit: limitNum
    });
  } catch (e) {
    logger.error('admin', 'GET /orders failed', { error: e.message });
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve orders'
    });
  }
});

/**
 * POST /admin/orders
 * Create a new order routing entry
 */
router.post('/orders', (req, res) => {
  try {
    const { shopify_order_id, shopify_order_number, source_store, source_product_id, source_variant_id, status, supplier_order_id, supplier_tracking, notes } = req.body;

    if (!shopify_order_id || !source_store) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: shopify_order_id, source_store'
      });
    }

    const result = createOrderRouting({
      shopify_order_id,
      shopify_order_number,
      source_store,
      source_product_id,
      source_variant_id,
      status: status || 'pending',
      supplier_order_id,
      supplier_tracking,
      notes
    });

    if (!result) {
      return res.status(500).json({
        success: false,
        error: 'Failed to create order routing'
      });
    }

    logger.info('admin', 'Created order routing', { shopify_order_id, source_store });

    res.json({
      success: true,
      message: 'Order routing created',
      id: result.lastInsertRowid
    });
  } catch (e) {
    logger.error('admin', 'POST /orders failed', { error: e.message });
    res.status(500).json({
      success: false,
      error: 'Failed to create order routing'
    });
  }
});

/**
 * PUT /admin/orders/:id
 * Update an order routing entry
 */
router.put('/orders/:id', (req, res) => {
  try {
    const { id } = req.params;
    const { status, supplier_order_id, supplier_tracking, notes } = req.body;

    const order = getOrderRoutingById(id);
    if (!order) {
      return res.status(404).json({
        success: false,
        error: 'Order not found'
      });
    }

    const updated = updateOrderRouting(id, {
      status,
      supplier_order_id,
      supplier_tracking,
      notes
    });

    if (!updated) {
      return res.status(500).json({
        success: false,
        error: 'Failed to update order routing'
      });
    }

    logger.info('admin', 'Updated order routing', { id, status });

    res.json({
      success: true,
      message: 'Order routing updated'
    });
  } catch (e) {
    logger.error('admin', 'PUT /orders/:id failed', { error: e.message });
    res.status(500).json({
      success: false,
      error: 'Failed to update order routing'
    });
  }
});

// ============================================================
// SOURCE FAILURES
// ============================================================

/**
 * GET /admin/failures
 * List source failures with optional filtering
 * Query params: resolved, limit, page
 */
router.get('/failures', (req, res) => {
  try {
    const { resolved = false, limit = 50, page = 1 } = req.query;
    const limitNum = Math.min(parseInt(limit) || 50, 200);
    const offset = (parseInt(page) - 1) * limitNum;
    const resolvedBool = resolved === 'true';

    const failures = getSourceFailures(limitNum, resolvedBool, offset);

    res.json({
      success: true,
      data: failures,
      count: failures.length,
      resolved: resolvedBool,
      page: parseInt(page),
      limit: limitNum
    });
  } catch (e) {
    logger.error('admin', 'GET /failures failed', { error: e.message });
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve failures'
    });
  }
});

/**
 * POST /admin/failures/:id/resolve
 * Mark a failure as resolved
 */
router.post('/failures/:id/resolve', (req, res) => {
  try {
    const { id } = req.params;
    const failure = getSourceFailureById(id);

    if (!failure) {
      return res.status(404).json({
        success: false,
        error: 'Failure not found'
      });
    }

    const resolved = resolveSourceFailure(id);

    if (!resolved) {
      return res.status(500).json({
        success: false,
        error: 'Failed to resolve failure'
      });
    }

    logger.info('admin', 'Resolved source failure', { id, source: failure.source_store });

    res.json({
      success: true,
      message: 'Failure marked as resolved'
    });
  } catch (e) {
    logger.error('admin', 'POST /failures/:id/resolve failed', { error: e.message });
    res.status(500).json({
      success: false,
      error: 'Failed to resolve failure'
    });
  }
});

// ============================================================
// SYNC MANAGEMENT
// ============================================================

/**
 * POST /admin/sync/resync/:source/:sourceId
 * Manually trigger a resync of a product from source
 */
router.post('/sync/resync/:source/:sourceId', async (req, res) => {
  try {
    const { source, sourceId } = req.params;

    // Find existing mapping
    const mapping = findMapping(source, sourceId);

    // Get adapter for source
    const adapter = getAdapter(source);
    if (!adapter) {
      return res.status(400).json({
        success: false,
        error: `Invalid source: ${source}`
      });
    }

    try {
      // Fetch fresh product data
      const productData = await adapter.getProduct(sourceId);

      if (!productData) {
        return res.status(404).json({
          success: false,
          error: 'Product not found in source'
        });
      }

      // Prepare for cart (this will create/update Shopify product and variant)
      const prepared = await prepareCart({
        source,
        sourceId: sourceId,
        quantity: 1
      });

      if (!prepared || !prepared.shopifyVariantId) {
        return res.status(500).json({
          success: false,
          error: 'Failed to sync product to Shopify'
        });
      }

      logger.info('admin', 'Resynced product', { source, sourceId, shopifyVariantId: prepared.shopifyVariantId });

      res.json({
        success: true,
        message: 'Product resynced successfully',
        shopifyProductId: prepared.shopifyProductId,
        shopifyVariantId: prepared.shopifyVariantId,
        handle: prepared.handle
      });
    } catch (adapterError) {
      logger.error('admin', 'Adapter error during resync', { source, sourceId, error: adapterError.message });
      logSourceFailure(source, `/product/${sourceId}`, 'RESYNC_FAILED', adapterError.message);

      res.status(500).json({
        success: false,
        error: `Failed to fetch from source: ${adapterError.message}`
      });
    }
  } catch (e) {
    logger.error('admin', 'POST /sync/resync/:source/:sourceId failed', { error: e.message });
    res.status(500).json({
      success: false,
      error: 'Failed to resync product'
    });
  }
});

/**
 * DELETE /admin/mappings/:id
 * Delete a product mapping
 */
router.delete('/mappings/:id', (req, res) => {
  try {
    const { id } = req.params;
    const mapping = getAllMappings(1, 0).find(m => m.id == id);

    if (!mapping) {
      return res.status(404).json({
        success: false,
        error: 'Mapping not found'
      });
    }

    const deleted = deleteMapping(id);

    if (!deleted) {
      return res.status(500).json({
        success: false,
        error: 'Failed to delete mapping'
      });
    }

    logger.info('admin', 'Deleted product mapping', { id, source: mapping.source_store });

    res.json({
      success: true,
      message: 'Mapping deleted'
    });
  } catch (e) {
    logger.error('admin', 'DELETE /mappings/:id failed', { error: e.message });
    res.status(500).json({
      success: false,
      error: 'Failed to delete mapping'
    });
  }
});

// ============================================================
// DASHBOARD / STATS
// ============================================================

/**
 * GET /admin/dashboard
 * Comprehensive statistics for the admin dashboard
 */
router.get('/dashboard', (req, res) => {
  try {
    const stats = getAdvancedStats();

    res.json({
      success: true,
      data: stats
    });
  } catch (e) {
    logger.error('admin', 'GET /dashboard failed', { error: e.message });
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve dashboard stats'
    });
  }
});

/**
 * GET /admin/logs
 * Recent sync logs
 * Query params: limit
 */
router.get('/logs', (req, res) => {
  try {
    const { limit = 100 } = req.query;
    const limitNum = Math.min(parseInt(limit) || 100, 500);

    const logs = getRecentSyncLogs(limitNum);

    res.json({
      success: true,
      data: logs,
      count: logs.length
    });
  } catch (e) {
    logger.error('admin', 'GET /logs failed', { error: e.message });
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve logs'
    });
  }
});

/**
 * GET /admin/mappings
 * List product mappings with pagination
 * Query params: limit, page
 */
router.get('/mappings', (req, res) => {
  try {
    const { limit = 50, page = 1 } = req.query;
    const limitNum = Math.min(parseInt(limit) || 50, 200);
    const offset = (parseInt(page) - 1) * limitNum;

    const mappings = getAllMappings(limitNum, offset);
    const totalCount = getMappingCount();

    res.json({
      success: true,
      data: mappings,
      count: mappings.length,
      total: totalCount,
      page: parseInt(page),
      limit: limitNum
    });
  } catch (e) {
    logger.error('admin', 'GET /mappings failed', { error: e.message });
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve mappings'
    });
  }
});

// ============================================================
// AUTODS SYNC MANAGEMENT
// ============================================================

const autods = require('../services/autods');

/**
 * GET /admin/autods/stats
 * Get AutoDS sync stats (pending, uploaded, linked counts)
 */
router.get('/autods/stats', (req, res) => {
  try {
    const stats = autods.getAutodsStats();
    res.json({ success: true, ...stats });
  } catch (e) {
    logger.error('admin', 'GET /autods/stats failed', { error: e.message });
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * GET /admin/autods/pending
 * Get pending products not yet synced to AutoDS
 */
router.get('/autods/pending', (req, res) => {
  try {
    const limit = parseInt(req.query.limit || '100', 10);
    const products = autods.getPendingProducts(limit);
    res.json({ success: true, count: products.length, products });
  } catch (e) {
    logger.error('admin', 'GET /autods/pending failed', { error: e.message });
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * GET /admin/autods/csv
 * Download a ready-to-upload CSV for AutoDS bulk import
 * Query: ?source=amazon|aliexpress&download=true
 */
router.get('/autods/csv', (req, res) => {
  try {
    const source = req.query.source || null;
    const download = req.query.download === 'true';

    const result = autods.generateAutodsCSV(source ? { source } : {});

    if (!result || result.count === 0) {
      return res.json({ success: true, count: 0, message: 'No pending products to export' });
    }

    if (download) {
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="autods-import-${Date.now()}.csv"`);
      return res.send(result.csv);
    }

    res.json({
      success: true,
      count: result.count,
      csvPreview: result.csv.split('\n').slice(0, 6).join('\n'),
    });
  } catch (e) {
    logger.error('admin', 'GET /autods/csv failed', { error: e.message });
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * POST /admin/autods/mark-linked
 * Mark a product as successfully linked in AutoDS
 * Body: { shopifyProductId: 1234567890 }
 */
router.post('/autods/mark-linked', (req, res) => {
  try {
    const { shopifyProductId } = req.body;
    if (!shopifyProductId) {
      return res.status(400).json({ success: false, error: 'shopifyProductId required' });
    }
    const result = autods.markProductLinked(shopifyProductId);
    res.json({ success: !!result });
  } catch (e) {
    logger.error('admin', 'POST /autods/mark-linked failed', { error: e.message });
    res.status(500).json({ success: false, error: e.message });
  }
});

// ---- THEME ASSET SYNC ----
// Push local JS assets to Shopify theme (for keeping storefront code in sync)
router.post('/theme-sync', async (req, res) => {
  try {
    const { shopifyAdmin } = require('../shopify-admin');
    const fs = require('fs');
    const path = require('path');

    // Get active theme ID
    const themes = await shopifyAdmin('GET', '/themes.json');
    const mainTheme = (themes.themes || []).find(t => t.role === 'main');
    if (!mainTheme) return res.status(500).json({ error: 'No main theme found' });

    const themeId = mainTheme.id;

    // Files to sync from public/ to Shopify theme assets/
    const filesToSync = req.body.files || ['dealshub-product.js', 'dealshub-search.js', 'dealshub-home.js', 'dealshub-api.js', 'dealshub-header.js', 'dealshub-cart.js'];
    const results = [];

    for (const filename of filesToSync) {
      const localPath = path.join(__dirname, '../../public', filename);
      if (!fs.existsSync(localPath)) {
        results.push({ file: filename, status: 'skipped', reason: 'file not found locally' });
        continue;
      }

      const content = fs.readFileSync(localPath, 'utf8');
      const assetKey = `assets/${filename}`;

      try {
        await shopifyAdmin('PUT', `/themes/${themeId}/assets.json`, {
          asset: { key: assetKey, value: content }
        });
        results.push({ file: filename, status: 'synced', themeId, assetKey });
        logger.info('admin', 'Theme asset synced', { filename, themeId });
      } catch (e) {
        results.push({ file: filename, status: 'error', error: e.message });
        logger.error('admin', 'Theme asset sync failed', { filename, error: e.message });
      }
    }

    res.json({ success: true, theme: mainTheme.name, themeId, results });
  } catch (e) {
    logger.error('admin', 'Theme sync failed', { error: e.message });
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
// SHIPPING BUFFERS (per-source absorbed shipping cost for pricing)
// ============================================================

router.get('/shipping-buffers', (req, res) => {
  try {
    const { getShippingBuffers, DEFAULT_SHIPPING_BUFFERS } = require('../utils/db');
    res.json({
      buffers: getShippingBuffers(),
      defaults: DEFAULT_SHIPPING_BUFFERS,
      explanation: {
        amazon_prime: 'Buffer applied when product.isFBA === true (usually $0 at continental US)',
        amazon_marketplace: 'Buffer applied for Amazon non-Prime / marketplace sellers',
        aliexpress: 'Buffer for AliExpress to cover variable shipping',
        sephora: 'Buffer for Sephora',
        macys: 'Buffer for Macys',
        shein: 'Buffer for SHEIN',
        _ak_hi_pr_surcharge: 'Extra surcharge absorbed to cover AK/HI/PR destinations (not yet auto-applied — use for reference)'
      }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/shipping-buffers', (req, res) => {
  try {
    const { setShippingBuffers, getShippingBuffers } = require('../utils/db');
    const input = req.body || {};
    const clean = {};
    for (const [k, v] of Object.entries(input)) {
      const num = parseFloat(v);
      if (!Number.isNaN(num) && num >= 0 && num <= 100) clean[k] = num;
    }
    setShippingBuffers(clean);
    // Invalidate pricing cache so changes take effect immediately
    try { require('../utils/pricing').invalidatePricingCache(); } catch {}
    logger.info('admin', 'Shipping buffers updated', { buffers: clean });
    res.json({ success: true, buffers: getShippingBuffers() });
  } catch (e) {
    logger.error('admin', 'Failed to update shipping buffers', { error: e.message });
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
// SHOPIFY SHIPPING ZONES CONFIGURATION
// Programmatically creates/updates delivery profiles in Shopify
// ============================================================

router.get('/shopify/shipping-zones', async (req, res) => {
  try {
    const { shopifyAdmin } = require('../shopify-admin');
    const r = await shopifyAdmin('GET', '/shipping_zones.json');
    res.json({ zones: r.shipping_zones || [], raw: r });
  } catch (e) {
    logger.error('admin', 'shipping-zones GET failed', { error: e.message });
    res.status(500).json({ error: e.message, hint: 'Token may lack read_shipping scope' });
  }
});

// Recommended shipping zones for DealsHub (USD, Basic plan friendly)
const RECOMMENDED_ZONES = [
  {
    name: 'Continental US (48 states)',
    countries: [{ code: 'US', provinces_exclude: ['AK', 'HI'] }],
    price_based_rates: [
      { name: 'Free Shipping (orders $35+)', price: 0, min_order_subtotal: 35 },
      { name: 'Standard Shipping', price: 4.99, max_order_subtotal: 34.99 }
    ]
  },
  {
    name: 'Alaska & Hawaii',
    countries: [{ code: 'US', provinces_include: ['AK', 'HI'] }],
    price_based_rates: [
      { name: 'Extended Area Shipping', price: 14.99 }
    ]
  },
  {
    name: 'Puerto Rico & US Virgin Islands',
    countries: [{ code: 'PR' }, { code: 'VI' }],
    price_based_rates: [
      { name: 'Island Shipping', price: 19.99 }
    ]
  }
];

router.post('/shopify/setup-shipping-zones', async (req, res) => {
  try {
    const { shopifyAdmin } = require('../shopify-admin');
    const customZones = req.body?.zones;
    const zonesToCreate = Array.isArray(customZones) && customZones.length ? customZones : RECOMMENDED_ZONES;

    // NOTE: Shopify Basic does not support programmatic DeliveryProfile creation
    // via the REST shipping_zones endpoint in all regions. This endpoint attempts
    // it and returns actionable errors if it fails so the user can configure manually.
    const existing = await shopifyAdmin('GET', '/shipping_zones.json').catch(e => ({ _err: e.message }));
    const results = [];
    for (const zone of zonesToCreate) {
      try {
        const r = await shopifyAdmin('POST', '/shipping_zones.json', { shipping_zone: zone });
        results.push({ name: zone.name, status: 'created', id: r.shipping_zone?.id });
      } catch (e) {
        results.push({ name: zone.name, status: 'error', error: e.message });
      }
    }
    const anySuccess = results.some(r => r.status === 'created');
    res.json({
      success: anySuccess,
      existing,
      results,
      recommendation: RECOMMENDED_ZONES,
      manualSetupUrl: 'https://admin.shopify.com/store/YOUR-STORE/settings/shipping',
      note: anySuccess
        ? 'Zones created. Review in Shopify admin > Settings > Shipping and delivery.'
        : 'Shopify REST shipping_zones API is limited. Use the manualSetupUrl to configure zones manually using the recommendation values.'
    });
  } catch (e) {
    logger.error('admin', 'setup-shipping-zones failed', { error: e.message });
    res.status(500).json({
      error: e.message,
      recommendation: RECOMMENDED_ZONES,
      hint: 'Configure zones manually at Shopify admin > Settings > Shipping and delivery using the recommendation values'
    });
  }
});

router.get('/shopify/recommended-zones', (req, res) => {
  res.json({ zones: RECOMMENDED_ZONES });
});

// ============================================================
// THEME ASSET — Generic upload/read/patch for Shopify theme files
// ============================================================
// GET  /shopify/theme-asset?key=assets/foo.css  -> read current value
// PUT  /shopify/theme-asset                     -> body: { key, value }  upload content
// POST /shopify/theme-asset/patch               -> body: { key, find, replace, insertBefore, content }
//      patches an existing asset by string replacement or insertion
// ============================================================

async function _getActiveThemeId() {
  const { shopifyAdmin } = require('../shopify-admin');
  const themes = await shopifyAdmin('GET', '/themes.json');
  const mainTheme = (themes.themes || []).find(t => t.role === 'main');
  if (!mainTheme) throw new Error('No main theme found');
  return mainTheme.id;
}

router.get('/shopify/theme-asset', async (req, res) => {
  try {
    const key = req.query.key;
    if (!key) return res.status(400).json({ error: 'Missing key query param (e.g. key=assets/foo.css)' });
    const { shopifyAdmin } = require('../shopify-admin');
    const themeId = await _getActiveThemeId();
    const r = await shopifyAdmin('GET', `/themes/${themeId}/assets.json?asset[key]=${encodeURIComponent(key)}&theme_id=${themeId}`);
    res.json({ success: true, themeId, asset: r.asset });
  } catch (e) {
    logger.error('admin', 'theme-asset GET failed', { error: e.message });
    res.status(500).json({ error: e.message });
  }
});

router.put('/shopify/theme-asset', async (req, res) => {
  try {
    const { key, value, src } = req.body || {};
    if (!key) return res.status(400).json({ error: 'Missing "key" in body (e.g. "assets/foo.css" or "layout/theme.liquid")' });
    if (value == null && !src) return res.status(400).json({ error: 'Provide "value" (string content) or "src" (remote URL)' });

    const { shopifyAdmin } = require('../shopify-admin');
    const themeId = await _getActiveThemeId();

    const asset = src ? { key, src } : { key, value: String(value) };
    const r = await shopifyAdmin('PUT', `/themes/${themeId}/assets.json`, { asset });
    logger.info('admin', 'Theme asset uploaded', { key, themeId, size: value ? String(value).length : 0 });
    res.json({ success: true, themeId, asset: r.asset });
  } catch (e) {
    logger.error('admin', 'theme-asset PUT failed', { error: e.message });
    res.status(500).json({ error: e.message });
  }
});

router.post('/shopify/theme-asset/patch', async (req, res) => {
  try {
    const { key, find, replace, insertBefore, content } = req.body || {};
    if (!key) return res.status(400).json({ error: 'Missing "key" (e.g. "layout/theme.liquid")' });
    if (!content && find == null && !insertBefore) return res.status(400).json({ error: 'Provide "content" for raw overwrite, or "find"+"replace", or "insertBefore"+"content" for insertion' });

    const { shopifyAdmin } = require('../shopify-admin');
    const themeId = await _getActiveThemeId();

    // 1) Fetch current value
    const current = await shopifyAdmin('GET', `/themes/${themeId}/assets.json?asset[key]=${encodeURIComponent(key)}&theme_id=${themeId}`);
    let value = current.asset?.value || '';
    if (!value) return res.status(404).json({ error: `Asset ${key} not found or empty` });

    let changed = false;
    let info = {};

    if (find != null && replace != null) {
      if (value.indexOf(find) === -1) {
        return res.status(409).json({ error: `"find" string not found in asset`, key, findPreview: String(find).slice(0, 100) });
      }
      value = value.split(find).join(replace);
      changed = true;
      info.op = 'replace';
    } else if (insertBefore != null && content != null) {
      const idx = value.indexOf(insertBefore);
      if (idx === -1) return res.status(409).json({ error: `"insertBefore" string not found`, key });
      if (value.indexOf(content) !== -1) {
        return res.json({ success: true, themeId, key, skipped: true, reason: 'Content already present, no changes made' });
      }
      value = value.slice(0, idx) + content + value.slice(idx);
      changed = true;
      info.op = 'insertBefore';
    } else if (content != null) {
      value = content;
      changed = true;
      info.op = 'overwrite';
    }

    if (!changed) return res.json({ success: true, themeId, key, skipped: true });

    const r = await shopifyAdmin('PUT', `/themes/${themeId}/assets.json`, { asset: { key, value } });
    logger.info('admin', 'Theme asset patched', { key, themeId, op: info.op });
    res.json({ success: true, themeId, key, op: info.op, newSize: value.length, asset: r.asset });
  } catch (e) {
    logger.error('admin', 'theme-asset patch failed', { error: e.message });
    res.status(500).json({ error: e.message });
  }
});


// ============================================================
// CRON RESYNC — Daily background job to refresh prices/stock/variants
// ============================================================
const cronResync = require('../services/cron-resync');

/**
 * POST /admin/cron/run
 * Trigger a manual resync of all (or filtered) mappings.
 * Body: { source?: 'amazon'|'aliexpress'|..., limit?: number }
 */
router.post('/cron/run', async (req, res) => {
  try {
    const { source, limit } = req.body || {};
    const result = await cronResync.resyncAll({ source, limit });
    if (result.error === 'already_running') {
      return res.status(409).json({ success: false, error: 'A resync job is already running', progress: result.progress });
    }
    res.json({ success: true, ...result });
  } catch (e) {
    logger.error('admin', 'POST /cron/run failed', { error: e.message });
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * GET /admin/cron/status
 * Returns last run status + current job progress (if running).
 */
router.get('/cron/status', (req, res) => {
  try {
    const status = cronResync.loadStatus();
    const progress = cronResync.getProgress();
    res.json({ success: true, isRunning: cronResync.isRunning(), progress, status });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * POST /admin/cron/stop
 * Politely request the running job to halt after current item.
 */
router.post('/cron/stop', (req, res) => {
  try {
    cronResync.requestStop();
    res.json({ success: true, message: 'Stop requested — will halt after current item' });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});


/**
 * POST /admin/mappings/bulk-import
 * Bulk insert/update mappings — used to recover from DB wipe
 * Body: { mappings: [{source, sourceId, sourceVariantId?, shopifyProductId, shopifyVariantId, handle, price, originalPrice}] }
 */
router.post('/mappings/bulk-import', (req, res) => {
  try {
    const { mappings } = req.body;
    if (!Array.isArray(mappings)) {
      return res.status(400).json({ success: false, error: 'mappings must be array' });
    }
    let ok = 0, err = 0;
    for (const m of mappings) {
      if (!m || !m.source || !m.sourceId || !m.shopifyProductId || !m.shopifyVariantId) { err++; continue; }
      const r = upsertMapping({
        source: m.source,
        sourceId: m.sourceId,
        sourceVariantId: m.sourceVariantId || null,
        shopifyProductId: m.shopifyProductId,
        shopifyVariantId: m.shopifyVariantId,
        handle: m.handle || '',
        price: m.price || null,
        originalPrice: m.originalPrice || null,
        syncHash: m.syncHash || null
      });
      if (r) ok++; else err++;
    }
    logger.info('admin', `Bulk mapping import: ok=${ok} err=${err} total=${mappings.length}`);
    res.json({ success: true, ok, err, total: mappings.length });
  } catch (e) {
    logger.error('admin', 'bulk-import failed', { error: e.message });
    res.status(500).json({ success: false, error: e.message });
  }
});

module.exports = router;
// ============================================================
// DealsHub — Admin Operations Router
// Pricing, Shipping, Orders, Sync Management, Logs
// ============================================================

const express = require('express');
const router = express.Router();
const logger = require('../utils/logger');
const {
  getPricingRules,
  getPricingRuleById,
  upsertPricingRule,
  deletePricingRule,
  getMarkupTiers,
  getMarkupTiersGrouped,
  bulkUpsertMarkupTiers,
  getTierMultiplier,
  getShippingRules,
  getShippingRuleById,
  upsertShippingRule,
  deleteShippingRule,
  getOrderRouting,
  getOrderRoutingById,
  createOrderRouting,
  updateOrderRouting,
  logSourceFailure,
  getSourceFailures,
  getSourceFailureById,
  resolveSourceFailure,
  deleteMapping,
  getAllMappings,
  getMappingCount,
  getRecentSyncLogs,
  getAdvancedStats,
  findMapping
} = require('../utils/db');
const { getAdapter } = require('../adapters');
const { prepareCart } = require('../services/shopify-sync');
const { invalidatePricingCache } = require('../utils/pricing');
const { invalidateShippingCache } = require('../services/shipping');

// ============================================================
// PRICING RULES
// ============================================================

/**
 * GET /admin/pricing-rules
 * List all pricing rules with optional filtering
 */
router.get('/pricing-rules', (req, res) => {
  try {
    const rules = getPricingRules();
    res.json({
      success: true,
      data: rules,
      count: rules.length
    });
  } catch (e) {
    logger.error('admin', 'GET /pricing-rules failed', { error: e.message });
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve pricing rules'
    });
  }
});

/**
 * POST /admin/pricing-rules
 * Create or update a pricing rule
 */
router.post('/pricing-rules', (req, res) => {
  try {
    const { id, source_store, category, brand, markup_pct, min_margin_pct, round_to, price_floor, is_active } = req.body;

    if (!source_store || markup_pct === undefined || min_margin_pct === undefined) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: source_store, markup_pct, min_margin_pct'
      });
    }

    const result = upsertPricingRule({
      id,
      source_store,
      category,
      brand,
      markup_pct,
      min_margin_pct,
      round_to: round_to || 0.99,
      price_floor,
      is_active
    });

    if (!result) {
      return res.status(500).json({
        success: false,
        error: 'Failed to save pricing rule'
      });
    }

    logger.info('admin', id ? 'Updated pricing rule' : 'Created pricing rule', { source_store });
    invalidatePricingCache();

    res.json({
      success: true,
      message: id ? 'Pricing rule updated' : 'Pricing rule created',
      id: id || result.lastInsertRowid
    });
  } catch (e) {
    logger.error('admin', 'POST /pricing-rules failed', { error: e.message });
    res.status(500).json({
      success: false,
      error: 'Failed to save pricing rule'
    });
  }
});

/**
 * DELETE /admin/pricing-rules/:id
 * Delete a pricing rule
 */
router.delete('/pricing-rules/:id', (req, res) => {
  try {
    const { id } = req.params;
    const rule = getPricingRuleById(id);

    if (!rule) {
      return res.status(404).json({
        success: false,
        error: 'Pricing rule not found'
      });
    }

    const deleted = deletePricingRule(id);

    if (!deleted) {
      return res.status(500).json({
        success: false,
        error: 'Failed to delete pricing rule'
      });
    }

    logger.info('admin', 'Deleted pricing rule', { id });
    invalidatePricingCache();

    res.json({
      success: true,
      message: 'Pricing rule deleted'
    });
  } catch (e) {
    logger.error('admin', 'DELETE /pricing-rules/:id failed', { error: e.message });
    res.status(500).json({
      success: false,
      error: 'Failed to delete pricing rule'
    });
  }
});

// ============================================================
// MARKUP TIERS (Multiplier by Source & Price Range)
// ============================================================

/**
 * GET /admin/markup-tiers
 * Get all markup tiers grouped for the admin UI table
 */
router.get('/markup-tiers', (req, res) => {
  try {
    const grouped = getMarkupTiersGrouped();
    res.json({
      success: true,
      data: grouped
    });
  } catch (e) {
    logger.error('admin', 'GET /markup-tiers failed', { error: e.message });
    res.status(500).json({ success: false, error: 'Failed to retrieve markup tiers' });
  }
});

/**
 * POST /admin/markup-tiers
 * Bulk update all markup tiers from admin UI
 * Body: { tiers: [{max, amazon, aliexpress, sephora, macys, shein, default}, ...] }
 */
router.post('/markup-tiers', (req, res) => {
  try {
    const { tiers } = req.body;
    if (!tiers || !Array.isArray(tiers) || tiers.length === 0) {
      return res.status(400).json({ success: false, error: 'tiers array required' });
    }

    const result = bulkUpsertMarkupTiers(tiers);
    if (!result) {
      return res.status(500).json({ success: false, error: 'Failed to save markup tiers' });
    }

    // Invalidate pricing cache so changes take effect immediately
    invalidatePricingCache();

    logger.info('admin', 'Updated markup tiers', { tierCount: tiers.length });
    res.json({ success: true, message: 'Markup tiers updated successfully' });
  } catch (e) {
    logger.error('admin', 'POST /markup-tiers failed', { error: e.message });
    res.status(500).json({ success: false, error: 'Failed to save markup tiers' });
  }
});

/**
 * GET /admin/markup-tiers/preview
 * Preview pricing with current tiers for sample products
 */
router.get('/markup-tiers/preview', (req, res) => {
  try {
    const { calculateFinalPrice } = require('../utils/pricing');
    const samples = [
      { name: 'iPhone Case', source: 'aliexpress', cost: 2.20 },
      { name: 'Leggings', source: 'shein', cost: 5.50 },
      { name: 'CeraVe Moisturizer', source: 'amazon', cost: 12.99 },
      { name: 'Lipstick', source: 'sephora', cost: 22 },
      { name: 'AirPods Pro', source: 'amazon', cost: 109 },
      { name: 'Dyson Vacuum', source: 'amazon', cost: 450 }
    ];
    const previews = samples.map(s => {
      const result = calculateFinalPrice(s.cost, s.source, { sourceCost: s.cost });
      return { ...s, finalPrice: result.price, margin: result.margin, marginPct: result.marginPct, multiplier: result.multiplier };
    });
    res.json({ success: true, data: previews });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ============================================================
// SHIPPING RULES
// ============================================================

/**
 * GET /admin/shipping-rules
 * List all shipping rules
 */
router.get('/shipping-rules', (req, res) => {
  try {
    const rules = getShippingRules();
    res.json({
      success: true,
      data: rules,
      count: rules.length
    });
  } catch (e) {
    logger.error('admin', 'GET /shipping-rules failed', { error: e.message });
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve shipping rules'
    });
  }
});

/**
 * POST /admin/shipping-rules
 * Create or update a shipping rule
 */
router.post('/shipping-rules', (req, res) => {
  try {
    const { id, source_store, region, method, cost, min_days, max_days, label, is_active } = req.body;

    if (!source_store || cost === undefined || min_days === undefined || max_days === undefined) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: source_store, cost, min_days, max_days'
      });
    }

    const result = upsertShippingRule({
      id,
      source_store,
      region: region || 'domestic',
      method: method || 'standard',
      cost,
      min_days,
      max_days,
      label,
      is_active
    });

    if (!result) {
      return res.status(500).json({
        success: false,
        error: 'Failed to save shipping rule'
      });
    }

    logger.info('admin', id ? 'Updated shipping rule' : 'Created shipping rule', { source_store });
    invalidateShippingCache();

    res.json({
      success: true,
      message: id ? 'Shipping rule updated' : 'Shipping rule created',
      id: id || result.lastInsertRowid
    });
  } catch (e) {
    logger.error('admin', 'POST /shipping-rules failed', { error: e.message });
    res.status(500).json({
      success: false,
      error: 'Failed to save shipping rule'
    });
  }
});

/**
 * DELETE /admin/shipping-rules/:id
 * Delete a shipping rule
 */
router.delete('/shipping-rules/:id', (req, res) => {
  try {
    const { id } = req.params;
    const rule = getShippingRuleById(id);

    if (!rule) {
      return res.status(404).json({
        success: false,
        error: 'Shipping rule not found'
      });
    }

    const deleted = deleteShippingRule(id);

    if (!deleted) {
      return res.status(500).json({
        success: false,
        error: 'Failed to delete shipping rule'
      });
    }

    logger.info('admin', 'Deleted shipping rule', { id });
    invalidateShippingCache();

    res.json({
      success: true,
      message: 'Shipping rule deleted'
    });
  } catch (e) {
    logger.error('admin', 'DELETE /shipping-rules/:id failed', { error: e.message });
    res.status(500).json({
      success: false,
      error: 'Failed to delete shipping rule'
    });
  }
});

// ============================================================
// ORDER ROUTING
// ============================================================

/**
 * GET /admin/orders
 * List order routing entries with optional filtering
 * Query params: status, limit, page
 */
router.get('/orders', (req, res) => {
  try {
    const { status, limit = 50, page = 1 } = req.query;
    const limitNum = Math.min(parseInt(limit) || 50, 200);
    const offset = (parseInt(page) - 1) * limitNum;

    const orders = getOrderRouting(limitNum, status || null, offset);

    res.json({
      success: true,
      data: orders,
      count: orders.length,
      page: parseInt(page),
      limit: limitNum
    });
  } catch (e) {
    logger.error('admin', 'GET /orders failed', { error: e.message });
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve orders'
    });
  }
});

/**
 * POST /admin/orders
 * Create a new order routing entry
 */
router.post('/orders', (req, res) => {
  try {
    const { shopify_order_id, shopify_order_number, source_store, source_product_id, source_variant_id, status, supplier_order_id, supplier_tracking, notes } = req.body;

    if (!shopify_order_id || !source_store) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: shopify_order_id, source_store'
      });
    }

    const result = createOrderRouting({
      shopify_order_id,
      shopify_order_number,
      source_store,
      source_product_id,
      source_variant_id,
      status: status || 'pending',
      supplier_order_id,
      supplier_tracking,
      notes
    });

    if (!result) {
      return res.status(500).json({
        success: false,
        error: 'Failed to create order routing'
      });
    }

    logger.info('admin', 'Created order routing', { shopify_order_id, source_store });

    res.json({
      success: true,
      message: 'Order routing created',
      id: result.lastInsertRowid
    });
  } catch (e) {
    logger.error('admin', 'POST /orders failed', { error: e.message });
    res.status(500).json({
      success: false,
      error: 'Failed to create order routing'
    });
  }
});

/**
 * PUT /admin/orders/:id
 * Update an order routing entry
 */
router.put('/orders/:id', (req, res) => {
  try {
    const { id } = req.params;
    const { status, supplier_order_id, supplier_tracking, notes } = req.body;

    const order = getOrderRoutingById(id);
    if (!order) {
      return res.status(404).json({
        success: false,
        error: 'Order not found'
      });
    }

    const updated = updateOrderRouting(id, {
      status,
      supplier_order_id,
      supplier_tracking,
      notes
    });

    if (!updated) {
      return res.status(500).json({
        success: false,
        error: 'Failed to update order routing'
      });
    }

    logger.info('admin', 'Updated order routing', { id, status });

    res.json({
      success: true,
      message: 'Order routing updated'
    });
  } catch (e) {
    logger.error('admin', 'PUT /orders/:id failed', { error: e.message });
    res.status(500).json({
      success: false,
      error: 'Failed to update order routing'
    });
  }
});

// ============================================================
// SOURCE FAILURES
// ============================================================

/**
 * GET /admin/failures
 * List source failures with optional filtering
 * Query params: resolved, limit, page
 */
router.get('/failures', (req, res) => {
  try {
    const { resolved = false, limit = 50, page = 1 } = req.query;
    const limitNum = Math.min(parseInt(limit) || 50, 200);
    const offset = (parseInt(page) - 1) * limitNum;
    const resolvedBool = resolved === 'true';

    const failures = getSourceFailures(limitNum, resolvedBool, offset);

    res.json({
      success: true,
      data: failures,
      count: failures.length,
      resolved: resolvedBool,
      page: parseInt(page),
      limit: limitNum
    });
  } catch (e) {
    logger.error('admin', 'GET /failures failed', { error: e.message });
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve failures'
    });
  }
});

/**
 * POST /admin/failures/:id/resolve
 * Mark a failure as resolved
 */
router.post('/failures/:id/resolve', (req, res) => {
  try {
    const { id } = req.params;
    const failure = getSourceFailureById(id);

    if (!failure) {
      return res.status(404).json({
        success: false,
        error: 'Failure not found'
      });
    }

    const resolved = resolveSourceFailure(id);

    if (!resolved) {
      return res.status(500).json({
        success: false,
        error: 'Failed to resolve failure'
      });
    }

    logger.info('admin', 'Resolved source failure', { id, source: failure.source_store });

    res.json({
      success: true,
      message: 'Failure marked as resolved'
    });
  } catch (e) {
    logger.error('admin', 'POST /failures/:id/resolve failed', { error: e.message });
    res.status(500).json({
      success: false,
      error: 'Failed to resolve failure'
    });
  }
});

// ============================================================
// SYNC MANAGEMENT
// ============================================================

/**
 * POST /admin/sync/resync/:source/:sourceId
 * Manually trigger a resync of a product from source
 */
router.post('/sync/resync/:source/:sourceId', async (req, res) => {
  try {
    const { source, sourceId } = req.params;

    // Find existing mapping
    const mapping = findMapping(source, sourceId);

    // Get adapter for source
    const adapter = getAdapter(source);
    if (!adapter) {
      return res.status(400).json({
        success: false,
        error: `Invalid source: ${source}`
      });
    }

    try {
      // Fetch fresh product data
      const productData = await adapter.getProduct(sourceId);

      if (!productData) {
        return res.status(404).json({
          success: false,
          error: 'Product not found in source'
        });
      }

      // Prepare for cart (this will create/update Shopify product and variant)
      const prepared = await prepareCart({
        source,
        sourceId: sourceId,
        quantity: 1
      });

      if (!prepared || !prepared.shopifyVariantId) {
        return res.status(500).json({
          success: false,
          error: 'Failed to sync product to Shopify'
        });
      }

      logger.info('admin', 'Resynced product', { source, sourceId, shopifyVariantId: prepared.shopifyVariantId });

      res.json({
        success: true,
        message: 'Product resynced successfully',
        shopifyProductId: prepared.shopifyProductId,
        shopifyVariantId: prepared.shopifyVariantId,
        handle: prepared.handle
      });
    } catch (adapterError) {
      logger.error('admin', 'Adapter error during resync', { source, sourceId, error: adapterError.message });
      logSourceFailure(source, `/product/${sourceId}`, 'RESYNC_FAILED', adapterError.message);

      res.status(500).json({
        success: false,
        error: `Failed to fetch from source: ${adapterError.message}`
      });
    }
  } catch (e) {
    logger.error('admin', 'POST /sync/resync/:source/:sourceId failed', { error: e.message });
    res.status(500).json({
      success: false,
      error: 'Failed to resync product'
    });
  }
});

/**
 * DELETE /admin/mappings/:id
 * Delete a product mapping
 */
router.delete('/mappings/:id', (req, res) => {
  try {
    const { id } = req.params;
    const mapping = getAllMappings(1, 0).find(m => m.id == id);

    if (!mapping) {
      return res.status(404).json({
        success: false,
        error: 'Mapping not found'
      });
    }

    const deleted = deleteMapping(id);

    if (!deleted) {
      return res.status(500).json({
        success: false,
        error: 'Failed to delete mapping'
      });
    }

    logger.info('admin', 'Deleted product mapping', { id, source: mapping.source_store });

    res.json({
      success: true,
      message: 'Mapping deleted'
    });
  } catch (e) {
    logger.error('admin', 'DELETE /mappings/:id failed', { error: e.message });
    res.status(500).json({
      success: false,
      error: 'Failed to delete mapping'
    });
  }
});

// ============================================================
// DASHBOARD / STATS
// ============================================================

/**
 * GET /admin/dashboard
 * Comprehensive statistics for the admin dashboard
 */
router.get('/dashboard', (req, res) => {
  try {
    const stats = getAdvancedStats();

    res.json({
      success: true,
      data: stats
    });
  } catch (e) {
    logger.error('admin', 'GET /dashboard failed', { error: e.message });
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve dashboard stats'
    });
  }
});

/**
 * GET /admin/logs
 * Recent sync logs
 * Query params: limit
 */
router.get('/logs', (req, res) => {
  try {
    const { limit = 100 } = req.query;
    const limitNum = Math.min(parseInt(limit) || 100, 500);

    const logs = getRecentSyncLogs(limitNum);

    res.json({
      success: true,
      data: logs,
      count: logs.length
    });
  } catch (e) {
    logger.error('admin', 'GET /logs failed', { error: e.message });
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve logs'
    });
  }
});

/**
 * GET /admin/mappings
 * List product mappings with pagination
 * Query params: limit, page
 */
router.get('/mappings', (req, res) => {
  try {
    const { limit = 50, page = 1 } = req.query;
    const limitNum = Math.min(parseInt(limit) || 50, 200);
    const offset = (parseInt(page) - 1) * limitNum;

    const mappings = getAllMappings(limitNum, offset);
    const totalCount = getMappingCount();

    res.json({
      success: true,
      data: mappings,
      count: mappings.length,
      total: totalCount,
      page: parseInt(page),
      limit: limitNum
    });
  } catch (e) {
    logger.error('admin', 'GET /mappings failed', { error: e.message });
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve mappings'
    });
  }
});

// ============================================================
// AUTODS SYNC MANAGEMENT
// ============================================================

const autods = require('../services/autods');

/**
 * GET /admin/autods/stats
 * Get AutoDS sync stats (pending, uploaded, linked counts)
 */
router.get('/autods/stats', (req, res) => {
  try {
    const stats = autods.getAutodsStats();
    res.json({ success: true, ...stats });
  } catch (e) {
    logger.error('admin', 'GET /autods/stats failed', { error: e.message });
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * GET /admin/autods/pending
 * Get pending products not yet synced to AutoDS
 */
router.get('/autods/pending', (req, res) => {
  try {
    const limit = parseInt(req.query.limit || '100', 10);
    const products = autods.getPendingProducts(limit);
    res.json({ success: true, count: products.length, products });
  } catch (e) {
    logger.error('admin', 'GET /autods/pending failed', { error: e.message });
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * GET /admin/autods/csv
 * Download a ready-to-upload CSV for AutoDS bulk import
 * Query: ?source=amazon|aliexpress&download=true
 */
router.get('/autods/csv', (req, res) => {
  try {
    const source = req.query.source || null;
    const download = req.query.download === 'true';

    const result = autods.generateAutodsCSV(source ? { source } : {});

    if (!result || result.count === 0) {
      return res.json({ success: true, count: 0, message: 'No pending products to export' });
    }

    if (download) {
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="autods-import-${Date.now()}.csv"`);
      return res.send(result.csv);
    }

    res.json({
      success: true,
      count: result.count,
      csvPreview: result.csv.split('\n').slice(0, 6).join('\n'),
    });
  } catch (e) {
    logger.error('admin', 'GET /autods/csv failed', { error: e.message });
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * POST /admin/autods/mark-linked
 * Mark a product as successfully linked in AutoDS
 * Body: { shopifyProductId: 1234567890 }
 */
router.post('/autods/mark-linked', (req, res) => {
  try {
    const { shopifyProductId } = req.body;
    if (!shopifyProductId) {
      return res.status(400).json({ success: false, error: 'shopifyProductId required' });
    }
    const result = autods.markProductLinked(shopifyProductId);
    res.json({ success: !!result });
  } catch (e) {
    logger.error('admin', 'POST /autods/mark-linked failed', { error: e.message });
    res.status(500).json({ success: false, error: e.message });
  }
});

// ---- THEME ASSET SYNC ----
// Push local JS assets to Shopify theme (for keeping storefront code in sync)
router.post('/theme-sync', async (req, res) => {
  try {
    const { shopifyAdmin } = require('../shopify-admin');
    const fs = require('fs');
    const path = require('path');

    // Get active theme ID
    const themes = await shopifyAdmin('GET', '/themes.json');
    const mainTheme = (themes.themes || []).find(t => t.role === 'main');
    if (!mainTheme) return res.status(500).json({ error: 'No main theme found' });

    const themeId = mainTheme.id;

    // Files to sync from public/ to Shopify theme assets/
    const filesToSync = req.body.files || ['dealshub-product.js', 'dealshub-search.js', 'dealshub-home.js', 'dealshub-api.js', 'dealshub-header.js', 'dealshub-cart.js'];
    const results = [];

    for (const filename of filesToSync) {
      const localPath = path.join(__dirname, '../../public', filename);
      if (!fs.existsSync(localPath)) {
        results.push({ file: filename, status: 'skipped', reason: 'file not found locally' });
        continue;
      }

      const content = fs.readFileSync(localPath, 'utf8');
      const assetKey = `assets/${filename}`;

      try {
        await shopifyAdmin('PUT', `/themes/${themeId}/assets.json`, {
          asset: { key: assetKey, value: content }
        });
        results.push({ file: filename, status: 'synced', themeId, assetKey });
        logger.info('admin', 'Theme asset synced', { filename, themeId });
      } catch (e) {
        results.push({ file: filename, status: 'error', error: e.message });
        logger.error('admin', 'Theme asset sync failed', { filename, error: e.message });
      }
    }

    res.json({ success: true, theme: mainTheme.name, themeId, results });
  } catch (e) {
    logger.error('admin', 'Theme sync failed', { error: e.message });
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
// SHIPPING BUFFERS (per-source absorbed shipping cost for pricing)
// ============================================================

router.get('/shipping-buffers', (req, res) => {
  try {
    const { getShippingBuffers, DEFAULT_SHIPPING_BUFFERS } = require('../utils/db');
    res.json({
      buffers: getShippingBuffers(),
      defaults: DEFAULT_SHIPPING_BUFFERS,
      explanation: {
        amazon_prime: 'Buffer applied when product.isFBA === true (usually $0 at continental US)',
        amazon_marketplace: 'Buffer applied for Amazon non-Prime / marketplace sellers',
        aliexpress: 'Buffer for AliExpress to cover variable shipping',
        sephora: 'Buffer for Sephora',
        macys: 'Buffer for Macys',
        shein: 'Buffer for SHEIN',
        _ak_hi_pr_surcharge: 'Extra surcharge absorbed to cover AK/HI/PR destinations (not yet auto-applied — use for reference)'
      }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/shipping-buffers', (req, res) => {
  try {
    const { setShippingBuffers, getShippingBuffers } = require('../utils/db');
    const input = req.body || {};
    const clean = {};
    for (const [k, v] of Object.entries(input)) {
      const num = parseFloat(v);
      if (!Number.isNaN(num) && num >= 0 && num <= 100) clean[k] = num;
    }
    setShippingBuffers(clean);
    // Invalidate pricing cache so changes take effect immediately
    try { require('../utils/pricing').invalidatePricingCache(); } catch {}
    logger.info('admin', 'Shipping buffers updated', { buffers: clean });
    res.json({ success: true, buffers: getShippingBuffers() });
  } catch (e) {
    logger.error('admin', 'Failed to update shipping buffers', { error: e.message });
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
// SHOPIFY SHIPPING ZONES CONFIGURATION
// Programmatically creates/updates delivery profiles in Shopify
// ============================================================

router.get('/shopify/shipping-zones', async (req, res) => {
  try {
    const { shopifyAdmin } = require('../shopify-admin');
    const r = await shopifyAdmin('GET', '/shipping_zones.json');
    res.json({ zones: r.shipping_zones || [], raw: r });
  } catch (e) {
    logger.error('admin', 'shipping-zones GET failed', { error: e.message });
    res.status(500).json({ error: e.message, hint: 'Token may lack read_shipping scope' });
  }
});

// Recommended shipping zones for DealsHub (USD, Basic plan friendly)
const RECOMMENDED_ZONES = [
  {
    name: 'Continental US (48 states)',
    countries: [{ code: 'US', provinces_exclude: ['AK', 'HI'] }],
    price_based_rates: [
      { name: 'Free Shipping (orders $35+)', price: 0, min_order_subtotal: 35 },
      { name: 'Standard Shipping', price: 4.99, max_order_subtotal: 34.99 }
    ]
  },
  {
    name: 'Alaska & Hawaii',
    countries: [{ code: 'US', provinces_include: ['AK', 'HI'] }],
    price_based_rates: [
      { name: 'Extended Area Shipping', price: 14.99 }
    ]
  },
  {
    name: 'Puerto Rico & US Virgin Islands',
    countries: [{ code: 'PR' }, { code: 'VI' }],
    price_based_rates: [
      { name: 'Island Shipping', price: 19.99 }
    ]
  }
];

router.post('/shopify/setup-shipping-zones', async (req, res) => {
  try {
    const { shopifyAdmin } = require('../shopify-admin');
    const customZones = req.body?.zones;
    const zonesToCreate = Array.isArray(customZones) && customZones.length ? customZones : RECOMMENDED_ZONES;

    // NOTE: Shopify Basic does not support programmatic DeliveryProfile creation
    // via the REST shipping_zones endpoint in all regions. This endpoint attempts
    // it and returns actionable errors if it fails so the user can configure manually.
    const existing = await shopifyAdmin('GET', '/shipping_zones.json').catch(e => ({ _err: e.message }));
    const results = [];
    for (const zone of zonesToCreate) {
      try {
        const r = await shopifyAdmin('POST', '/shipping_zones.json', { shipping_zone: zone });
        results.push({ name: zone.name, status: 'created', id: r.shipping_zone?.id });
      } catch (e) {
        results.push({ name: zone.name, status: 'error', error: e.message });
      }
    }
    const anySuccess = results.some(r => r.status === 'created');
    res.json({
      success: anySuccess,
      existing,
      results,
      recommendation: RECOMMENDED_ZONES,
      manualSetupUrl: 'https://admin.shopify.com/store/YOUR-STORE/settings/shipping',
      note: anySuccess
        ? 'Zones created. Review in Shopify admin > Settings > Shipping and delivery.'
        : 'Shopify REST shipping_zones API is limited. Use the manualSetupUrl to configure zones manually using the recommendation values.'
    });
  } catch (e) {
    logger.error('admin', 'setup-shipping-zones failed', { error: e.message });
    res.status(500).json({
      error: e.message,
      recommendation: RECOMMENDED_ZONES,
      hint: 'Configure zones manually at Shopify admin > Settings > Shipping and delivery using the recommendation values'
    });
  }
});

router.get('/shopify/recommended-zones', (req, res) => {
  res.json({ zones: RECOMMENDED_ZONES });
});

// ============================================================
// THEME ASSET — Generic upload/read/patch for Shopify theme files
// ============================================================
// GET  /shopify/theme-asset?key=assets/foo.css  -> read current value
// PUT  /shopify/theme-asset                     -> body: { key, value }  upload content
// POST /shopify/theme-asset/patch               -> body: { key, find, replace, insertBefore, content }
//      patches an existing asset by string replacement or insertion
// ============================================================

async function _getActiveThemeId() {
  const { shopifyAdmin } = require('../shopify-admin');
  const themes = await shopifyAdmin('GET', '/themes.json');
  const mainTheme = (themes.themes || []).find(t => t.role === 'main');
  if (!mainTheme) throw new Error('No main theme found');
  return mainTheme.id;
}

router.get('/shopify/theme-asset', async (req, res) => {
  try {
    const key = req.query.key;
    if (!key) return res.status(400).json({ error: 'Missing key query param (e.g. key=assets/foo.css)' });
    const { shopifyAdmin } = require('../shopify-admin');
    const themeId = await _getActiveThemeId();
    const r = await shopifyAdmin('GET', `/themes/${themeId}/assets.json?asset[key]=${encodeURIComponent(key)}&theme_id=${themeId}`);
    res.json({ success: true, themeId, asset: r.asset });
  } catch (e) {
    logger.error('admin', 'theme-asset GET failed', { error: e.message });
    res.status(500).json({ error: e.message });
  }
});

router.put('/shopify/theme-asset', async (req, res) => {
  try {
    const { key, value, src } = req.body || {};
    if (!key) return res.status(400).json({ error: 'Missing "key" in body (e.g. "assets/foo.css" or "layout/theme.liquid")' });
    if (value == null && !src) return res.status(400).json({ error: 'Provide "value" (string content) or "src" (remote URL)' });

    const { shopifyAdmin } = require('../shopify-admin');
    const themeId = await _getActiveThemeId();

    const asset = src ? { key, src } : { key, value: String(value) };
    const r = await shopifyAdmin('PUT', `/themes/${themeId}/assets.json`, { asset });
    logger.info('admin', 'Theme asset uploaded', { key, themeId, size: value ? String(value).length : 0 });
    res.json({ success: true, themeId, asset: r.asset });
  } catch (e) {
    logger.error('admin', 'theme-asset PUT failed', { error: e.message });
    res.status(500).json({ error: e.message });
  }
});

router.post('/shopify/theme-asset/patch', async (req, res) => {
  try {
    const { key, find, replace, insertBefore, content } = req.body || {};
    if (!key) return res.status(400).json({ error: 'Missing "key" (e.g. "layout/theme.liquid")' });
    if (!content && find == null && !insertBefore) return res.status(400).json({ error: 'Provide "content" for raw overwrite, or "find"+"replace", or "insertBefore"+"content" for insertion' });

    const { shopifyAdmin } = require('../shopify-admin');
    const themeId = await _getActiveThemeId();

    // 1) Fetch current value
    const current = await shopifyAdmin('GET', `/themes/${themeId}/assets.json?asset[key]=${encodeURIComponent(key)}&theme_id=${themeId}`);
    let value = current.asset?.value || '';
    if (!value) return res.status(404).json({ error: `Asset ${key} not found or empty` });

    let changed = false;
    let info = {};

    if (find != null && replace != null) {
      if (value.indexOf(find) === -1) {
        return res.status(409).json({ error: `"find" string not found in asset`, key, findPreview: String(find).slice(0, 100) });
      }
      value = value.split(find).join(replace);
      changed = true;
      info.op = 'replace';
    } else if (insertBefore != null && content != null) {
      const idx = value.indexOf(insertBefore);
      if (idx === -1) return res.status(409).json({ error: `"insertBefore" string not found`, key });
      if (value.indexOf(content) !== -1) {
        return res.json({ success: true, themeId, key, skipped: true, reason: 'Content already present, no changes made' });
      }
      value = value.slice(0, idx) + content + value.slice(idx);
      changed = true;
      info.op = 'insertBefore';
    } else if (content != null) {
      value = content;
      changed = true;
      info.op = 'overwrite';
    }

    if (!changed) return res.json({ success: true, themeId, key, skipped: true });

    const r = await shopifyAdmin('PUT', `/themes/${themeId}/assets.json`, { asset: { key, value } });
    logger.info('admin', 'Theme asset patched', { key, themeId, op: info.op });
    res.json({ success: true, themeId, key, op: info.op, newSize: value.length, asset: r.asset });
  } catch (e) {
    logger.error('admin', 'theme-asset patch failed', { error: e.message });
    res.status(500).json({ error: e.message });
  }
});


// ============================================================
// CRON RESYNC — Daily background job to refresh prices/stock/variants
// ============================================================
const cronResync = require('../services/cron-resync');

/**
 * POST /admin/cron/run
 * Trigger a manual resync of all (or filtered) mappings.
 * Body: { source?: 'amazon'|'aliexpress'|..., limit?: number }
 */
router.post('/cron/run', async (req, res) => {
  try {
    const { source, limit } = req.body || {};
    const result = await cronResync.resyncAll({ source, limit });
    if (result.error === 'already_running') {
      return res.status(409).json({ success: false, error: 'A resync job is already running', progress: result.progress });
    }
    res.json({ success: true, ...result });
  } catch (e) {
    logger.error('admin', 'POST /cron/run failed', { error: e.message });
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * GET /admin/cron/status
 * Returns last run status + current job progress (if running).
 */
router.get('/cron/status', (req, res) => {
  try {
    const status = cronResync.loadStatus();
    const progress = cronResync.getProgress();
    res.json({ success: true, isRunning: cronResync.isRunning(), progress, status });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * POST /admin/cron/stop
 * Politely request the running job to halt after current item.
 */
router.post('/cron/stop', (req, res) => {
  try {
    cronResync.requestStop();
    res.json({ success: true, message: 'Stop requested — will halt after current item' });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

module.exports = router;
