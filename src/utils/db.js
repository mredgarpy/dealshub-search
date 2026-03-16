// ============================================================
// StyleHub — Persistent Database (SQLite)
// Source→Shopify product/variant mappings + sync logs
// ============================================================

const path = require('path');
const logger = require('./logger');

let db = null;

function getDb() {
  if (db) return db;
  try {
    const Database = require('better-sqlite3');
    const dbPath = path.join(process.env.DB_PATH || '/tmp', 'stylehub.db');
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    initSchema();
    logger.info('db', `SQLite connected at ${dbPath}`);
    return db;
  } catch (e) {
    logger.warn('db', `SQLite not available: ${e.message}. Using in-memory fallback.`);
    return null;
  }
}

function initSchema() {
  if (!db) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS product_mappings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_store TEXT NOT NULL,
      source_product_id TEXT NOT NULL,
      source_variant_id TEXT,
      shopify_product_id INTEGER,
      shopify_variant_id INTEGER,
      shopify_handle TEXT,
      last_price REAL,
      last_original_price REAL,
      sync_hash TEXT,
      sync_status TEXT DEFAULT 'synced',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE(source_store, source_product_id)
    );
    CREATE INDEX IF NOT EXISTS idx_mapping_source ON product_mappings(source_store, source_product_id);
    CREATE INDEX IF NOT EXISTS idx_mapping_shopify ON product_mappings(shopify_product_id);
    CREATE TABLE IF NOT EXISTS sync_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_store TEXT, source_product_id TEXT,
      action TEXT, status TEXT, details TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS pricing_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_store TEXT, category TEXT, brand TEXT,
      markup_pct REAL, min_margin_pct REAL,
      round_to REAL DEFAULT 0.99, price_floor REAL,
      is_active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS shipping_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_store TEXT, region TEXT DEFAULT 'domestic',
      method TEXT DEFAULT 'standard', cost REAL,
      min_days INTEGER, max_days INTEGER, label TEXT,
      is_active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS order_routing (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shopify_order_id INTEGER, shopify_order_number TEXT,
      source_store TEXT, source_product_id TEXT, source_variant_id TEXT,
      status TEXT DEFAULT 'pending',
      supplier_order_id TEXT, supplier_tracking TEXT, notes TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_routing_shopify ON order_routing(shopify_order_id);
    CREATE INDEX IF NOT EXISTS idx_routing_source ON order_routing(source_store);
    CREATE INDEX IF NOT EXISTS idx_routing_status ON order_routing(status);
    CREATE TABLE IF NOT EXISTS source_failures (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_store TEXT, endpoint TEXT,
      error_type TEXT, error_message TEXT,
      resolved INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_failures_source ON source_failures(source_store);
    CREATE INDEX IF NOT EXISTS idx_failures_resolved ON source_failures(resolved);
  `);
  // Seed default pricing rules
  try {
    if (db.prepare('SELECT COUNT(*) as c FROM pricing_rules').get().c === 0) {
      const defaults = [
        ['amazon', 12, 8], ['aliexpress', 25, 15], ['sephora', 10, 5],
        ['macys', 10, 5], ['shein', 30, 18]
      ];
      const stmt = db.prepare('INSERT INTO pricing_rules (source_store, category, brand, markup_pct, min_margin_pct, round_to, is_active) VALUES (?, null, null, ?, ?, 0.99, 1)');
      defaults.forEach(d => stmt.run(d[0], d[1], d[2]));
      logger.info('db', 'Seeded default pricing rules');
    }
  } catch (e) { logger.warn('db', 'Failed to seed pricing rules', { error: e.message }); }
  // Seed default shipping rules
  try {
    if (db.prepare('SELECT COUNT(*) as c FROM shipping_rules').get().c === 0) {
      const defaults = [
        ['amazon', 'standard', 0, 2, 5, 'Standard'],
        ['amazon', 'prime', 0, 1, 2, 'Prime'],
        ['aliexpress', 'standard', 2.50, 15, 30, 'Standard Shipping'],
        ['sephora', 'standard', 5, 3, 7, 'Standard'],
        ['macys', 'standard', 5, 5, 7, 'Standard'],
        ['shein', 'standard', 3, 10, 20, 'Standard Shipping']
      ];
      const stmt = db.prepare('INSERT INTO shipping_rules (source_store, method, cost, min_days, max_days, label, is_active) VALUES (?, ?, ?, ?, ?, ?, 1)');
      defaults.forEach(d => stmt.run(...d));
      logger.info('db', 'Seeded default shipping rules');
    }
  } catch (e) { logger.warn('db', 'Failed to seed shipping rules', { error: e.message }); }
}

// MAPPING OPERATIONS
function findMapping(source, sourceId) {
  const d = getDb(); if (!d) return null;
  try { return d.prepare('SELECT * FROM product_mappings WHERE source_store = ? AND source_product_id = ?').get(source, String(sourceId)); }
  catch (e) { logger.error('db', 'findMapping failed', { error: e.message }); return null; }
}

function upsertMapping(data) {
  const d = getDb(); if (!d) return null;
  try {
    const stmt = d.prepare(`
      INSERT INTO product_mappings (source_store, source_product_id, source_variant_id,
        shopify_product_id, shopify_variant_id, shopify_handle, last_price, last_original_price,
        sync_hash, sync_status, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'synced', datetime('now'))
      ON CONFLICT(source_store, source_product_id) DO UPDATE SET
        shopify_product_id = excluded.shopify_product_id,
        shopify_variant_id = excluded.shopify_variant_id,
        shopify_handle = excluded.shopify_handle,
        last_price = excluded.last_price,
        last_original_price = excluded.last_original_price,
        sync_hash = excluded.sync_hash,
        sync_status = 'synced', updated_at = datetime('now')
    `);
    return stmt.run(data.source, String(data.sourceId), data.sourceVariantId || null,
      data.shopifyProductId, data.shopifyVariantId, data.handle,
      data.price || null, data.originalPrice || null, data.syncHash || null);
  } catch (e) { logger.error('db', 'upsertMapping failed', { error: e.message }); return null; }
}

function logSync(source, sourceId, action, status, details = '') {
  const d = getDb(); if (!d) return;
  try { d.prepare('INSERT INTO sync_logs (source_store, source_product_id, action, status, details) VALUES (?, ?, ?, ?, ?)').run(source, String(sourceId), action, status, typeof details === 'object' ? JSON.stringify(details) : details); }
  catch (e) { /* silent */ }
}

function getAllMappings(limit = 100, offset = 0) {
  const d = getDb(); if (!d) return [];
  try { return d.prepare('SELECT * FROM product_mappings ORDER BY updated_at DESC LIMIT ? OFFSET ?').all(limit, offset); }
  catch (e) { return []; }
}

function getMappingCount() {
  const d = getDb(); if (!d) return 0;
  try { return d.prepare('SELECT COUNT(*) as count FROM product_mappings').get().count; }
  catch (e) { return 0; }
}

function getRecentSyncLogs(limit = 50) {
  const d = getDb(); if (!d) return [];
  try { return d.prepare('SELECT * FROM sync_logs ORDER BY created_at DESC LIMIT ?').all(limit); }
  catch (e) { return []; }
}

// PRICING RULES
function getPricingRules() {
  const d = getDb(); if (!d) return [];
  try { return d.prepare('SELECT * FROM pricing_rules ORDER BY source_store, category, brand').all(); }
  catch (e) { return []; }
}
function getPricingRuleById(id) {
  const d = getDb(); if (!d) return null;
  try { return d.prepare('SELECT * FROM pricing_rules WHERE id = ?').get(id); }
  catch (e) { return null; }
}
function upsertPricingRule(data) {
  const d = getDb(); if (!d) return null;
  try {
    const { id, source_store, category, brand, markup_pct, min_margin_pct, round_to, price_floor, is_active } = data;
    if (id) {
      return d.prepare('UPDATE pricing_rules SET source_store=?, category=?, brand=?, markup_pct=?, min_margin_pct=?, round_to=?, price_floor=?, is_active=?, updated_at=datetime(\'now\') WHERE id=?').run(source_store, category||null, brand||null, markup_pct, min_margin_pct, round_to||0.99, price_floor||null, is_active!==false?1:0, id);
    } else {
      return d.prepare('INSERT INTO pricing_rules (source_store,category,brand,markup_pct,min_margin_pct,round_to,price_floor,is_active) VALUES (?,?,?,?,?,?,?,?)').run(source_store, category||null, brand||null, markup_pct, min_margin_pct, round_to||0.99, price_floor||null, is_active!==false?1:0);
    }
  } catch (e) { logger.error('db', 'upsertPricingRule failed', { error: e.message }); return null; }
}
function deletePricingRule(id) {
  const d = getDb(); if (!d) return false;
  try { return d.prepare('DELETE FROM pricing_rules WHERE id=?').run(id).changes>0; }
  catch (e) { return false; }
}

// SHIPPING RULES
function getShippingRules() {
  const d = getDb(); if (!d) return [];
  try { return d.prepare('SELECT * FROM shipping_rules ORDER BY source_store, method').all(); }
  catch (e) { return []; }
}
function getShippingRuleById(id) {
  const d = getDb(); if (!d) return null;
  try { return d.prepare('SELECT * FROM shipping_rules WHERE id=?').get(id); }
  catch (e) { return null; }
}
function upsertShippingRule(data) {
  const d = getDb(); if (!d) return null;
  try {
    const { id, source_store, region, method, cost, min_days, max_days, label, is_active } = data;
    if (id) {
      return d.prepare('UPDATE shipping_rules SET source_store=?, region=?, method=?, cost=?, min_days=?, max_days=?, label=?, is_active=? WHERE id=?').run(source_store, region||'domestic', method||'standard', cost, min_days, max_days, label, is_active!==false?1:0, id);
    } else {
      return d.prepare('INSERT INTO shipping_rules (source_store,region,method,cost,min_days,max_days,label,is_active) VALUES (?,?,?,?,?,?,?,?)').run(source_store, region||'domestic', method||'standard', cost, min_days, max_days, label, is_active!==false?1:0);
    }
  } catch (e) { logger.error('db', 'upsertShippingRule failed', { error: e.message }); return null; }
}
function deleteShippingRule(id) {
  const d = getDb(); if (!d) return false;
  try { return d.prepare('DELETE FROM shipping_rules WHERE id=?').run(id).changes>0; }
  catch (e) { return false; }
}

// ORDER ROUTING
function getOrderRouting(limit=50, status=null, offset=0) {
  const d = getDb(); if (!d) return [];
  try {
    if (status) return d.prepare('SELECT * FROM order_routing WHERE status=? ORDER BY created_at DESC LIMIT ? OFFSET ?').all(status, limit, offset);
    return d.prepare('SELECT * FROM order_routing ORDER BY created_at DESC LIMIT ? OFFSET ?').all(limit, offset);
  } catch (e) { return []; }
}
function getOrderRoutingById(id) {
  const d = getDb(); if (!d) return null;
  try { return d.prepare('SELECT * FROM order_routing WHERE id=?').get(id); }
  catch (e) { return null; }
}
function createOrderRouting(data) {
  const d = getDb(); if (!d) return null;
  try {
    const { shopify_order_id, shopify_order_number, source_store, source_product_id, source_variant_id, status, supplier_order_id, supplier_tracking, notes } = data;
    return d.prepare('INSERT INTO order_routing (shopify_order_id,shopify_order_number,source_store,source_product_id,source_variant_id,status,supplier_order_id,supplier_tracking,notes) VALUES (?,?,?,?,?,?,?,?,?)').run(shopify_order_id, shopify_order_number, source_store, source_product_id, source_variant_id, status||'pending', supplier_order_id||null, supplier_tracking||null, notes||null);
  } catch (e) { logger.error('db', 'createOrderRouting failed', { error: e.message }); return null; }
}
function updateOrderRouting(id, data) {
  const d = getDb(); if (!d) return false;
  try {
    const { status, supplier_order_id, supplier_tracking, notes } = data;
    return d.prepare('UPDATE order_routing SET status=?, supplier_order_id=?, supplier_tracking=?, notes=?, updated_at=datetime(\'now\') WHERE id=?').run(status||null, supplier_order_id||null, supplier_tracking||null, notes||null, id).changes>0;
  } catch (e) { return false; }
}

// SOURCE FAILURES
function logSourceFailure(source, endpoint, errorType, errorMessage) {
  const d = getDb(); if (!d) return;
  try { d.prepare('INSERT INTO source_failures (source_store,endpoint,error_type,error_message) VALUES (?,?,?,?)').run(source, endpoint, errorType, errorMessage); }
  catch (e) { /* silent */ }
}
function getSourceFailures(limit=50, resolved=false, offset=0) {
  const d = getDb(); if (!d) return [];
  try { return d.prepare('SELECT * FROM source_failures WHERE resolved=? ORDER BY created_at DESC LIMIT ? OFFSET ?').all(resolved?1:0, limit, offset); }
  catch (e) { return []; }
}
function getSourceFailureById(id) {
  const d = getDb(); if (!d) return null;
  try { return d.prepare('SELECT * FROM source_failures WHERE id=?').get(id); }
  catch (e) { return null; }
}
function resolveSourceFailure(id) {
  const d = getDb(); if (!d) return false;
  try { return d.prepare('UPDATE source_failures SET resolved=1 WHERE id=?').run(id).changes>0; }
  catch (e) { return false; }
}
function deleteMapping(id) {
  const d = getDb(); if (!d) return false;
  try { return d.prepare('DELETE FROM product_mappings WHERE id=?').run(id).changes>0; }
  catch (e) { return false; }
}

// ADVANCED STATS
function getAdvancedStats() {
  const d = getDb(); if (!d) return {};
  try {
    return {
      mappingCount: d.prepare('SELECT COUNT(*) as c FROM product_mappings').get().c,
      syncLogCount: d.prepare('SELECT COUNT(*) as c FROM sync_logs').get().c,
      orderCount: d.prepare('SELECT COUNT(*) as c FROM order_routing').get().c,
      failureCount: d.prepare('SELECT COUNT(*) as c FROM source_failures WHERE resolved=0').get().c,
      recentSyncs: d.prepare('SELECT source_store,action,status,COUNT(*) as count FROM sync_logs WHERE created_at>datetime(\'now\',\'-24 hours\') GROUP BY source_store,action,status').all(),
      mappingsBySource: d.prepare('SELECT source_store,COUNT(*) as count FROM product_mappings GROUP BY source_store').all(),
      ordersBySource: d.prepare('SELECT source_store,status,COUNT(*) as count FROM order_routing GROUP BY source_store,status').all(),
      timestamp: new Date().toISOString()
    };
  } catch (e) { logger.error('db', 'getAdvancedStats failed', { error: e.message }); return {}; }
}

module.exports = {
  getDb, findMapping, upsertMapping, logSync,
  getAllMappings, getMappingCount, getRecentSyncLogs, deleteMapping,
  getPricingRules, getPricingRuleById, upsertPricingRule, deletePricingRule,
  getShippingRules, getShippingRuleById, upsertShippingRule, deleteShippingRule,
  getOrderRouting, getOrderRoutingById, createOrderRouting, updateOrderRouting,
  logSourceFailure, getSourceFailures, getSourceFailureById, resolveSourceFailure,
  getAdvancedStats
};
