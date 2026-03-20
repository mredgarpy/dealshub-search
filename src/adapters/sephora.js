// ============================================================
// DealsHub Ã¢ÂÂ Sephora Adapter (via RapidAPI)
  const { BaseAdapter, emptySearchResult, emptyProduct } = require('./base');
const { parsePrice } = require('../utils/pricing');
const logger = require('../utils/logger');

const API_HOST = 'sephora.p.rapidapi.com';

class SephoraAdapter extends BaseAdapter {
  constructor(config) { super('sephora', { ...config, timeout: 18000 }); }

  async search(query, limit = 12) {
    const url = `https://${API_HOST}/us/products/v2/search?q=${encodeURIComponent(query)}&pageIndex=0&pageSize=${limit}`;
    const data = await this.fetchJSON(url, { headers: this.rapidHeaders(API_HOST) });
    if (!data) {
      logger.warn('sephora', 'Search returned null/undefined', { query });
      return [];
    }
    // API may return products at data.products or data.data or other shapes
    const products = data.products || data.data || data.items || data.results || [];
    if (!Array.isArray(products) || products.length === 0) {
      logger.warn('sephora', 'Search returned no products array', { query, keys: Object.keys(data).join(','), totalProducts: data.totalProducts || data.total });
      return [];
    }
    return products.slice(0, limit).map(p => this.normalizeSearchResult(p)).filter(Boolean);
  }

  async getProduct(id, options = {}) {
    // id can be productId (P######) or skuId (numeric)
    const isProductId = /^P\d+$/i.test(id);

    // ATTEMPT 1: Try detail endpoint directly
    const productIdParam = isProductId ? id : id;
    const skuParam = isProductId ? '' : id;
    const url = `https://${API_HOST}/us/products/v2/detail?productId=${encodeURIComponent(productIdParam)}${skuParam ? '&preferedSku=' + encodeURIComponent(skuParam) : ''}`;
    const data = await this.fetchWithRetry(url, { headers: this.rapidHeaders(API_HOST) });
    if (data?.currentSku) return this.normalizeProduct(data);

        // FIX: If detail returned 204/null, try getting skuId from search first
        if (!data && isProductId) {
                try {
                          const skuSearchUrl = `https://${API_HOST}/us/products/v2/search?q=${encodeURIComponent((options.title || id).split(' ').slice(0, 2).join(' '))}&pageSize=5&currentPage=1`;
                          const skuSearchData = await this.fetchJSON(skuSearchUrl, { headers: this.rapidHeaders(API_HOST) });
                          const skuMatch = skuSearchData?.products?.find(p => p.productId === id);
                          if (skuMatch?.currentSku?.skuId) {
                                      const retryUrl = `https://${API_HOST}/us/products/v2/detail?productId=${encodeURIComponent(id)}&preferedSku=${encodeURIComponent(skuMatch.currentSku.skuId)}`;
                                      const retryData = await this.fetchJSON(retryUrl, { headers: this.rapidHeaders(API_HOST) });
if (retryData?.currentSku) {
                              retryData.displayName = retryData.displayName || skuMatch.displayName;
                              retryData.heroImage = retryData.heroImage || skuMatch.heroImage || skuMatch.image250;
                              retryData.brandName = retryData.brandName || skuMatch.brandName;
                              retryData.productId = retryData.productId || skuMatch.productId || id;
                              retryData.rating = retryData.rating || skuMatch.rating;
                              retryData.reviews = retryData.reviews || skuMatch.reviews;
                              return this.normalizeProduct(retryData);
}
                          }
                } catch (e) { logger.debug('sephora', 'SKU pre-search retry failed: ' + e.message); }
        }

    // If detail returned partial data with enough info, try to normalize it directly
    if (data && data.displayName && data.productId) {
      logger.warn('sephora', `Truncated JSON from detail API, extracting partial data`, { textLen: JSON.stringify(data).length });
      try {
        const partial = this.normalizeProductFromSearch({
          productId: data.productId,
          displayName: data.displayName,
          brandName: data.brandName,
          listPrice: data.listPrice || data.currentSku?.listPrice,
          heroImage: data.heroImage,
          rating: data.rating,
          reviews: data.reviews,
          currentSku: data.currentSku || null,
          longDescription: data.longDescription,
          shortDescription: data.shortDescription
        });
        if (partial && partial.title) return partial;
      } catch (partialErr) {
        logger.debug('sephora', 'Partial normalization failed', { error: partialErr.message });
      }
    }

    // ATTEMPT 2: Search fallback Ã¢ÂÂ works for both productId and skuId formats
    // Use the product name from detail response if available, otherwise search by ID
    const searchQuery = options.title || data?.displayName || id;
    const searchUrl = `https://${API_HOST}/us/products/v2/search?q=${encodeURIComponent(searchQuery)}&pageIndex=0&pageSize=5`;
    const sData = await this.fetchJSON(searchUrl, { headers: this.rapidHeaders(API_HOST) });

    if (sData?.products?.length) {
      // Try to find exact match by productId or skuId
      let match = sData.products.find(p =>
        p.productId === id || String(p.currentSku?.skuId) === String(id)
      );

      // If no exact ID match but we have a title hint, use the first result
      // (search by exact product name is highly likely to return the right product first)
      if (!match && options.title) {
        logger.info('sephora', `No exact ID match for ${id}, using first search result for title "${options.title}"`);
        match = sData.products[0];
      }

      if (match) {
        logger.info('sephora', `Search fallback found product: ${match.displayName} (${match.productId})`);
        return this.normalizeProductFromSearch(match);
      }
    }

    logger.warn('sephora', `No results found for ${id} via search fallback`);
    return null;
  }

