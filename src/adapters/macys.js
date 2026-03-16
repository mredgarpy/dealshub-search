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
    if (!data?.product) {
      // Try search fallback
      const searchUrl = `https://${API_HOST}/search?keyword=${encodeURIComponent(productId)}&pageSize=1&requestType=search`;
      const sData = await this.fetchJSON(searchUrl, { headers: this.rapidHeaders(API_HOST) });
      const items = sData?.searchresultgroups?.[0]?.products?.product || sData?.products?.product;
      if (items?.[0]) return this.normalizeProductFromSearch(items[0]);
      return null;
    }
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
    try { return this._normalizeProductInner(d); }
    catch (e) { logger.error('macys', 'normalizeProduct error', { error: e.message }); return this.normalizeProductFromSearch(d); }
  }

  _normalizeProductInner(d) {
    const p = emptyProduct();
    p.source = 'macys';
    p.sourceId = String(d.id || '');
    p.sourceName = "Macy's";
    p.title = d.detail?.name || '';
    p.brand = d.detail?.brand?.name || null;
    p.category = d.detail?.typeName || null;
    p.breadcrumbs = d.detail?.categoryBreadcrumbs?.map(b => b.name) || [];

    // Description — combine description, shortDescription, and additional details
    const descParts = [];
    if (d.detail?.description) descParts.push(d.detail.description);
    if (d.detail?.shortDescription && d.detail.shortDescription !== d.detail?.description) {
      descParts.push(d.detail.shortDescription);
    }
    // Care instructions, materials, additional details
    if (d.detail?.additionalDescription) descParts.push(d.detail.additionalDescription);
    if (d.detail?.careInstructions) descParts.push(`Care: ${d.detail.careInstructions}`);
    if (d.detail?.fabricContent) descParts.push(`Material: ${d.detail.fabricContent}`);
    if (d.detail?.countryOfOrigin) descParts.push(`Origin: ${d.detail.countryOfOrigin}`);
    p.description = descParts.join('\n\n') || '';

    // Bullets — bulletText array + product attributes
    p.bullets = [];
    if (Array.isArray(d.detail?.bulletText) && d.detail.bulletText.length) {
      p.bullets = d.detail.bulletText.filter(b => b && typeof b === 'string');
    }
    // Add key attributes as bullets
    if (d.detail?.fabricContent) p.bullets.push(`Material: ${d.detail.fabricContent}`);
    if (d.detail?.careInstructions) p.bullets.push(`Care: ${d.detail.careInstructions}`);
    if (d.detail?.countryOfOrigin) p.bullets.push(`Made in: ${d.detail.countryOfOrigin}`);
    if (d.detail?.gender) p.bullets.push(`For: ${d.detail.gender}`);
    // Product details/specs
    if (d.detail?.productAttributes) {
      d.detail.productAttributes.forEach(attr => {
        if (attr.name && attr.values?.[0]) {
          p.bullets.push(`${attr.name}: ${attr.values.join(', ')}`);
        }
      });
    }

    // Images
    if (d.imagery?.images) {
      p.images = d.imagery.images.map(img => {
        const path = img.filePath || '';
        return path.startsWith('http') ? path : `https://slimages.macysassets.com/is/image/MCY/products/${path}`;
      }).filter(Boolean);
    }
    // Additional images from color swatches
    if (d.imagery?.additionalImages) {
      d.imagery.additionalImages.forEach(img => {
        const url = img.filePath?.startsWith('http') ? img.filePath : `https://slimages.macysassets.com/is/image/MCY/products/${img.filePath}`;
        if (url && !p.images.includes(url)) p.images.push(url);
      });
    }
    p.primaryImage = p.images[0] || '';

    // Price
    const pricing = d.pricing || {};
    p.price = this._extractPrice(pricing);
    p.originalPrice = this._extractOrigPrice(pricing);
    if (p.originalPrice && p.price && p.originalPrice <= p.price) p.originalPrice = null;
    p.badge = pricing.badge?.text || null;

    // Rating
    const reviews = d.detail?.reviewStatistics || {};
    p.rating = reviews.averageRating ? parseFloat(reviews.averageRating) : null;
    p.reviews = reviews.reviewCount || 0;

    // Availability
    p.availability = d.availability?.available ? 'In Stock' : 'Limited Stock';
    p.stockSignal = d.availability?.available ? 'in_stock' : 'low_stock';
    if (d.availability?.upc?.some(u => u.available)) p.stockSignal = 'in_stock';

    // Variants (colors/sizes) from traits
    if (d.traits) {
      d.traits.forEach(trait => {
        p.options.push({
          name: trait.traitName || 'Option',
          values: (trait.traitValues || []).map(v => ({
            value: v.name || v.value || '',
            image: v.swatchImage ? (v.swatchImage.startsWith('http') ? v.swatchImage : `https://slimages.macysassets.com/is/image/MCY/products/${v.swatchImage}`) : null,
            selected: v.isDefault || false
          }))
        });
      });
    }
    if (d.upcs) {
      p.variants = d.upcs.map(upc => ({
        id: String(upc.upcNumber || ''),
        title: [upc.color, upc.size].filter(Boolean).join(' / ') || 'Default',
        price: parsePrice(upc.price?.retailPrice) || p.price,
        image: null,
        available: upc.availability?.available !== false
      }));
    }

    // Shipping
    p.shippingData.note = 'FREE Shipping on orders over $25';
    p.shippingData.cost = null;
    p.shippingData.method = 'Standard';
    if (d.detail?.freeShipMessage) p.shippingData.note = d.detail.freeShipMessage;
    p.deliveryEstimate = { minDays: 3, maxDays: 8, label: '3-8 business days' };

    // Return policy
    p.returnPolicy = { window: 30, summary: 'Free returns within 30 days' };
    if (d.detail?.returnPolicy) p.returnPolicy.summary = d.detail.returnPolicy;

    // Seller
    p.sellerData.name = "Macy's";

    p.sourceUrl = `https://www.macys.com/shop/product/${p.sourceId}`;
    p.normalizedHandle = this._makeHandle(p.title);

    // Raw source meta
    p.rawSourceMeta = {
      productWebId: d.detail?.productWebId || d.id,
      brand: p.brand,
      typeName: d.detail?.typeName || null,
      gender: d.detail?.gender || null,
      fabricContent: d.detail?.fabricContent || null,
      careInstructions: d.detail?.careInstructions || null,
      countryOfOrigin: d.detail?.countryOfOrigin || null,
      isOnSale: pricing.badge?.text?.toLowerCase().includes('sale') || false,
      hasFreeShipping: d.detail?.freeShipMessage?.toLowerCase().includes('free') || true,
      colorCount: d.traits?.find(t => t.traitName?.toLowerCase() === 'color')?.traitValues?.length || 0,
      sizeCount: d.traits?.find(t => t.traitName?.toLowerCase() === 'size')?.traitValues?.length || 0,
      upcCount: d.upcs?.length || 0,
      reviewCount: p.reviews,
      averageRating: p.rating
    };

    return p;
  }

  normalizeProductFromSearch(p) {
    const product = emptyProduct();
    product.source = 'macys';
    const detail = p.detail || p;
    const pricing = p.pricing || {};
    product.sourceId = String(detail.id || p.id || '');
    product.sourceName = "Macy's";
    product.title = detail.name || '';
    product.brand = detail.brand?.name || null;
    product.category = detail.typeName || null;
    product.description = detail.description || detail.shortDescription || '';
    product.bullets = Array.isArray(detail.bulletText) ? detail.bulletText : [];
    const img = p.imagery?.images?.[0]?.filePath || '';
    product.images = img ? [`https://slimages.macysassets.com/is/image/MCY/products/${img}`] : [];
    product.primaryImage = product.images[0] || '';
    product.price = this._extractPrice(pricing);
    product.originalPrice = this._extractOrigPrice(pricing);
    product.rating = detail.reviewStatistics?.averageRating ? parseFloat(detail.reviewStatistics.averageRating) : null;
    product.reviews = detail.reviewStatistics?.reviewCount || 0;
    product.badge = pricing.badge?.text || null;
    product.availability = 'In Stock';
    product.stockSignal = 'in_stock';
    product.shippingData.note = 'FREE Shipping on orders over $25';
    product.deliveryEstimate = { minDays: 3, maxDays: 8, label: '3-8 business days' };
    product.returnPolicy = { window: 30, summary: 'Free returns within 30 days' };
    product.sourceUrl = `https://www.macys.com/shop/product/${product.sourceId}`;
    product.normalizedHandle = this._makeHandle(product.title);
    return product;
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
    return parsePrice(pricing?.price?.originalPrice || pricing?.price?.msrp);
  }

  _makeHandle(title) {
    return (title || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').substring(0, 100);
  }
}

module.exports = MacysAdapter;
