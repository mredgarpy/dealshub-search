// ============================================================
// StyleHub CRM — API Endpoints (Admin + Customer)
// ============================================================
const { db, save } = require('./data');
const { shopifyAdmin } = require('./shopify-admin');
const logger = require('./utils/logger');

const ADMIN_TOKEN = process.env.CRM_ADMIN_TOKEN || 'stylehub-admin-2026';

function auth(req, res, next) {
  const t = req.headers['x-admin-token'] || req.query.token;
  if (t !== ADMIN_TOKEN) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// ═══════════════════════════════════════════
// SHOPIFY ORDER HYDRATION
// Pulls orders from Shopify Admin API into db.orders
// Solves ephemeral filesystem issue on Render
// ═══════════════════════════════════════════
let lastHydration = 0;
const HYDRATION_COOLDOWN = 60000; // 1 min cooldown

async function hydrateOrdersFromShopify(force = false) {
  const now = Date.now();
  if (!force && (now - lastHydration) < HYDRATION_COOLDOWN && Object.keys(db.orders).length > 0) {
    return; // skip if recently hydrated and we have data
  }

  try {
    const domain = process.env.SHOPIFY_STORE_DOMAIN;
    const token = process.env.SHOPIFY_ADMIN_TOKEN;
    if (!domain || !token) {
      logger.warn('crm', 'Shopify not configured — skipping order hydration');
      return;
    }

    // Fetch up to 250 recent orders from Shopify
    const resp = await fetch(
      `https://${domain}/admin/api/2024-01/orders.json?status=any&limit=250&order=created_at+desc&fields=id,name,order_number,email,total_price,subtotal_price,total_tax,currency,financial_status,fulfillment_status,line_items,shipping_address,customer,created_at,cancelled_at,fulfillments,refunds,note`,
      {
        headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(20000)
      }
    );

    if (!resp.ok) {
      logger.error('crm', `Shopify orders API returned ${resp.status}`);
      return;
    }

    const data = await resp.json();
    const orders = data.orders || [];
    let added = 0;
    let updated = 0;

    for (const o of orders) {
      const existing = db.orders[o.id];

      // Detect source: SKU pattern (DH-SOURCE-xxx) > line item properties > vendor name
      let source = 'unknown';
      const items = o.line_items || [];

      for (const item of items) {
        // Strategy 1: SKU pattern DH-AMAZON-xxx, DH-ALIEXPRESS-xxx, etc.
        const sku = (item.sku || '').toUpperCase();
        if (sku.startsWith('DH-')) {
          const parts = sku.split('-');
          if (parts.length >= 3) {
            const src = parts[1].toLowerCase();
            if (['amazon', 'aliexpress', 'sephora', 'macys', 'shein'].includes(src)) {
              source = src;
              break;
            }
          }
        }

        // Strategy 2: Line item properties (_source_store)
        const props = item.properties || [];
        const sourceProp = props.find(p => p.name === '_source_store');
        if (sourceProp && sourceProp.value) {
          source = sourceProp.value.toLowerCase();
          break;
        }

        // Strategy 3: Vendor name fallback
        const vendor = (item.vendor || '').toLowerCase();
        if (vendor.includes('amazon')) { source = 'amazon'; break; }
        else if (vendor.includes('aliexpress')) { source = 'aliexpress'; break; }
        else if (vendor.includes('sephora')) { source = 'sephora'; break; }
        else if (vendor.includes('macy')) { source = 'macys'; break; }
        else if (vendor.includes('shein')) { source = 'shein'; break; }
      }

      const manualSources = ['sephora', 'macys', 'shein'];
      const requiresManual = items.some(i => {
        const sku = (i.sku || '').toUpperCase();
        if (sku.startsWith('DH-')) {
          const src = sku.split('-')[1]?.toLowerCase();
          if (manualSources.includes(src)) return true;
        }
        return manualSources.some(s => (i.vendor || '').toLowerCase().includes(s));
      });

      // Cost estimation based on source margins
      const marginBySource = {
        aliexpress: 0.45, amazon: 0.70, sephora: 0.75, macys: 0.70, shein: 0.40, unknown: 0.60
      };
      const costRatio = marginBySource[source] || 0.60;
      const cost = items.reduce((s, i) =>
        s + (parseFloat(i.price) * (i.quantity || 1) * costRatio), 0);
      const total = parseFloat(o.total_price || 0);

      // Get tracking from fulfillments
      let tracking = null, trackingUrl = null, trackingCompany = null, fulfilledAt = null;
      if (o.fulfillments && o.fulfillments.length) {
        const f = o.fulfillments[o.fulfillments.length - 1];
        tracking = f.tracking_number || null;
        trackingUrl = f.tracking_url || null;
        trackingCompany = f.tracking_company || null;
        fulfilledAt = f.created_at || null;
      }

      // Calculate refund amount
      let refundAmount = 0;
      if (o.refunds && o.refunds.length) {
        for (const r of o.refunds) {
          refundAmount += (r.transactions || []).reduce((s, t) => s + parseFloat(t.amount || 0), 0);
        }
      }

      const orderData = {
        id: o.id,
        shopifyId: o.id,
        number: o.name || '#' + o.order_number,
        email: o.customer?.email || o.email || '',
        customerName: ((o.customer?.first_name || '') + ' ' + (o.customer?.last_name || '')).trim(),
        customerId: o.customer?.id,
        total: total,
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
        estimatedProfit: Math.round((total - cost) * 100) / 100,
        tracking,
        trackingUrl,
        trackingCompany,
        fulfilledAt,
        cancelledAt: o.cancelled_at || null,
        refundAmount,
        returnId: null,
        source,
        requiresManual,
        notes: existing?.notes || o.note || '',
        createdAt: o.created_at || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        events: existing?.events || [{ type: 'created', at: o.created_at || new Date().toISOString() }]
      };

      // Preserve CRM-specific data from existing entry
      if (existing) {
        orderData.notes = existing.notes || orderData.notes;
        orderData.events = existing.events || orderData.events;
        orderData.returnId = existing.returnId || null;
        updated++;
      } else {
        added++;
      }

      db.orders[o.id] = orderData;
    }

    save('orders');
    lastHydration = Date.now();
    logger.info('crm', `[Hydration] Synced ${orders.length} orders from Shopify (${added} new, ${updated} updated)`);
  } catch (e) {
    logger.error('crm', `[Hydration] Failed: ${e.message}`);
  }
}

function setupCRMApi(app) {
  // Hydrate orders from Shopify on first load
  setTimeout(() => hydrateOrdersFromShopify(true), 5000);
  // Re-hydrate every 5 minutes
  setInterval(() => hydrateOrdersFromShopify(), 5 * 60 * 1000);

  // ═══════════════════════════════════════════
  // DASHBOARD METRICS
  // ═══════════════════════════════════════════
  app.get('/api/crm/dashboard', auth, async (req, res) => {
    // Ensure orders are hydrated from Shopify
    if (Object.keys(db.orders).length === 0) {
      await hydrateOrdersFromShopify(true);
    }

    const all = Object.values(db.orders);
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const month = new Date(now.getFullYear(), now.getMonth(), 1);

    const active = all.filter(o => o.financialStatus !== 'cancelled');
    const todayOrd = active.filter(o => new Date(o.createdAt) >= today);
    const monthOrd = active.filter(o => new Date(o.createdAt) >= month);
    const pending = all.filter(o => !o.fulfillmentStatus && o.financialStatus !== 'cancelled');
    const manual = pending.filter(o => o.requiresManual);
    const shipped = all.filter(o => o.fulfillmentStatus === 'fulfilled');

    const rev = active.reduce((s, o) => s + (o.total || 0), 0);
    const profit = active.reduce((s, o) => s + (o.estimatedProfit || 0), 0);
    const mRev = monthOrd.reduce((s, o) => s + (o.total || 0), 0);
    const mProfit = monthOrd.reduce((s, o) => s + (o.estimatedProfit || 0), 0);
    const refunds = all.reduce((s, o) => s + (o.refundAmount || 0), 0);
    const todayRev = todayOrd.reduce((s, o) => s + (o.total || 0), 0);

    const bySource = {};
    all.forEach(o => {
      const src = o.source || 'unknown';
      if (!bySource[src]) bySource[src] = { count: 0, revenue: 0, profit: 0 };
      bySource[src].count++;
      bySource[src].revenue += o.total || 0;
      bySource[src].profit += o.estimatedProfit || 0;
    });

    const returns = Object.values(db.returns);
    const pendingReturns = returns.filter(r => r.status === 'pending');
    const pendingReviews = db.reviews.filter(r => r.status === 'pending');

    // Get AutoDS stats if available
    let autodsStats = null;
    try {
      const autods = require('./services/autods');
      autodsStats = autods.getAutodsStats();
    } catch (e) {}

    // Get cron status if available
    let cronStatus = null;
    try {
      const cron = require('./services/cron');
      cronStatus = cron.getCronStatus();
    } catch (e) {}

    // Build recent activity from orders
    const recent = all
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .slice(0, 30)
      .map(o => ({
        ...o,
        action: `Order ${o.number} — $${(o.total || 0).toFixed(2)} (${o.source || 'unknown'})`,
        timestamp: o.createdAt
      }));

    res.json({
      overview: {
        totalOrders: all.length,
        todayOrders: todayOrd.length,
        monthOrders: monthOrd.length,
        revenue: +rev.toFixed(2),
        profit: +profit.toFixed(2),
        monthRevenue: +mRev.toFixed(2),
        monthProfit: +mProfit.toFixed(2),
        todayRevenue: +todayRev.toFixed(2),
        refunds: +refunds.toFixed(2),
        avgOrder: active.length ? +(rev / active.length).toFixed(2) : 0,
        margin: rev ? Math.round(profit / rev * 100) : 0
      },
      counts: {
        pending: pending.length,
        manual: manual.length,
        shipped: shipped.length,
        cancelled: all.filter(o => o.financialStatus === 'cancelled').length,
        pendingReturns: pendingReturns.length,
        pendingReviews: pendingReviews.length
      },
      bySource,
      recent,
      autods: autodsStats,
      cron: cronStatus
    });
  });

  // ═══════════════════════════════════════════
  // ORDERS
  // ═══════════════════════════════════════════
  app.get('/api/crm/orders', auth, async (req, res) => {
    // Ensure orders are hydrated
    if (Object.keys(db.orders).length === 0) {
      await hydrateOrdersFromShopify(true);
    }
    const { status, source, q } = req.query;
    let list = Object.values(db.orders);

    if (status === 'pending') list = list.filter(o => !o.fulfillmentStatus && o.financialStatus !== 'cancelled');
    else if (status === 'fulfilled' || status === 'shipped') list = list.filter(o => o.fulfillmentStatus === 'fulfilled');
    else if (status === 'cancelled') list = list.filter(o => o.financialStatus === 'cancelled');
    else if (status === 'manual') list = list.filter(o => o.requiresManual && !o.fulfillmentStatus && o.financialStatus !== 'cancelled');
    else if (status === 'returns') list = list.filter(o => o.returnId);

    if (source) list = list.filter(o => o.source === source);
    if (q) {
      const ql = q.toLowerCase();
      list = list.filter(o =>
        (o.number || '').toLowerCase().includes(ql) ||
        (o.email || '').toLowerCase().includes(ql) ||
        (o.customerName || '').toLowerCase().includes(ql)
      );
    }

    list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json({ orders: list, total: list.length });
  });

  app.get('/api/crm/orders/:id', auth, (req, res) => {
    const o = db.orders[req.params.id];
    if (!o) return res.status(404).json({ error: 'Not found' });
    res.json(o);
  });

  // ═══════════════════════════════════════════
  // FULFILL MANUAL
  // ═══════════════════════════════════════════
  app.post('/api/crm/orders/:id/fulfill', auth, async (req, res) => {
    try {
      const { trackingNumber, trackingCompany, trackingUrl } = req.body;
      const id = req.params.id;

      const foData = await shopifyAdmin('GET', `/orders/${id}/fulfillment_orders.json`);
      const fo = foData.fulfillment_orders?.find(f => f.status === 'open');
      if (!fo) return res.status(400).json({ error: 'No open fulfillment order found' });

      await shopifyAdmin('POST', '/fulfillments.json', {
        fulfillment: {
          line_items_by_fulfillment_order: [{ fulfillment_order_id: fo.id }],
          tracking_info: {
            number: trackingNumber || '',
            company: trackingCompany || 'Other',
            url: trackingUrl || ''
          },
          notify_customer: true
        }
      });

      if (db.orders[id]) {
        db.orders[id].fulfillmentStatus = 'fulfilled';
        db.orders[id].tracking = trackingNumber || null;
        db.orders[id].trackingUrl = trackingUrl || null;
        db.orders[id].trackingCompany = trackingCompany || null;
        db.orders[id].fulfilledAt = new Date().toISOString();
        db.orders[id].updatedAt = new Date().toISOString();
        db.orders[id].events.push({
          type: 'fulfilled_manual',
          tracking: trackingNumber,
          carrier: trackingCompany,
          at: new Date().toISOString()
        });
        save('orders');
      }

      logger.info('crm', `Manual fulfill: order ${id}, tracking: ${trackingNumber}`);
      res.json({ success: true });
    } catch (e) {
      logger.error('crm', `Fulfill error: ${e.message}`);
      res.status(400).json({ error: e.message });
    }
  });

  // ═══════════════════════════════════════════
  // ADD NOTE
  // ═══════════════════════════════════════════
  app.post('/api/crm/orders/:id/note', auth, (req, res) => {
    if (!db.orders[req.params.id]) return res.status(404).json({ error: 'Not found' });
    db.orders[req.params.id].notes = req.body.note || '';
    db.orders[req.params.id].updatedAt = new Date().toISOString();
    db.orders[req.params.id].events.push({
      type: 'note',
      text: req.body.note,
      at: new Date().toISOString()
    });
    save('orders');
    res.json({ success: true });
  });

  // ═══════════════════════════════════════════
  // RETURNS
  // ═══════════════════════════════════════════

  // Customer creates return
  app.post('/api/crm/returns/create', (req, res) => {
    const b = req.body;
    const { orderId, customerId, reason, comment } = b;
    if (!orderId) return res.status(400).json({ error: 'Missing orderId' });

    const id = 'RET-' + Date.now();
    db.returns[id] = {
      id,
      orderId,
      customerId,
      orderNumber: b.orderNumber || db.orders[orderId]?.number || orderId,
      customerEmail: b.customerEmail || db.orders[orderId]?.email || '',
      customerName: b.customerName || db.orders[orderId]?.customerName || '',
      reason: reason || '',
      reasonLabel: b.reasonLabel || reason || '',
      comment: comment || '',
      description: b.description || '',
      amount: parseFloat(b.amount) || 0,
      items: b.items || [],
      source: b.source || 'unknown',
      status: 'pending',
      refundAmount: 0,
      adminNotes: '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      events: [{ type: 'created', at: new Date().toISOString() }]
    };

    if (db.orders[orderId]) {
      db.orders[orderId].returnId = id;
      save('orders');
    }
    save('returns');
    logger.info('crm', `Return created: ${id} for order ${orderId}`);
    res.json({ success: true, returnId: id });
  });

  // Admin updates return (shared handler for PUT and POST)
  function handleReturnUpdate(req, res) {
    const r = db.returns[req.params.id];
    if (!r) return res.status(404).json({ error: 'Not found' });

    if (req.body.status) {
      r.status = req.body.status;
      r.events.push({ type: 'status_change', status: req.body.status, at: new Date().toISOString() });
    }
    if (req.body.adminNotes !== undefined) r.adminNotes = req.body.adminNotes;
    if (req.body.refundAmount !== undefined) r.refundAmount = req.body.refundAmount;
    r.updatedAt = new Date().toISOString();
    save('returns');
    res.json({ success: true });
  }
  app.put('/api/crm/returns/:id', auth, handleReturnUpdate);
  app.post('/api/crm/returns/:id', auth, handleReturnUpdate);

  // Admin lists returns
  app.get('/api/crm/returns', auth, (req, res) => {
    let list = Object.values(db.returns).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    if (req.query.status) list = list.filter(r => r.status === req.query.status);
    res.json({ returns: list, total: list.length });
  });

  // Customer views their returns
  app.get('/api/crm/returns/customer/:cid', (req, res) => {
    const list = Object.values(db.returns).filter(r => String(r.customerId) === String(req.params.cid));
    res.json({ returns: list });
  });

  // ═══════════════════════════════════════════
  // REVIEWS
  // ═══════════════════════════════════════════

  // Customer creates review
  app.post('/api/crm/reviews/create', (req, res) => {
    const b = req.body;
    const { productId, productTitle, customerId, customerName, customerEmail, rating, title, text, orderId } = b;
    if (!rating) return res.status(400).json({ error: 'Missing required fields' });

    const review = {
      id: 'REV-' + Date.now(),
      productId: productId || '',
      product_name: productTitle || b.product_name || '',
      productTitle: productTitle || '',
      customerId,
      customerName: customerName || 'Customer',
      customer_name: customerName || 'Customer',
      customerEmail: customerEmail || '',
      orderId: orderId || null,
      rating: Math.min(5, Math.max(1, parseInt(rating))),
      title: title || '',
      text: b.body || text || '',
      status: 'pending',
      helpful: 0,
      createdAt: new Date().toISOString(),
      created_at: new Date().toISOString()
    };

    db.reviews.push(review);
    save('reviews');
    logger.info('crm', `Review created: ${review.id} for product ${productId}`);
    res.json({ success: true, review });
  });

  // Public: get published reviews for a product
  app.get('/api/crm/reviews/product/:pid', (req, res) => {
    const list = db.reviews.filter(r => String(r.productId) === String(req.params.pid) && r.status === 'published');
    const avg = list.length ? +(list.reduce((s, r) => s + r.rating, 0) / list.length).toFixed(1) : 0;
    res.json({ reviews: list, total: list.length, avgRating: avg });
  });

  // Admin updates review (approve/reject)
  app.put('/api/crm/reviews/:id', auth, (req, res) => {
    const idx = db.reviews.findIndex(r => r.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Not found' });
    if (req.body.status) db.reviews[idx].status = req.body.status;
    save('reviews');
    res.json({ success: true });
  });

  // Admin lists all reviews
  app.get('/api/crm/reviews', auth, (req, res) => {
    let list = [...db.reviews].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    if (req.query.status) list = list.filter(r => r.status === req.query.status);
    res.json({ reviews: list, total: list.length });
  });

  // ═══════════════════════════════════════════
  // CUSTOMER PROFILE (via Shopify Admin API)
  // ═══════════════════════════════════════════
  app.post('/api/customer/update-profile', async (req, res) => {
    try {
      const { customerId, firstName, lastName, phone } = req.body;
      if (!customerId) return res.status(400).json({ error: 'Missing customerId' });

      const customer = {};
      if (firstName !== undefined) customer.first_name = firstName;
      if (lastName !== undefined) customer.last_name = lastName;
      if (phone !== undefined) customer.phone = phone || '';

      const data = await shopifyAdmin('PUT', `/customers/${customerId}.json`, { customer });
      res.json({ success: true, customer: data.customer });
    } catch (e) {
      logger.error('crm', `Profile update error: ${e.message}`);
      res.status(400).json({ error: e.message });
    }
  });

  // ═══════════════════════════════════════════
  // CUSTOMER ADDRESSES (via Shopify Admin API)
  // ═══════════════════════════════════════════
  app.get('/api/customer/addresses/:cid', async (req, res) => {
    try {
      const data = await shopifyAdmin('GET', `/customers/${req.params.cid}/addresses.json`);
      res.json({ addresses: data.addresses || [] });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  app.post('/api/customer/address/create', async (req, res) => {
    try {
      const { customerId, address } = req.body;
      if (!customerId || !address) return res.status(400).json({ error: 'Missing data' });

      const data = await shopifyAdmin('POST', `/customers/${customerId}/addresses.json`, {
        address: {
          first_name: address.firstName,
          last_name: address.lastName,
          company: address.company || '',
          address1: address.address1,
          address2: address.address2 || '',
          city: address.city,
          province: address.province || '',
          zip: address.zip,
          country: address.country,
          phone: address.phone || ''
        }
      });

      if (address.isDefault) {
        await shopifyAdmin('PUT', `/customers/${customerId}/addresses/${data.customer_address.id}/default.json`);
      }

      res.json({ success: true, address: data.customer_address });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  app.delete('/api/customer/address/delete', async (req, res) => {
    try {
      const { customerId, addressId } = req.body;
      if (!customerId || !addressId) return res.status(400).json({ error: 'Missing data' });
      await shopifyAdmin('DELETE', `/customers/${customerId}/addresses/${addressId}.json`);
      res.json({ success: true });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // POST alias for delete (frontend compatibility)
  app.post('/api/customer/address/delete', async (req, res) => {
    try {
      const { customerId, addressId } = req.body;
      if (!customerId || !addressId) return res.status(400).json({ error: 'Missing data' });
      await shopifyAdmin('DELETE', `/customers/${customerId}/addresses/${addressId}.json`);
      res.json({ success: true });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // Set address as default
  app.post('/api/customer/address/set-default', async (req, res) => {
    try {
      const { customerId, addressId } = req.body;
      if (!customerId || !addressId) return res.status(400).json({ error: 'Missing data' });
      await shopifyAdmin('PUT', `/customers/${customerId}/addresses/${addressId}/default.json`);
      res.json({ success: true });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });
  // ═══════════════════════════════════════════
  // PLUS MEMBERS STATS
  // ═══════════════════════════════════════════
  app.get('/api/crm/plus-stats', auth, async (req, res) => {
    try {
      const plusMembers = db.plusMembers || {};
      const active = Object.values(plusMembers).filter(m => m.status === 'active');
      const cancelled = Object.values(plusMembers).filter(m => m.status === 'cancelled');

      // Calculate monthly revenue
      const monthlyRevenue = active.length * 7.99;

      // Calculate churn
      const total = Object.values(plusMembers).length;
      const churnRate = total > 0 ? Math.round((cancelled.length / total) * 100) : 0;

      // Recent activity
      const plusActivity = (db.activity || [])
        .filter(a => a.type && a.type.startsWith('plus_'))
        .slice(0, 50);

      res.json({
        totalActive: active.length,
        totalCancelled: cancelled.length,
        monthlyRevenue: Math.round(monthlyRevenue * 100) / 100,
        annualProjected: Math.round(monthlyRevenue * 12 * 100) / 100,
        churnRate,
        members: active.map(m => ({
          customerId: m.customerId,
          email: m.email,
          since: m.subscribedAt,
          plan: m.plan
        })),
        recentActivity: plusActivity
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // NUEVOS ENDPOINTS — CRM Pro upgrade
  // NO MODIFICAR NADA ARRIBA DE ESTA LÍNEA
  // ═══════════════════════════════════════════════════════════

  const fs = require('fs');
  const path = require('path');

  // ─── CUSTOMERS (data real de Shopify Admin API) ───

  app.get('/api/crm/customers', auth, async function(req, res) {
    try {
      const limit = parseInt(req.query.limit) || 50;
      const shopifyRes = await fetch(
        'https://' + process.env.SHOPIFY_STORE_DOMAIN + '/admin/api/2024-01/customers.json?limit=' + limit + '&order=created_at+desc',
        { headers: { 'X-Shopify-Access-Token': process.env.SHOPIFY_ADMIN_TOKEN } }
      );
      const data = await shopifyRes.json();

      const orders = Object.values(db.orders || {});
      const returns = Object.values(db.returns || {});

      const customers = (data.customers || []).map(function(c) {
        const email = c.email || '';
        const custOrders = orders.filter(function(o) { return o.customerEmail === email; });
        const custReturns = returns.filter(function(r) { return r.customerEmail === email; });
        const totalSpent = custOrders.reduce(function(sum, o) { return sum + parseFloat(o.total || o.totalPrice || 0); }, 0);
        const orderCount = c.orders_count || custOrders.length;

        let segment = 'regular';
        if (totalSpent > 200 || orderCount >= 3) segment = 'vip';
        else if (orderCount === 0) segment = 'new';
        else if (custReturns.length > 2) segment = 'at_risk';

        return {
          id: c.id,
          name: ((c.first_name || '') + ' ' + (c.last_name || '')).trim() || email,
          email: email,
          phone: c.phone || null,
          ordersCount: orderCount,
          totalSpent: Math.round(totalSpent * 100) / 100,
          returnsCount: custReturns.length,
          lastOrder: custOrders.length ? custOrders[0].createdAt : null,
          createdAt: c.created_at,
          segment: segment,
          tags: c.tags ? c.tags.split(',').map(function(t) { return t.trim(); }).filter(Boolean) : []
        };
      });

      const totalCustomers = customers.length;
      const vipCount = customers.filter(function(c) { return c.segment === 'vip'; }).length;
      const newCount = customers.filter(function(c) { return c.segment === 'new'; }).length;
      const atRiskCount = customers.filter(function(c) { return c.segment === 'at_risk'; }).length;
      const avgSpent = totalCustomers ? customers.reduce(function(s,c) { return s + c.totalSpent; }, 0) / totalCustomers : 0;

      res.json({
        customers: customers,
        stats: {
          total: totalCustomers,
          vip: vipCount,
          new: newCount,
          atRisk: atRiskCount,
          avgSpent: Math.round(avgSpent * 100) / 100
        }
      });
    } catch(e) {
      logger.error('crm', 'Customers API error: ' + e.message);
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/crm/customers/:id', auth, async function(req, res) {
    try {
      const shopifyRes = await fetch(
        'https://' + process.env.SHOPIFY_STORE_DOMAIN + '/admin/api/2024-01/customers/' + req.params.id + '.json',
        { headers: { 'X-Shopify-Access-Token': process.env.SHOPIFY_ADMIN_TOKEN } }
      );
      const data = await shopifyRes.json();
      if (!data.customer) return res.status(404).json({ error: 'Customer not found' });

      const c = data.customer;
      const email = c.email || '';

      const orders = Object.values(db.orders || {});
      const returns = Object.values(db.returns || {});
      const reviews = db.reviews || [];
      let tickets = [];
      try { tickets = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'tickets.json'), 'utf8')); } catch(e) {}

      const custOrders = orders.filter(function(o) { return o.customerEmail === email; });
      const custReturns = returns.filter(function(r) { return r.customerEmail === email; });
      const custReviews = reviews.filter(function(r) { return r.customerEmail === email; });
      const custTickets = tickets.filter(function(t) { return t.customerEmail === email; });
      const totalSpent = custOrders.reduce(function(s, o) { return s + parseFloat(o.total || o.totalPrice || 0); }, 0);

      res.json({
        customer: {
          id: c.id,
          name: ((c.first_name || '') + ' ' + (c.last_name || '')).trim(),
          email: email,
          phone: c.phone,
          addresses: c.addresses || [],
          createdAt: c.created_at,
          tags: c.tags
        },
        orders: custOrders,
        returns: custReturns,
        reviews: custReviews,
        tickets: custTickets,
        stats: {
          totalSpent: Math.round(totalSpent * 100) / 100,
          ordersCount: custOrders.length,
          avgOrderValue: custOrders.length ? Math.round(totalSpent / custOrders.length * 100) / 100 : 0,
          returnRate: custOrders.length ? Math.round(custReturns.length / custOrders.length * 1000) / 10 : 0
        }
      });
    } catch(e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ─── ANALYTICS (data real de orders + returns) ───

  app.get('/api/crm/analytics', auth, async function(req, res) {
    try {
      // Ensure orders are hydrated
      if (Object.keys(db.orders).length === 0) {
        await hydrateOrdersFromShopify(true);
      }
      const orders = Object.values(db.orders || {});
      const returns = Object.values(db.returns || {});

      const period = parseInt(req.query.period) || 30;
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - period);

      const filtered = orders.filter(function(o) { return new Date(o.createdAt) >= cutoff; });
      const filteredReturns = returns.filter(function(r) { return new Date(r.createdAt) >= cutoff; });

      // Revenue by day
      const revenueByDay = {};
      const ordersByDay = {};
      filtered.forEach(function(o) {
        const day = (o.createdAt || '').substring(0, 10);
        if (!day) return;
        revenueByDay[day] = (revenueByDay[day] || 0) + parseFloat(o.total || o.totalPrice || 0);
        ordersByDay[day] = (ordersByDay[day] || 0) + 1;
      });

      // By source
      const revenueBySource = {};
      const ordersBySource = {};
      filtered.forEach(function(o) {
        const src = o.source || 'unknown';
        revenueBySource[src] = (revenueBySource[src] || 0) + parseFloat(o.total || o.totalPrice || 0);
        ordersBySource[src] = (ordersBySource[src] || 0) + 1;
      });

      // Top products
      const productMap = {};
      filtered.forEach(function(o) {
        (o.items || []).forEach(function(item) {
          const key = item.title || item.sourceProductId || 'Unknown';
          if (!productMap[key]) productMap[key] = { title: key, count: 0, revenue: 0, image: item.image || null };
          productMap[key].count += 1;
          productMap[key].revenue += parseFloat(item.price || o.totalPrice || 0);
        });
      });
      const topProducts = Object.values(productMap)
        .sort(function(a, b) { return b.count - a.count; })
        .slice(0, 10);

      // Top return reasons
      const reasonMap = {};
      filteredReturns.forEach(function(r) {
        const reason = r.reason || r.reasonLabel || 'Unknown';
        reasonMap[reason] = (reasonMap[reason] || 0) + 1;
      });
      const topReasons = Object.entries(reasonMap)
        .sort(function(a, b) { return b[1] - a[1]; })
        .map(function(e) { return { reason: e[0], count: e[1] }; });

      const totalRevenue = filtered.reduce(function(s, o) { return s + parseFloat(o.total || o.totalPrice || 0); }, 0);
      const totalProfit = filtered.reduce(function(s, o) { return s + parseFloat(o.estimatedProfit || o.profit || 0); }, 0);

      // Build daily revenue array for chart
      const days = Object.keys(revenueByDay).sort();
      const dailyRevenue = days.map(d => revenueByDay[d] || 0);

      // Build top products list for frontend
      const topProductsList = topProducts.map(p => ({
        name: p.title,
        count: p.count,
        revenue: Math.round(p.revenue * 100) / 100
      }));

      res.json({
        period: period,
        overview: {
          revenue: Math.round(totalRevenue * 100) / 100,
          profit: Math.round(totalProfit * 100) / 100,
          margin: totalRevenue > 0 ? Math.round(totalProfit / totalRevenue * 1000) / 10 : 0,
          totalOrders: filtered.length
        },
        daily_revenue: dailyRevenue,
        top_products: topProductsList,
        top_return_reasons: topReasons,
        revenueByDay: revenueByDay,
        ordersByDay: ordersByDay,
        revenueBySource: revenueBySource,
        ordersBySource: ordersBySource,
        totals: {
          revenue: Math.round(totalRevenue * 100) / 100,
          profit: Math.round(totalProfit * 100) / 100,
          margin: totalRevenue > 0 ? Math.round(totalProfit / totalRevenue * 1000) / 10 : 0,
          orders: filtered.length,
          returns: filteredReturns.length,
          returnRate: filtered.length > 0 ? Math.round(filteredReturns.length / filtered.length * 1000) / 10 : 0,
          avgOrderValue: filtered.length > 0 ? Math.round(totalRevenue / filtered.length * 100) / 100 : 0
        }
      });
    } catch(e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ─── SETTINGS ───

  const SETTINGS_FILE = path.join(__dirname, '..', 'data', 'settings.json');

  app.get('/api/crm/settings', auth, function(req, res) {
    try {
      const settings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
      res.json(settings);
    } catch(e) {
      res.json({
        markup: { amazon: 12, aliexpress: 15 },
        shipping: { freeThreshold: 35 },
        returns: { windowAmazon: 30, windowAliexpress: 15 },
        notifications: { newOrder: true, returnRequest: true, apiDown: true }
      });
    }
  });

  app.post('/api/crm/settings', auth, function(req, res) {
    try {
      fs.writeFileSync(SETTINGS_FILE, JSON.stringify(req.body, null, 2));
      res.json({ success: true });
    } catch(e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ─── MANUAL REFRESH: Force re-hydrate orders from Shopify ───
  app.post('/api/crm/refresh-orders', auth, async function(req, res) {
    try {
      await hydrateOrdersFromShopify(true);
      res.json({ success: true, orderCount: Object.keys(db.orders).length });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  logger.info('crm', 'CRM Pro endpoints loaded (customers, analytics, settings, hydration)');
}

module.exports = { setupCRMApi, hydrateOrdersFromShopify };
