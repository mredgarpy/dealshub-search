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

// ============================================================
// PRICING RULES
// ============================================================

router.get('/pricing-rules', (req, res) => {
  try {
    const rules = getPricingRules();
    res.json({ success: true, data: rules, count: rules.length });
  } catch (e) {
    logger.error('admin', 'GET /pricing-rules failed', { error: e.message });
    res.status(500).json({ success: false, error: 'Failed to retrieve pricing rules' });
  }
});

router.post('/pricing-rules', (req, res) => {
  try {
    const { id, source_store, category, brand, markup_pct, min_margin_pct, round_to, price_floor, is_active } = req.body;
    if (!source_store || markup_pct === undefined || min_margin_pct === undefined) {
      return res.status(400).json({ success: false, error: 'Missing required fields' });
    }
    const result = upsertPricingRule({ id, source_store, category, brand, markup_pct, min_margin_pct, round_to: round_to || 0.99, price_floor, is_active });
    if (!result) return res.status(500).json({ success: false, error: 'Failed to save' });
    logger.info('admin', id ? 'Updated pricing rule' : 'Created pricing rule', { source_store });
    res.json({ success: true, message: id ? 'Updated' : 'Created', id: id || result.lastInsertRowid });
  } catch (e) {
    logger.error('admin', 'POST /pricing-rules failed', { error: e.message });
    res.status(500).json({ success: false, error: 'Failed to save' });
  }
});

router.delete('/pricing-rules/:id', (req, res) => {
  try {
    const { id } = req.params;
    if (!getPricingRuleById(id)) return res.status(404).json({ success: false, error: 'Not found' });
    if (!deletePricingRule(id)) return res.status(500).json({ success: false, error: 'Failed to delete' });
    logger.info('admin', 'Deleted pricing rule', { id });
    res.json({ success: true, message: 'Deleted' });
  } catch (e) {
    res.status(500).json({ success: false, error: 'Failed to delete' });
  }
});

// SHIPPING RULES
router.get('/shipping-rules', (req, res) => {
  try {
    const rules = getShippingRules();
    res.json({ success: true, data: rules, count: rules.length });
  } catch (e) {
    res.status(500).json({ success: false, error: 'Failed to retrieve shipping rules' });
  }
});

router.post('/shipping-rules', (req, res) => {
  try {
    const { id, source_store, region, method, cost, min_days, max_days, label, is_active } = req.body;
    if (!source_store || cost === undefined || min_days === undefined || max_days === undefined) {
      return res.status(400).json({ success: false, error: 'Missing required fields' });
    }
    const result = upsertShippingRule({ id, source_store, region: region || 'domestic', method: method || 'standard', cost, min_days, max_days, label, is_active });
    if (!result) return res.status(500).json({ success: false, error: 'Failed to save' });
    res.json({ success: true, message: id ? 'Updated' : 'Created', id: id || result.lastInsertRowid });
  } catch (e) {
    res.status(500).json({ success: false, error: 'Failed to save' });
  }
});

router.delete('/shipping-rules/:id', (req, res) => {
  try {
    const { id } = req.params;
    if (!getShippingRuleById(id)) return res.status(404).json({ success: false, error: 'Not found' });
    if (!deleteShippingRule(id)) return res.status(500).json({ success: false, error: 'Failed to delete' });
    res.json({ success: true, message: 'Deleted' });
  } catch (e) {
    res.status(500).json({ success: false, error: 'Failed to delete' });
  }
});

// ORDER ROUTING
router.get('/orders', (req, res) => {
  try {
    const { status, limit = 50, page = 1 } = req.query;
    const limitNum = Math.min(parseInt(limit) || 50, 200);
    const offset = (parseInt(page) - 1) * limitNum;
    const orders = getOrderRouting(limitNum, status || null, offset);
    res.json({ success: true, data: orders, count: orders.length, page: parseInt(page), limit: limitNum });
  } catch (e) {
    res.status(500).json({ success: false, error: 'Failed to retrieve orders' });
  }
});

router.post('/orders', (req, res) => {
  try {
    const { shopify_order_id, shopify_order_number, source_store, source_product_id, source_variant_id, status, supplier_order_id, supplier_tracking, notes } = req.body;
    if (!shopify_order_id || !source_store) return res.status(400).json({ success: false, error: 'Missing required fields' });
    const result = createOrderRouting({ shopify_order_id, shopify_order_number, source_store, source_product_id, source_variant_id, status: status || 'pending', supplier_order_id, supplier_tracking, notes });
    if (!result) return res.status(500).json({ success: false, error: 'Failed to create' });
    res.json({ success: true, message: 'Created', id: result.lastInsertRowid });
  } catch (e) {
    res.status(500).json({ success: false, error: 'Failed to create' });
  }
});