  normalizeSearchResult(p) {
    if (!p) return null;
    const price = parsePrice(p.currentSku?.listPrice || p.listPrice);
    const origPrice = parsePrice(p.currentSku?.valuePrice);
    const img = p.currentSku?.skuImages?.image450 || p.heroImage || p.image450 || '';
    return {
      id: p.productId || p.currentSku?.skuId || '',
      title: p.displayName || p.productName || '',
      price: price ? `$${price.toFixed(2)}` : null,
      originalPrice: origPrice && origPrice > (price || 0) ? `$${origPrice.toFixed(2)}` : null,
      image: img,
      url: `https://www.sephora.com${p.targetUrl || '/product/' + (p.productId || '')}`,
      rating: p.rating ? parseFloat(p.rating) : null,
      reviews: p.reviews || 0,
      badge: p.isNew ? 'New' : (p.isExclusive ? 'Exclusive' : (p.isLimitedEdition ? 'Limited Edition' : null)),
      source: 'sephora',
      sourceName: 'Sephora',
      brand: p.brandName || null
    };
  }

  normalizeProduct(d) {
    try { return this._normalizeProductInner(d); }
    catch (e) { logger.error('sephora', 'normalizeProduct error', { error: e.message }); return this.normalizeProductFromSearch(d); }
  }

