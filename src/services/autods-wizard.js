// ──────────────────────────────────────────────────────────────────────
// AutoDS Bridge Wizard Client
// ──────────────────────────────────────────────────────────────────────
// HTTP client for the AutoDS Local Bridge `/add-product-wizard` endpoint
// running on Edgar's PC and exposed via Cloudflare Tunnel.
//
// The wizard automates AutoDS Single Product UI flow to create a Shopify
// product that is already Connected in AutoDS, so Orders Processor will
// auto-fulfill. End-to-end takes ~3-4 minutes per ASIN.
//
// Required env vars:
//   AUTODS_BRIDGE_URL      e.g. https://xxx.trycloudflare.com
//   AUTODS_BRIDGE_TOKEN    must match BRIDGE_TOKEN in the bridge
//
// Optional:
//   AUTODS_BRIDGE_WIZARD_TIMEOUT_MS  default 280000 (4:40, gives headroom over bridge's internal 240s)
// ──────────────────────────────────────────────────────────────────────

const fetch = require('node-fetch');

const DEFAULT_TIMEOUT_MS = parseInt(
  process.env.AUTODS_BRIDGE_WIZARD_TIMEOUT_MS || '280000',
  10
);

/**
 * Call AutoDS Bridge `/add-product-wizard`.
 *
 * @param {Object} opts
 * @param {string} opts.source     'amazon' | 'aliexpress' | 'macys' | 'sephora' | 'shein'
 * @param {string} opts.sourceId   ASIN / item id
 * @param {string} [opts.sourceUrl] full URL (preferred — bridge uses it verbatim)
 * @param {string} [opts.smid]     Amazon seller id (when known) — fills ?smid=
 * @returns {Promise<{
 *   ok: boolean,
 *   httpStatus: number,
 *   shopifyProductId?: string,
 *   autodsImportJobId?: string,
 *   detailsStatus?: string,
 *   bannerStatus?: string,
 *   reason?: string
 * }>}
 */
async function callWizard({ source, sourceId, sourceUrl, smid } = {}) {
  const bridgeUrl = process.env.AUTODS_BRIDGE_URL;
  const bridgeToken = process.env.AUTODS_BRIDGE_TOKEN || 'dev-token-change-me-in-production';

  if (!bridgeUrl) {
    return { ok: false, reason: 'AUTODS_BRIDGE_URL not configured', httpStatus: 0 };
  }
  if (!source || !sourceId) {
    return { ok: false, reason: 'source and sourceId required', httpStatus: 0 };
  }

  const url = bridgeUrl.replace(/\/$/, '') + '/add-product-wizard';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), DEFAULT_TIMEOUT_MS);

  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Bridge-Token': bridgeToken
      },
      body: JSON.stringify({ source, sourceId, sourceUrl, smid }),
      signal: ctrl.signal
    });
    const body = await r.json().catch(() => ({}));
    return { httpStatus: r.status, ok: !!body.ok, ...body };
  } catch (e) {
    return {
      ok: false,
      reason: e.name === 'AbortError'
        ? `bridge wizard timeout after ${DEFAULT_TIMEOUT_MS}ms`
        : `bridge call failed: ${e.message}`,
      httpStatus: 0
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Health check — does the bridge respond at all?
 * Used by /api/admin/bridge-health and worker pre-flight.
 */
async function checkBridgeHealth(timeoutMs = 10000) {
  const bridgeUrl = process.env.AUTODS_BRIDGE_URL;
  if (!bridgeUrl) return { ok: false, reason: 'AUTODS_BRIDGE_URL not configured' };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(bridgeUrl.replace(/\/$/, '') + '/health', { signal: ctrl.signal });
    const body = await r.json().catch(() => ({}));
    return { ok: r.ok, httpStatus: r.status, ...body };
  } catch (e) {
    return { ok: false, reason: e.message };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { callWizard, checkBridgeHealth };
