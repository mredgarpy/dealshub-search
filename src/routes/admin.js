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

const autodsSync = require('../services/autods-sync');
const autods = require('../services/autods');

/**
 * GET /admin/autods/stats
 * Get AutoDS sync stats (pending, uploaded, linked counts)
 */
router.get('/autods/stats', (req, res) => {
  try {
    const syncStats = autodsSync.getSyncStats();
    const autodsStats = autods.getAutodsStats();
    res.json({
      success: true,
      sync: syncStats,
      autods: autodsStats,
    });
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
    const products = autodsSync.getPendingForAutoDS(limit);
    res.json({
      success: true,
      count: products.length,
      products,
    });
  } catch (e) {
    logger.error('admin', 'GET /autods/pending failed', { error: e.message });
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * GET /admin/autods/csv
 * Download a ready-to-upload CSV for AutoDS Untracked Products
 * Query: ?limit=100&download=true
 */
router.get('/autods/csv', (req, res) => {
  try {
    const limit = parseInt(req.query.limit || '100', 10);
    const download = req.query.download === 'true';

    const result = autodsSync.generateDownloadableCSV(limit);

    if (result.count === 0) {
      return res.json({
        success: true,
        count: 0,
        message: 'No pending products to export',
      });
    }

    if (download) {
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
      return res.send(result.csv);
    }

    res.json({
      success: true,
      count: result.count,
      filename: result.filename,
      skipped: result.skipped,
      productIds: result.productIds,
      instructions: result.instructions,
      csvPreview: result.csv.split('\n').slice(0, 6).join('\n'),
    });
  } catch (e) {
    logger.error('admin', 'GET /autods/csv failed', { error: e.message });
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * POST /admin/autods/sync
 * Trigger manual AutoDS sync (generate CSV + Puppeteer upload)
 */
router.post('/autods/sync', async (req, res) => {
  try {
    logger.info('admin', 'Manual AutoDS sync triggered');
    const result = await autodsSync.runAutodsSync();
    res.json({
      success: result.status === 'success',
      result,
    });
  } catch (e) {
    logger.error('admin', 'POST /autods/sync failed', { error: e.message });
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * POST /admin/autods/mark-uploaded
 * Mark specific products as CSV uploaded (for manual CSV upload flow)
 * Body: { productIds: [1, 2, 3] }
 */
router.post('/autods/mark-uploaded', (req, res) => {
  try {
    const { productIds } = req.body;
    if (!Array.isArray(productIds) || productIds.length === 0) {
      return res.status(400).json({ success: false, error: 'productIds array required' });
    }

    const count = autodsSync.markProductsAsUploaded(productIds);
    res.json({
      success: true,
      markedCount: count,
      requestedCount: productIds.length,
    });
  } catch (e) {
    logger.error('admin', 'POST /autods/mark-uploaded failed', { error: e.message });
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

    const result = autodsSync.markProductAsLinked(shopifyProductId);
    res.json({ success: result });
  } catch (e) {
    logger.error('admin', 'POST /autods/mark-linked failed', { error: e.message });
    res.status(500).json({ success: false, error: e.message });
  }
});

module.exports = router;
