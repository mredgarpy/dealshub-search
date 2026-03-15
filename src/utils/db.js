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
  `);
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
    return stmt.run(
      data.source, String(data.sourceId), data.sourceVariantId || null,
      data.shopifyProductId, data.shopifyVariantId, data.handle,
      data.price || null, data.originalPrice || null,
      data.syncHash || null
    );
  } catch (e) {
    logger.error('db', 'upsertMapping failed', { error: e.message });
    return null;
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
    return d.prepare('SELECT COUNT(*) as count FROM product_mappings').get().count;
  } catch (e) { return 0; }
}

function getRecentSyncLogs(limit = 50) {
  const d = getDb();
  if (!d) return [];
  try {
    return d.prepare('SELECT * FROM sync_logs ORDER BY created_at DESC LIMIT ?').all(limit);
  } catch (e) { return []; }
}

module.exports = {
  getDb,
  findMapping,
  upsertMapping,
  logSync,
  getAllMappings,
  getMappingCount,
  getRecentSyncLogs
};
