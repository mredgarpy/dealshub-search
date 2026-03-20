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

module.exports = router;
