// ============================================================
// StyleHub Plus — Subscription Webhooks (Seal Subscriptions)
// ============================================================
// Handles: subscription-created, subscription-cancelled,
//          subscription-failed, subscription-renewed
// Updates Shopify customer tags + metafields for Plus status
// Seal webhook topics registered via Merchant API:
//   - subscription/created  → /webhooks/subscription-created
//   - subscription/cancelled → /webhooks/subscription-cancelled
//   - billing_attempt/failed → /webhooks/subscription-failed
//   - billing_attempt/succeeded → /webhooks/subscription-renewed
// ============================================================

const crypto = require('crypto');
const { shopifyAdmin } = require('./shopify-admin');
const { db, save } = require('./data');
const logger = require('./utils/logger');

// Seal API credentials
const SEAL_API_TOKEN = process.env.SEAL_API_TOKEN || '';
const SEAL_API_SECRET = process.env.SEAL_API_SECRET || '';

/**
 * Verify Seal webhook HMAC signature
 * Seal sends X-Seal-Hmac-Sha256 header for webhook verification
 */
function verifySealHmac(req) {
  const hmac = req.headers['x-seal-hmac-sha256'];
  if (!hmac || !SEAL_API_SECRET || !req.rawBody) return true; // Skip if not configured
  try {
    const hash = crypto.createHmac('sha256', SEAL_API_SECRET)
      .update(req.rawBody, 'utf8').digest('base64');
    return crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(hash));
  } catch (e) {
    logger.warn('plus', `Seal HMAC verification error: ${e.message}`);
    return false;
  }
}

