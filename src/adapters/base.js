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
      let resp = await fetch(url, { redirect: 'follow', ...options, signal: controller.signal });

      // If we still see a 3xx after redirect: 'follow', manually follow Location header
      if (resp.status >= 300 && resp.status < 400) {
        const location = resp.headers.get('location');
        if (location) {
          logger.info('adapter', `${this.name} manually following ${resp.status} redirect`, { from: url.split('?')[0], to: location.split('?')[0] });
          const redirectUrl = location.startsWith('http') ? location : new URL(location, url).href;
          resp = await fetch(redirectUrl, { ...options, signal: controller.signal, redirect: 'follow' });
        } else {
          // 3xx with no Location — try to read body anyway (some APIs return data with 302)
          logger.warn('adapter', `${this.name} HTTP ${resp.status} with no Location header`, { url: url.split('?')[0] });
          const text = await resp.text();
          if (text && (text.trim().startsWith('{') || text.trim().startsWith('['))) {
            try {
              const parsed = JSON.parse(text);
              logger.info('adapter', `${this.name} extracted JSON from ${resp.status} body (${text.length} chars)`);
              return parsed;
            } catch (e) {
              // Try truncated JSON recovery on 302 bodies too
              if (text.length > 100) {
                const recovered = this._recoverTruncatedJSON(text);
                if (recovered) {
                  logger.info('adapter', `${this.name} recovered truncated JSON from ${resp.status} body`);
                  return recovered;
                }
              }
            }
          }
          return null;
        }
      }

      clearTimeout(timer);
      if (!resp.ok) {
        logger.warn('adapter', `${this.name} HTTP ${resp.status}`, { url: url.split('?')[0] });
        return null;
      }
      if (resp.status === 204) {
        logger.warn('adapter', `${this.name} HTTP 204 No Content`, { url: url.split('?')[0] });
        return null;
      }
      const text = await resp.text();
      if (!text || text.length === 0) {
        logger.warn('adapter', `${this.name} empty response body`, { url: url.split('?')[0] });
        return null;
      }
      try {
        return JSON.parse(text);
      } catch (parseErr) {
        if (text && text.length > 100) {
          logger.warn('adapter', `${this.name} truncated JSON (${text.length} chars), attempting recovery`, { url: url.split('?')[0] });
          const recovered = this._recoverTruncatedJSON(text);
          if (recovered) return recovered;
        }
        logger.error('adapter', `${this.name} fetch error`, { error: 'invalid json at ' + url.split('?')[0] + ': ' + parseErr.message });
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

  async fetchWithRetry(url, options = {}, retries = 1, backoffMs = 2000) {
    for (let attempt = 0; attempt <= retries; attempt++) {
      const result = await this.fetchJSON(url, options);
      if (result !== null) return result;
      if (attempt < retries) {
        const delay = backoffMs * Math.pow(1.5, attempt);
        logger.info('adapter', `${this.name} retry ${attempt + 1}/${retries} after ${Math.round(delay)}ms`, { url: url.split('?')[0] });
        await new Promise(r => setTimeout(r, delay));
      }
    }
    return null;
  }

  _recoverTruncatedJSON(text) {
    try {
      let t = text.trimEnd();
      for (let attempts = 0; attempts < 10; attempts++) {
        if (t.endsWith(',')) t = t.slice(0, -1);
        if (t.endsWith('"')) {
          const lastQuote = t.lastIndexOf('"', t.length - 2);
          if (lastQuote > -1) {
            const beforeQuote = t.substring(0, lastQuote).trimEnd();
            if (beforeQuote.endsWith(':') || beforeQuote.endsWith(',')) {
              t = beforeQuote.endsWith(':') ? beforeQuote + '""' : beforeQuote.slice(0, -1);
            }
          }
        }
        let braces = 0, brackets = 0;
        for (const c of t) {
          if (c === '{') braces++;
          else if (c === '}') braces--;
          else if (c === '[') brackets++;
          else if (c === ']') brackets--;
        }
        let closer = '';
        while (brackets > 0) { closer += ']'; brackets--; }
        while (braces > 0) { closer += '}'; braces--; }
        try {
          const result = JSON.parse(t + closer);
          if (result && typeof result === 'object') {
            logger.info('adapter', `${this.name} recovered truncated JSON`, {
              originalLen: text.length, recoveredKeys: Object.keys(result).length
            });
            return result;
          }
        } catch (e) {
          const lastComma = t.lastIndexOf(',');
          if (lastComma > 0) { t = t.substring(0, lastComma); } else { break; }
        }
      }
    } catch (e) {}
    return null;
  }

  async search(query, limit) { throw new Error('search() not implemented'); }
  async getProduct(sourceId) { throw new Error('getProduct() not implemented'); }
  normalizeSearchResult(raw) { throw new Error('normalizeSearchResult() not implemented'); }
  normalizeProduct(raw) { throw new Error('normalizeProduct() not implemented'); }
}

function emptySearchResult() {
  return {
    id: null, title: '', price: null, originalPrice: null,
    image: '', url: '', rating: null, reviews: 0,
    badge: null, source: '', sourceName: '', brand: null
  };
}

function emptyProduct() {
  return {
    source: '', sourceId: '', sourceName: '',
    title: '', brand: null, category: null, breadcrumbs: [],
    description: '', bullets: [],
    images: [], primaryImage: '',
    price: null, originalPrice: null, currency: 'USD',
    rating: null, reviews: 0, badge: null,
    availability: null, stockSignal: 'unknown',
    options: [], selectedVariant: null, variants: [],
    shippingData: { cost: null, method: null, note: 'Standard shipping' },
    returnPolicy: { window: null, summary: '30-day returns' },
    deliveryEstimate: { minDays: null, maxDays: null, label: null },
    sellerData: { name: null, rating: null },
    sourceUrl: '', normalizedHandle: '',
    lastSyncedAt: null, rawSourceMeta: {}
  };
}

module.exports = { BaseAdapter, emptySearchResult, emptyProduct };
