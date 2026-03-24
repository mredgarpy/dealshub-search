// ============================================================
// StyleHub CRM — Webhooks (Persistent to disk)
// ============================================================
const crypto = require('crypto');
const { db, save } = require('./data');
const { shopifyAdmin } = require('./shopify-admin');
const logger = require('./utils/logger');

const PLUS_PRODUCT_ID = 8982486155395;

function verifyHmac(req) {
  const hmac = req.headers['x-shopify-hmac-sha256'];
  const secret = process.env.SHOPIFY_WEBHOOK_SECRET || process.env.SHOPIFY_CLIENT_SECRET;
  if (!hmac || !secret || !req.rawBody) return true; // Skip if not configured
  const hash = crypto.createHmac('sha256', secret)
    .update(req.rawBody, 'utf8').digest('base64');
  try {
    return crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(hash));
  } catch (e) {
    return false;
  }
}

function detectSource(items) {
  if (!items || !items.length) return 'unknown';
  const vendors = items.map(i => (i.vendor || '').toLowerCase());
  if (vendors.some(v => v.includes('amazon'))) return 'amazon';
  if (vendors.some(v => v.includes('aliexpress'))) return 'aliexpress';
  if (vendors.some(v => v.includes('sephora'))) return 'sephora';
  if (vendors.some(v => v.includes('macy'))) return 'macys';
  if (vendors.some(v => v.includes('shein'))) return 'shein';
  return 'unknown';
}

function needsManual(items) {
  if (!items || !items.length) return false;
  const manualSources = ['sephora', 'macys', 'shein'];
  return items.some(i => manualSources.some(s => (i.vendor || '').toLowerCase().includes(s)));
}

