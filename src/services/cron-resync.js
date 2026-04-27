// ============================================================
// StyleHub — Cron Resync Service
// ============================================================
// Periodically refreshes Shopify products with live data from source APIs:
//   - Price + compareAt (using current pricing tiers)
//   - Title (cleaned of promotional text by adapter)
//   - Stock signal (availability)
//   - Variants count (new ASINs/items added since last sync)
//   - Images (refreshed)
//
// Two entry points:
//   1) Auto: setInterval-based daily run (scheduled in server.js)
//   2) Manual: POST /api/admin/cron/run
//
// Status persisted to /data/cron-status.json so admins can see last run
// without depending on logs.
//
// Rate-limit: 1 call every 1.2s (~50/min) sustained — RapidAPI 429-safe.
// Concurrent runs guarded by _runningJob lock.

const fs = require('fs');
const path = require('path');
const { getAllMappingsForRepricing } = require('../utils/db');
const { prepareCart } = require('./shopify-sync');
const { getAdapter } = require('../adapters');
const logger = require('../utils/logger');

// Persist status to disk so admin can read across restarts.
// /data is the persistent dir on Render Free; fall back to /tmp.
const DATA_DIR = fs.existsSync('/data') ? '/data' : '/tmp';
const STATUS_FILE = path.join(DATA_DIR, 'cron-status.json');

// In-memory lock so two simultaneous trigger calls don't race.
let _runningJob = null;
let _shouldStop = false;

const RATE_LIMIT_MS = 1200; // 1.2s between API calls — sustainable for RapidAPI

function loadStatus() {
  try {
    if (fs.existsSync(STATUS_FILE)) {
      return JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8'));
    }
  } catch (e) {
    logger.warn('cron-resync', `Failed to read status file: ${e.message}`);
  }
  return {
    lastRun: null,
    lastFinish: null,
    lastStatus: 'never',
    lastTotal: 0,
    lastOk: 0,
    lastErr: 0,
    history: []
  };
}

function saveStatus(status) {
  try {
    fs.writeFileSync(STATUS_FILE, JSON.stringify(status, null, 2));
  } catch (e) {
    logger.warn('cron-resync', `Failed to write status file: ${e.message}`);
  }
}

function isRunning() {
  return _runningJob !== null;
}

function getProgress() {
  if (!_runningJob) return null;
  return {
    running: true,
    startedAt: _runningJob.startedAt,
    processed: _runningJob.processed,
    ok: _runningJob.ok,
    err: _runningJob.err,
    total: _runningJob.total,
    currentSource: _runningJob.currentSource || null,
    currentSourceId: _runningJob.currentSourceId || null
  };
}

function requestStop() {
  _shouldStop = true;
  logger.info('cron-resync', 'Stop requested — will halt after current item');
}

