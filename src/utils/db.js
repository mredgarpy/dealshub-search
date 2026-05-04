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

    CREATE INDEX IF NOT EXISTS idx_mapping_source
      ON product_mappings(source_store, source_product_id);

    CREATE INDEX IF NOT EXISTS idx_mapping_shopify
      ON product_mappings(shopify_product_id);

    CREATE TABLE IF NOT EXISTS sync_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_store TEXT,
      source_product_id TEXT,
      action TEXT,
      status TEXT,
      details TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS pricing_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_store TEXT,
      category TEXT,
      brand TEXT,
      markup_pct REAL,
      min_margin_pct REAL,
      round_to REAL DEFAULT 0.99,
      price_floor REAL,
      is_active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS shipping_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_store TEXT,
      region TEXT DEFAULT 'domestic',
      method TEXT DEFAULT 'standard',
      cost REAL,
      min_days INTEGER,
      max_days INTEGER,
      label TEXT,
      is_active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS order_routing (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shopify_order_id INTEGER,
      shopify_order_number TEXT,
      source_store TEXT,
      source_product_id TEXT,
      source_variant_id TEXT,
      status TEXT DEFAULT 'pending',
      supplier_order_id TEXT,
      supplier_tracking TEXT,
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_routing_shopify
      ON order_routing(shopify_order_id);

    CREATE INDEX IF NOT EXISTS idx_routing_source
      ON order_routing(source_store);

    CREATE INDEX IF NOT EXISTS idx_routing_status
      ON order_routing(status);

    CREATE TABLE IF NOT EXISTS source_failures (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_store TEXT,
      endpoint TEXT,
      error_type TEXT,
      error_message TEXT,
      resolved INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_failures_source
      ON source_failures(source_store);

    CREATE INDEX IF NOT EXISTS idx_failures_resolved
      ON source_failures(resolved);

    CREATE TABLE IF NOT EXISTS markup_tiers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_store TEXT NOT NULL,
      min_price REAL NOT NULL DEFAULT 0,
      max_price REAL NOT NULL DEFAULT 999999,
      multiplier REAL NOT NULL DEFAULT 1.20,
      is_active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_tiers_source
      ON markup_tiers(source_store, min_price);

    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // Seed default pricing rules if empty
  try {
    const pricingCount = db.prepare('SELECT COUNT(*) as c FROM pricing_rules').get().c;
    if (pricingCount === 0) {
      const defaults = [
        { source: 'amazon', category: null, brand: null, markup: 12, margin: 8 },
        { source: 'aliexpress', category: null, brand: null, markup: -45, margin: 0 },
        { source: 'sephora', category: null, brand: null, markup: 10, margin: 5 },
        { source: 'macys', category: null, brand: null, markup: 10, margin: 5 },
        { source: 'shein', category: null, brand: null, markup: 30, margin: 18 }
      ];
      const stmt = db.prepare(`
        INSERT INTO pricing_rules (source_store, category, brand, markup_pct, min_margin_pct, round_to, is_active)
        VALUES (?, ?, ?, ?, ?, 0.99, 1)
      `);
      defaults.forEach(d => {
        stmt.run(d.source, d.category, d.brand, d.markup, d.margin);
      });
      logger.info('db', 'Seeded default pricing rules');
    }
  } catch (e) {
    logger.warn('db', 'Failed to seed pricing rules', { error: e.message });
  }

  // Migration: AliExpress uses MSRP-discount model (-45% markup, 0% min margin)
  // The old seed had +25% markup which produced prices 3x above AliExpress retail.
  try {
    const aliRule = db.prepare(
      "SELECT * FROM pricing_rules WHERE source_store = 'aliexpress' AND category IS NULL AND brand IS NULL"
    ).get();
    if (aliRule && (aliRule.markup_pct > 0 || !aliRule.price_floor)) {
      db.prepare(
        "UPDATE pricing_rules SET markup_pct = -45, min_margin_pct = 0, price_floor = 2.99 WHERE id = ?"
      ).run(aliRule.id);
      logger.info('db', 'Migrated AliExpress pricing rule to MSRP-discount model (-45% markup)', {
        oldMarkup: aliRule.markup_pct, newMarkup: -45
      });
    }
  } catch (e) {
    logger.warn('db', 'Failed to migrate AliExpress pricing rule', { error: e.message });
  }

  // Seed default markup tiers if empty
  try {
    const tiersCount = db.prepare('SELECT COUNT(*) as c FROM markup_tiers').get().c;
    if (tiersCount === 0) {
      const ranges = [
        { min: 0,   max: 3 },
        { min: 3,   max: 10 },
        { min: 10,  max: 25 },
        { min: 25,  max: 50 },
        { min: 50,  max: 100 },
        { min: 100, max: 200 },
        { min: 200, max: 500 },
        { min: 500, max: 999999 }
      ];
      // Default multipliers per source per range
      const sourceMultipliers = {
        amazon:     [1.70, 1.35, 1.25, 1.20, 1.15, 1.10, 1.07, 1.05],
        aliexpress: [2.50, 1.70, 1.50, 1.40, 1.30, 1.22, 1.15, 1.10],
        sephora:    [1.50, 1.30, 1.22, 1.18, 1.12, 1.08, 1.06, 1.05],
        macys:      [1.50, 1.30, 1.22, 1.18, 1.12, 1.08, 1.06, 1.05],
        shein:      [2.50, 1.70, 1.50, 1.40, 1.30, 1.22, 1.15, 1.10],
        default:    [1.70, 1.35, 1.25, 1.20, 1.15, 1.10, 1.07, 1.05]
      };
      const stmt = db.prepare(`
        INSERT INTO markup_tiers (source_store, min_price, max_price, multiplier, is_active)
        VALUES (?, ?, ?, ?, 1)
      `);
      for (const [source, mults] of Object.entries(sourceMultipliers)) {
        ranges.forEach((r, i) => {
          stmt.run(source, r.min, r.max, mults[i]);
        });
      }
      logger.info('db', 'Seeded default markup tiers (6 sources × 8 ranges)');
    }
  } catch (e) {
    logger.warn('db', 'Failed to seed markup tiers', { error: e.message });
  }

  // Seed default shipping rules if empty
  try {
    const shippingCount = db.prepare('SELECT COuNT(*) as c FROM shipping_rules').get().c;
    if (shippingCount === 0) {
      const defaults = [
        { source: 'amazon', method: 'standard', cost: 0, minDays: 2, maxDays: 5, label: 'Standard' },
        { source: 'amazon', method: 'prime', cost: 0, minDays: 1, maxDays: 2, label: 'Prime' },
        { source: 'aliexpress', method: 'standard', cost: 2.50, minDays: 15, maxDays: 30, label: 'Standard Shipping' },
        { source: 'sephora', method: 'standard', cost: 5, minDays: 3, maxDays: 7, label: 'Standard' },
        { source: 'macys', method: 'standard', cost: 5, minDays: 5, maxDays: 7, label: 'Standard' },
        { source: 'shein', method: 'standard', cost: 3, minDays: 10, maxDays: 20, label: 'Standard Shipping' }
      ];
      const stmt = db.prepare(`
        INSERT INTO shipping_rules (source_store, method, cost, min_days, max_days, label, is_active)
        VALUES (?, ?, ?, ?, ?, ?, 1)
      `);
      defaults.forEach(d => {
        stmt.run(d.source, d.method, d.cost, d.minDays, d.maxDays, d.label);
      });
      logger.info('db', 'Seeded default shipping rules');
    }
  } catch (e) {
    logger.warn('db', 'Failed to seed shipping rules', { error: e.message });
  }
}

// ---- MAPPING OPERATIONS ----

function findMapping(source, sourceId) {
  const d = getDb();
  if (!d) return null;
  try {
    return d.prepare(
      'SELECT * FROM product_mappings WHERE source_store = ? AND source_product_id = ?'
    ).get(source, String(sourceId));
  } catch (e) {
    logger.error('db', 'findMapping failed', { error: e.message });
    return null;
  }
}

function upsertMapping(data) {
  const d = getDb();
  if (!d) return null;
  let result = null;
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
        sync_status = 'synced',
        updated_at = datetime('now')
    `);
    result = stmt.run(
      data.source, String(data.sourceId), data.sourceVariantId || null,
      data.shopifyProductId, data.shopifyVariantId, data.handle,
      data.price || null, data.originalPrice || null,
      data.syncHash || null
    );
  } catch (e) {
    logger.error('db', 'upsertMapping failed', { error: e.message });
    return null;
  }

  // Mirror to persistent Postgres backup (no-op when DATABASE_URL unset).
  // Async, fire-and-forget — SQLite is the source of truth at runtime.
  try {
    const pgBackup = require('./db-pg-backup');
    pgBackup.backupMapping(data);
  } catch (e) { /* non-fatal */ }

  return result;
}

/**
 * Restore mappings from Postgres backup (called on boot after Render Free
 * wipes the SQLite filesystem). Inserts directly without re-mirroring back
 * to PG (so no infinite loop). Returns the count restored.
 */
async function restoreMappingsFromBackup() {
  const d = getDb();
  if (!d) return 0;
  let pgBackup;
  try {
    pgBackup = require('./db-pg-backup');
  } catch (e) {
    return 0;
  }
  if (!pgBackup.isEnabled()) return 0;
  let rows = [];
  try {
    rows = await pgBackup.restoreMappings();
  } catch (e) {
    logger.error('db', `restoreMappings call failed: ${e.message}`);
    return 0;
  }
  if (!rows || rows.length === 0) return 0;

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
      sync_status = 'synced',
      updated_at = datetime('now')
  `);
  const tx = d.transaction((rows) => {
    for (const r of rows) {
      stmt.run(
        r.source, String(r.sourceId), r.sourceVariantId || null,
        r.shopifyProductId, r.shopifyVariantId, r.handle,
        r.price || null, r.originalPrice || null,
        r.syncHash || null
      );
    }
  });
  try {
    tx(rows);
    logger.info('db', `Restored ${rows.length} mapping(s) from Postgres backup`);
    return rows.length;
  } catch (e) {
    logger.error('db', `restoreMappingsFromBackup tx failed: ${e.message}`);
    return 0;
  }
}

