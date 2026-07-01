// ============================================================
// StyleHub — AutoDS Slot Purge Service
// ============================================================
// Why this exists:
//   AutoDS Plan A caps us at 500 products in the supplier list. Once
//   we hit that ceiling, the wizard fails and Add to Cart breaks for
//   any new ASIN the user views. Manually pruning the AutoDS UI is
//   slow, error-prone, and we forget.
//
//   This service watches our local mirror (autods_products) and once
//   we cross PURGE_THRESHOLD products, deletes the oldest unsold
//   products from Shopify. AutoDS auto-syncs the deletion (it polls
//   the store every few minutes), which frees the slot.
//
//   Selection criteria for purge candidates:
//     - Synced via prepare-cart (in product_mappings)
//     - NEVER ordered (no row in autods_order_items referencing the
//       Shopify product_id)
//     - Older than PURGE_MIN_AGE_DAYS (avoid deleting fresh views
//       that may convert)
//     - Sorted by created_at ASC (oldest first)
//
// Two entry points:
//   1) Auto: setInterval-based daily run (scheduled in server.js)
//   2) Manual: POST /api/admin/autods/purge?dryRun=true
//
// Status persisted to /data/autods-purge-status.json so admins can
// see last run without depending on logs.
// ============================================================

const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const { getDb, deleteMapping } = require('../utils/db');
const logger = require('../utils/logger');

// ---- CONFIG ----
const SHOPIFY_DOMAIN  = () => process.env.SHOPIFY_STORE_DOMAIN;
const SHOPIFY_TOKEN   = () => process.env.SHOPIFY_ADMIN_TOKEN;
const API_VERSION     = '2024-01';

// AutoDS Plan A caps at 500 — start purging at 450 so we always have
// ~50 free slots for organic traffic spikes.
const PURGE_THRESHOLD     = parseInt(process.env.AUTODS_PURGE_THRESHOLD     || '450', 10);
const PURGE_TARGET        = parseInt(process.env.AUTODS_PURGE_TARGET        || '400', 10);
const PURGE_MIN_AGE_DAYS  = parseInt(process.env.AUTODS_PURGE_MIN_AGE_DAYS  || '7', 10);
const PURGE_BATCH_LIMIT   = parseInt(process.env.AUTODS_PURGE_BATCH_LIMIT   || '50', 10);
const PURGE_THROTTLE_MS   = parseInt(process.env.AUTODS_PURGE_THROTTLE_MS   || '600', 10);

const DATA_DIR    = fs.existsSync('/data') ? '/data' : '/tmp';
const STATUS_FILE = path.join(DATA_DIR, 'autods-purge-status.json');

let _runningJob = null;

function loadStatus() {
  try {
    if (fs.existsSync(STATUS_FILE)) {
      return JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8'));
    }
  } catch (e) {
    logger.warn('autods-purge', `Failed to read status file: ${e.message}`);
  }
  return {
    lastRun: null,
    lastFinish: null,
    lastStatus: 'never',
    lastDeleted: 0,
    lastErrors: 0,
    history: []
  };
}

function saveStatus(status) {
  try {
    fs.writeFileSync(STATUS_FILE, JSON.stringify(status, null, 2));
  } catch (e) {
    logger.warn('autods-purge', `Failed to write status file: ${e.message}`);
  }
}

function isRunning() { return _runningJob !== null; }
function getProgress() {
  if (!_runningJob) return null;
  return { ..._runningJob, running: true };
}

// ---- COUNT CURRENT AUTODS PRODUCTS ----
// Source of truth = product_mappings (every row corresponds to a Shopify
// product that AutoDS has imported via the wizard).
function countAutodsProducts() {
  const db = getDb();
  if (!db) return 0;
  try {
    return db.prepare('SELECT COUNT(*) as c FROM product_mappings').get().c;
  } catch (e) {
    logger.error('autods-purge', `countAutodsProducts failed: ${e.message}`);
    return 0;
  }
}

// ---- FIND PURGE CANDIDATES ----
// Find Shopify products that are safe to delete: present in product_mappings,
// older than PURGE_MIN_AGE_DAYS, NEVER appeared in any order line item.
// Sorted by created_at ASC so we kill the oldest dead inventory first.
function findCandidates(limit = PURGE_BATCH_LIMIT) {
  const db = getDb();
  if (!db) return [];
  try {
    // Self-defense: only target rows that are already in autods_products
    // (i.e. were created via the wizard) AND have NO order item referencing
    // them. The LEFT JOIN is the simplest way to express "no orders".
    const rows = db.prepare(`
      SELECT pm.id              AS mapping_id,
             pm.source_store,
             pm.source_product_id,
             pm.shopify_product_id,
             pm.shopify_variant_id,
             pm.shopify_handle,
             pm.created_at      AS mapping_created_at,
             pm.last_price
        FROM product_mappings pm
   LEFT JOIN autods_order_items oi
          ON oi.shopify_product_id = pm.shopify_product_id
       WHERE oi.id IS NULL
         AND pm.shopify_product_id IS NOT NULL
         AND datetime(pm.created_at) < datetime('now', '-' || ? || ' days')
    ORDER BY datetime(pm.created_at) ASC
       LIMIT ?
    `).all(PURGE_MIN_AGE_DAYS, limit);
    return rows;
  } catch (e) {
    logger.error('autods-purge', `findCandidates failed: ${e.message}`);
    return [];
  }
}

