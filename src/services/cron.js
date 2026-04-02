// ============================================================
// StyleHub — Cron / Scheduled Tasks Service
// ============================================================
// Runs periodic tasks on configurable intervals.
// All tasks are non-blocking and error-tolerant.
//
// Tasks:
//   1. Product Mapping Sync → AutoDS tracking (every 15 min)
//   2. Source Health Check (every 30 min)
//   3. Stale Order Reprocessing (every 1 hour)
//   4. AutoDS Stats Snapshot / Alerting (every 6 hours)
//   5. DB Cleanup — old logs/failures (every 24 hours)
// ============================================================

const logger = require('../utils/logger');
const fetch = require('node-fetch');

let cronStarted = false;
const taskHistory = [];
const MAX_HISTORY = 200;

function logTask(name, status, details = '') {
  const entry = {
    task: name,
    status,
    details: typeof details === 'object' ? JSON.stringify(details) : details,
    at: new Date().toISOString()
  };
  taskHistory.unshift(entry);
  if (taskHistory.length > MAX_HISTORY) taskHistory.length = MAX_HISTORY;
  return entry;
}

// ---- TASK 1: Sync product_mappings → autods_products ----
// Ensures any product synced to Shopify is also registered for AutoDS tracking
async function taskSyncMappingsToAutods() {
  const taskName = 'sync-mappings-to-autods';
  try {
    const { getAllMappings } = require('../utils/db');
    const autods = require('./autods');

    const mappings = getAllMappings(500, 0);
    if (!mappings || mappings.length === 0) {
      logTask(taskName, 'ok', 'No mappings to sync');
      return;
    }

    let registered = 0;
    let skipped = 0;
    for (const m of mappings) {
      try {
        autods.registerProduct({
          source: m.source_store,
          sourceId: m.source_product_id,
          sourceUrl: '',
          shopifyProductId: m.shopify_product_id,
          shopifyVariantId: m.shopify_variant_id,
          shopifyHandle: m.shopify_handle
        });
        registered++;
      } catch (e) {
        skipped++;
      }
    }

    logger.info('cron', `[${taskName}] Synced ${registered} mappings, skipped ${skipped}`);
    logTask(taskName, 'ok', { total: mappings.length, registered, skipped });
  } catch (e) {
    logger.error('cron', `[${taskName}] Failed: ${e.message}`);
    logTask(taskName, 'error', e.message);
  }
}

// ---- TASK 2: Source Health Check ----
// Pings each source adapter to verify APIs are responding
async function taskSourceHealthCheck() {
  const taskName = 'source-health-check';
  try {
    const baseUrl = process.env.RENDER_EXTERNAL_URL || 'http://localhost:' + (process.env.PORT || 10000);
    const sources = ['amazon', 'aliexpress', 'sephora', 'macys', 'shein'];
    const results = {};

    for (const source of sources) {
      const start = Date.now();
      try {
        const resp = await fetch(`${baseUrl}/api/search?q=test&store=${source}&limit=1`, {
          signal: AbortSignal.timeout(15000)
        });
        const elapsed = Date.now() - start;
        results[source] = {
          status: resp.ok ? 'up' : 'error',
          code: resp.status,
          latency: elapsed
        };
      } catch (e) {
        results[source] = {
          status: 'down',
          error: e.message,
          latency: Date.now() - start
        };
      }
    }

    const downSources = Object.entries(results).filter(([, r]) => r.status !== 'up');
    if (downSources.length > 0) {
      logger.warn('cron', `[${taskName}] Down sources: ${downSources.map(([s]) => s).join(', ')}`, results);
    } else {
      logger.info('cron', `[${taskName}] All sources healthy`);
    }

    logTask(taskName, downSources.length > 0 ? 'warning' : 'ok', results);

    // Log failures to DB
    const { logSourceFailure } = require('../utils/db');
    for (const [source, result] of Object.entries(results)) {
      if (result.status !== 'up') {
        logSourceFailure(source, '/api/search', 'health_check', result.error || `HTTP ${result.code}`);
      }
    }
  } catch (e) {
    logger.error('cron', `[${taskName}] Failed: ${e.message}`);
    logTask(taskName, 'error', e.message);
  }
}

