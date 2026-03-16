// ============================================================
// DealsHub â Sephora Adapter (via RapidAPI)
// ============================================================
const { BaseAdapter, emptySearchResult, emptyProduct } = require('./base');
const { parsePrice } = require('../utils/pricing');
const logger = require('../utils/logger');

const API_HOST = 'sephora.p.rapidapi.com';

class SephoraAdapter extends BaseAdapter {
  constructor(config) { super('sephora', { ...config, timeout: 18000 }); }

  async search(query, limit = 12) {
    const url = `https://${API_HOST}/us/products/v2/search?q=${encodeURIComponent(query)}&pageIndex=0&pageSize=${limit}`;
    const data = await this.fetchJSON(url, { headers: this.rapidHeaders(API_HOST) });
    if (!data || !data.products) return [];
    return data.products.slice(0, limit).map(p => this.normalizeSearchResult(p)).filter(Boolean);
  }

  async getProduct(id) {
    // id can be productId (P######) or skuId (numeric)
    const isProductId = /^P\d+$/i.test(id);

    // ATTEMPT 1: Try detail endpoint with resilient JSON parsing
    const productIdParam = isProductId ? id : id;
    const skuParam = isProductId ? '' : id;
    const detailUrl = `https://${API_HOST}/us/products/v2/detail?productId=${encodeURIComponent(productIdParam)}${skuParam ? '&preferedSku=' + encodeURIComponent(skuParam) : ''}`;
    const { data, rawText } = await this._fetchDetailResilient(detailUrl);
    if (data?.currentSku) return this.normalizeProduct(data);

    // Extract displayName from partial/truncated JSON response
    let searchQuery = data?.displayName || null;
    if (!searchQuery && rawText) {
      const m = rawText.match(/"displayName"\s*:\s*"([^"]+)"/);
      if (m) searchQuery = m[1];
    }
    searchQuery = searchQuery || id;

    // ATTEMPT 2: Search fallback using displayName or id
    const searchUrl = `https://${API_HOST}/us/products/v2/search?q=${encodeURIComponent(searchQuery)}&pageIndex=0&pageSize=5`;
    const sData = await this.fetchJSON(searchUrl, { headers: this.rapidHeaders(API_HOST) });

    if (sData?.products?.length) {
      // Try to find exact match by productId or skuId
      const exactMatch = sData.products.find(p =>
        p.productId === id || String(p.currentSku?.skuId) === String(id)
      );
      const bestMatch = exactMatch || sData.products[0];

      // If we found a different productId, try detail again with it
      if (!isProductId && bestMatch.productId && bestMatch.productId !== id) {
        const retryUrl = `https://${API_HOST}/us/products/v2/detail?productId=${encodeURIComponent(bestMatch.productId)}&preferedSku=${encodeURIComponent(id)}`;
        const retryData = await this.fetchJSON(retryUrl, { headers: this.rapidHeaders(API_HOST) });
        if (retryData?.currentSku) return this.normalizeProduct(retryData);
      }

      // Fall back to search-based normalization (still provides usable product data)
      logger.warn('sephora', `Detail API failed for ${id}, using search fallback`);
      return this.normalizeProductFromSearch(bestMatch);
    }

    return null;
  }

  async _fetchDetailResilient(url) {
    try {
      const response = await fetch(url, {
        headers: this.rapidHeaders(API_HOST),
        signal: AbortSignal.timeout(this.config?.timeout || 18000)
      });
      if (!response.ok) {
        logger.error('sephora', `Detail API HTTP ${response.status}`, { url: url.substring(0, 80) });
        return { data: null, rawText: '' };
      }
      const rawText = await response.text();
      try {
        const data = JSON.parse(rawText);
        return { data, rawText };
      } catch (e) {
        logger.warn('sephora', 'Truncated JSON from detail API, extracting partial data', { textLen: rawText.length });
        return { data: null, rawText };
      }
    } catch (e) {
      logger.error('sephora', 'Detail fetch error', { error: e.message });
      return { data: null, rawText: '' };
    }
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

    // Description â combine all text fields for rich content
    const descParts = [];
    if (d.longDescription) descParts.push(d.longDescription);
    if (d.shortDescription && d.shortDescription !== d.longDescription) descParts.push(d.shortDescription);
    if (d.suggestedUsage) descParts.push(`How to Use: ${d.suggestedUsage}`);
    if (d.ingredientDesc) descParts.push(`Ingredients: ${d.ingredientDesc}`);
    p.description = descParts.join('\n\n') || '';

    // Bullets â quick look + key details
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

    // Images â collect from multiple sources
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