// ---- DELETE A SHOPIFY PRODUCT ----
// 404 is treated as success (already gone). Any other non-OK response is
// returned as an error string so the caller can record it.
async function deleteShopifyProduct(shopifyProductId) {
  const url = `https://${SHOPIFY_DOMAIN()}/admin/api/${API_VERSION}/products/${shopifyProductId}.json`;
  const resp = await fetch(url, {
    method: 'DELETE',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': SHOPIFY_TOKEN()
    }
  });
  if (resp.ok) return { ok: true };
  if (resp.status === 404) return { ok: true, alreadyGone: true };
  const txt = await resp.text();
  return { ok: false, status: resp.status, error: txt.slice(0, 200) };
}

// ---- CREATE 301 REDIRECT FOR A PURGED PRODUCT (SEO fix) ----
// When we delete a product, its /products/<handle> url would 404 and Google
// would flag it. Instead we leave a 301 -> /collections/all so link equity and
// crawl budget aren't wasted. Best-effort: never throws, 422 (exists) ignored.
async function createRedirectForDeleted(handle) {
  if (!handle) return;
  try {
    const url = `https://${SHOPIFY_DOMAIN()}/admin/api/${API_VERSION}/redirects.json`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': SHOPIFY_TOKEN()
      },
      body: JSON.stringify({ redirect: { path: `/products/${handle}`, target: '/collections/all' } })
    });
    if (!resp.ok && resp.status !== 422) {
      const t = await resp.text();
      logger.warn('autods-purge', `Redirect create failed for ${handle}: ${resp.status} ${t.slice(0, 120)}`);
    }
  } catch (e) {
    logger.warn('autods-purge', `Redirect create exception for ${handle}: ${e.message}`);
  }
}

// ---- DELETE LOCAL MAPPING + AUTODS RECORD ----
function purgeLocalRecords(mappingId, source, sourceId, shopifyProductId) {
  const db = getDb();
  if (!db) return;
  try {
    // 1. product_mappings — also mirrors delete to Postgres (see deleteMapping)
    deleteMapping(mappingId);
    // 2. autods_products — remove the record so the count is accurate
    db.prepare('DELETE FROM autods_products WHERE source_store = ? AND source_product_id = ?')
      .run(source, String(sourceId));
  } catch (e) {
    logger.warn('autods-purge', `purgeLocalRecords partial failure: ${e.message}`);
  }
}