// ---- TASK 3: Reprocess stale/failed orders ----
// Checks for orders in 'processing' or 'error' status and retries them
async function taskReprocessStaleOrders() {
  const taskName = 'reprocess-stale-orders';
  try {
    const { getDb } = require('../utils/db');
    const autods = require('./autods');
    const db = getDb();
    if (!db) {
      logTask(taskName, 'skip', 'No DB available');
      return;
    }

    // Find orders stuck in processing or error state
    const staleOrders = db.prepare(`
      SELECT * FROM autods_orders
      WHERE autods_status IN ('processing', 'error')
      AND created_at > datetime('now', '-48 hours')
      ORDER BY created_at DESC
      LIMIT 20
    `).all();

    if (staleOrders.length === 0) {
      logTask(taskName, 'ok', 'No stale orders');
      return;
    }

    let reprocessed = 0;
    let failed = 0;
    for (const order of staleOrders) {
      try {
        const orderData = JSON.parse(order.items_json || '[]');
        // Reconstruct minimal order data for reprocessing
        const fakeOrderData = {
          id: order.shopify_order_id,
          order_number: order.shopify_order_number,
          name: order.shopify_order_name,
          email: order.customer_email,
          total_price: String(order.total_price),
          currency: order.currency,
          financial_status: order.financial_status,
          fulfillment_status: order.fulfillment_status,
          line_items: orderData,
          shipping_address: JSON.parse(order.shipping_address_json || '{}'),
          customer: {
            first_name: (order.customer_name || '').split(' ')[0],
            last_name: (order.customer_name || '').split(' ').slice(1).join(' '),
            email: order.customer_email
          }
        };

        await autods.processOrderWebhook(fakeOrderData);
        reprocessed++;
      } catch (e) {
        failed++;
        logger.debug('cron', `[${taskName}] Failed to reprocess order ${order.shopify_order_id}: ${e.message}`);
      }
    }

    logger.info('cron', `[${taskName}] Reprocessed ${reprocessed}/${staleOrders.length} stale orders (${failed} failed)`);
    logTask(taskName, 'ok', { total: staleOrders.length, reprocessed, failed });
  } catch (e) {
    logger.error('cron', `[${taskName}] Failed: ${e.message}`);
    logTask(taskName, 'error', e.message);
  }
}

// ---- TASK 4: AutoDS Stats Snapshot ----
// Logs periodic stats for monitoring
async function taskAutodsStatsSnapshot() {
  const taskName = 'autods-stats-snapshot';
  try {
    const autods = require('./autods');
    const stats = autods.getAutodsStats();

    logger.info('cron', `[${taskName}] Products: ${stats.summary?.totalProducts || 0} (linked: ${stats.summary?.linkedProducts || 0}), Orders: ${stats.summary?.totalOrders || 0} (ready: ${stats.summary?.readyOrders || 0})`);
    logTask(taskName, 'ok', stats.summary || {});
  } catch (e) {
    logger.error('cron', `[${taskName}] Failed: ${e.message}`);
    logTask(taskName, 'error', e.message);
  }
}

// ---- TASK 5: DB Cleanup ----
// Removes old sync logs and resolved failures
async function taskDbCleanup() {
  const taskName = 'db-cleanup';
  try {
    const { getDb } = require('../utils/db');
    const db = getDb();
    if (!db) {
      logTask(taskName, 'skip', 'No DB available');
      return;
    }

    // Delete sync logs older than 7 days
    const logsDeleted = db.prepare(
      "DELETE FROM sync_logs WHERE created_at < datetime('now', '-7 days')"
    ).run().changes;

    // Delete resolved failures older than 7 days
    const failuresDeleted = db.prepare(
      "DELETE FROM source_failures WHERE resolved = 1 AND created_at < datetime('now', '-7 days')"
    ).run().changes;

    // Delete old autods order items for processed orders older than 30 days
    const oldItemsDeleted = db.prepare(`
      DELETE FROM autods_order_items WHERE autods_order_id IN (
        SELECT id FROM autods_orders WHERE created_at < datetime('now', '-30 days')
      )
    `).run().changes;

    logger.info('cron', `[${taskName}] Cleaned: ${logsDeleted} sync logs, ${failuresDeleted} resolved failures, ${oldItemsDeleted} old order items`);
    logTask(taskName, 'ok', { logsDeleted, failuresDeleted, oldItemsDeleted });
  } catch (e) {
    logger.error('cron', `[${taskName}] Failed: ${e.message}`);
    logTask(taskName, 'error', e.message);
  }
}

// ---- TASK 6: Fetch recent Shopify orders and process any missed ones ----
// In case a webhook was missed, this catches up by pulling recent orders from Shopify
async function taskCatchUpMissedOrders() {
  const taskName = 'catch-up-missed-orders';
  try {
    const { getDb } = require('../utils/db');
    const autods = require('./autods');
    const db = getDb();
    if (!db) {
      logTask(taskName, 'skip', 'No DB available');
      return;
    }

    const shopifyDomain = process.env.SHOPIFY_STORE_DOMAIN;
    const shopifyToken = process.env.SHOPIFY_ADMIN_TOKEN;
    if (!shopifyDomain || !shopifyToken) {
      logTask(taskName, 'skip', 'Shopify not configured');
      return;
    }

    // Fetch last 10 orders from Shopify
    const resp = await fetch(
      `https://${shopifyDomain}/admin/api/2024-01/orders.json?status=any&limit=10&fields=id,name,order_number,email,total_price,currency,financial_status,fulfillment_status,line_items,shipping_address,customer,created_at`,
      {
        headers: {
          'X-Shopify-Access-Token': shopifyToken,
          'Content-Type': 'application/json'
        },
        signal: AbortSignal.timeout(15000)
      }
    );

    if (!resp.ok) {
      throw new Error(`Shopify API ${resp.status}`);
    }

    const data = await resp.json();
    const orders = data.orders || [];
    let newlyProcessed = 0;
    let alreadyProcessed = 0;

    for (const order of orders) {
      // Check if we already processed this order
      const existing = db.prepare(
        'SELECT id FROM autods_orders WHERE shopify_order_id = ?'
      ).get(order.id);

      if (existing) {
        alreadyProcessed++;
        continue;
      }

      // Process the missed order
      try {
        await autods.processOrderWebhook(order);
        newlyProcessed++;
        logger.info('cron', `[${taskName}] Caught missed order ${order.name}`);
      } catch (e) {
        logger.warn('cron', `[${taskName}] Failed to process order ${order.name}: ${e.message}`);
      }
    }

    logger.info('cron', `[${taskName}] Checked ${orders.length} orders: ${newlyProcessed} new, ${alreadyProcessed} already processed`);
    logTask(taskName, 'ok', { checked: orders.length, newlyProcessed, alreadyProcessed });
  } catch (e) {
    logger.error('cron', `[${taskName}] Failed: ${e.message}`);
    logTask(taskName, 'error', e.message);
  }
}

