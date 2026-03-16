// ============================================================
// DealsHub â Macy's Adapter (via RapidAPI)
// Corrected API paths: /api/search/product/ and /api/products/{id}
// ============================================================
const { BaseAdapter, emptySearchResult, emptyProduct } = require('./base');
const { parsePrice } = require('../utils/pricing');
const logger = require('../utils/logger');

const API_HOST = 'macys4.p.rapidapi.com';

class MacysAdapter extends BaseAdapter {
  constructor(config) { super('macys', { ...config, timeout: 18000 }); }

  async search(query, limit = 12) {
    // Correct endpoint: /api/search/product/ with q= param
    const url = `https://${API_HOST}/api/search/product/?q=${encodeURIComponent(query)}&currencyCode=USD&regionCode=US&perPage=${limit}&pageIndex=1`;
    const data = await this.fetchJSON(url, { headers: this.rapidHeaders(API_HOST) });
    // Response shape: { result: { products: [...] } }
    let products = data?.result?.products;
    if (!products || !Array.isArray(products) || products.length === 0) {
      logger.warn('macys', 'Search returned no results', { query, hasData: !!data, keys: data ? Object.keys(data) : [] });
      return [];
    }
    return products.slice(0, limit).map(p => this.normalizeSearchResult(p)).filter(Boolean);
  }

  async getProduct(productId) {
    // Correct endpoint: /api/products/{productId} (path-based)
    const url = `https://${API_HOST}/api/products/${encodeURIComponent(productId)}`;
    const data = await this.fetchJSON(url, { headers: this.rapidHeaders(API_HOST) });
    // Detail response may wrap in result or return product directly
    const product = data?.result || data?.product || data;
    if (product?.detail || product?.identifier) return this.normalizeProduct(product);
    // Fallback: search by ID
    const searchUrl = `https://${API_HOST}/api/search/product/?q=${encodeURIComponent(productId)}&currencyCode=USD&regionCode=US&perPage=3&pageIndex=1`;
    const sData = await this.fetchJSON(searchUrl, { headers: this.rapidHeaders(API_HOST) });
    const items = sData?.result?.products;
    if (items?.length) {
      // Try to find exact match by productId
      const exact = items.find(p => String(p.identifier?.productId || p.id) === String(productId));
      const best = exact || items[0];
      return this.normalizeProductFromSearch(best);
    }
    return null;
  }

  // Search result normalization â new API response shape:
  // { id, identifier: { productId }, detail: { name, brand (string), flags, reviewStatistics: { aggregate: { rating, count } } },
  //   typeName, imagery: { primaryImage: { filePath, urlTemplate } }, pricing: { tieredPrice, badges }, url }
  normalizeSearchResult(p) {
    if (!p) return null;
    const detail = p.detail || {};
    const pricing = p.pricing || {};
    const primaryImg = p.imagery?.primaryImage?.filePath || '';
    const urlTemplate = p.imagery?.primaryImage?.urlTemplate || '';
    const price = this._extractPrice(pricing);
    const origPrice = this._extractOrigPrice(pricing);

    // Build image URL from template or fallback
    let imageUrl = '';
    if (urlTemplate && primaryImg) {
      imageUrl = urlTemplate.replace('[IMAGEFILEPATH]', primaryImg);
    } else if (primaryImg) {
      imageUrl = primaryImg.startsWith('http') ? primaryImg : `https://slimages.macysassets.com/is/image/MCY/products/${primaryImg}`;
    }

    // Rating from new shape: reviewStatistics.aggregate.{rating, count}
    const reviewStats = detail.reviewStatistics?.aggregate || detail.reviewStatistics || {};
    const rating = reviewStats.rating ? parseFloat(reviewStats.rating) :
                   reviewStats.averageRating ? parseFloat(reviewStats.averageRating) : null;
    const reviewCount = reviewStats.count || reviewStats.reviewCount || 0;

    // Badge from pricing.badges array or pricing.badge
    let badge = null;
    if (Array.isArray(pricing.badges) && pricing.badges.length) {
      badge = pricing.badges[0]?.text || pricing.badges[0] || null;
    }
    if (!badge && pricing.badge?.text) badge = pricing.badge.text;

    // Brand â new API returns string directly in detail.brand, old returns object
    const brand = typeof detail.brand === 'string' ? detail.brand :
                  detail.brand?.name || null;

    return {
      id: String(p.identifier?.productId || p.id || detail.id || ''),
      title: detail.name || '',
      price: price ? `$${price.toFixed(2)}` : null,
      originalPrice: origPrice && origPrice > (price || 0) ? `$${origPrice.toFixed(2)}` : null,
      image: imageUrl,
      url: p.url || `https://www.macys.com/shop/product/${p.identifier?.productId || p.id || ''}`,
      rating: rating,
      reviews: reviewCount,
      badge: badge,
      source: 'macys',
      sourceName: "Macy's",
      brand: brand
    };
  }

