// ============================================================
// DealsHub — Macy's Adapter (via RapidAPI)
// ============================================================
const { BaseAdapter, emptySearchResult, emptyProduct } = require('./base');
const { parsePrice } = require('../utils/pricing');
const logger = require('../utils/logger');

const API_HOST = 'macys4.p.rapidapi.com';

class MacysAdapter extends BaseAdapter {
  constructor(config) { super('macys', { ...config, timeout: 15000 }); }

  async search(query, limit = 12) {
    const url = `https://${API_HOST}/search?keyword=${encodeURIComponent(query)}&pageSize=${limit}&requestType=search`;
    const data = await this.fetchJSON(url, { headers: this.rapidHeaders(API_HOST) });
    // Try multiple response shapes
    let products = data?.searchresultgroups?.[0]?.products?.product;
    if (!products) products = data?.products?.product;
    if (!products) products = data?.items;
    if (!products || !Array.isArray(products)) {
      logger.warn('macys', 'Search returned no results', { query, hasData: !!data });
      return [];
    }
    return products.slice(0, limit).map(p => this.normalizeSearchResult(p)).filter(Boolean);
  }

  async getProduct(productId) {
    const url = `https://${API_HOST}/product?productId=${encodeURIComponent(productId)}`;
    const data = await this.fetchJSON(url, { headers: this.rapidHeaders(API_HOST) });
    if (!data?.product) return null;
    return this.normalizeProduct(data.product);
  }

  normalizeSearchResult(p) {
    if (!p) return null;
    try {
      const detail = p.detail || {};
      const pricing = p.pricing || {};
      const img = p.imagery?.images?.[0]?.filePath || '';
      const price = this._extractPrice(pricing);
      const origPrice = this._extractOrigPrice(pricing);
      return {
        id: String(detail.id || p.id || ''),
        title: detail.name || '',
        price: price ? `$${price.toFixed(2)}` : null,
        originalPrice: origPrice && origPrice > (price || 0) ? `$${origPrice.toFixed(2)}` : null,
        image: img ? `https://slimages.macysassets.com/is/image/MCY/products/${img}` : '',
        url: `https://www.macys.com${detail.defaultCategoryPath || '/shop/product/' + (detail.id || '')}`,
        rating: detail.reviewStatistics?.averageRating ? parseFloat(detail.reviewStatistics.averageRating) : null,
        reviews: detail.reviewStatistics?.reviewCount || 0,
        badge: pricing.badge?.text || null,
        source: 'macys',
        sourceName: "Macy's",
        brand: detail.brand?.name || null
      };
    } catch (e) {
      logger.warn('macys', 'normalizeSearchResult error', { error: e.message });
      return null;
    }
  }

  normalizeProduct(d) {
    try {
      const p = emptyProduct();
      p.source = 'macys';
      p.sourceId = String(d.id || '');
      p.sourceName = "Macy's";
      p.title = d.detail?.name || '';
      p.brand = d.detail?.brand?.name || null;
      p.category = d.detail?.typeName || null;
      p.breadcrumbs = Array.isArray(d.detail?.categoryBreadcrumbs) ? d.detail.categoryBreadcrumbs.map(b => b.name || b) : [];
      p.description = d.detail?.description || d.detail?.shortDescription || '';
      p.bullets = Array.isArray(d.detail?.bulletText) ? d.detail.bulletText : [];

      if (d.imagery?.images && Array.isArray(d.imagery.images)) {
        p.images = d.imagery.images.map(img => {
          const path = img.filePath || '';
          return path.startsWith('http') ? path : `https://slimages.macysassets.com/is/image/MCY/products/${path}`;
        }).filter(Boolean);
      }
      p.primaryImage = p.images[0] || '';

      const pricing = d.pricing || {};
      p.price = this._extractPrice(pricing);
      p.originalPrice = this._extractOrigPrice(pricing);
      p.badge = pricing.badge?.text || null;

      const reviews = d.detail?.reviewStatistics || {};
      p.rating = reviews.averageRating ? parseFloat(reviews.averageRating) : null;
      p.reviews = reviews.reviewCount || 0;

      p.availability = d.availability?.available ? 'In Stock' : 'Limited Stock';
      p.stockSignal = d.availability?.available ? 'in_stock' : 'low_stock';

      if (Array.isArray(d.traits)) {
        d.traits.forEach(trait => {
          p.options.push({
            name: trait.traitName || 'Option',
            values: (trait.traitValues || []).map(v => ({
              value: v.name || v.value || '',
              image: v.swatchImage || null,
              selected: v.isDefault || false
            }))
          });
        });
      }
      if (Array.isArray(d.upcs)) {
        p.variants = d.upcs.map(upc => ({
          id: String(upc.upcNumber || ''),
          title: [upc.color, upc.size].filter(Boolean).join(' / ') || 'Default',
          price: parsePrice(upc.price?.retailPrice) || p.price,
          image: null,
          available: upc.availability?.available !== false
        }));
      }

      p.shippingData.note = 'FREE Shipping on orders over $25';
      p.deliveryEstimate = { minDays: 3, maxDays: 8, label: '3-8 business days' };
      p.returnPolicy = { window: 30, summary: 'Free returns within 30 days' };
      p.sourceUrl = `https://www.macys.com/shop/product/${p.sourceId}`;
      p.normalizedHandle = this._makeHandle(p.title);
      return p;
    } catch (e) {
      logger.error('macys', 'normalizeProduct error', { error: e.message });
      return null;
    }
  }

  _extractPrice(pricing) {
    if (pricing?.tieredPrice?.[0]?.values?.[0]) {
      const v = pricing.tieredPrice[0].values[0];
      return parsePrice(v.value || v.formattedValue);
    }
    return parsePrice(pricing?.price?.regularPrice);
  }

  _extractOrigPrice(pricing) {
    if (pricing?.tieredPrice?.[0]?.values?.length > 1) {
      return parsePrice(pricing.tieredPrice[0].values[1]?.value);
    }
    return null;
  }

  _makeHandle(title) {
    return (title || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').substring(0, 100);
  }
}

module.exports = MacysAdapter;