// ---- SCHEDULE CONFIGURATION ----
const CRON_SCHEDULE = {
  syncMappings:     { fn: taskSyncMappingsToAutods,   interval: 15 * 60 * 1000,      name: 'Sync Mappings → AutoDS',       delay: 30000 },
  healthCheck:      { fn: taskSourceHealthCheck,       interval: 30 * 60 * 1000,      name: 'Source Health Check',           delay: 60000 },
  reprocessOrders:  { fn: taskReprocessStaleOrders,    interval: 60 * 60 * 1000,      name: 'Reprocess Stale Orders',        delay: 120000 },
  catchUpOrders:    { fn: taskCatchUpMissedOrders,     interval: 20 * 60 * 1000,      name: 'Catch Up Missed Orders',        delay: 45000 },
  statsSnapshot:    { fn: taskAutodsStatsSnapshot,     interval: 6 * 60 * 60 * 1000,  name: 'AutoDS Stats Snapshot',         delay: 180000 },
  dbCleanup:        { fn: taskDbCleanup,               interval: 24 * 60 * 60 * 1000, name: 'DB Cleanup',                    delay: 300000 }
};

const runningIntervals = {};

// ---- START ALL CRON JOBS ----
function startCronJobs() {
  if (cronStarted) {
    logger.warn('cron', 'Cron jobs already started — skipping');
    return;
  }
  cronStarted = true;

  logger.info('cron', '═══ Starting scheduled tasks ═══');

  for (const [key, config] of Object.entries(CRON_SCHEDULE)) {
    const { fn, interval, name, delay } = config;
    const intervalMin = Math.round(interval / 60000);

    // Initial run after delay
    const initialTimer = setTimeout(async () => {
      logger.info('cron', `[${name}] Initial run`);
      try {
        await fn();
      } catch (e) {
        logger.error('cron', `[${name}] Initial run failed: ${e.message}`);
      }

      // Then run on interval
      runningIntervals[key] = setInterval(async () => {
        logger.info('cron', `[${name}] Scheduled run`);
        try {
          await fn();
        } catch (e) {
          logger.error('cron', `[${name}] Scheduled run failed: ${e.message}`);
        }
      }, interval);

      logger.info('cron', `[${name}] Scheduled every ${intervalMin} min`);
    }, delay);

    runningIntervals[`${key}_init`] = initialTimer;
    logger.info('cron', `  ✓ ${name} — every ${intervalMin}min (first run in ${Math.round(delay / 1000)}s)`);
  }

  logger.info('cron', `═══ ${Object.keys(CRON_SCHEDULE).length} tasks scheduled ═══`);
}

// ---- STOP ALL CRON JOBS ----
function stopCronJobs() {
  for (const [key, timer] of Object.entries(runningIntervals)) {
    clearInterval(timer);
    clearTimeout(timer);
    delete runningIntervals[key];
  }
  cronStarted = false;
  logger.info('cron', 'All cron jobs stopped');
}

// ---- RUN A SPECIFIC TASK ON DEMAND ----
async function runTask(taskName) {
  const config = CRON_SCHEDULE[taskName];
  if (!config) {
    throw new Error(`Unknown task: ${taskName}. Available: ${Object.keys(CRON_SCHEDULE).join(', ')}`);
  }
  logger.info('cron', `[${config.name}] Manual run triggered`);
  await config.fn();
  return logTask(config.name, 'manual', 'Triggered via API');
}

// ---- GET CRON STATUS ----
function getCronStatus() {
  return {
    started: cronStarted,
    tasks: Object.entries(CRON_SCHEDULE).map(([key, config]) => ({
      key,
      name: config.name,
      intervalMin: Math.round(config.interval / 60000),
      running: !!runningIntervals[key]
    })),
    recentHistory: taskHistory.slice(0, 50),
    timestamp: new Date().toISOString()
  };
}

module.exports = {
  startCronJobs,
  stopCronJobs,
  runTask,
  getCronStatus,
  taskHistory,
  // Export individual tasks for testing
  taskSyncMappingsToAutods,
  taskSourceHealthCheck,
  taskReprocessStaleOrders,
  taskCatchUpMissedOrders,
  taskAutodsStatsSnapshot,
  taskDbCleanup
};
