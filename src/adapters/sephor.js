// ============================================================
// DealsHub — Sephora Adapter (via RapidAPI)
// ============================================================
const { BaseAdapter, emptySearchResult, emptyProduct } = require('./base');
const { parsePrice } = require('../utils/pricing');

const API_HOST = 'sephora.brayle