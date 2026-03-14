// ============================================================
// DealsHub — Adapter Registry
// ============================================================
const AmazonAdapter = require('./amazon');
const AliExpressAdapter = require('./aliexpress');
const SephoraAdapter = require('./sephora');
const MacysAdapter = require('./macys');
const SheinAdapter = require('./shein');

const adapters = {};

function initAdapters(config = {}) {
  adapters.amazon = new AmazonAdapter(config);
  adapters.aliexpress = new AliExpressAdapter(config);
  adapters.sephora = new SephoraAdapter(config);
  adapters.macys = new MacysAdapter(config);
  adapters.shein = new SheinAdapter(config);
}

function getAdapter(source) {
  const key = (source || '').toLowerCase();
  return adapters[key] || null;
}

function getAllAdapters() { return adapters; }

const VALID_SOURCES = ['amazon', 'aliexpress', 'sephora', 'macys', 'shein'];

module.exports = { initAdapters, getAdapter, getAllAdapters, VALID_SOURCES };
