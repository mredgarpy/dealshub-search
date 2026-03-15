// ============================================================
// StyleHub — Persistent Database (In-Memory with optional SQLite)
// Source->Shopify product/variant mappings + sync logs
// ============================================================

const path = require('path');
const logger = require('./logger');

// In-memory storage as primary (SQLite optional if available)
const memoryDb = {
  mappings: new Map(),
  syncLogs: [],
  pricingRules: [],
  shippingRules: []
};

let db = null;

function getDb() {
  if (db) return db;
  try {
    const Database = require('better-sqlite3');
    const dbPath = path.join(process.env.DB_PATH || '/tmp', 'stylehub.db');
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    initSchema();
    logger.info('db', 'SQLite connected at ' + dbPath);
    return db;
  } catch (e) {
    logger.info('db', 'SQLite not available, using in-memory storage');
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
  `);
}

// ---- MAPPING OPERATIONS ----

function findMapping(source, sourceId) {
  const d = getDb();
  if (d) {
    try {
      return d.prepare(
        'SELECT * FROM product_mappings WHERE source_store = ? AND source_product_id = ?'
      ).get(source, String(sourceId));
    } catch (e) {
      logger.error('db', 'findMapping SQL failed', { error: e.message });
    }
  }
  // Fallback to in-memory
  const key = source + ':' + String(sourceId);
  return memoryDb.mappings.get(key) || null;
}

function upsertMapping(data) {
  const d = getDb();
  if (d) {
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
      logger.error('db', 'upsertMapping SQL failed', { error: e.message });
    }
  }
  // Fallback to in-memory
  const key = data.source + ':' + String(data.sourceId);
  memoryDb.mappings.set(key, {
    source_store: data.source,
    source_product_id: String(data.sourceId),
    shopify_product_id: data.shopifyProductId,
    shopify_variant_id: data.shopifyVariantId,
    shopify_handle: data.handle,
    last_price: data.price,
    last_original_price: data.originalPrice
  });
  return { changes: 1 };
}

function logSync(source, sourceId, action, status, details) {
  const d = getDb();
  if (d) {
    try {
      d.prepare(
        'INSERT INTO sync_logs (source_store, source_product_id, action, status, details) VALUES (?, ?, ?, ?, ?)'
      ).run(source, String(sourceId), action, status, typeof details === 'object' ? JSON.stringify(details) : String(details || ''));
    } catch (e) { /* silent */ }
  }
  memoryDb.syncLogs.unshift({ source, sourceId: String(sourceId), action, status, details, created_at: new Date().toISOString() });
  if (memoryDb.syncLogs.length > 200) memoryDb.syncLogs.length = 200;
}

function getAllMappings(limit, offset) {
  limit = limit || 100;
  offset = offset || 0;
  const d = getDb();
  if (d) {
    try { return d.prepare('SELECT * FROM product_mappings ORDER BY updated_at DESC LIMIT ? OFFSET ?').all(limit, offset); }
    catch (e) { /* fall through */ }
  }
  return Array.from(memoryDb.mappings.values()).slice(offset, offset + limit);
}

function getMappingCount() {
  const d = getDb();
  if (d) {
    try { return d.prepare('SELECT COUNT(*) as count FROM product_mappings').get().count; }
    catch (e) { /* fall through */ }
  }
  return memoryDb.mappings.size;
}

function getRecentSyncLogs(limit) {
  limit = limit || 50;
  const d = getDb();
  if (d) {
    try { return d.prepare('SELECT * FROM sync_logs ORDER BY created_at DESC LIMIT ?').all(limit); }
    catch (e) { /* fall through */ }
  }
  return memoryDb.syncLogs.slice(0, limit);
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