async function resyncAll(opts = {}) {
  if (_runningJob) {
    return { error: 'already_running', progress: getProgress() };
  }

  const limit = opts.limit || 999999;
  const sourceFilter = opts.source || null; // 'amazon' | 'aliexpress' | null

  let mappings;
  try {
    mappings = getAllMappingsForRepricing();
  } catch (e) {
    return { error: 'db_error', message: e.message };
  }

  if (sourceFilter) {
    mappings = mappings.filter(m => m.source_store === sourceFilter);
  }
  if (mappings.length > limit) {
    mappings = mappings.slice(0, limit);
  }

  _runningJob = {
    startedAt: new Date().toISOString(),
    processed: 0,
    ok: 0,
    err: 0,
    total: mappings.length,
    currentSource: null,
    currentSourceId: null,
    errors: []
  };
  _shouldStop = false;

  // Persist start
  const status = loadStatus();
  status.lastRun = _runningJob.startedAt;
  status.lastStatus = 'running';
  status.lastTotal = mappings.length;
  saveStatus(status);

  logger.info('cron-resync', `Starting resync of ${mappings.length} mappings`);

  // Run async — don't block request
  (async () => {
    try {
      for (const m of mappings) {
        if (_shouldStop) {
          logger.info('cron-resync', 'Stopped by request');
          break;
        }
        _runningJob.currentSource = m.source_store;
        _runningJob.currentSourceId = m.source_product_id;
        try {
          const adapter = getAdapter(m.source_store);
          if (!adapter) {
            _runningJob.err++;
            _runningJob.errors.push({ source: m.source_store, sourceId: m.source_product_id, error: 'no_adapter' });
            continue;
          }
          const productData = await adapter.getProduct(m.source_product_id);
          if (!productData) {
            _runningJob.err++;
            _runningJob.errors.push({ source: m.source_store, sourceId: m.source_product_id, error: 'product_not_found' });
            continue;
          }
          const result = await prepareCart({
            source: m.source_store,
            sourceId: m.source_product_id,
            productData,
            quantity: 1,
            forceResync: true
          });
          if (result && result.shopifyVariantId) {
            _runningJob.ok++;
          } else {
            _runningJob.err++;
            _runningJob.errors.push({ source: m.source_store, sourceId: m.source_product_id, error: 'prepare_cart_no_variant' });
          }
        } catch (err) {
          _runningJob.err++;
          if (_runningJob.errors.length < 50) {
            _runningJob.errors.push({ source: m.source_store, sourceId: m.source_product_id, error: (err.message || String(err)).slice(0, 200) });
          }
          logger.warn('cron-resync', `Failed ${m.source_store}:${m.source_product_id}: ${err.message}`);
        } finally {
          _runningJob.processed++;
          if (_runningJob.processed % 25 === 0) {
            // Persist progress every 25 items
            const s = loadStatus();
            s.lastProcessed = _runningJob.processed;
            s.lastOk = _runningJob.ok;
            s.lastErr = _runningJob.err;
            saveStatus(s);
          }
        }
        // Rate-limit between API calls
        await new Promise(r => setTimeout(r, RATE_LIMIT_MS));
      }

      const finishedAt = new Date().toISOString();
      const finalStatus = loadStatus();
      finalStatus.lastRun = _runningJob.startedAt;
      finalStatus.lastFinish = finishedAt;
      finalStatus.lastStatus = _shouldStop ? 'stopped' : 'completed';
      finalStatus.lastTotal = _runningJob.total;
      finalStatus.lastOk = _runningJob.ok;
      finalStatus.lastErr = _runningJob.err;
      finalStatus.history = (finalStatus.history || []).slice(-19); // keep last 19
      finalStatus.history.push({
        startedAt: _runningJob.startedAt,
        finishedAt,
        total: _runningJob.total,
        ok: _runningJob.ok,
        err: _runningJob.err,
        status: _shouldStop ? 'stopped' : 'completed'
      });
      saveStatus(finalStatus);
      logger.info('cron-resync', `Resync finished: ${_runningJob.ok}/${_runningJob.total} ok, ${_runningJob.err} err`);
    } catch (err) {
      logger.error('cron-resync', `Resync crashed: ${err.message}`);
    } finally {
      _runningJob = null;
      _shouldStop = false;
    }
  })();

  return { started: true, total: mappings.length, startedAt: _runningJob.startedAt };
}

// ---- Auto-schedule (called from server.js) ----
// Runs every 24h after server start. First run delayed by 30min so server has time to warm up.
let _intervalHandle = null;
function startScheduler() {
  if (_intervalHandle) return; // already started
  // Initial delay: 30 minutes after server boot
  const initialDelay = 30 * 60 * 1000;
  // Recurrence: every 24 hours
  const recurrence = 24 * 60 * 60 * 1000;
  setTimeout(() => {
    logger.info('cron-resync', 'Initial scheduled run starting');
    resyncAll().catch(e => logger.error('cron-resync', `Scheduled run failed: ${e.message}`));
    _intervalHandle = setInterval(() => {
      logger.info('cron-resync', 'Scheduled run starting (interval tick)');
      resyncAll().catch(e => logger.error('cron-resync', `Scheduled run failed: ${e.message}`));
    }, recurrence);
  }, initialDelay);
  logger.info('cron-resync', `Scheduler armed: first run in 30min, then every 24h`);
}

function stopScheduler() {
  if (_intervalHandle) {
    clearInterval(_intervalHandle);
    _intervalHandle = null;
  }
}

module.exports = {
  resyncAll,
  isRunning,
  getProgress,
  requestStop,
  loadStatus,
  startScheduler,
  stopScheduler
};