function logSync(source, sourceId, action, status, details = '') {
  const d = getDb();
  if (!d) return;
  try {
    d.prepare(
      'INSERT INTO sync_logs (source_store, source_product_id, action, status, details) VALUES (?, ?, ?, ?, ?)'
    ).run(source, String(sourceId), action, status, typeof details === 'object' ? JSON.stringify(details) : details);
  } catch (e) {
    // silent fail for logging
  }
}

function getAllMappings(limit = 100, offset = 0) {
  const d = getDb();
  if (!d) return [];
  try {
    return d.prepare('SELECT * FROM product_mappings ORDER BY updated_at DESC LIMIT ? OFFSET ?').all(limit, offset);
  } catch (e) { return []; }
}

function getMappingCount() {
  const d = getDb();
  if (!d) return 0;
  try {
    return d.prepare('SELECT COuNT(*) as count FROM product_mappings').get().count;
  } catch (e) { return 0; }
}

function getRecentSyncLogs(limit = 50) {
  const d = getDb();
  if (!d) return [];
  try {
    return d.prepare('SELECT * FROM sync_logs ORDER BY created_at DESC LIMIT ?').all(limit);
  } catch (e) { return []; }
}

// ---- PRICING RULES ----

function getPricingRules() {
  const d = getDb();
  if (!d) return [];
  try {
    return d.prepare('SELECT * FROM pricing_rules ORDER BY source_store, category, brand').all();
  } catch (e) {
    logger.error('db', 'getPricingRules failed', { error: e.message });
    return [];
  }
}