// ---- MAIN PURGE RUN ----
async function runPurge(opts = {}) {
  if (_runningJob) {
    return { error: 'already_running', progress: getProgress() };
  }

  const dryRun       = !!opts.dryRun;
  const forceLimit   = opts.limit ? parseInt(opts.limit, 10) : null;
  const ignoreThreshold = !!opts.force;

  const currentCount = countAutodsProducts();
  const overage = currentCount - PURGE_TARGET;

  if (!ignoreThreshold && currentCount < PURGE_THRESHOLD) {
    logger.info('autods-purge', `No purge needed: ${currentCount}/${PURGE_THRESHOLD} (target ${PURGE_TARGET})`);
    return {
      skipped: true,
      reason: 'below_threshold',
      currentCount,
      threshold: PURGE_THRESHOLD,
      target: PURGE_TARGET
    };
  }

  // Slots to free = overage + small buffer; capped to BATCH_LIMIT.
  const desired   = forceLimit || Math.max(0, overage);
  const toDelete  = Math.min(desired, PURGE_BATCH_LIMIT);
  const candidates = findCandidates(toDelete);

  // Capture startedAt locally so the response can return it even if the
  // async IIFE finishes (and nulls _runningJob) before this function returns,
  // which is what happens when candidates.length === 0.
  const startedAt = new Date().toISOString();
  _runningJob = {
    startedAt,
    currentCount,
    target: PURGE_TARGET,
    plannedDeletes: candidates.length,
    deleted: 0,
    errors: 0,
    skipped: 0,
    dryRun,
    items: []
  };

  const status = loadStatus();
  status.lastRun = startedAt;
  status.lastStatus = dryRun ? 'dry-running' : 'running';
  saveStatus(status);

  logger.info('autods-purge', `Purge starting: ${currentCount} → ${PURGE_TARGET} | candidates: ${candidates.length} | dryRun: ${dryRun}`);

  // Run async — do not block request
  (async () => {
    try {
      for (const c of candidates) {
        if (dryRun) {
          _runningJob.items.push({
            source: c.source_store,
            sourceId: c.source_product_id,
            shopifyProductId: c.shopify_product_id,
            handle: c.shopify_handle,
            createdAt: c.mapping_created_at,
            action: 'would-delete'
          });
          _runningJob.skipped++;
          continue;
        }
        try {
          const r = await deleteShopifyProduct(c.shopify_product_id);
          if (r.ok) {
            // SEO: leave a 301 so the now-dead product url doesn't 404 in Google
            if (!r.alreadyGone) { await createRedirectForDeleted(c.shopify_handle); }
            purgeLocalRecords(c.mapping_id, c.source_store, c.source_product_id, c.shopify_product_id);
            _runningJob.deleted++;
            _runningJob.items.push({
              source: c.source_store,
              sourceId: c.source_product_id,
              shopifyProductId: c.shopify_product_id,
              handle: c.shopify_handle,
              alreadyGone: !!r.alreadyGone,
              action: 'deleted'
            });
          } else {
            _runningJob.errors++;
            _runningJob.items.push({
              source: c.source_store,
              sourceId: c.source_product_id,
              shopifyProductId: c.shopify_product_id,
              handle: c.shopify_handle,
              error: r.error || `status_${r.status}`,
              action: 'error'
            });
            logger.warn('autods-purge', `Delete failed for ${c.shopify_product_id}: ${r.error}`);
          }
        } catch (err) {
          _runningJob.errors++;
          _runningJob.items.push({
            source: c.source_store,
            sourceId: c.source_product_id,
            shopifyProductId: c.shopify_product_id,
            handle: c.shopify_handle,
            error: err.message.slice(0, 200),
            action: 'exception'
          });
          logger.error('autods-purge', `Exception deleting ${c.shopify_product_id}: ${err.message}`);
        }
        // Throttle between Shopify Admin API calls — REST limit is 2/sec
        await new Promise(r => setTimeout(r, PURGE_THROTTLE_MS));
      }

      const finishedAt = new Date().toISOString();
      const finalStatus = loadStatus();
      finalStatus.lastRun       = _runningJob.startedAt;
      finalStatus.lastFinish    = finishedAt;
      finalStatus.lastStatus    = dryRun ? 'dry-completed' : 'completed';
      finalStatus.lastDeleted   = _runningJob.deleted;
      finalStatus.lastErrors    = _runningJob.errors;
      finalStatus.lastSkipped   = _runningJob.skipped;
      finalStatus.lastDryRun    = dryRun;
      finalStatus.lastCount     = currentCount;
      finalStatus.history = (finalStatus.history || []).slice(-19);
      finalStatus.history.push({
        startedAt: _runningJob.startedAt,
        finishedAt,
        deleted: _runningJob.deleted,
        errors: _runningJob.errors,
        skipped: _runningJob.skipped,
        dryRun,
        beforeCount: currentCount
      });
      saveStatus(finalStatus);
      logger.info('autods-purge', `Purge done: ${_runningJob.deleted} deleted, ${_runningJob.errors} errors, ${_runningJob.skipped} skipped (dryRun=${dryRun})`);
    } catch (err) {
      logger.error('autods-purge', `Purge crashed: ${err.message}`);
    } finally {
      _runningJob = null;
    }
  })();

  return {
    started: true,
    dryRun,
    currentCount,
    target: PURGE_TARGET,
    plannedDeletes: candidates.length,
    startedAt
  };
}

// ---- AUTO-SCHEDULER ----
// Daily run, 6h after server start. Quick first probe at 90 minutes
// post-boot so a freshly-deployed instance still gets a chance to act
// the same day.
let _intervalHandle = null;
function startScheduler() {
  if (_intervalHandle) return;
  if (process.env.AUTODS_PURGE_SCHEDULER === 'off') {
    logger.info('autods-purge', 'Scheduler disabled by AUTODS_PURGE_SCHEDULER=off');
    return;
  }
  const initialDelay = 90 * 60 * 1000; // 90 minutes
  const recurrence   = 24 * 60 * 60 * 1000; // 24h
  setTimeout(() => {
    logger.info('autods-purge', 'Initial scheduled purge starting');
    runPurge({}).catch(e => logger.error('autods-purge', `Scheduled run failed: ${e.message}`));
    _intervalHandle = setInterval(() => {
      logger.info('autods-purge', 'Scheduled purge starting (interval tick)');
      runPurge({}).catch(e => logger.error('autods-purge', `Scheduled run failed: ${e.message}`));
    }, recurrence);
  }, initialDelay);
  logger.info('autods-purge', `Scheduler armed: first run in 90min, then every 24h | threshold=${PURGE_THRESHOLD} target=${PURGE_TARGET} minAge=${PURGE_MIN_AGE_DAYS}d`);
}

function stopScheduler() {
  if (_intervalHandle) {
    clearInterval(_intervalHandle);
    _intervalHandle = null;
  }
}

module.exports = {
  runPurge,
  isRunning,
  getProgress,
  loadStatus,
  countAutodsProducts,
  findCandidates,
  startScheduler,
  stopScheduler,
  // exposed for tests / inspection
  _config: () => ({
    PURGE_THRESHOLD,
    PURGE_TARGET,
    PURGE_MIN_AGE_DAYS,
    PURGE_BATCH_LIMIT,
    PURGE_THROTTLE_MS
  })
};
