// ============================================================
// DealsHub â Macy's Adapter (via RapidAPI)
// Fixed: removed trailing slashes to prevent redirect stripping query params
// Added retry logic and verbose logging
// ============================================================
const { BaseAdapter, emptySearchResult, emptyProduct } = require('./base');
const { parsePrice } = require('../utils/pricing');
const logger = require('../utils/logger');

const API_HOST = 'macys4.p.rapidapi.com';

// Try both URL patterns â without trailing slash first (avoids redirect stripping query params)
const SEARCH_PATHS = [
  '/api/search/product',   // No trailing slash â preferred
  '/api/search/product/'   // With trailing slash â fallback
];

class MacysAdapter extends BaseAdapter {
  constructor(config) { super('macys', { ...config, timeout: 18000 }); }

  async search(query, limit = 12) {
    const params = `q=${encodeURIComponent(query)}&currencyCode=USD&regionCode=US&perPage=${limit}&pageIndex=1`;

    for (const path of SEARCH_PATHS) {
      const url = `https://${API_HOST}${path}?${params}`;
      logger.info('macys', `Search attempt via ${path}`, { query, url: url.substring(0, 120) });

      try {
        const data = await this.fetchJSON(url, { headers: { ...this.rapidHeaders(API_HOST), 'Content-Type': 'application/json' } });

        if (!data) {
          logger.warn('macys', `${path} returned null (HTTP error or timeout)`, { query });
          continue;
        }

        // Rate limit check
        if (data.message && data.message.includes('rate limit')) {
          logger.warn('macys', `Rate limited on search`, { query, message: data.message });
          return []; // Don't retry other paths â rate limit is account-wide
        }

        // Log the response shape for debugging
        const resultKeys = data.result ? Object.keys(data.result) : [];
        const productCount = data.result?.products?.length || 0;
        const tagsQ = data.result?.tags?.q || null;
        logger.info('macys', `${path} response shape`, {
          query,
          hasResult: !!data.result,
          resultKeys,
          productCount,
          tagsQ,
          paginationTotal: data.result?.pagination?.totalProducts || 0
        });

        let products = data?.result?.products;
        if (products && Array.isArray(products) && products.length > 0) {
          logger.info('macys', `Search success via ${path}`, { query, count: products.length });
          return products.slice(0, limit).map(p => this.normalizeSearchResult(p)).filter(Boolean);
        }

        // If tagsQ is null, it means the query param wasn't received â try next path
        if (tagsQ === null || tagsQ === undefined) {
          logger.warn('macys', `${path} tags.q is null â query param likely stripped by redirect`, { query });
          continue;
        }

        // If tagsQ exists but products empty, the query genuinely returned no results
        logger.warn('macys', `${path} returned 0 products for query`, { query, tagsQ });
        return [];

      } catch (e) {
        logger.warn('macys', `${path} exception`, { error: e.message, query });
        continue;
      }
    }

    logger.warn('macys', 'All search paths failed', { query });
    return [];
  }

  async getProduct(productId) {
    // Correct endpoint: /api/products/{productId} (path-based, no trailing slash)
    const url = `https://${API_HOST}/api/products/${encodeURIComponent(productId)}`;
    logger.info('macys', 'getProduct attempt', { productId });
    try {
      const data = await this.fetchWithRetry(url, { headers: { ...this.rapidHeaders(API_HOST), 'Content-Type': 'application/json' } });

      // Rate limit check
      if (data?.message && data.message.includes('rate limit')) {
        logger.warn('macys', 'Rate limited on product detail', { productId, message: data.message });
        // Fall through to search fallback
      } else {
        // New API shape: { status: "success", data: { id, identifier, detail, pricing, imagery, ... } }
        const product = data?.data || data?.result || data?.product || data;
        if (product?.detail || product?.identifier) {
          logger.info('macys', 'getProduct success via detail endpoint', { productId });
          return this.normalizeProduct(product);
        }
        logger.warn('macys', 'Product detail returned unexpected shape', { productId, keys: Object.keys(data || {}) });
      }
    } catch (e) {
      logger.warn('macys', 'Product detail endpoint failed', { productId, error: e.message });
    }

    // Fallback: search by ID (use trailing-slash path + Content-Type header)
    try {
      const searchUrl = `https://${API_HOST}/api/search/product/?q=${encodeURIComponent(productId)}&currencyCode=USD&regionCode=US&perPage=3&pageIndex=1`;
      const sData = await this.fetchJSON(searchUrl, { headers: { ...this.rapidHeaders(API_HOST), 'Content-Type': 'application/json' } });
      const items = sData?.result?.products;
      if (items?.length) {
        const exact = items.find(p => String(p.identifier?.productId || p.id) === String(productId));
        const best = exact || items[0];
        logger.info('macys', 'getProduct success via search fallback', { productId });
        return this.normalizeProductFromSearch(best);
      }
    } catch (e) {
      logger.warn('macys', 'Search fallback also failed', { productId, error: e.message });
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
      badge = this._extractBadge(pricing.badges[0]);
    }
    if (!badge && pricing.badge) badge = this._extractBadge(pricing.badge);

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
      p.badge = this._extractBadge(pricing.badges[0]);
    }
    if (!p.badge && pricing.badge) p.badge = this._extractBadge(pricing.badge);

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
      product.badge = this._extractBadge(pricing.badges[0]);
    }
    if (!product.badge && pricing.badge) product.badge = this._extractBadge(pricing.badge);

    product.availability = 'In Stock';
    product.stockSignal = 'in_stock';
    product.shippingData.note = 'FREE Shipping on orders over $25';
    product.deliveryEstimate = { minDays: 3, maxDays: 8, label: '3-8 business days' };
    product.returnPolicy = { window: 30, summary: 'Free returns within 30 days' };
    product.sourceUrl = p.url || `https://www.macys.com/shop/product/${product.sourceId}`;
    product.normalizedHandle = this._makeHandle(product.title);
    return product;
  }


  _extractBadge(raw) {
    if (!raw) return null;
    if (typeof raw === 'string') return raw;
    if (typeof raw === 'object') return raw.text || raw.description || raw.badgeText || null;
    return String(raw);
  }

  _extractPrice(pricing) {
    // tieredPrice can be at pricing.tieredPrice OR pricing.price.tieredPrice
    const tiered = pricing?.tieredPrice || pricing?.price?.tieredPrice;
    if (tiered?.[0]?.values?.[0]) {
      const v = tiered[0].values[0];
      return parsePrice(v.value || v.formattedValue);
    }
    return parsePrice(pricing?.price?.regularPrice || pricing?.regularPrice);
  }

  _extractOrigPrice(pricing) {
    // Second value in tieredPrice is often the original/compare price
    const tiered = pricing?.tieredPrice || pricing?.price?.tieredPrice;
    if (tiered?.[0]?.values?.length > 1) {
      return parsePrice(tiered[0].values[1]?.value || tiered[0].values[1]?.formattedValue);
    }
    return parsePrice(pricing?.price?.originalPrice || pricing?.price?.msrp);
  }

  _makeHandle(title) {
    return (title || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').substring(0, 100);
  }
}

module.exports = MacysAdapter;