  normalizeProduct(d) {
    try { return this._normalizeProductInner(d); }
    catch (e) { logger.error('macys', 'normalizeProduct error', { error: e.message }); return this.normalizeProductFromSearch(d); }
  }

  _normalizeProductInner(d) {
    const p = emptyProduct();
    p.source = 'macys';
    p.sourceId = String(d.identifier?.productId || d.id || '');
    p.sourceName = "Macy's";

    const detail = d.detail || {};
    p.title = detail.name || '';
    // Brand â handle both string and object shapes
    p.brand = typeof detail.brand === 'string' ? detail.brand :
              detail.brand?.name || null;
    p.category = d.typeName || detail.typeName || null;

    // Breadcrumbs â from taxonomy or categoryBreadcrumbs
    if (detail.categoryBreadcrumbs?.length) {
      p.breadcrumbs = detail.categoryBreadcrumbs.map(b => b.name || b).filter(Boolean);
    } else if (d.relationships?.taxonomy) {
      p.breadcrumbs = [d.typeName].filter(Boolean);
    }

    // Description
    const descParts = [];
    if (detail.description) descParts.push(detail.description);
    if (detail.shortDescription && detail.shortDescription !== detail.description) {
      descParts.push(detail.shortDescription);
    }
    if (detail.additionalDescription) descParts.push(detail.additionalDescription);
    if (detail.careInstructions) descParts.push(`Care: ${detail.careInstructions}`);
    if (detail.fabricContent) descParts.push(`Material: ${detail.fabricContent}`);
    if (detail.countryOfOrigin) descParts.push(`Origin: ${detail.countryOfOrigin}`);
    p.description = descParts.join('\n\n') || '';

    // Bullets
    p.bullets = [];
    if (Array.isArray(detail.bulletText) && detail.bulletText.length) {
      p.bullets = detail.bulletText.filter(b => b && typeof b === 'string');
    }
    if (detail.fabricContent) p.bullets.push(`Material: ${detail.fabricContent}`);
    if (detail.careInstructions) p.bullets.push(`Care: ${detail.careInstructions}`);
    if (detail.countryOfOrigin) p.bullets.push(`Made in: ${detail.countryOfOrigin}`);
    if (detail.gender) p.bullets.push(`For: ${detail.gender}`);
    if (detail.productAttributes) {
      detail.productAttributes.forEach(attr => {
        if (attr.name && attr.values?.[0]) {
          p.bullets.push(`${attr.name}: ${attr.values.join(', ')}`);
        }
      });
    }

    // Images â from imagery.primaryImage + additionalImages or images array
    p.images = [];
    const urlTemplate = d.imagery?.primaryImage?.urlTemplate || '';
    const primaryFilePath = d.imagery?.primaryImage?.filePath || '';
    if (primaryFilePath) {
      const imgUrl = urlTemplate ? urlTemplate.replace('[IMAGEFILEPATH]', primaryFilePath) :
                     primaryFilePath.startsWith('http') ? primaryFilePath :
                     `https://slimages.macysassets.com/is/image/MCY/products/${primaryFilePath}`;
      p.images.push(imgUrl);
    }
    // Legacy images array
    if (d.imagery?.images) {
      d.imagery.images.forEach(img => {
        const path = img.filePath || '';
        const url = path.startsWith('http') ? path : `https://slimages.macysassets.com/is/image/MCY/products/${path}`;
        if (url && !p.images.includes(url)) p.images.push(url);
      });
    }
    if (d.imagery?.additionalImages) {
      d.imagery.additionalImages.forEach(img => {
        const path = img.filePath || img.origin_image || '';
        const url = path.startsWith('http') ? path : `https://slimages.macysassets.com/is/image/MCY/products/${path}`;
        if (url && !p.images.includes(url)) p.images.push(url);
      });
    }
    p.primaryImage = p.images[0] || '';

    // Price
    const pricing = d.pricing || {};
    p.price = this._extractPrice(pricing);
    p.originalPrice = this._extractOrigPrice(pricing);
    if (p.originalPrice && p.price && p.originalPrice <= p.price) p.originalPrice = null;

    // Badge
    if (Array.isArray(pricing.badges) && pricing.badges.length) {
      p.badge = pricing.badges[0]?.text || pricing.badges[0] || null;
    }
    if (!p.badge && pricing.badge?.text) p.badge = pricing.badge.text;

    // Rating â handle both aggregate and flat shapes
    const reviewStats = detail.reviewStatistics?.aggregate || detail.reviewStatistics || {};
    p.rating = reviewStats.rating ? parseFloat(reviewStats.rating) :
               reviewStats.averageRating ? parseFloat(reviewStats.averageRating) : null;
    p.reviews = reviewStats.count || reviewStats.reviewCount || 0;

    // Availability
    p.availability = d.availability?.available === false ? 'Out of Stock' :
                     d.availability?.available ? 'In Stock' : 'In Stock';
    p.stockSignal = d.availability?.available === false ? 'out_of_stock' : 'in_stock';
    if (d.availability?.upc?.some(u => u.available)) p.stockSignal = 'in_stock';

    // Variants from traits
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
    if (detail.freeShipMessage) p.shippingData.note = detail.freeShipMessage;
    p.deliveryEstimate = { minDays: 3, maxDays: 8, label: '3-8 business days' };

    // Return policy
    p.returnPolicy = { window: 30, summary: 'Free returns within 30 days' };
    if (detail.returnPolicy) p.returnPolicy.summary = detail.returnPolicy;

    // Seller
    p.sellerData.name = "Macy's";

    p.sourceUrl = d.url || `https://www.macys.com/shop/product/${p.sourceId}`;
    p.normalizedHandle = this._makeHandle(p.title);

    // Raw source meta
    p.rawSourceMeta = {
      productWebId: d.identifier?.productId || d.id,
      brand: p.brand,
      typeName: d.typeName || detail.typeName || null,
      gender: detail.gender || null,
      fabricContent: detail.fabricContent || null,
      careInstructions: detail.careInstructions || null,
      countryOfOrigin: detail.countryOfOrigin || null,
      isOnSale: (Array.isArray(pricing.badges) && pricing.badges.some(b => (b?.text || b || '').toLowerCase().includes('sale'))) || false,
      hasFreeShipping: detail.freeShipMessage?.toLowerCase().includes('free') || true,
      colorCount: d.traits?.find(t => t.traitName?.toLowerCase() === 'color')?.traitValues?.length || 0,
      sizeCount: d.traits?.find(t => t.traitName?.toLowerCase() === 'size')?.traitValues?.length || 0,
      upcCount: d.upcs?.length || 0,
      reviewCount: p.reviews,
      averageRating: p.rating,
      flags: detail.flags || null,
      taxonomyCategoryId: d.relationships?.taxonomy?.defaultCategoryId || null
    };

    return p;
  }

