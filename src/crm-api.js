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

function setupCRMApi(app) {

  // ═══════════════════════════════════════════
  // DASHBOARD METRICS
  // ═══════════════════════════════════════════
  app.get('/api/crm/dashboard', auth, (req, res) => {
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
      recent: all.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 30)
    });
  });

  // ═══════════════════════════════════════════
  // ORDERS
  // ═══════════════════════════════════════════
  app.get('/api/crm/orders', auth, (req, res) => {
    const { status, source, q } = req.query;
    let list = Object.values(db.orders);

    if (status === 'pending') list = list.filter(o => !o.fulfillmentStatus && o.financialStatus !== 'cancelled');
    else if (status === 'fulfilled') list = list.filter(o => o.fulfillmentStatus === 'fulfilled');
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
    const { orderId, customerId, reason, comment } = req.body;
    if (!orderId) return res.status(400).json({ error: 'Missing orderId' });

    const id = 'RET-' + Date.now();
    db.returns[id] = {
      id,
      orderId,
      customerId,
      orderNumber: db.orders[orderId]?.number || orderId,
      customerEmail: db.orders[orderId]?.email || '',
      customerName: db.orders[orderId]?.customerName || '',
      reason: reason || '',
      comment: comment || '',
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

  // Admin updates return
  app.put('/api/crm/returns/:id', auth, (req, res) => {
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
  });

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
    const { productId, productTitle, customerId, customerName, rating, title, text, orderId } = req.body;
    if (!productId || !rating) return res.status(400).json({ error: 'Missing required fields' });

    const review = {
      id: 'REV-' + Date.now(),
      productId,
      productTitle: productTitle || '',
      customerId,
      customerName: customerName || 'Customer',
      orderId: orderId || null,
      rating: Math.min(5, Math.max(1, parseInt(rating))),
      title: title || '',
      text: text || '',
      status: 'pending',
      helpful: 0,
      createdAt: new Date().toISOString()
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
}

module.exports = { setupCRMApi };
