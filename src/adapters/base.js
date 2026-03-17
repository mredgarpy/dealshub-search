// ============================================================
// DealsHub â Base Adapter Interface
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
      // Handle 204 No Content (some APIs return 2xx but empty body)
      if (resp.status === 204) {
        logger.warn('adapter', `${this.name} HTTP 204 No Content`, { url: url.split('?')[0] });
        return null;
      }
      // Get raw text first to handle truncated JSON gracefully
      const text = await resp.text();
      if (!text || text.length === 0) {
        logger.warn('adapter', `${this.name} empty response body`, { url: url.split('?')[0] });
        return null;
      }
      try {
        return JSON.parse(text);
      } catch (parseErr) {
        // Try to recover truncated JSON by finding the last valid object boundary
        if (text && text.length > 100) {
          logger.warn('adapter', `${this.name} truncated JSON (${text.length} chars), attempting recovery`, { url: url.split('?')[0] });
          const recovered = this._recoverTruncatedJSON(text);
          if (recovered) return recovered;
        }
        logger.error('adapter', `${this.name} fetch error`, { error: 'invalid json response body at ' + url.split('?')[0] + ' reason: ' + parseErr.message });
        return null;
      }
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

  _recoverTruncatedJSON(text) {
    // Strategy: progressively remove characters from the end and try to close the JSON
    // Find the last comma or closing brace and try to close it
    try {
      // Remove trailing whitespace
      let t = text.trimEnd();
      // Try adding closing braces/brackets
      for (let attempts = 0; attempts < 10; attempts++) {
        // Remove trailing comma if present
        if (t.endsWith(',')) t = t.slice(0, -1);
        // Remove truncated string value (e.g., ..."partial text)
        if (t.endsWith('"')) {
          // Check if this is an unclosed string â find the opening quote
          const lastQuote = t.lastIndexOf('"', t.length - 2);
          if (lastQuote > -1) {
            const beforeQuote = t.substring(0, lastQuote).trimEnd();
            if (beforeQuote.endsWith(':') || beforeQuote.endsWith(',')) {
              t = beforeQuote.endsWith(':') ? beforeQuote + '""' : beforeQuote.slice(0, -1);
            }
          }
        }
        // Count open/close braces and brackets
        let braces = 0, brackets = 0;
        for (const c of t) {
          if (c === '{') braces++;
          else if (c === '}') braces--;
          else if (c === '[') brackets++;
          else if (c === ']') brackets--;
        }
        // Add missing closers
        let closer = '';
        while (brackets > 0) { closer += ']'; brackets--; }
        while (braces > 0) { closer += '}'; braces--; }
        try {
          const result = JSON.parse(t + closer);
          if (result && typeof result === 'object') {
            logger.info('adapter', `${this.name} recovered truncated JSON successfully`, { originalLen: text.length, recoveredKeys: Object.keys(result).length });
            return result;
          }
        } catch (e) {
          // Try removing the last property (might be partial)
          const lastComma = t.lastIndexOf(',');
          if (lastComma > 0) {
            t = t.substring(0, lastComma);
          } else {
            break;
          }
        }
      }
    } catch (e) {
      // Recovery failed silently
    }
    return null;
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
