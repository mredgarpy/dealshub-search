const fs = require('fs');
const path = require('path');

const TICKETS_FILE = path.join(__dirname, '..', 'data', 'tickets.json');

function readTickets() {
  try { return JSON.parse(fs.readFileSync(TICKETS_FILE, 'utf8')); }
  catch(e) { return []; }
}

function writeTickets(data) {
  fs.writeFileSync(TICKETS_FILE, JSON.stringify(data, null, 2));
}

function detectCategory(text) {
  text = (text || '').toLowerCase();
  if (/order|shipping|deliver|track|where.*my/i.test(text)) return 'orders';
  if (/return|refund|exchange|send.*back/i.test(text)) return 'returns';
  if (/payment|charge|bill|card/i.test(text)) return 'billing';
  if (/account|password|login|email/i.test(text)) return 'account';
  if (/product|size|color|quality|fit/i.test(text)) return 'product';
  return 'general';
}

function getAutoResponse(subject, message) {
  const text = ((subject || '') + ' ' + (message || '')).toLowerCase();

  if (/where.*(my|is).*(order|package|shipment)/i.test(text)) {
    return 'Thanks for reaching out! You can track your order at:\nhttps://stylehubmiami.com/pages/my-account#orders\n\nIf your order shows "Shipped", click the tracking number to see real-time status.\nOur team will respond within 24 hours if you need more help.';
  }
  if (/return|refund|send.*back/i.test(text)) {
    return 'To start a return, go to:\nMy Account → Orders → Select your order → "Return items"\n\nReturns are processed within 24-48 hours.\nOur team will respond shortly if you need help.';
  }
  if (/cancel/i.test(text)) {
    return 'To cancel an order that hasn\'t shipped yet, please go to:\nMy Account → Orders → Select order → "Cancel"\n\nIf it already shipped, you can request a return instead.';
  }
  if (/size|fit|sizing/i.test(text)) {
    return 'You can find size charts on each product page below the size selector.\nIf the item doesn\'t fit, you can return it within 30 days.\nOur team will respond within 24 hours if you need more help.';
  }
  return null;
}