router.put('/orders/:id', (req, res) => {
  try {
    const { id } = req.params;
    const { status, supplier_order_id, supplier_tracking, notes } = req.body;
    if (!getOrderRoutingById(id)) return res.status(404).json({ success: false, error: 'Not found' });
    if (!updateOrderRouting(id, { status, supplier_order_id, supplier_tracking, notes })) return res.status(500).json({ success: false, error: 'Failed to update' });
    res.json({ success: true, message: 'Updated' });
  } catch (e) {
    res.status(500).json({ success: false, error: 'Failed to update' });
  }
});

// SOURCE FAILURES
router.get('/failures', (req, res) => {
  try {
    const { resolved = false, limit = 50, page = 1 } = req.query;
    const limitNum = Math.min(parseInt(limit) || 50, 200);
    const offset = (parseInt(page) - 1) * limitNum;
    const failures = getSourceFailures(limitNum, resolved === 'true', offset);
    res.json({ success: true, data: failures, count: failures.length });
  } catch (e) {
    res.status(500).json({ success: false, error: 'Failed to retrieve failures' });
  }
});

router.post('/failures/:id/resolve', (req, res) => {
  try {
    const { id } = req.params;
    if (!getSourceFailureById(id)) return res.status(404).json({ success: false, error: 'Not found' });
    if (!resolveSourceFailure(id)) return res.status(500).json({ success: false, error: 'Failed to resolve' });
    res.json({ success: true, message: 'Resolved' });
  } catch (e) {
    res.status(500).json({ success: false, error: 'Failed to resolve' });
  }
});

// SYNC MANAGEMENT
router.post('/sync/resync/:source/:sourceId', async (req, res) => {
  try {
    const { source, sourceId } = req.params;
    const adapter = getAdapter(source);
    if (!adapter) return res.status(400).json({ success: false, error: `Invalid source: ${source}` });
    try {
      const prepared = await prepareCart({ source, sourceId, quantity: 1 });
      if (!prepared || !prepared.shopifyVariantId) return res.status(500).json({ success: false, error: 'Failed to sync' });
      res.json({ success: true, message: 'Resynced', shopifyProductId: prepared.shopifyProductId, shopifyVariantId: prepared.shopifyVariantId, handle: prepared.handle });
    } catch (ae) {
      logSourceFailure(source, `/product/${sourceId}`, 'RESYNC_FAILED', ae.message);
      res.status(500).json({ success: false, error: `Source error: ${ae.message}` });
    }
  } catch (e) {
    res.status(500).json({ success: false, error: 'Failed to resync' });
  }
});

router.delete('/mappings/:id', (req, res) => {
  try {
    const { id } = req.params;
    if (!deleteMapping(id)) return res.status(404).json({ success: false, error: 'Not found' });
    res.json({ success: true, message: 'Deleted' });
  } catch (e) {
    res.status(500).json({ success: false, error: 'Failed to delete' });
  }
});

// DASHBOARD / STATS
router.get('/dashboard', (req, res) => {
  try {
    res.json({ success: true, data: getAdvancedStats() });
  } catch (e) {
    res.status(500).json({ success: false, error: 'Failed to retrieve stats' });
  }
});

router.get('/logs', (req, res) => {
  try {
    const { limit = 100 } = req.query;
    const logs = getRecentSyncLogs(Math.min(parseInt(limit) || 100, 500));
    res.json({ success: true, data: logs, count: logs.length });
  } catch (e) {
    res.status(500).json({ success: false, error: 'Failed to retrieve logs' });
  }
});

router.get('/mappings', (req, res) => {
  try {
    const { limit = 50, page = 1 } = req.query;
    const limitNum = Math.min(parseInt(limit) || 50, 200);
    const offset = (parseInt(page) - 1) * limitNum;
    const mappings = getAllMappings(limitNum, offset);
    res.json({ success: true, data: mappings, count: mappings.length, total: getMappingCount() });
  } catch (e) {
    res.status(500).json({ success: false, error: 'Failed to retrieve mappings' });
  }
});

module.exports = router;