  normalizeProductFromSearch(p) {
    const product = emptyProduct();
    product.source = 'macys';
    const detail = p.detail || p;
    const pricing = p.pricing || {};
    product.sourceId = String(p.identifier?.productId || p.id || detail.id || '');
    product.sourceName = "Macy's";
    product.title = detail.name || '';
    // Brand â handle both string and object
    product.brand = typeof detail.brand === 'string' ? detail.brand :
                    detail.brand?.name || null;
    product.category = p.typeName || detail.typeName || null;
    product.description = detail.description || detail.shortDescription || '';
    product.bullets = Array.isArray(detail.bulletText) ? detail.bulletText : [];

    // Image from new shape
    const primaryImg = p.imagery?.primaryImage?.filePath || '';
    const urlTemplate = p.imagery?.primaryImage?.urlTemplate || '';
    let imageUrl = '';
    if (urlTemplate && primaryImg) {
      imageUrl = urlTemplate.replace('[IMAGEFILEPATH]', primaryImg);
    } else if (primaryImg) {
      imageUrl = primaryImg.startsWith('http') ? primaryImg : `https://slimages.macysassets.com/is/image/MCY/products/${primaryImg}`;
    }
    // Fallback to legacy images array
    if (!imageUrl && p.imagery?.images?.[0]?.filePath) {
      const fp = p.imagery.images[0].filePath;
      imageUrl = fp.startsWith('http') ? fp : `https://slimages.macysassets.com/is/image/MCY/products/${fp}`;
    }
    product.images = imageUrl ? [imageUrl] : [];
    product.primaryImage = product.images[0] || '';

    product.price = this._extractPrice(pricing);
    product.originalPrice = this._extractOrigPrice(pricing);

    const reviewStats = detail.reviewStatistics?.aggregate || detail.reviewStatistics || {};
    product.rating = reviewStats.rating ? parseFloat(reviewStats.rating) :
                     reviewStats.averageRating ? parseFloat(reviewStats.averageRating) : null;
    product.reviews = reviewStats.count || reviewStats.reviewCount || 0;

    if (Array.isArray(pricing.badges) && pricing.badges.length) {
      product.badge = pricing.badges[0]?.text || pricing.badges[0] || null;
    }
    if (!product.badge && pricing.badge?.text) product.badge = pricing.badge.text;

    product.availability = 'In Stock';
    product.stockSignal = 'in_stock';
    product.shippingData.note = 'FREE Shipping on orders over $25';
    product.deliveryEstimate = { minDays: 3, maxDays: 8, label: '3-8 business days' };
    product.returnPolicy = { window: 30, summary: 'Free returns within 30 days' };
    product.sourceUrl = p.url || `https://www.macys.com/shop/product/${product.sourceId}`;
    product.normalizedHandle = this._makeHandle(product.title);
    return product;
  }

  _extractPrice(pricing) {
    // tieredPrice shape: [{ values: [{ value, formattedValue, type }] }]
    if (pricing?.tieredPrice?.[0]?.values?.[0]) {
      const v = pricing.tieredPrice[0].values[0];
      return parsePrice(v.value || v.formattedValue);
    }
    return parsePrice(pricing?.price?.regularPrice);
  }

  _extractOrigPrice(pricing) {
    // Second value in tieredPrice is often the original/compare price
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