  _normalizeProductInner(d) {
    const p = emptyProduct();
    p.source = 'sephora';
    p.sourceId = d.currentSku?.skuId || d.productId || '';
    p.sourceName = 'Sephora';
    p.title = d.displayName || d.productName || '';
    p.brand = d.brandName || d.brand?.displayName || null;
    p.category = d.parentCategory?.displayName || null;

    // Breadcrumbs
    if (d.breadcrumbs?.length) {
      p.breadcrumbs = d.breadcrumbs.map(b => b.displayName || b.name || b).filter(Boolean);
    } else if (d.parentCategory) {
      p.breadcrumbs = [d.parentCategory.displayName].filter(Boolean);
    }

    // Description Ã¢ÂÂ combine all text fields for rich content
    const descParts = [];
    if (d.longDescription) descParts.push(d.longDescription);
    if (d.shortDescription && d.shortDescription !== d.longDescription) descParts.push(d.shortDescription);
    if (d.suggestedUsage) descParts.push(`How to Use: ${d.suggestedUsage}`);
    if (d.ingredientDesc) descParts.push(`Ingredients: ${d.ingredientDesc}`);
    p.description = descParts.join('\n\n') || '';

    // Bullets Ã¢ÂÂ quick look + key details
    p.bullets = [];
    if (d.quickLookDescription) p.bullets.push(d.quickLookDescription);
    // Size / value info
    if (d.currentSku?.size) p.bullets.push(`Size: ${d.currentSku.size}`);
    if (d.currentSku?.variationValue) p.bullets.push(`Shade: ${d.currentSku.variationValue}`);
    // Key details from product
    if (d.skinType) p.bullets.push(`Skin Type: ${d.skinType}`);
    if (d.coverage) p.bullets.push(`Coverage: ${d.coverage}`);
    if (d.finish) p.bullets.push(`Finish: ${d.finish}`);
    if (d.formulation) p.bullets.push(`Formulation: ${d.formulation}`);
    if (d.skinConcern) p.bullets.push(`Concerns: ${d.skinConcern}`);
    if (d.hairType) p.bullets.push(`Hair Type: ${d.hairType}`);
    if (d.fragFamily) p.bullets.push(`Fragrance: ${d.fragFamily}`);
    // Product claims / highlights
    if (Array.isArray(d.productHighlights)) {
      d.productHighlights.forEach(h => {
        if (h && typeof h === 'string') p.bullets.push(h);
      });
    }

    // Images Ã¢ÂÂ collect from multiple sources
    p.images = [];
    const skuImgs = d.currentSku?.skuImages;
    if (skuImgs?.image450) p.images.push(skuImgs.image450);
    // Alternate images
    if (d.alternateImages) {
      d.alternateImages.forEach(i => {
        if (i.image450 && !p.images.includes(i.image450)) p.images.push(i.image450);
      });
    }
    // Hero image as fallback
    if (d.heroImage && !p.images.includes(d.heroImage)) p.images.push(d.heroImage);
    p.primaryImage = p.images[0] || '';

    // Price
    p.price = parsePrice(d.currentSku?.listPrice || d.listPrice);
    p.originalPrice = parsePrice(d.currentSku?.valuePrice || d.valuePrice);
    if (p.originalPrice && p.price && p.originalPrice <= p.price) p.originalPrice = null;

    // Rating
    p.rating = d.rating ? parseFloat(d.rating) : null;
    p.reviews = d.reviews || 0;

    // Badge
    p.badge = d.isNew ? 'New' :
              d.isExclusive ? 'Exclusive' :
              d.isLimitedEdition ? 'Limited Edition' :
              d.isOnlyFewLeft ? 'Almost Gone' :
              d.lovesCount > 10000 ? 'Loved' : null;

    // Availability
    p.availability = d.currentSku?.isOutOfStock ? 'Out of Stock' : 'In Stock';
    p.stockSignal = d.currentSku?.isOutOfStock ? 'out_of_stock' : 'in_stock';

    // Variants (colors/sizes)
    if (d.regularChildSkus) {
      const colorMap = {};
      d.regularChildSkus.forEach(sku => {
        const val = sku.variationValue || 'Default';
        if (!colorMap[val]) colorMap[val] = [];
        colorMap[val].push(sku);
      });
      if (Object.keys(colorMap).length > 1) {
        p.options.push({
          name: d.variationType || 'Shade',
          values: Object.keys(colorMap).map(c => ({
            value: c,
            image: colorMap[c][0]?.skuImages?.image135 || null,
            selected: colorMap[c][0]?.skuId === p.sourceId
          }))
        });
      }
      p.variants = d.regularChildSkus.map(sku => ({
        id: sku.skuId || '',
        title: [sku.variationValue, sku.size].filter(Boolean).join(' / ') || 'Default',
        price: parsePrice(sku.listPrice) || p.price,
        image: sku.skuImages?.image450 || null,
        available: !sku.isOutOfStock
      }));
    }

    // Shipping
    p.shippingData.note = 'FREE Standard Shipping';
    p.shippingData.cost = 0;
    p.shippingData.method = 'Standard';
    p.deliveryEstimate = { minDays: 3, maxDays: 7, label: '3-7 business days' };

    // Return policy
    p.returnPolicy = { window: 30, summary: 'Free returns within 30 days' };
    if (d.returnPolicy) p.returnPolicy.summary = d.returnPolicy;

    p.sourceUrl = d.targetUrl ? `https://www.sephora.com${d.targetUrl}` :
                  `https://www.sephora.com/product/${this._makeHandle(p.title)}-P${d.productId || p.sourceId}`;
    p.normalizedHandle = this._makeHandle(p.title);

    // Raw source meta
    p.rawSourceMeta = {
      productId: d.productId || null,
      skuId: d.currentSku?.skuId || null,
      brandId: d.brand?.brandId || null,
      isNew: d.isNew || false,
      isExclusive: d.isExclusive || false,
      isLimitedEdition: d.isLimitedEdition || false,
      isOnlyFewLeft: d.isOnlyFewLeft || false,
      lovesCount: d.lovesCount || 0,
      variationType: d.variationType || null,
      totalChildSkus: d.regularChildSkus?.length || 0,
      hasIngredients: !!d.ingredientDesc,
      hasSuggestedUsage: !!d.suggestedUsage,
      skinType: d.skinType || null,
      coverage: d.coverage || null,
      finish: d.finish || null,
      formulation: d.formulation || null,
      size: d.currentSku?.size || null,
      targetUrl: d.targetUrl || null
    };

    return p;
  }

  normalizeProductFromSearch(p) {
    const product = emptyProduct();
    product.source = 'sephora';
    product.sourceId = p.currentSku?.skuId || p.productId || '';
    product.sourceName = 'Sephora';
    product.title = p.displayName || '';
    product.brand = p.brandName || null;
    product.description = p.longDescription || p.shortDescription || '';
    product.bullets = p.quickLookDescription ? [p.quickLookDescription] : [];
    product.price = parsePrice(p.currentSku?.listPrice || p.listPrice);
    product.originalPrice = parsePrice(p.currentSku?.valuePrice);
    product.images = [p.heroImage || p.currentSku?.skuImages?.image450].filter(Boolean);
    product.primaryImage = product.images[0] || '';
    product.rating = p.rating ? parseFloat(p.rating) : null;
    product.reviews = p.reviews || 0;
    product.badge = p.isNew ? 'New' : (p.isExclusive ? 'Exclusive' : null);
    product.availability = p.currentSku?.isOutOfStock ? 'Out of Stock' : 'In Stock';
    product.stockSignal = p.currentSku?.isOutOfStock ? 'out_of_stock' : 'in_stock';
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