function setupWebhooks(app) {

  // ── ORDER CREATED ──
  app.post('/webhooks/order-created', (req, res) => {
    try {
      if (!verifyHmac(req)) {
        logger.warn('webhook', 'HMAC verification failed for order-created');
      }

      const o = req.body;
      if (!o || !o.id) return res.sendStatus(400);

      const cost = (o.line_items || []).reduce((s, i) =>
        s + (parseFloat(i.price) * (i.quantity || 1) * 0.60), 0);

      db.orders[o.id] = {
        id: o.id,
        shopifyId: o.id,
        number: o.name || '#' + o.order_number,
        email: o.customer?.email || o.email || '',
        customerName: ((o.customer?.first_name || '') + ' ' + (o.customer?.last_name || '')).trim(),
        customerId: o.customer?.id,
        total: parseFloat(o.total_price || 0),
        subtotal: parseFloat(o.subtotal_price || 0),
        tax: parseFloat(o.total_tax || 0),
        currency: o.currency || 'USD',
        financialStatus: o.financial_status || 'pending',
        fulfillmentStatus: o.fulfillment_status || null,
        items: (o.line_items || []).map(i => ({
          id: i.id,
          title: i.title,
          variant: i.variant_title,
          price: parseFloat(i.price),
          quantity: i.quantity || 1,
          image: i.image?.src || null,
          vendor: i.vendor || 'Unknown',
          sku: i.sku,
          productId: i.product_id
        })),
        shippingAddress: o.shipping_address || null,
        estimatedCost: Math.round(cost * 100) / 100,
        estimatedProfit: Math.round((parseFloat(o.total_price || 0) - cost) * 100) / 100,
        tracking: null,
        trackingUrl: null,
        trackingCompany: null,
        fulfilledAt: null,
        cancelledAt: null,
        refundAmount: 0,
        returnId: null,
        source: detectSource(o.line_items),
        requiresManual: needsManual(o.line_items),
        notes: '',
        createdAt: o.created_at || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        events: [{ type: 'created', at: o.created_at || new Date().toISOString() }]
      };

      save('orders');
      logger.info('webhook', `[CRM] Order created: ${db.orders[o.id].number} - $${o.total_price} - ${(o.line_items || []).length} items`);

      // ── AUTO-DETECT PLUS MEMBERSHIP PURCHASE ──
      const plusItem = (o.line_items || []).find(i =>
        i.product_id === PLUS_PRODUCT_ID || i.product_id === String(PLUS_PRODUCT_ID)
      );
      if (plusItem && o.customer?.id) {
        const custId = o.customer.id;
        const custEmail = o.customer.email || o.email || '';
        logger.info('plus', `[AUTO] Plus membership purchased by ${custEmail} (order ${o.name})`);

        // Tag customer as Plus in Shopify
        (async () => {
          try {
            const resp = await shopifyAdmin('GET', `/customers/${custId}.json`);
            const currentTags = (resp.customer?.tags || '').split(',').map(t => t.trim()).filter(Boolean);
            if (!currentTags.includes('plus')) {
              currentTags.push('plus');
              await shopifyAdmin('PUT', `/customers/${custId}.json`, {
                customer: { id: custId, tags: currentTags.join(', ') }
              });
            }
            // Set metafields
            await shopifyAdmin('POST', `/customers/${custId}/metafields.json`, {
              metafield: { namespace: 'stylehub', key: 'plus_active', value: 'true', type: 'single_line_text_field' }
            });
            await shopifyAdmin('POST', `/customers/${custId}/metafields.json`, {
              metafield: { namespace: 'stylehub', key: 'plus_since', value: new Date().toISOString(), type: 'single_line_text_field' }
            });

            // Track in local DB
            if (!db.plusMembers) db.plusMembers = {};
            db.plusMembers[custId] = {
              customerId: custId, email: custEmail, status: 'active',
              subscribedAt: new Date().toISOString(), cancelledAt: null,
              plan: '$7.99/mo', source: 'order_webhook'
            };
            save('plusMembers');

            if (!db.activity) db.activity = [];
            db.activity.unshift({
              type: 'plus_subscribed', customerId: custId, email: custEmail,
              message: `⚡ ${custEmail} subscribed to Plus (order ${o.name})`,
              at: new Date().toISOString()
            });
            if (db.activity.length > 500) db.activity = db.activity.slice(0, 500);
            save('activity');

            logger.info('plus', `[AUTO] Customer ${custId} tagged as Plus`);
          } catch (err) {
            logger.error('plus', `[AUTO] Failed to tag Plus: ${err.message}`);
          }
        })();
      }

      res.sendStatus(200);
    } catch (err) {
      logger.error('webhook', 'Error in order-created', { error: err.message });
      res.sendStatus(200); // Always 200 to prevent Shopify retries
    }
  });

  // ── ORDER FULFILLED ──
  app.post('/webhooks/order-fulfilled', (req, res) => {
    try {
      if (!verifyHmac(req)) {
        logger.warn('webhook', 'HMAC verification failed for order-fulfilled');
      }

      const o = req.body;
      if (!o || !o.id) return res.sendStatus(200);

      if (db.orders[o.id]) {
        const ord = db.orders[o.id];
        ord.fulfillmentStatus = 'fulfilled';
        ord.fulfilledAt = new Date().toISOString();
        ord.updatedAt = new Date().toISOString();

        if (o.fulfillments && o.fulfillments.length) {
          const f = o.fulfillments[o.fulfillments.length - 1];
          ord.tracking = f.tracking_number || null;
          ord.trackingUrl = f.tracking_url || null;
          ord.trackingCompany = f.tracking_company || null;
        }
        ord.events.push({
          type: 'fulfilled',
          tracking: ord.tracking,
          carrier: ord.trackingCompany,
          at: new Date().toISOString()
        });
        save('orders');
      }

      logger.info('webhook', `[CRM] Order fulfilled: ${o.name || o.id}`);
      res.sendStatus(200);
    } catch (err) {
      logger.error('webhook', 'Error in order-fulfilled', { error: err.message });
      res.sendStatus(200);
    }
  });

  // ── ORDER CANCELLED ──
  app.post('/webhooks/order-cancelled', (req, res) => {
    try {
      if (!verifyHmac(req)) {
        logger.warn('webhook', 'HMAC verification failed for order-cancelled');
      }

      const o = req.body;
      if (!o || !o.id) return res.sendStatus(200);

      if (db.orders[o.id]) {
        db.orders[o.id].financialStatus = 'cancelled';
        db.orders[o.id].cancelledAt = o.cancelled_at || new Date().toISOString();
        db.orders[o.id].updatedAt = new Date().toISOString();
        db.orders[o.id].events.push({
          type: 'cancelled',
          reason: o.cancel_reason,
          at: new Date().toISOString()
        });
        save('orders');
      }

      logger.info('webhook', `[CRM] Order cancelled: ${o.name || o.id}`);
      res.sendStatus(200);
    } catch (err) {
      logger.error('webhook', 'Error in order-cancelled', { error: err.message });
      res.sendStatus(200);
    }
  });

  // ── REFUND CREATED ──
  app.post('/webhooks/refund-created', (req, res) => {
    try {
      if (!verifyHmac(req)) {
        logger.warn('webhook', 'HMAC verification failed for refund-created');
      }

      const r = req.body;
      const oid = r?.order_id;
      if (!oid) return res.sendStatus(200);

      if (db.orders[oid]) {
        const amt = (r.refund_line_items || []).reduce((s, i) => s + parseFloat(i.subtotal || 0), 0)
          + (r.transactions || []).reduce((s, t) => s + parseFloat(t.amount || 0), 0);
        const refAmt = amt > 0 ? amt : 0;
        db.orders[oid].refundAmount = (db.orders[oid].refundAmount || 0) + refAmt;
        db.orders[oid].financialStatus = 'refunded';
        db.orders[oid].updatedAt = new Date().toISOString();
        db.orders[oid].events.push({
          type: 'refunded',
          amount: refAmt,
          refundId: r.id,
          at: new Date().toISOString()
        });
        save('orders');
      }

      logger.info('webhook', `[CRM] Refund for order: ${oid}`);
      res.sendStatus(200);
    } catch (err) {
      logger.error('webhook', 'Error in refund-created', { error: err.message });
      res.sendStatus(200);
    }
  });
}

module.exports = { setupWebhooks };
