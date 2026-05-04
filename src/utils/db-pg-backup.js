// ──────────────────────────────────────────────────────────────────────
// Postgres backup layer for product_mappings
// ──────────────────────────────────────────────────────────────────────
// Render Free Tier wipes the SQLite filesystem on every deploy, taking the
// product_mappings with it. That means each redeploy turns every wizard-
// created mapping into a duplicate AutoDS slot consumption.
//
// This module mirrors product_mappings to a persistent Postgres database.
//   - On boot: if DATABASE_URL is set, restoreMappings() returns every row
//     so server.js can re-seed the in-process SQLite.
//   - On upsert: backupMapping() writes the same row to Postgres async,
//     fire-and-forget (the SQLite write is the source of truth at runtime).
//
// SQLite remains the synchronous runtime DB — zero refactor of existing
// findMapping/upsertMapping/etc. callers. Postgres is the durable backup.
//
// Activates only when process.env.DATABASE_URL is present. Otherwise this
// module is a no-op (returns null/empty), so dev environments keep working
// without a Postgres instance.
// ──────────────────────────────────────────────────────────────────────

const ENABLED = !!process.env.DATABASE_URL;
let _pool = null;
let _ready = false;
let _readyPromise = null;
let logger;
try { logger = require('./logger'); } catch (e) { logger = { info: console.log, warn: console.warn, error: console.error }; }

function _initOnce() {
  if (!ENABLED) return Promise.resolve(false);
  if (_readyPromise) return _readyPromise;

  _readyPromise = (async () => {
    try {
      const { Pool } = require('pg');
      _pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false },
        max: 4,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 10000
      });

      // Ensure schema. Idempotent.
      await _pool.query(`
        CREATE TABLE IF NOT EXISTS product_mappings (
          source_store          TEXT NOT NULL,
          source_product_id     TEXT NOT NULL,
          source_variant_id     TEXT,
          shopify_product_id    BIGINT NOT NULL,
          shopify_variant_id    BIGINT NOT NULL,
          shopify_handle        TEXT,
          last_price            NUMERIC(12,2),
          last_original_price   NUMERIC(12,2),
          sync_hash             TEXT,
          sync_status           TEXT DEFAULT 'synced',
          created_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (source_store, source_product_id)
        )
      `);
      await _pool.query(`CREATE INDEX IF NOT EXISTS idx_pm_shopify_product_id ON product_mappings(shopify_product_id)`);
      await _pool.query(`CREATE INDEX IF NOT EXISTS idx_pm_updated_at        ON product_mappings(updated_at)`);

      _ready = true;
      logger.info('db-pg', 'Postgres backup layer ready (DATABASE_URL detected)');
      return true;
    } catch (e) {
      logger.error('db-pg', `Postgres init failed: ${e.message} — backup disabled`);
      _pool = null;
      _ready = false;
      return false;
    }
  })();
  return _readyPromise;
}

/**
 * Restore all mappings from Postgres so the in-process SQLite can be re-seeded
 * after a Render Free deploy wiped its filesystem. Returns an array of rows
 * shaped for sqlite upsert ({ source, sourceId, ... }) — empty if disabled
 * or empty backup.
 */
async function restoreMappings() {
  if (!ENABLED) return [];
  await _initOnce();
  if (!_ready) return [];
  try {
    const r = await _pool.query(`
      SELECT source_store, source_product_id, source_variant_id,
             shopify_product_id, shopify_variant_id, shopify_handle,
             last_price, last_original_price, sync_hash, sync_status
        FROM product_mappings
        ORDER BY updated_at DESC
    `);
    return r.rows.map(row => ({
      source: row.source_store,
      sourceId: row.source_product_id,
      sourceVariantId: row.source_variant_id,
      shopifyProductId: row.shopify_product_id ? String(row.shopify_product_id) : null,
      shopifyVariantId: row.shopify_variant_id ? String(row.shopify_variant_id) : null,
      handle: row.shopify_handle,
      price: row.last_price !== null ? Number(row.last_price) : null,
      originalPrice: row.last_original_price !== null ? Number(row.last_original_price) : null,
      syncHash: row.sync_hash
    }));
  } catch (e) {
    logger.error('db-pg', `restoreMappings failed: ${e.message}`);
    return [];
  }
}

/**
 * Async fire-and-forget backup of a mapping to Postgres. Caller does NOT
 * need to await — this is durability, not the runtime path.
 */
function backupMapping(data) {
  if (!ENABLED) return;
  // Don't await _initOnce; if it isn't ready yet, queue a microtask
  _initOnce().then(ok => {
    if (!ok || !_pool) return;
    return _pool.query(
      `
      INSERT INTO product_mappings
        (source_store, source_product_id, source_variant_id,
         shopify_product_id, shopify_variant_id, shopify_handle,
         last_price, last_original_price, sync_hash, sync_status, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'synced', CURRENT_TIMESTAMP)
      ON CONFLICT (source_store, source_product_id) DO UPDATE SET
        source_variant_id   = EXCLUDED.source_variant_id,
        shopify_product_id  = EXCLUDED.shopify_product_id,
        shopify_variant_id  = EXCLUDED.shopify_variant_id,
        shopify_handle      = EXCLUDED.shopify_handle,
        last_price          = EXCLUDED.last_price,
        last_original_price = EXCLUDED.last_original_price,
        sync_hash           = EXCLUDED.sync_hash,
        sync_status         = 'synced',
        updated_at          = CURRENT_TIMESTAMP
      `,
      [
        data.source,
        String(data.sourceId),
        data.sourceVariantId || null,
        data.shopifyProductId || null,
        data.shopifyVariantId || null,
        data.handle || null,
        data.price !== undefined ? data.price : null,
        data.originalPrice !== undefined ? data.originalPrice : null,
        data.syncHash || null
      ]
    );
  }).catch(e => {
    logger.warn('db-pg', `backupMapping failed (non-fatal): ${e.message}`);
  });
}

/**
 * Async fire-and-forget delete from Postgres.
 */
function deleteBackupMapping(source, sourceId) {
  if (!ENABLED) return;
  _initOnce().then(ok => {
    if (!ok || !_pool) return;
    return _pool.query(
      `DELETE FROM product_mappings WHERE source_store = $1 AND source_product_id = $2`,
      [source, String(sourceId)]
    );
  }).catch(e => {
    logger.warn('db-pg', `deleteBackupMapping failed (non-fatal): ${e.message}`);
  });
}

function isEnabled() { return ENABLED; }

module.exports = { isEnabled, restoreMappings, backupMapping, deleteBackupMapping };
