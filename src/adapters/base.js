// ============================================================
// DealsHub — Base Adapter Interface
// ============================================================
// All source adapters extend this to ensure consistent data shape

const fetch = require('node-fetch');
const logger = require('../utils/logger');

class BaseAdapter {
  constructor(name, config = {}) {
    this.name = name;
    this.timeout = config.timeout || 12000;
    this.rapidApiKey = config.rapidApiKey || process.env.RAPIDAPI_KEY;
  }

  rapidHeaders(host) {
    return {
      'x-rapidapi-key': this.rapidApiKey,
      'x-rapidapi-host': host
    };
  }

  async fetchJSON(url, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);
    try {
      const resp = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(timer);
      if (!resp.ok) {
        logger.warn('adapter', `${this.name} HTTP ${resp.status}`, { url: url.split('?')[0] });
        return null;
      }
      return await resp.json();
    } catch (err) {
      clearTimeout(timer);
      if (err.name === 'AbortError') {
        logger.warn('adapter', `${this.name} timeout`, { url: url.split('?')[0] });
      } else {
        logger.error('adapter', `${this.name} fetch error`, { error: err.message });
      }
      return null;
    }
  }

  // Must be implemented by each adapter
  async search(query, limit) { throw new Error('search() not implemented'); }
  async getProduct(sourceId) { throw new Error('getProduct() not implemented'); }

  // Normalize a search result to unified card format
  normalizeSearchResult(raw) { throw new Error('normalizeSearchResult() not implemented'); }

  // Normalize a product detail to unified product format
  normalizeProduct(raw) { throw new Error('normalizeProduct() not implemented'); }
}

// Unified search result shape (for cards)
function emptySearchResult() {
  return {
    id: null, title: '', price: null, originalPrice: null,
    image: '', url: '', rating: null, reviews: 0,
    badge: null, source: '', sourceName: '', brand: null
  };
}

// Unified product detail shape
function emptyProduct() {
  return {
    source: '', sourceId: '', sourceName: '', title: '', brand: null,
    category: null, breadcrumbs: [], description: '', bullets: [],
    images: [], primaryImage: '', price: null, originalPrice: null,
    currency: 'USD', rating: null, reviews: 0, badge: null,
    availability: null, stockSignal: 'unknown',
    options: [], selectedVariant: null, variants: [],
    shippingData: { cost: null, method: null, note: 'Standard shipping' },
    returnPolicy: { window: null, summary: '30-day returns' },
    deliveryEstimate: { minDays: null, maxDays: null, label: null },
    sellerData: { name: null, rating: null },
    sourceUrl: '', normalizedHandle: '', lastSyncedAt: null,
    rawSourceMeta: {}
  };
}

module.exports = { BaseAdapter, emptySearchResult, emptyProduct };
