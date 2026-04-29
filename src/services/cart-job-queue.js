// ──────────────────────────────────────────────────────────────────────
// Cart Job Queue — in-memory async tracker for prepare-cart wizard jobs
// ──────────────────────────────────────────────────────────────────────
// Tracks the lifecycle of an async wizard call so the frontend can poll.
//
// Job lifecycle:
//   pending  → wizard call in progress
//   ready    → wizard succeeded OR fallback Admin API succeeded — has shopifyVariantId
//   failed   → both wizard and fallback failed — frontend should show error
//
// Dedup: jobs are keyed by `${source}:${sourceId}`. Concurrent requests
// for the same ASIN reuse the same job (no duplicate wizard calls).
//
// Persistence: in-memory only (Map). On backend restart, jobs are lost
// but the bridge call still completes on Edgar's PC. Customer's next
// request for the same ASIN will find the product via DB mapping.
// ──────────────────────────────────────────────────────────────────────

const crypto = require('crypto');

const TTL_MS = parseInt(process.env.CART_JOB_TTL_MS || String(30 * 60 * 1000), 10);   // 30 min
const GC_INTERVAL_MS = 5 * 60 * 1000;                                                  // 5 min

const _jobs = new Map();        // jobId → job
const _jobsByAsin = new Map();  // `${source}:${sourceId}` → jobId

function _makeJobId() {
  return 'wj_' + crypto.randomBytes(8).toString('hex');
}

/**
 * Get an existing live job for source+sourceId, or null.
 * "Live" = pending or ready (within TTL).
 */
function findLiveJob(source, sourceId) {
  const key = `${source}:${sourceId}`;
  const jobId = _jobsByAsin.get(key);
  if (!jobId) return null;
  const job = _jobs.get(jobId);
  if (!job) {
    _jobsByAsin.delete(key);
    return null;
  }
  if ((Date.now() - job.startedAt) > TTL_MS) {
    _jobs.delete(jobId);
    _jobsByAsin.delete(key);
    return null;
  }
  // Failed jobs older than 30s are not reusable — let the new request retry
  if (job.status === 'failed' && (Date.now() - (job.completedAt || job.startedAt)) > 30000) {
    _jobs.delete(jobId);
    _jobsByAsin.delete(key);
    return null;
  }
  return job;
}

/**
 * Create a new job. Caller must check findLiveJob first.
 */
function createJob({ source, sourceId, productPreview = {} }) {
  const jobId = _makeJobId();
  const job = {
    jobId,
    status: 'pending',
    source,
    sourceId,
    productPreview: {
      title: productPreview.title || null,
      image: productPreview.image || null,
      price: productPreview.price || null,
      handle: productPreview.handle || null
    },
    result: null,        // when ready: { shopifyProductId, shopifyVariantId, handle, autoFulfill, ... }
    error: null,         // when failed: string
    autoFulfill: false,  // true if wizard path succeeded; false if Admin API fallback
    startedAt: Date.now(),
    completedAt: null
  };
  _jobs.set(jobId, job);
  _jobsByAsin.set(`${source}:${sourceId}`, jobId);
  return job;
}

function getJob(jobId) {
  return _jobs.get(jobId) || null;
}

/**
 * Apply a partial update. Sets completedAt automatically when reaching ready/failed.
 */
function updateJob(jobId, patch) {
  const job = _jobs.get(jobId);
  if (!job) return null;
  Object.assign(job, patch);
  if ((patch.status === 'ready' || patch.status === 'failed') && !job.completedAt) {
    job.completedAt = Date.now();
  }
  return job;
}

/**
 * Public-safe view of the job (no internals leaked).
 */
function publicView(job) {
  if (!job) return null;
  return {
    jobId: job.jobId,
    status: job.status,
    source: job.source,
    sourceId: job.sourceId,
    productPreview: job.productPreview,
    result: job.status === 'ready' ? job.result : null,
    error: job.status === 'failed' ? job.error : null,
    autoFulfill: job.autoFulfill,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    elapsedMs: Date.now() - job.startedAt
  };
}

function listAll() {
  return Array.from(_jobs.values()).map(publicView);
}

// ─── Periodic garbage collection ───
setInterval(() => {
  const now = Date.now();
  let pruned = 0;
  for (const [jobId, job] of _jobs) {
    if ((now - job.startedAt) > TTL_MS) {
      _jobs.delete(jobId);
      _jobsByAsin.delete(`${job.source}:${job.sourceId}`);
      pruned++;
    }
  }
  if (pruned > 0) {
    // eslint-disable-next-line no-console
    console.log(`[cart-job-queue] GC pruned ${pruned} stale jobs (live=${_jobs.size})`);
  }
}, GC_INTERVAL_MS).unref?.();

module.exports = {
  findLiveJob,
  createJob,
  getJob,
  updateJob,
  publicView,
  listAll
};