function setupTicketsApi(app) {
  const TOKEN = process.env.CRM_ADMIN_TOKEN || 'stylehub-admin-2026';

  function authAdmin(req, res, next) {
    const token = req.query.token || req.headers['x-admin-token'];
    if (token === TOKEN) return next();
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // ═══ ADMIN: Listar tickets ═══
  app.get('/api/crm/tickets', authAdmin, function(req, res) {
    let tickets = readTickets();
    const status = req.query.status;
    if (status && status !== 'all') {
      tickets = tickets.filter(function(t) { return t.status === status; });
    }
    tickets.sort(function(a, b) { return new Date(b.updatedAt) - new Date(a.updatedAt); });
    res.json({ tickets: tickets, total: tickets.length });
  });

  // ═══ ADMIN: Stats de tickets ═══
  app.get('/api/crm/tickets/stats', authAdmin, function(req, res) {
    const tickets = readTickets();
    const open = tickets.filter(function(t) { return t.status === 'open'; }).length;
    const inProgress = tickets.filter(function(t) { return t.status === 'in_progress'; }).length;
    const resolved = tickets.filter(function(t) { return t.status === 'resolved'; }).length;
    const closed = tickets.filter(function(t) { return t.status === 'closed'; }).length;

    const responseTimes = tickets
      .filter(function(t) { return t.firstResponseAt; })
      .map(function(t) { return (new Date(t.firstResponseAt) - new Date(t.createdAt)) / 3600000; });
    const avgHrs = responseTimes.length
      ? (responseTimes.reduce(function(a,b) { return a+b; }, 0) / responseTimes.length).toFixed(1)
      : '0';

    res.json({
      open: open, inProgress: inProgress, resolved: resolved, closed: closed,
      total: tickets.length, avgResponseHrs: parseFloat(avgHrs)
    });
  });

  // ═══ ADMIN: Detalle de un ticket ═══
  app.get('/api/crm/tickets/:id', authAdmin, function(req, res) {
    const tickets = readTickets();
    const ticket = tickets.find(function(t) { return t.id === req.params.id; });
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
    res.json(ticket);
  });

  // ═══ ADMIN: Responder ticket ═══
  app.post('/api/crm/tickets/:id/reply', authAdmin, function(req, res) {
    const tickets = readTickets();
    const ticket = tickets.find(function(t) { return t.id === req.params.id; });
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

    ticket.messages.push({
      from: 'admin',
      name: 'StyleHub Support',
      message: req.body.message,
      timestamp: new Date().toISOString()
    });

    if (!ticket.firstResponseAt) ticket.firstResponseAt = new Date().toISOString();
    ticket.status = 'in_progress';
    ticket.updatedAt = new Date().toISOString();
    writeTickets(tickets);
    res.json({ success: true });
  });

  // ═══ ADMIN: Cambiar status ═══
  app.post('/api/crm/tickets/:id/status', authAdmin, function(req, res) {
    const tickets = readTickets();
    const ticket = tickets.find(function(t) { return t.id === req.params.id; });
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

    ticket.status = req.body.status;
    ticket.updatedAt = new Date().toISOString();
    if (req.body.status === 'resolved') ticket.resolvedAt = new Date().toISOString();
    writeTickets(tickets);
    res.json({ success: true });
  });

  // ═══ CLIENTE: Crear ticket ═══
  app.post('/api/tickets/create', function(req, res) {
    const tickets = readTickets();
    const b = req.body;

    if (!b.customerEmail || !b.subject || !b.message) {
      return res.status(400).json({ error: 'Missing required fields: customerEmail, subject, message' });
    }

    const ticket = {
      id: 'TKT-' + Date.now(),
      customerId: b.customerId || null,
      customerEmail: b.customerEmail,
      customerName: b.customerName || b.customerEmail.split('@')[0],
      subject: b.subject,
      category: detectCategory(b.subject + ' ' + b.message),
      orderId: b.orderId || null,
      priority: b.priority || 'normal',
      status: 'open',
      messages: [{
        from: 'customer',
        name: b.customerName || b.customerEmail.split('@')[0],
        message: b.message,
        timestamp: new Date().toISOString()
      }],
      firstResponseAt: null,
      resolvedAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    const auto = getAutoResponse(b.subject, b.message);
    if (auto) {
      ticket.messages.push({
        from: 'system',
        name: 'StyleHub Bot',
        message: auto,
        timestamp: new Date().toISOString(),
        automated: true
      });
      ticket.firstResponseAt = new Date().toISOString();
    }

    tickets.push(ticket);
    writeTickets(tickets);
    res.json({ success: true, ticketId: ticket.id, autoResponse: !!auto });
  });

  // ═══ CLIENTE: Responder ticket ═══
  app.post('/api/tickets/:id/reply', function(req, res) {
    const tickets = readTickets();
    const ticket = tickets.find(function(t) { return t.id === req.params.id; });
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

    ticket.messages.push({
      from: 'customer',
      name: ticket.customerName,
      message: req.body.message,
      timestamp: new Date().toISOString()
    });
    ticket.status = 'open';
    ticket.updatedAt = new Date().toISOString();
    writeTickets(tickets);
    res.json({ success: true });
  });

  // ═══ CLIENTE: Mis tickets ═══
  app.get('/api/tickets/customer/:customerId', function(req, res) {
    const tickets = readTickets();
    const mine = tickets.filter(function(t) { return t.customerId === req.params.customerId; });
    mine.sort(function(a, b) { return new Date(b.updatedAt) - new Date(a.updatedAt); });
    res.json({ tickets: mine });
  });

  console.log('✓ Tickets API loaded');
}

module.exports = { setupTicketsApi };