function getPricingRuleById(id) {
  const d = getDb();
  if (!d) return null;
  try {
    return d.prepare('SELECT * FROM pricing_rules WHERE id = ?').get(id);
  } catch (e) {
    logger.error('db', 'getPricingRuleById failed', { error: e.message });
    return null;
  }
}

function upsertPricingRule(data) {
  const d = getDb();
  if (!d) return null;
  try {
    const { id, source_store, category, brand, markup_pct, min_margin_pct, round_to, price_floor, is_active } = data;
    if (id) {
      // Update
      const stmt = d.prepare(`
        UPDATE pricing_rules
        SET source_store = ?, category = ?, brand = ?, markup_pct = ?, min_margin_pct = ?,
            round_to = ?, price_floor = ?, is_active = ?, updated_at = datetime('now')
        WHERE id = ?
      `);
      return stmt.run(source_store, category || null, brand || null, markup_pct, min_margin_pct, round_to || 0.99, price_floor || null, is_active !== false ? 1 : 0, id);
    } else {
      // Insert
      const stmt = d.prepare(`
        INSERT INTO pricing_rules (source_store, category, brand, markup_pct, min_margin_pct, round_to, price_floor, is_active)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      return stmt.run(source_store, category || null, brand || null, markup_pct, min_margin_pct, round_to || 0.99, price_floor || null, is_active !== false ? 1 : 0);
    }
  } catch (e) {
    logger.error('db', 'upsertPricingRule failed', { error: e.message });
    return null;
  }
}

function deletePricingRule(id) {
  const d = getDb();
  if (!d) return false;
  try {
    const stmt = d.prepare('DELETE FROM pricing_rules WHERE id = ?');
    return stmt.run(id).changes > 0;
  } catch (e) {
    logger.error('db', 'deletePricingRule failed', { error: e.message });
    return false;
  }
}

// ---- SHIPPING RULES ----

function getShippingRules() {
  const d = getDb();
  if (!d) return [];
  try {
    return d.prepare('SELECT * FROM shipping_rules ORDER BY source_store, method').all();
  } catch (e) {
    logger.error('db', 'getShippingRules failed', { error: e.message });
    return [];
  }
}

function getShippingRuleById(id) {
  const d = getDb();
  if (!d) return null;
  try {
    return d.prepare('SELECT * FROM shipping_rules WHERE id = ?').get(id);
  } catch (e) {
    logger.error('db', 'getShippingRuleById failed', { error: e.message });
    return null;
  }
}

function upsertShippingRule(data) {
  const d = getDb();
  if (!d) return null;
  try {
    const { id, source_store, region, method, cost, min_days, max_days, label, is_active } = data;
    if (id) {
      // Update
      const stmt = d.prepare(`
        UPDATE shipping_rules
        SET source_store = ?, region = ?, method = ?, cost = ?, min_days = ?, max_days = ?, label = ?, is_active = ?
        WHERE id = ?
      `);
      return stmt.run(source_store, region || 'domestic', method || 'standard', cost, min_days, max_days, label, is_active !== false ? 1 : 0, id);
    } else {
      // Insert
      const stmt = d.prepare(`
        INSERT INTO shipping_rules (source_store, region, method, cost, min_days, max_days, label, is_active)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      return stmt.run(source_store, region || 'domestic', method || 'standard', cost, min_days, max_days, label, is_active !== false ? 1 : 0);
    }
  } catch (e) {
    logger.error('db', 'upsertShippingRule failed', { error: e.message });
    return null;
  }
}

function deleteShippingRule(id) {
  const d = getDb();
  if (!d) return false;
  try {
    const stmt = d.prepare('DELETE FROM shipping_rules WHERE id = ?');
    return stmt.run(id).changes > 0;
  } catch (e) {
    logger.error('db', 'deleteShippingRule failed', { error: e.message });
    return false;
  }
}

// ---- ORDER ROUTING ----

function getOrderRouting(limit = 50, status = null, offset = 0) {
  const d = getDb();
  if (!d) return [];
  try {
    if (status) {
      return d.prepare(`
        SELECT * FROM order_routing
        WHERE status = ?
        ORDER BY created_at DESC
        LIMIT ? OFFSET ?
      `).all(status, limit, offset);
    } else {
      return d.prepare(`
        SELECT * FROM order_routing
        ORDER BY created_at DESC
        LIMIT ? OFFSET ?
      `).all(limit, offset);
    }
  } catch (e) {
    logger.error('db', 'getOrderRouting failed', { error: e.message });
    return [];
  }
}

function getOrderRoutingById(id) {
  const d = getDb();
  if (!d) return null;
  try {
    return d.prepare('SELECT * FROM order_routing WHERE id = ?').get(id);
  } catch (e) {
    logger.error('db', 'getOrderRoutingById failed', { error: e.message });
    return null;
  }
}

function createOrderRouting(data) {
  const d = getDb();
  if (!d) return null;
  try {
    const { shopify_order_id, shopify_order_number, source_store, source_product_id, source_variant_id, status, supplier_order_id, supplier_tracking, notes } = data;
    const stmt = d.prepare(`
      INSERT INTO order_routing (shopify_order_id, shopify_order_number, source_store, source_product_id, source_variant_id, status, supplier_order_id, supplier_tracking, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    return stmt.run(shopify_order_id, shopify_order_number, source_store, source_product_id, source_variant_id, status || 'pending', supplier_order_id || null, supplier_tracking || null, notes || null);
  } catch (e) {
    logger.error('db', 'createOrderRouting failed', { error: e.message });
    return null;
  }
}

function updateOrderRouting(id, data) {
  const d = getDb();
  if (!d) return false;
  try {
    const { status, supplier_order_id, supplier_tracking, notes } = data;
    const stmt = d.prepare(`
      UPDATE order_routing
      SET status = ?, supplier_order_id = ?, supplier_tracking = ?, notes = ?, updated_at = datetime('now')
      WHERE id = ?
    `);
    return stmt.run(status || null, supplier_order_id || null, supplier_tracking || null, notes || null, id).changes > 0;
  } catch (e) {
    logger.error('db', 'updateOrderRouting failed', { error: e.message });
    return false;
  }
}

// ---- SOURCE FAILURES ----

function logSourceFailure(source, endpoint, errorType, errorMessage) {
  const d = getDb();
  if (!d) return;
  try {
    const stmt = d.prepare(`
      INSERT INTO source_failures (source_store, endpoint, error_type, error_message)
      VALUES (?, ?, ?, ?)
    `);
    stmt.run(source, endpoint, errorType, errorMessage);
  } catch (e) {
    logger.warn('db', 'Failed to log source failure', { error: e.message });
  }
}

function getSourceFailures(limit = 50, resolved = false, offset = 0) {
  const d = getDb();
  if (!d) return [];
  try {
    return d.prepare(`
      SELECT * FROM source_failures
      WHERE resolved = ?
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `).all(resolved ? 1 : 0, limit, offset);
  } catch (e) {
    logger.error('db', 'getSourceFailures failed', { error: e.message });
    return [];
  }
}

function getSourceFailureById(id) {
  const d = getDb();
  if (!d) return null;
  try {
    return d.prepare('SELECT * FROM source_failures WHERE id = ?').get(id);
  } catch (e) {
    logger.error('db', 'getSourceFailureById failed', { error: e.message });
    return null;
  }
}

function resolveSourceFailure(id) {
  const d = getDb();
  if (!d) return false;
  try {
    const stmt = d.prepare('UPDATE source_failures SET resolved = 1 WHERE id = ?');
    return stmt.run(id).changes > 0;
  } catch (e) {
    logger.error('db', 'resolveSourceFailure failed', { error: e.message });
    return false;
  }
}

function deleteMapping(id) {
  const d = getDb();
  if (!d) return false;
  try {
    // Capture source/sourceId before delete so we can mirror the delete to PG
    const row = d.prepare('SELECT source_store, source_product_id FROM product_mappings WHERE id = ?').get(id);
    const stmt = d.prepare('DELETE FROM product_mappings WHERE id = ?');
    const ok = stmt.run(id).changes > 0;
    if (ok && row) {
      try {
        const pgBackup = require('./db-pg-backup');
        pgBackup.deleteBackupMapping(row.source_store, row.source_product_id);
      } catch (e) { /* non-fatal */ }
    }
    return ok;
  } catch (e) {
    logger.error('db', 'deleteMapping failed', { error: e.message });
    return false;
  }
}

// ---- ADVANCED STATS ----

function getAdvancedStats() {
  const d = getDb();
  if (!d) return {};
  try {
    const mappingCount = d.prepare('SELECT COUNT(*) as c FROM product_mappings').get().c;
    const syncLogCount = d.prepare('SELECT COUNT(*) as c FROM sync_logs').get().c;
    const orderCount = d.prepare('SELECT COUNT(*) as c FROM order_routing').get().c;
    const failureCount = d.prepare('SELECT COUNT(*) as c FROM source_failures WHERE resolved = 0').get().c;

    const recentSyncs = d.prepare(`
      SELECT source_store, action, status, COuNT(*) as count
      FROM sync_logs
      WHERE created_at > datetime('now', '-24 hours')
      GROUP BY source_store, action, status
    `).all();

    const mappingsBySource = d.prepare(`
      SELECT source_store, COUNT(*) as count
      FROM product_mappings
      GROUP BY source_store
    `).all();

    const ordersBySource = d.prepare(`
      SELECT source_store, status, COUNT(*) as count
      FROM order_routing
      GROUP BY source_store, status
    `).all();

    return {
      mappingCount,
      syncLogCount,
      orderCount,
      failureCount,
      recentSyncs,
      mappingsBySource,
      ordersBySource,
      timestamp: new Date().toISOString()
    };
  } catch (e) {
    logger.error('db', 'getAdvancedStats failed', { error: e.message });
    return {};
  }
}

// ---- MARKUP TIERS ----

function getMarkupTiers() {
  const d = getDb();
  if (!d) return [];
  try {
    return d.prepare('SELECT * FROM markup_tiers WHERE is_active = 1 ORDER BY source_store, min_price').all();
  } catch (e) {
    logger.error('db', 'getMarkupTiers failed', { error: e.message });
    return [];
  }
}

function getMarkupTiersGrouped() {
  const tiers = getMarkupTiers();
  // Group by range index for admin UI: [{max, amazon, aliexpress, sephora, macys, shein, default}, ...]
  const ranges = [3, 10, 25, 50, 100, 200, 500, 999999];
  return ranges.map((max, i) => {
    const min = i === 0 ? 0 : ranges[i - 1];
    const row = { max };
    const sources = ['amazon', 'aliexpress', 'sephora', 'macys', 'shein', 'default'];
    sources.forEach(src => {
      const tier = tiers.find(t => t.source_store === src && t.min_price === min && t.max_price === max);
      row[src] = tier ? tier.multiplier : 1.20;
    });
    return row;
  });
}

function bulkUpsertMarkupTiers(tiersData) {
  // tiersData = array of {max, amazon, aliexpress, sephora, macys, shein, default}
  const d = getDb();
  if (!d) return false;
  try {
    const ranges = [3, 10, 25, 50, 100, 200, 500, 999999];
    const sources = ['amazon', 'aliexpress', 'sephora', 'macys', 'shein', 'default'];

    const upsert = d.prepare(`
      INSERT INTO markup_tiers (source_store, min_price, max_price, multiplier, is_active, updated_at)
      VALUES (?, ?, ?, ?, 1, datetime('now'))
      ON CONFLICT(id) DO UPDATE SET multiplier = excluded.multiplier, updated_at = datetime('now')
    `);

    const findTier = d.prepare(
      'SELECT id FROM markup_tiers WHERE source_store = ? AND min_price = ? AND max_price = ?'
    );
    const updateTier = d.prepare(
      'UPDATE markup_tiers SET multiplier = ?, updated_at = datetime(\'now\') WHERE id = ?'
    );
    const insertTier = d.prepare(
      'INSERT INTO markup_tiers (source_store, min_price, max_price, multiplier, is_active) VALUES (?, ?, ?, ?, 1)'
    );

    const transaction = d.transaction(() => {
      tiersData.forEach((row, i) => {
        const max = row.max || ranges[i] || 999999;
        const min = i === 0 ? 0 : (ranges[i - 1] || 0);
        sources.forEach(src => {
          const mult = parseFloat(row[src]) || 1.20;
          const existing = findTier.get(src, min, max);
          if (existing) {
            updateTier.run(mult, existing.id);
          } else {
            insertTier.run(src, min, max, mult);
          }
        });
      });
    });

    transaction();
    logger.info('db', 'Bulk updated markup tiers', { rowCount: tiersData.length });
    return true;
  } catch (e) {
    logger.error('db', 'bulkUpsertMarkupTiers failed', { error: e.message });
    return false;
  }
}

/**
 * Get the multiplier for a given source and price.
 * Used by the pricing engine.
 */
function getTierMultiplier(source, price) {
  const d = getDb();
  if (!d) return null;
  try {
    const tier = d.prepare(
      'SELECT multiplier FROM markup_tiers WHERE source_store = ? AND min_price <= ? AND max_price > ? AND is_active = 1 LIMIT 1'
    ).get(source, price, price);
    if (tier) return tier.multiplier;
    // Fallback to 'default' source
    const defTier = d.prepare(
      'SELECT multiplier FROM markup_tiers WHERE source_store = \'default\' AND min_price <= ? AND max_price > ? AND is_active = 1 LIMIT 1'
    ).get(price, price);
    return defTier ? defTier.multiplier : null;
  } catch (e) {
    return null;
  }
}

// ---- REPRICING: Get all mappings that have a Shopify variant to reprice ----

function getAllMappingsForRepricing() {
  const d = getDb();
  if (!d) return [];
  try {
    return d.prepare(`
      SELECT id, source_store, source_product_id, source_variant_id,
             shopify_product_id, shopify_variant_id, shopify_handle,
             last_price, last_original_price, sync_status
      FROM product_mappings
      WHERE shopify_variant_id IS NOT NULL
        AND sync_status = 'synced'
      ORDER BY source_store, updated_at DESC
    `).all();
  } catch (e) {
    logger.error('db', 'getAllMappingsForRepricing failed', { error: e.message });
    return [];
  }
}

function updateMappingPrice(id, newPrice, newOriginalPrice) {
  const d = getDb();
  if (!d) return false;
  try {
    const stmt = d.prepare(`
      UPDATE product_mappings
      SET last_price = ?, last_original_price = ?, updated_at = datetime('now')
      WHERE id = ?
    `);
    return stmt.run(newPrice, newOriginalPrice, id).changes > 0;
  } catch (e) {
    logger.error('db', 'updateMappingPrice failed', { error: e.message });
    return false;
  }
}

// ============================================================
// APP SETTINGS (generic key-value store) + SHIPPING BUFFERS
// ============================================================

function getSetting(key, defaultValue = null) {
  try {
    const row = getDb().prepare('SELECT value FROM app_settings WHERE key = ?').get(key);
    if (!row) return defaultValue;
    try { return JSON.parse(row.value); } catch { return row.value; }
  } catch (e) {
    logger.error('db', 'getSetting failed', { key, error: e.message });
    return defaultValue;
  }
}

function setSetting(key, value) {
  try {
    const v = typeof value === 'string' ? value : JSON.stringify(value);
    getDb().prepare(`
      INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
    `).run(key, v);
    return true;
  } catch (e) {
    logger.error('db', 'setSetting failed', { key, error: e.message });
    return false;
  }
}

// Default shipping buffer per source (USD added to landed cost before markup)
const DEFAULT_SHIPPING_BUFFERS = {
  amazon_prime:       0,   // Prime/FBA continental US is reliably free
  amazon_marketplace: 4,   // Non-Prime sellers charge shipping
  aliexpress:         3,   // AliExpress has variable shipping
  sephora:            0,   // Usually free
  macys:              2,
  shein:              2,
  _ak_hi_pr_surcharge: 8   // Extra surcharge absorbed when shipping AK/HI/PR
};

function getShippingBuffers() {
  const stored = getSetting('shipping_buffers', null);
  return { ...DEFAULT_SHIPPING_BUFFERS, ...(stored || {}) };
}

function setShippingBuffers(buffers) {
  const merged = { ...DEFAULT_SHIPPING_BUFFERS, ...buffers };
  return setSetting('shipping_buffers', merged);
}

module.exports = {
  getDb,
  getSetting,
  setSetting,
  getShippingBuffers,
  setShippingBuffers,
  DEFAULT_SHIPPING_BUFFERS,
  findMapping,
  upsertMapping,
  restoreMappingsFromBackup,
  logSync,
  getAllMappings,
  getMappingCount,
  getRecentSyncLogs,
  deleteMapping,
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
  getAdvancedStats,
  getMarkupTiers,
  getMarkupTiersGrouped,
  bulkUpsertMarkupTiers,
  getTierMultiplier,
  getAllMappingsForRepricing,
  updateMappingPrice
};