function setupSubscriptionWebhooks(app) {

  // ── SUBSCRIPTION CREATED (customer subscribes to Plus) ──
  app.post('/webhooks/subscription-created', async (req, res) => {
    try {
      if (!verifySealHmac(req)) {
        logger.warn('plus', 'Seal HMAC verification failed for subscription-created');
      }

      const data = req.body;
      const customerId = data.customer?.id || data.customer_id;
      const email = data.customer?.email || data.email;

      logger.info('plus', `Subscription created for customer ${customerId} (${email})`);

      // Track in local DB
      if (!db.plusMembers) db.plusMembers = {};
      db.plusMembers[customerId || email] = {
        customerId,
        email,
        status: 'active',
        subscribedAt: new Date().toISOString(),
        cancelledAt: null,
        sealSubscriptionId: data.id || data.subscription_id || null,
        plan: '$7.99/mo',
        source: 'seal'
      };
      save('plusMembers');

      // Log activity
      if (!db.activity) db.activity = [];
      db.activity.unshift({
        type: 'plus_subscribed',
        customerId,
        email,
        message: `⚡ ${email || customerId} subscribed to Plus`,
        at: new Date().toISOString()
      });
      if (db.activity.length > 500) db.activity = db.activity.slice(0, 500);
      save('activity');

      if (customerId) {
        // Add "plus" tag to customer in Shopify
        const tags = await getUpdatedTags(customerId, 'plus', 'add');
        await shopifyAdmin('PUT', `/customers/${customerId}.json`, {
          customer: { id: customerId, tags }
        });

        // Set metafield: plus_active = true
        await shopifyAdmin('POST', `/customers/${customerId}/metafields.json`, {
          metafield: {
            namespace: 'stylehub',
            key: 'plus_active',
            value: 'true',
            type: 'single_line_text_field'
          }
        });

        // Set metafield: plus_since
        await shopifyAdmin('POST', `/customers/${customerId}/metafields.json`, {
          metafield: {
            namespace: 'stylehub',
            key: 'plus_since',
            value: new Date().toISOString(),
            type: 'single_line_text_field'
          }
        });

        logger.info('plus', `Customer ${customerId} tagged as Plus in Shopify`);
      }

      res.status(200).json({ ok: true });
    } catch (err) {
      logger.error('plus', `Error processing subscription-created: ${err.message}`);
      res.status(200).json({ ok: false, error: err.message });
    }
  });

  // ── SUBSCRIPTION CANCELLED ──
  app.post('/webhooks/subscription-cancelled', async (req, res) => {
    try {
      if (!verifySealHmac(req)) {
        logger.warn('plus', 'Seal HMAC verification failed for subscription-cancelled');
      }

      const data = req.body;
      const customerId = data.customer?.id || data.customer_id;
      const email = data.customer?.email || data.email;

      logger.info('plus', `Subscription cancelled for customer ${customerId} (${email})`);

      // Update local DB
      if (!db.plusMembers) db.plusMembers = {};
      const key = customerId || email;
      if (db.plusMembers[key]) {
        db.plusMembers[key].status = 'cancelled';
        db.plusMembers[key].cancelledAt = new Date().toISOString();
      }
      save('plusMembers');

      // Log activity
      if (!db.activity) db.activity = [];
      db.activity.unshift({
        type: 'plus_cancelled',
        customerId,
        email,
        message: `⚡ ${email || customerId} cancelled Plus`,
        at: new Date().toISOString()
      });
      save('activity');

      if (customerId) {
        // Remove "plus" tag
        const tags = await getUpdatedTags(customerId, 'plus', 'remove');
        await shopifyAdmin('PUT', `/customers/${customerId}.json`, {
          customer: { id: customerId, tags }
        });

        // Update metafield: plus_active = false
        await shopifyAdmin('POST', `/customers/${customerId}/metafields.json`, {
          metafield: {
            namespace: 'stylehub',
            key: 'plus_active',
            value: 'false',
            type: 'single_line_text_field'
          }
        });

        logger.info('plus', `Customer ${customerId} Plus tag removed from Shopify`);
      }

      res.status(200).json({ ok: true });
    } catch (err) {
      logger.error('plus', `Error processing subscription-cancelled: ${err.message}`);
      res.status(200).json({ ok: false, error: err.message });
    }
  });

  // ── PAYMENT FAILED ──
  app.post('/webhooks/subscription-failed', async (req, res) => {
    try {
      if (!verifySealHmac(req)) {
        logger.warn('plus', 'Seal HMAC verification failed for subscription-failed');
      }

      const data = req.body;
      const customerId = data.customer?.id || data.customer_id;
      const email = data.customer?.email || data.email;

      logger.info('plus', `Payment failed for customer ${customerId} (${email})`);

      // Log activity but don't remove tag yet — Seal will retry
      if (!db.activity) db.activity = [];
      db.activity.unshift({
        type: 'plus_payment_failed',
        customerId,
        email,
        message: `⚠️ Plus payment failed for ${email || customerId}`,
        at: new Date().toISOString()
      });
      save('activity');

      res.status(200).json({ ok: true });
    } catch (err) {
      logger.error('plus', `Error processing subscription-failed: ${err.message}`);
      res.status(200).json({ ok: false });
    }
  });

  // ── SUBSCRIPTION RENEWED (billing succeeded) ──
  app.post('/webhooks/subscription-renewed', async (req, res) => {
    try {
      if (!verifySealHmac(req)) {
        logger.warn('plus', 'Seal HMAC verification failed for subscription-renewed');
      }

      const data = req.body;
      const customerId = data.customer?.id || data.customer_id;
      const email = data.customer?.email || data.email;

      logger.info('plus', `Subscription renewed for customer ${customerId} (${email})`);

      // Update local DB — ensure status is active after successful renewal
      if (!db.plusMembers) db.plusMembers = {};
      const key = customerId || email;
      if (db.plusMembers[key]) {
        db.plusMembers[key].status = 'active';
        db.plusMembers[key].lastRenewedAt = new Date().toISOString();
      }
      save('plusMembers');

      // Log activity
      if (!db.activity) db.activity = [];
      db.activity.unshift({
        type: 'plus_renewed',
        customerId,
        email,
        message: `🔄 Plus renewed for ${email || customerId}`,
        at: new Date().toISOString()
      });
      if (db.activity.length > 500) db.activity = db.activity.slice(0, 500);
      save('activity');

      res.status(200).json({ ok: true });
    } catch (err) {
      logger.error('plus', `Error processing subscription-renewed: ${err.message}`);
      res.status(200).json({ ok: false });
    }
  });

  // ── PLUS STATUS CHECK (for frontend auth) ──
  app.get('/api/plus-status', async (req, res) => {
    try {
      const { email, customerId } = req.query;
      if (!email && !customerId) {
        return res.json({ isPlus: false, reason: 'no identifier' });
      }

      // Check local DB first (fast)
      if (db.plusMembers) {
        const key = customerId || email;
        const member = db.plusMembers[key] ||
          Object.values(db.plusMembers).find(m => m.email === email);
        if (member && member.status === 'active') {
          return res.json({
            isPlus: true,
            since: member.subscribedAt,
            plan: member.plan
          });
        }
      }

      // Fallback: check Shopify customer tags
      if (customerId) {
        try {
          const data = await shopifyAdmin('GET', `/customers/${customerId}.json`);
          const tags = (data.customer?.tags || '').split(',').map(t => t.trim());
          if (tags.includes('plus')) {
            return res.json({ isPlus: true, source: 'shopify_tag' });
          }
        } catch (e) { /* ignore */ }
      }

      res.json({ isPlus: false });
    } catch (err) {
      res.json({ isPlus: false, error: err.message });
    }
  });

  logger.info('plus', 'Subscription webhooks + Plus status API initialized');
}

// ── Helper: get customer tags, add or remove one ──
async function getUpdatedTags(customerId, tag, action) {
  try {
    const response = await shopifyAdmin('GET', `/customers/${customerId}.json`);
    const currentTags = (response.customer?.tags || '')
      .split(',')
      .map(t => t.trim())
      .filter(Boolean);

    if (action === 'add' && !currentTags.includes(tag)) {
      currentTags.push(tag);
    } else if (action === 'remove') {
      const idx = currentTags.indexOf(tag);
      if (idx > -1) currentTags.splice(idx, 1);
    }

    return currentTags.join(', ');
  } catch (err) {
    return action === 'add' ? tag : '';
  }
}

module.exports = { setupSubscriptionWebhooks };
