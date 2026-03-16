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
  }

  normalizeProduct(d) {
    const p = emptyProduct();
    p.source = 'macys';
    p.sourceId = String(d.id || '');
    p.sourceName = "Macy's";
    p.title = d.detail?.name || '';
    p.brand = d.detail?.brand?.name || null;
    p.category = d.detail?.typeName || null;
    p.breadcrumbs = d.detail?.categoryBreadcrumbs?.map(b => b.name) || [];
    p.description = d.detail?.description || d.detail?.shortDescription || '';
    p.bullets = d.detail?.bulletText || [];
    if (d.imagery?.images) {
      p.images = d.imagery.images.map(img => {
        const path = img.filePath || '';
        return path.startsWith('http') ? path : 'https://slimages.macysassets.com/is/image/MCY/products/' + path;
      }).filter(Boolean);
    }
    p.primaryImage = p.images[0] || '';
    const pricing = d.pricing || {};
    p.price = this._extractPrice(pricing);
    p.originalPrice = this._extractOrigPrice(pricing);
    p.badge = pricing.badge && pricing.badge.text || null;
    const reviews = d.detail && d.detail.reviewStatistics || {};
    p.rating = reviews.averageRating ? parseFloat(reviews.averageRating) : null;
    p.reviews = reviews.reviewCount || 0;
    p.availability = d.availability && d.availability.available ? 'In Stock' : 'Limited Stock';
    p.stockSignal = d.availability && d.availability.available ? 'in_stock' : 'low_stock';
    if (d.traits) { d.traits.forEach(t => { p.options.push({ name: t.traitName || 'Option', values: (t.traitValues || []).map(v => ({ value: v.name || v.value || '', image: v.swatchImage || null, selected: v.isDefault || false })) }); }); }
    if (d.upcs) { p.variants = d.upcs.map(u => ({ id: String(u.upcNumber || ''), title: [u.color, u.size].filter(Boolean).join(' / ') || 'Default', price: parsePrice(u.price && u.price.retailPrice) || p.price, image: null, available: u.availability && u.availability.available !== false })); }
    p.shippingData.note = 'FREE Shipping on orders over $25';
    p.deliveryEstimate = { minDays: 3, maxDays: 8, label: '3-8 business days' };
    p.returnPolicy = { window: 30, summary: 'Free returns within 30 days' };
    p.sourceUrl = 'https://www.macys.com/shop/product/' + p.sourceId;
    p.normalizedHandle = this._makeHandle(p.title);
    return p;
  }
  _extractPrice(pricing) { if (pricing && pricing.tieredPrice && pricing.tieredPrice[0] && pricing.tieredPrice[0].values && pricing.tieredPrice[0].values[0]) { const v = pricing.tieredPrice[0].values[0]; return parsePrice(v.value || v.formattedValue); } return parsePrice(pricing && pricing.price && pricing.price.regularPrice); }
  _extractOrigPrice(pricing) { if (pricing && pricing.tieredPrice && pricing.tieredPrice[0] && pricing.tieredPrice[0].values && pricing.tieredPrice[0].values.length > 1) { return parsePrice(pricing.tieredPrice[0].values[1] && pricing.tieredPrice[0].values[1].value); } return null; }
  _makeHandle(title) { return (title || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').substring(0, 100); }
}
module.exports = MacysAdapter;