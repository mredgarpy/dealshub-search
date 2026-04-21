// ============================================================
// StyleHub — AutoDS Order Email (CSV per Shopify order)
// ============================================================
// When a Shopify order comes in, we generate a small CSV with
// the source products of that order and email it to the ops
// inbox. The operator uploads the CSV to AutoDS (bulk import
// products), which links them to their suppliers. Once linked,
// AutoDS picks up the Shopify order via its native Shopify
// connection and triggers the automatic purchase at the supplier.
//
// This is a stop-gap until we unlock AutoDS's API (paid tier)
// or implement Playwright-based CSV upload automation.
// ============================================================

const logger = require('../utils/logger');
const { sendMail } = require('./mailer');
const {
  extractSourceInfo,
  buildSourceUrl,
  AUTODS_SUPPLIER_MAP
} = require('./autods');
const { getDb } = require('../utils/db');

const CSV_RECIPIENT = () => process.env.AUTODS_CSV_EMAIL_TO || 'commercecargollc@gmail.com';
const WAREHOUSE_REGION = () => process.env.AUTODS_WAREHOUSE_REGION || 'US';

// ---- CSV ESCAPING ----
function csvEscape(value) {
  if (value == null) return '';
  const s = String(value);
  // If contains comma, quote, or newline — wrap in quotes and escape inner quotes.
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

// ---- BUILD CSV ROWS FROM AN ORDER ----
/**
 * Returns { csv, rows, unmapped } for a Shopify order payload.
 *
 * CSV schema — AutoDS Bulk Import format (official):
 *   BuyId — Variant-specific supplier URL (sku_id / skuId / child ASIN embedded)
 *           or supplier product ID. THIS IS THE ONLY REQUIRED COLUMN; AutoDS
 *           rejects the whole upload if this header is missing/misnamed.
 *   Title — Optional product title; helps AutoDS display the correct name
 *           after import instead of the default scraped one.
 *
 * We keep the attachment minimal because AutoDS's CSV parser is strict:
 * unknown columns in prior tests caused silent rejection. All the richer
 * per-line context (quantity, variant SKU, variant title, order ref) still
 * lives in `rowObjects` and renders in the HTML body of the email for the
 * operator, but does NOT go into the CSV.
 *
 * @returns {{
 *   csv: string,
 *   rows: Array<{sourceUrl, supplier, region, quantity, variantSku, variantTitle,
 *                title, sku, lineItemId, source, sourceId, sourceVariantId, method}>,
 *   unmapped: Array<{lineItemId, productId, title, sku, variantTitle, quantity}>
 * }}
 */
function buildOrderCsv(order) {
  const db = getDb();
  const lineItems = order.line_items || [];

  // AutoDS official header — MUST be "BuyId" for the upload to be recognized.
  const header = 'BuyId,Title';
  const rows = [];
  const rowObjects = [];
  const unmapped = [];

  const orderRef = order.name || `#${order.order_number || order.id}`;

  for (const item of lineItems) {
    const info = extractSourceInfo(item, db);
    if (!info) {
      unmapped.push({
        lineItemId: item.id,
        productId: item.product_id,
        title: item.title,
        sku: item.sku || '',
        variantTitle: item.variant_title && item.variant_title !== 'Default Title'
          ? item.variant_title : '',
        quantity: item.quantity || 1
      });
      continue;
    }

    const supplier = AUTODS_SUPPLIER_MAP[info.source.toLowerCase()] || info.source;
    // info.buyId is already variant-aware (built via buildSourceUrl with variantId).
    // The fallback chain here only fires if extractSourceInfo returned partial data.
    const url = info.buyId
      || info.sourceUrl
      || buildSourceUrl(info.source, info.sourceId, null, info.sourceVariantId);
    const region = WAREHOUSE_REGION();
    const qty = item.quantity || 1;
    const variantSku = info.shopifySku || item.sku || '';
    const variantTitle = info.variantTitle || '—';

    // CSV: only BuyId + Title (AutoDS strict schema).
    // Title append variant for disambiguation when available.
    const csvTitle = (variantTitle && variantTitle !== '—')
      ? `${item.title || ''} (${variantTitle})`
      : (item.title || '');

    rows.push([url, csvTitle]
      .map(csvEscape)
      .join(','));

    // rowObjects: full context for the HTML email body (NOT for the CSV).
    rowObjects.push({
      sourceUrl: url,
      supplier,
      region,
      quantity: qty,
      variantSku,
      variantTitle,
      title: item.title,
      sku: item.sku || '',
      lineItemId: item.id,
      source: info.source,
      sourceId: info.sourceId,
      sourceVariantId: info.sourceVariantId,
      method: info.method
    });
  }

  const csv = [header, ...rows].join('\n');
  return { csv, rows: rowObjects, unmapped };
}

// ---- BUILD HTML BODY FOR THE EMAIL ----
function buildHtmlBody(order, rows, unmapped) {
  const orderRef = order.name || `#${order.order_number || order.id}`;
  const customer = order.customer || {};
  const customerName = `${customer.first_name || ''} ${customer.last_name || ''}`.trim() || '—';
  const customerEmail = customer.email || order.email || '—';
  const ship = order.shipping_address || {};
  const total = order.total_price || '0.00';
  const currency = order.currency || 'USD';

  const shippingLines = [
    ship.name,
    ship.address1,
    ship.address2,
    [ship.city, ship.province_code, ship.zip].filter(Boolean).join(', '),
    ship.country
  ].filter(Boolean);

  const styleTd = 'padding:8px 12px;border-bottom:1px solid #eee;font-size:14px;color:#222;vertical-align:top;';
  const styleTh = 'padding:10px 12px;background:#f7f7f9;text-align:left;font-size:12px;color:#555;text-transform:uppercase;letter-spacing:0.5px;border-bottom:2px solid #e4e4e7;';

  const rowsHtml = rows.map(r => {
    const variantBadge = (r.variantTitle && r.variantTitle !== '—')
      ? `<div style="margin-top:4px;display:inline-block;padding:2px 8px;background:#eef2ff;color:#3730a3;border-radius:4px;font-size:11px;font-weight:600;">${escapeHtml(r.variantTitle)}</div>`
      : '';
    return `
    <tr>
      <td style="${styleTd}">${r.supplier}</td>
      <td style="${styleTd}">
        <a href="${r.sourceUrl}" style="color:#d8232a;word-break:break-all;">${r.sourceUrl}</a>
        ${variantBadge}
      </td>
      <td style="${styleTd}">${r.quantity}</td>
      <td style="${styleTd}">
        ${escapeHtml(r.title || '')}
        ${r.variantSku ? `<div style="margin-top:4px;color:#6b7280;font-size:11px;font-family:ui-monospace,Menlo,monospace;">${escapeHtml(r.variantSku)}</div>` : ''}
      </td>
    </tr>
  `;
  }).join('');

  const unmappedHtml = unmapped.length ? `
    <h3 style="font-family:system-ui,sans-serif;color:#b91c1c;margin:24px 0 8px;">⚠ ${unmapped.length} item(s) without source mapping</h3>
    <p style="font-family:system-ui,sans-serif;color:#555;font-size:14px;margin:0 0 8px;">These line items do not carry source properties. They need manual lookup before uploading to AutoDS.</p>
    <table cellspacing="0" cellpadding="0" style="border-collapse:collapse;width:100%;margin-top:8px;">
      <thead><tr>
        <th style="${styleTh}">Title</th>
        <th style="${styleTh}">SKU</th>
        <th style="${styleTh}">Variant</th>
        <th style="${styleTh}">Qty</th>
      </tr></thead>
      <tbody>
        ${unmapped.map(u => `
          <tr>
            <td style="${styleTd}">${escapeHtml(u.title || '')}</td>
            <td style="${styleTd}">${escapeHtml(u.sku || '—')}</td>
            <td style="${styleTd}">${escapeHtml(u.variantTitle || '—')}</td>
            <td style="${styleTd}">${u.quantity}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  ` : '';

  return `<!DOCTYPE html>
<html><body style="margin:0;padding:24px;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;">
  <div style="max-width:720px;margin:0 auto;background:#fff;border-radius:8px;overflow:hidden;border:1px solid #e4e4e7;">
    <div style="padding:24px;background:#111827;color:#fff;">
      <h1 style="margin:0 0 4px;font-size:20px;">StyleHub — AutoDS CSV for order ${escapeHtml(orderRef)}</h1>
      <p style="margin:0;font-size:13px;color:#a1a1aa;">Upload the attached CSV to AutoDS → Products → Import → CSV. AutoDS will link the products to their suppliers and process the order automatically.</p>
    </div>

    <div style="padding:20px 24px;">
      <h2 style="margin:0 0 12px;font-size:16px;color:#111;">Order summary</h2>
      <table cellspacing="0" cellpadding="0" style="border-collapse:collapse;width:100%;">
        <tr><td style="${styleTd}width:140px;color:#666;">Order</td><td style="${styleTd}"><strong>${escapeHtml(orderRef)}</strong></td></tr>
        <tr><td style="${styleTd}color:#666;">Customer</td><td style="${styleTd}">${escapeHtml(customerName)} &lt;${escapeHtml(customerEmail)}&gt;</td></tr>
        <tr><td style="${styleTd}color:#666;">Total</td><td style="${styleTd}"><strong>${escapeHtml(total)} ${escapeHtml(currency)}</strong></td></tr>
        <tr><td style="${styleTd}color:#666;">Ship to</td><td style="${styleTd}">${shippingLines.map(escapeHtml).join('<br>') || '—'}</td></tr>
        <tr><td style="${styleTd}color:#666;">Line items mapped</td><td style="${styleTd}">${rows.length} / ${rows.length + unmapped.length}</td></tr>
      </table>

      <h2 style="margin:24px 0 8px;font-size:16px;color:#111;">Products to link in AutoDS</h2>
      <table cellspacing="0" cellpadding="0" style="border-collapse:collapse;width:100%;">
        <thead><tr>
          <th style="${styleTh}">Supplier</th>
          <th style="${styleTh}">Product URL</th>
          <th style="${styleTh}">Qty</th>
          <th style="${styleTh}">Title</th>
        </tr></thead>
        <tbody>${rowsHtml || `<tr><td colspan="4" style="${styleTd}color:#999;">(no mapped items — see unmapped list below)</td></tr>`}</tbody>
      </table>

      ${unmappedHtml}

      <div style="margin-top:28px;padding:16px;background:#f9fafb;border:1px solid #e5e7eb;border-radius:6px;font-size:13px;color:#374151;line-height:1.5;">
        <strong>Next steps</strong><br>
        1. Download the attached <code>order-${escapeHtml(orderRef)}.csv</code><br>
        2. Open AutoDS → Products → Import → CSV<br>
        3. Upload the file, confirm supplier matches<br>
        4. AutoDS will auto-trigger the purchase via its Shopify connection
      </div>
    </div>
  </div>
</body></html>`;
}

function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ---- SEND EMAIL WITH CSV ATTACHMENT ----
/**
 * Generate CSV for this order and send it via SMTP to the ops inbox.
 * Returns { ok, reason?, rows, unmapped, messageId? }.
 * Never throws — callers can fire-and-forget.
 */
async function sendAutodsOrderEmail(order, options = {}) {
  try {
    if (!order || !order.id) {
      return { ok: false, reason: 'invalid_order' };
    }

    const orderRef = order.name || `#${order.order_number || order.id}`;
    const { csv, rows, unmapped } = buildOrderCsv(order);

    if (rows.length === 0 && unmapped.length === 0) {
      logger.warn('autods-email', `Order ${orderRef} has no line items — skipping email`);
      return { ok: false, reason: 'empty_order' };
    }

    const filename = `order-${(orderRef || order.id).replace(/[^\w.-]/g, '_')}.csv`;
    const to = options.to || CSV_RECIPIENT();
    const subject = `[StyleHub] AutoDS CSV — Order ${orderRef} (${rows.length} item${rows.length === 1 ? '' : 's'})`;

    const html = buildHtmlBody(order, rows, unmapped);

    const result = await sendMail({
      to,
      subject,
      html,
      text: `Order ${orderRef} — ${rows.length} mapped item(s), ${unmapped.length} unmapped.\nCSV attached. Upload to AutoDS → Products → Import.`,
      attachments: [{
        filename,
        content: csv,
        contentType: 'text/csv; charset=utf-8'
      }]
    });

    logger.info('autods-email', `Order ${orderRef} → email result`, {
      ok: result.ok,
      reason: result.reason,
      rowsMapped: rows.length,
      unmapped: unmapped.length,
      to
    });

    return { ...result, rows, unmapped };
  } catch (e) {
    logger.error('autods-email', `Failed to send order email: ${e.message}`);
    return { ok: false, reason: 'exception', error: e.message };
  }
}

module.exports = {
  sendAutodsOrderEmail,
  buildOrderCsv,
  buildHtmlBody
};
