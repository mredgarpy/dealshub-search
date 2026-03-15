// ============================================================
// DealsHub — AliExpress Adapter (AliExpress DataHub via RapidAPI)
// ============================================================
const { BaseAdapter, emptySearchResult, emptyProduct } = require('./base');
const { parsePrice } = require('../utils/pricing');
const logger = require('../utils/logger');

const SEARCH_HOST = 'aliexpress-datahub.p.rapidapi.com';

class AliExpressAdapter extends BaseAdapter {
  constructor(config) {
    super('aliexpress', config);
  }

  async search(query, limit = 12) {
    const url = `https://${SEARCH_HOST}/item/search?q=${encodeURIComponent(query)}&page=1&sort=default`;
    const data = await this.fetchJSON(url, { headers: this.rapidHeaders(SEARCH_HOST) });
    if (!data || !data.result?.resultList) return [];
    return data.result.resultList.slice(0, limit).map(p => this.normalizeSearchResult(p.item || p)).filter(Boolean);
  }

  async getProduct(productId) {
    const url = `https://${SEARCH_HOST}/item/detail?itemId=${encodeURIComponent(productId)}`;
    const data = await this.fetchJSON(url, { headers: this.rapidHeaders(SEARCH_HOST) });
    if (!data || !data.result) {
      // Fallback: try v2 endpoint
      const url2 = `https://${SEARCH_HOST}/item/detail2?itemId=${encodeURIComponent(productId)}`;
      const data2 = await this.fetchJSON(url2, { headers: this.rapidHeaders(SEARCH_HOST) });
      if (data2?.result) return this.normalizeProduct(data2.result);
      logger.warn('aliexpress', `Product not found: ${productId}`);
      return null;
    }
    return this.normalizeProduct(data.result);
  }

  normalizeSearchResult(p) {
    if (!p) return null;
    const price = parsePrice(p.price?.minPrice || p.salePrice || p.sku?.def?.price);
    const origPrice = parsePrice(p.price?.maxPrice || p.originalPrice);
    return {
      id: String(p.itemId || p.productId || ''),
      title: p.title || p.displayTitle || '',
      price: price ? `$${price.toFixed(2)}` : null,
      originalPrice: origPrice && origPrice > (price || 0) ? `$${origPrice.toFixed(2)}` : null,
      image: p.image || (p.images?.[0]) || '',
      url: `https://www.aliexpress.com/item/${p.itemId || p.productId}.html`,
      rating: p.evaluation?.starRating ? parseFloat(p.evaluation.starRating) : null,
      reviews: p.trade?.tradeCount || p.evaluation?.totalCount || 0,
      badge: p.trade?.tradeCount > 1000 ? 'Popular' : null,
      source: 'aliexpress',
      sourceName: 'AliExpress',
      brand: p.store?.name || null
    };
  }

  normalizeProduct(d) {
    const p = emptyProduct();
    p.source = 'aliexpress';
    p.sourceId = String(d.itemId || d.productId || '');
    p.sourceName = 'AliExpress';
    p.title = d.title || d.subject || '';
    p.brand = d.storeName || d.store?.name || null;
    p.category = d.categoryName || null;
    p.breadcrumbs = d.breadcrumbs?.map(b => b.name) || [];
    p.description = d.description || '';
    p.bullets = d.features || [];

    // Images
    const imgs = d.images || d.imagePathList || [];
    p.images = imgs.map(img => typeof img === 'string' ? img : img.imgUrl || '').filter(Boolean);
    p.primaryImage = p.images[0] || '';

    // Price
    p.price = parsePrice(d.price?.minPrice || d.currentPrice || d.salePrice);
    p.originalPrice = parsePrice(d.price?.maxPrice || d.originalPrice || d.retailPrice);

    // Rating
    p.rating = d.evaluation?.starRating ? parseFloat(d.evaluation.starRating) :
               d.averageRating ? parseFloat(d.averageRating) : null;
    p.reviews = d.evaluation?.totalCount || d.reviews || 0;

    p.availability = 'In Stock';
    p.stockSignal = 'in_stock';

    // Variants / SKU
    if (d.skuModule?.productSKUPropertyList) {
      d.skuModule.productSKUPropertyList.forEach(prop => {
        const option = {
          name: prop.skuPropertyName || 'Option',
          values: (prop.skuPropertyValues || []).map(v => ({
            value: v.propertyValueDefinitionName || v.propertyValueName || '',
            image: v.skuPropertyImagePath || null,
            id: v.propertyValueId || null,
            selected: false
          }))
        };
        p.options.push(option);
      });
    }

    if (d.skuModule?.skuPriceList) {
      p.variants = d.skuModule.skuPriceList.map(sku => ({
        id: sku.skuId || '',
        title: sku.skuAttr || '',
        price: parsePrice(sku.skuVal?.actSkuCalPrice || sku.skuVal?.skuCalPrice),
        image: null,
        available: sku.skuVal?.availQuantity > 0
      }));
    }

    // Shipping
    if (d.shippingModule) {
      const ship = d.shippingModule;
      p.shippingData.cost = ship.freightAmount ? parseFloat(ship.freightAmount) : null;
      p.shippingData.method = ship.deliveryProviderName || 'Standard';
      p.shippingData.note = ship.freightAmount == 0 ? 'FREE Shipping' : 'Shipping calculated at checkout';
      p.deliveryEstimate.minDays = ship.deliveryMinDay || 7;
      p.deliveryEstimate.maxDays = ship.deliveryMaxDay || 21;
      p.deliveryEstimate.label = `${p.deliveryEstimate.minDays}-${p.deliveryEstimate.maxDays} business days`;
    } else {
      p.deliveryEstimate = { minDays: 10, maxDays: 25, label: '10-25 business days' };
      p.shippingData.note = 'International Shipping';
    }

    // Return policy
    p.returnPolicy = { window: 15, summary: 'Returns accepted within 15 days' };

    // Seller
    if (d.store) {
      p.sellerData.name = d.store.name || null;
      p.sellerData.rating = d.store.positiveRate ? parseFloat(d.store.positiveRate) : null;
    }

    p.sourceUrl = `https://www.aliexpress.com/item/${p.sourceId}.html`;
    p.normalizedHandle = this._makeHandle(p.title);
    return p;
  }

  _makeHandle(title) {
    return (title || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').substring(0, 100);
  }
}

module.exports = AliExpressAdapter;
