// ============================================================
// DealsHub — Sephora Adapter (via RapidAPI)
// ============================================================
const { BaseAdapter, emptySearchResult, emptyProduct } = require('./base');
const { parsePrice } = require('../utils/pricing');

const API_HOST = 'sephora.p.rapidapi.com';

class SephoraAdapter extends BaseAdapter {
  constructor(config) { super('sephora', config); }

  async search(query, limit = 12) {
    const url = `https://${API_HOST}/us/products/v2/search?q=${encodeURIComponent(query)}&pageIndex=0&pageSize=${limit}`;
    const data = await this.fetchJSON(url, { headers: this.rapidHeaders(API_HOST) });
    if (!data || !data.products) return [];
    return data.products.slice(0, limit).map(p => this.normalizeSearchResult(p)).filter(Boolean);
  }

  async getProduct(skuId) {
    const url = `https://${API_HOST}/us/products/v2/detail?productId=${encodeURIComponent(skuId)}&preferedSku=${encodeURIComponent(skuId)}`;
    const data = await this.fetchJSON(url, { headers: this.rapidHeaders(API_HOST) });
    if (!data || !data.currentSku) {
      // Try search fallback
      const searchUrl = `https://${API_HOST}/us/products/v2/search?q=${encodeURIComponent(skuId)}&pageIndex=0&pageSize=1`;
      const sData = await this.fetchJSON(searchUrl, { headers: this.rapidHeaders(API_HOST) });
      if (sData?.products?.[0]) return this.normalizeProductFromSearch(sData.products[0]);
      return null;
    }
    return this.normalizeProduct(data);
  }

  normalizeSearchResult(p) {
    if (!p) return null;
    const price = parsePrice(p.currentSku?.listPrice || p.listPrice);
    const img = p.currentSku?.skuImages?.image450 || p.heroImage || p.image450 || '';
    return {
      id: p.currentSku?.skuId || p.productId || '',
      title: p.displayName || p.productName || '',
      price: price ? `$${price.toFixed(2)}` : null,
      originalPrice: null,
      image: img,
      url: `https://www.sephora.com${p.targetUrl || '/product/' + (p.productId || '')}`,
      rating: p.rating ? parseFloat(p.rating) : null,
      reviews: p.reviews || 0,
      badge: p.isNew ? 'New' : (p.isExclusive ? 'Exclusive' : null),
      source: 'sephora',
      sourceName: 'Sephora',
      brand: p.brandName || null
    };
  }

  normalizeProduct(d) {
    const p = emptyProduct();
    p.source = 'sephora';
    p.sourceId = d.currentSku?.skuId || d.productId || '';
    p.sourceName = 'Sephora';
    p.title = d.displayName || d.productName || '';
    p.brand = d.brandName || d.brand?.displayName || null;
    p.category = d.parentCategory?.displayName || null;
    p.breadcrumbs = d.breadcrumbs?.map(b => b.displayName) || [];
    p.description = d.longDescription || d.shortDescription || '';
    p.bullets = d.quickLookDescription ? [d.quickLookDescription] : [];

    // Images
    const skuImgs = d.currentSku?.skuImages;
    if (skuImgs) {
      p.images = [skuImgs.image450, skuImgs.image250, skuImgs.image135].filter(Boolean);
    }
    if (d.alternateImages) p.images.push(...d.alternateImages.map(i => i.image450).filter(Boolean));
    p.primaryImage = p.images[0] || '';

    p.price = parsePrice(d.currentSku?.listPrice || d.listPrice);
    p.originalPrice = parsePrice(d.currentSku?.valuePrice);
    p.rating = d.rating ? parseFloat(d.rating) : null;
    p.reviews = d.reviews || 0;
    p.badge = d.isNew ? 'New' : (d.isExclusive ? 'Exclusive' : null);
    p.availability = d.currentSku?.isOutOfStock ? 'Out of Stock' : 'In Stock';
    p.stockSignal = d.currentSku?.isOutOfStock ? 'out_of_stock' : 'in_stock';

    // Variants (colors/sizes)
    if (d.regularChildSkus) {
      const colorMap = {};
      d.regularChildSkus.forEach(sku => {
        const color = sku.variationValue || 'Default';
        if (!colorMap[color]) colorMap[color] = [];
        colorMap[color].push(sku);
      });
      if (Object.keys(colorMap).length > 1) {
        p.options.push({
          name: d.variationType || 'Color',
          values: Object.keys(colorMap).map(c => ({
            value: c,
            image: colorMap[c][0]?.skuImages?.image135 || null,
            selected: colorMap[c][0]?.skuId === p.sourceId
          }))
        });
      }
      p.variants = d.regularChildSkus.map(sku => ({
        id: sku.skuId || '',
        title: sku.variationValue || 'Default',
        price: parsePrice(sku.listPrice),
        image: sku.skuImages?.image450 || null,
        available: !sku.isOutOfStock
      }));
    }

    p.shippingData.note = 'FREE Standard Shipping';
    p.deliveryEstimate = { minDays: 3, maxDays: 7, label: '3-7 business days' };
    p.returnPolicy = { window: 30, summary: 'Free returns within 30 days' };
    p.sourceUrl = `https://www.sephora.com/product/${p.normalizedHandle || p.sourceId}`;
    p.normalizedHandle = this._makeHandle(p.title);
    return p;
  }

  normalizeProductFromSearch(p) {
    const product = emptyProduct();
    product.source = 'sephora';
    product.sourceId = p.currentSku?.skuId || p.productId || '';
    product.sourceName = 'Sephora';
    product.title = p.displayName || '';
    product.brand = p.brandName || null;
    product.price = parsePrice(p.currentSku?.listPrice || p.listPrice);
    product.images = [p.heroImage || p.currentSku?.skuImages?.image450].filter(Boolean);
    product.primaryImage = product.images[0] || '';
    product.rating = p.rating ? parseFloat(p.rating) : null;
    product.reviews = p.reviews || 0;
    product.availability = 'In Stock';
    product.stockSignal = 'in_stock';
    product.shippingData.note = 'FREE Standard Shipping';
    product.deliveryEstimate = { minDays: 3, maxDays: 7, label: '3-7 business days' };
    product.returnPolicy = { window: 30, summary: 'Free returns within 30 days' };
    product.normalizedHandle = this._makeHandle(product.title);
    return product;
  }

  _makeHandle(title) {
    return (title || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').substring(0, 100);
  }
}

module.exports = SephoraAdapter;
