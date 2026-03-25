// ============================================================
// DealsHub — AliExpress Adapter (AliExpress DataHub via RapidAPI)
// Corrected: underscore URL paths, new response shapes
// Working endpoints: item_search_3, item_detail_2
// ============================================================
const { BaseAdapter, emptySearchResult, emptyProduct } = require('./base');
const { parsePrice } = require('../utils/pricing');
const logger = require('../utils/logger');

const SEARCH_HOST = 'aliexpress-datahub.p.rapidapi.com';

// Endpoint fallback chains — ordered by reliability
const SEARCH_ENDPOINTS = [
  '/item_search_3',  // Confirmed working 2026-03-17
  '/item_search_2',  // Returns 5003 intermittently
  '/item_search_5',  // Alternate
  '/item_search_4',  // Alternate
];

// Primary detail endpoints — item_detail_2 for shipping/origin/seller, item_detail_6 for description/specs/reviews/video
const DETAIL_PRIMARY = '/item_detail_2';
const DETAIL_ENRICHMENT = '/item_detail_6';
const DETAIL_FALLBACK = '/item_detail_3';
const STORE_INFO_ENDPOINT = '/store_info';

// In-memory cache for store_info (24h TTL)
const storeInfoCache = new Map();

class AliExpressAdapter extends BaseAdapter {
  constructor(config) {
    super('aliexpress', { ...config, timeout: 20000 });
  }

  async search(query, limit = 12, options = {}) {
    const pageNum = (options && options.page) || 1;
    // Try each search endpoint with retry logic
    for (const endpoint of SEARCH_ENDPOINTS) {
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const url = `https://${SEARCH_HOST}${endpoint}?q=${encodeURIComponent(query)}&page=${pageNum}&sort=default`;
          logger.info('aliexpress', `Search attempt ${attempt} via ${endpoint}`, { query });
          const data = await this.fetchJSON(url, { headers: this.rapidHeaders(SEARCH_HOST) });

          if (!data) {
            logger.warn('aliexpress', `${endpoint} returned null (HTTP error or timeout)`, { query, attempt });
            if (attempt === 1) { await this._delay(1000); continue; }
            break; // Move to next endpoint
          }

          if (!data.result) {
            logger.warn('aliexpress', `${endpoint} no result key`, { query, keys: Object.keys(data) });
            break;
          }

          // Check for API-level error
          const statusCode = data.result.status?.code;
          if (data.result.status?.data === 'error' || (statusCode && statusCode >= 5000)) {
            logger.warn('aliexpress', `${endpoint} API error code ${statusCode}`, { query });
            break; // Try next endpoint
          }

          // Extract items from ALL possible response shapes
          const items = this._extractSearchItems(data.result);
          if (items.length > 0) {
            logger.info('aliexpress', `Search success via ${endpoint}`, { query, count: items.length, attempt });
            return items.slice(0, limit).map(p => this.normalizeSearchResult(p)).filter(Boolean);
          }

          logger.warn('aliexpress', `${endpoint} returned 0 items`, {
            query, attempt,
            resultKeys: Object.keys(data.result),
            hasResultList: !!data.result.resultList,
            resultListType: data.result.resultList ? typeof data.result.resultList : 'N/A',
            statusData: data.result.status?.data
          });
          break; // No items, try next endpoint
        } catch (e) {
          logger.warn('aliexpress', `${endpoint} exception`, { error: e.message, query, attempt });
          if (attempt === 1) { await this._delay(1000); continue; }
        }
      }
    }
    logger.warn('aliexpress', 'All search endpoints failed', { query });
    return [];
  }

  // Extract items from all known response shapes
  _extractSearchItems(result) {
    let items = [];

    // SHAPE 1 (PRIMARY): result.resultList — array of { item: {...} }
    // This is the confirmed shape for item_search_3 as of 2026-03-17
    if (result.resultList) {
      const rl = result.resultList;
      if (Array.isArray(rl) && rl.length > 0) {
        items = rl.map(entry => entry?.item || entry).filter(i => i && (i.itemId || i.productId || i.title));
        if (items.length > 0) return items;
      }
      // resultList might be an object with numeric keys (rare)
      if (typeof rl === 'object' && !Array.isArray(rl)) {
        const numKeys = Object.keys(rl).filter(k => /^\d+$/.test(k)).sort((a, b) => Number(a) - Number(b));
        for (const k of numKeys) {
          const entry = rl[k];
          if (entry?.item) items.push(entry.item);
          else if (entry?.itemId) items.push(entry);
        }
        if (items.length > 0) return items;
      }
    }

    // SHAPE 2: Numerically indexed items directly on result object
    // { result: { 0: { item: {...} }, 1: { item: {...} }, ... } }
    for (let i = 0; i < 60; i++) {
      if (result[i]?.item) {
        items.push(result[i].item);
      } else if (result[i] && !result[i].item && result[i].itemId) {
        items.push(result[i]);
      } else if (i > 0 && !result[i]) {
        break;
      }
    }
    if (items.length > 0) return items;

    // SHAPE 3: result.items array
    if (Array.isArray(result.items) && result.items.length > 0) {
      return result.items.filter(i => i && (i.itemId || i.title));
    }

    // SHAPE 4: result.data.resultList or result.data.items
    if (result.data?.resultList && Array.isArray(result.data.resultList)) {
      return result.data.resultList.map(e => e?.item || e).filter(i => i && (i.itemId || i.title));
    }

    return items;
  }

  _delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

  // Fetch a single detail endpoint, return raw result or null
  async _fetchDetailEndpoint(endpoint, productId) {
    try {
      const url = `https://${SEARCH_HOST}${endpoint}?itemId=${encodeURIComponent(productId)}`;
      const data = await this.fetchJSON(url, { headers: this.rapidHeaders(SEARCH_HOST) });
      if (!data || !data.result) {
        logger.warn('aliexpress', `${endpoint} returned null/no result`, { productId });
        return null;
      }
      const statusData = data.result.status?.data;
      const statusCode = data.result.status?.code;
      if (statusData === 'error' || (statusCode && statusCode >= 5000)) {
        logger.warn('aliexpress', `${endpoint} API error`, { productId, statusCode });
        return null;
      }
      logger.info('aliexpress', `${endpoint} response OK`, { productId, keys: Object.keys(data.result).join(',') });
      return data.result;
    } catch (e) {
      logger.warn('aliexpress', `${endpoint} failed`, { error: e.message, productId });
      return null;
    }
  }

  // Fetch store_info for seller rating (cached 24h)
  // Returns normalized: { positiveRate, sellerScore, sellerLevel, storeFollowers }
  async _fetchStoreInfo(sellerId) {
    if (!sellerId) return null;
    const cacheKey = String(sellerId);
    const cached = storeInfoCache.get(cacheKey);
    if (cached && (Date.now() - cached.ts < 86400000)) return cached.data;
    try {
      const url = `https://${SEARCH_HOST}${STORE_INFO_ENDPOINT}?sellerId=${encodeURIComponent(sellerId)}`;
      const data = await this.fetchJSON(url, { headers: this.rapidHeaders(SEARCH_HOST) });
      const seller = data?.result?.seller || {};
      const rating = seller.storeRating || {};
      const normalized = {
        positiveRate: rating.sellerPositiveRate || null,
        sellerScore: rating.sellerScore || null,
        sellerLevel: rating.sellerLevel || null,
        storeFollowers: seller.storeFollowers || null,
        storeItemCount: seller.storeItemCount || null,
        storeImage: seller.storeImage || null
      };
      if (normalized.positiveRate) {
        storeInfoCache.set(cacheKey, { data: normalized, ts: Date.now() });
        logger.info('aliexpress', 'store_info fetched', { sellerId, positiveRate: normalized.positiveRate, score: normalized.sellerScore });
      }
      return normalized;
    } catch (e) {
      logger.warn('aliexpress', 'store_info failed', { sellerId, error: e.message });
      return null;
    }
  }

  async getProduct(productId, opts = {}) {
    // ==== STRATEGY: Call item_detail_2 + item_detail_6 in PARALLEL ====
    // item_detail_2: shipping, origin, seller, sku, images, title
    // item_detail_6: description HTML, description images, specs, reviews, video
    // Merge both for a complete PDP

    const [res2, res6] = await Promise.allSettled([
      this._fetchDetailEndpoint(DETAIL_PRIMARY, productId),
      this._fetchDetailEndpoint(DETAIL_ENRICHMENT, productId)
    ]);

    const data2 = res2.status === 'fulfilled' ? res2.value : null;
    const data6 = res6.status === 'fulfilled' ? res6.value : null;

    // If item_detail_2 failed, try fallback endpoint
    let primaryData = data2;
    if (!primaryData || (!primaryData.item && !primaryData.itemId)) {
      logger.warn('aliexpress', 'item_detail_2 failed, trying fallback', { productId });
      primaryData = await this._fetchDetailEndpoint(DETAIL_FALLBACK, productId);
    }

    // If we have primary data, normalize and enrich with item_detail_6
    if (primaryData && (primaryData.item || primaryData.itemId || primaryData.title)) {
      const product = this.normalizeProduct(primaryData);
      if (product) {
        // Enrich with item_detail_6 data
        this._enrichFromDetail6(product, data6);

        // Fetch seller rating from store_info (async, non-blocking)
        const sellerId = primaryData.seller?.sellerId || product.sellerData?.id;
        if (sellerId) {
          try {
            const storeInfo = await this._fetchStoreInfo(sellerId);
            if (storeInfo) {
              if (storeInfo.positiveRate) product.sellerData.rating = parseFloat(storeInfo.positiveRate);
              if (storeInfo.sellerScore) product.sellerData.score = storeInfo.sellerScore;
              if (storeInfo.sellerLevel) product.sellerData.level = storeInfo.sellerLevel;
              if (storeInfo.storeFollowers) product.rawSourceMeta.storeFollowers = storeInfo.storeFollowers;
            }
          } catch (e) { /* non-critical */ }
        }

        if (product.price) return product;
        const priceProduct = await this._fillPriceFromSearch(product, productId);
        if (priceProduct.price) return priceProduct;
      }
    }

    // If only item_detail_6 succeeded, try to normalize from it
    if (data6 && (data6.item || data6.itemId || data6.title)) {
      logger.info('aliexpress', 'Using item_detail_6 as primary (item_detail_2 failed)', { productId });
      const product = this.normalizeProduct(data6);
      if (product) {
        this._enrichFromDetail6(product, data6);
        if (product.price) return product;
        const priceProduct = await this._fillPriceFromSearch(product, productId);
        if (priceProduct.price) return priceProduct;
      }
    }

    // Final fallback: search by productId
    logger.warn('aliexpress', `All detail endpoints failed for ${productId}, trying search fallback`);
    const searchResults = await this.search(productId, 5);
    if (searchResults.length > 0) {
      const exact = searchResults.find(r => String(r.id) === String(productId));
      if (exact) {
        logger.info('aliexpress', `Search fallback found exact match for ${productId}`);
        return this._searchResultToProduct(exact);
      }
    }

    // Title-based search fallback
    if (opts.title) {
      const titleResults = await this.search(opts.title, 5);
      if (titleResults.length > 0) {
        const exactById = titleResults.find(r => String(r.id) === String(productId));
        if (exactById) return this._searchResultToProduct(exactById);
        const result = this._searchResultToProduct(titleResults[0]);
        if (result) result.sourceId = String(productId);
        return result;
      }
    }

    // Last resort
    if (searchResults && searchResults.length > 0) {
      const result = this._searchResultToProduct(searchResults[0]);
      if (result) result.sourceId = String(productId);
      return result;
    }

    return null;
  }

  // Enrich a normalized product with data from item_detail_6
  _enrichFromDetail6(product, data6) {
    if (!data6) return;
    const item6 = data6.item || data6;

    // === Description HTML from item_detail_6 ===
    const desc6 = item6.description;
    if (desc6 && typeof desc6 === 'object') {
      // description.images = array of descriptive image URLs (like A+ content)
      const descImages = (desc6.images || [])
        .filter(img => typeof img === 'string' && img.length > 5)
        .map(img => img.startsWith('//') ? 'https:' + img : img);
      if (descImages.length > 0) {
        product.aplusImages = descImages;
        logger.info('aliexpress', 'Enriched with description images from item_detail_6', {
          productId: product.sourceId, imageCount: descImages.length
        });
      }
      // description.html = full HTML description
      if (desc6.html && typeof desc6.html === 'string' && desc6.html.length > 10) {
        product.description = desc6.html;
      }
    } else if (typeof desc6 === 'string' && desc6.length > 20) {
      // Plain string description from item_detail_6
      if (!product.description || product.description.length < desc6.length) {
        product.description = desc6;
      }
    }

    // Fix: if description is still an object (from item_detail_2), clear it
    if (product.description && typeof product.description === 'object') {
      product.description = '';
    }
    // Safety: prevent "[object Object]"
    if (product.description === '[object Object]') {
      product.description = '';
    }

    // === Specifications from item_detail_6 properties.list ===
    const props6 = item6.properties;
    if (props6 && typeof props6 === 'object') {
      const specList = props6.list || [];
      if (Array.isArray(specList) && specList.length > 0) {
        const specs = specList
          .filter(s => s && typeof s === 'object' && s.name && s.value)
          .map(s => ({ name: String(s.name).trim(), value: String(s.value).trim() }));
        if (specs.length > product.specifications.length) {
          product.specifications = specs;
          product.quickSpecs = specs.slice(0, 10);
          logger.info('aliexpress', 'Enriched specs from item_detail_6', {
            productId: product.sourceId, specCount: specs.length
          });
        }
      }
    }

    // === Reviews from item_detail_6 ===
    const reviews6 = data6.reviews;
    if (reviews6 && typeof reviews6 === 'object') {
      if (reviews6.count && (!product.reviews || reviews6.count > product.reviews)) {
        product.reviews = reviews6.count;
      }
      if (reviews6.averageStar && (!product.rating || reviews6.averageStar > 0)) {
        product.rating = parseFloat(reviews6.averageStar);
      }
      logger.info('aliexpress', 'Enriched reviews from item_detail_6', {
        productId: product.sourceId, count: reviews6.count, avg: reviews6.averageStar
      });
    }

    // === Video from item_detail_6 ===
    if (item6.video && typeof item6.video === 'object' && item6.video.url) {
      const videoUrl = item6.video.url.startsWith('//') ? 'https:' + item6.video.url : item6.video.url;
      if (!product.videos.length || !product.videos.includes(videoUrl)) {
        product.videos = [videoUrl];
        product.hasVideo = true;
        logger.info('aliexpress', 'Enriched video from item_detail_6', { productId: product.sourceId });
      }
    }
  }

  // Normalize search result item — handles both new (item_search_3) and legacy shapes
  normalizeSearchResult(p) {
    if (!p) return null;

    // New shape from item_search_3:
    // { itemId, title, sales, itemUrl, image, sku: { def: { price, promotionPrice } },
    //   averageStarRate, type, delivery: { freeShipping, shippingFee }, sellingPoints: [] }
    const price = parsePrice(
      p.sku?.def?.promotionPrice || p.sku?.def?.price ||
      p.price?.minPrice || p.price?.minAmount?.value || p.salePrice
    );
    const origPrice = parsePrice(
      p.sku?.def?.price || p.price?.maxPrice || p.price?.maxAmount?.value || p.originalPrice
    );
    // If promo and orig are the same, no original
    const finalOrigPrice = origPrice && origPrice > (price || 0) ? origPrice : null;

    const salesCount = p.sales || 0;
    const salesNum = typeof salesCount === 'string' ? parseInt(salesCount.replace(/[^0-9]/g, '')) || 0 : salesCount;
    const tradeCount = p.trade?.tradeCount || p.trade?.tradeDesc || salesNum;
    const tradeNum = typeof tradeCount === 'string' ? parseInt(tradeCount.replace(/[^0-9]/g, '')) || 0 : tradeCount;

    const rating = p.averageStarRate ? parseFloat(p.averageStarRate) :
                   p.evaluation?.starRating ? parseFloat(p.evaluation.starRating) : null;

    let imageUrl = p.image || (p.images?.[0]) || '';
    if (imageUrl.startsWith('//')) imageUrl = 'https:' + imageUrl;

    const itemId = String(p.itemId || p.productId || '');

    // Extract delivery info from search result
    const deliv = p.delivery || {};
    const shipFee = deliv.shippingFee ? parseFloat(deliv.shippingFee) : null;
    const isFreeShip = deliv.freeShipping === true || shipFee === 0;

    return {
      id: itemId,
      title: p.title || p.displayTitle || '',
      price: price ? `$${price.toFixed(2)}` : null,
      originalPrice: finalOrigPrice ? `$${finalOrigPrice.toFixed(2)}` : null,
      image: imageUrl,
      url: p.itemUrl ? (p.itemUrl.startsWith('//') ? 'https:' + p.itemUrl : p.itemUrl) :
           `https://www.aliexpress.com/item/${itemId}.html`,
      rating: rating,
      reviews: p.evaluation?.totalCount || p.trade?.reviewCount || 0,
      badge: tradeNum > 1000 ? 'Popular' :
             (rating && rating >= 4.5 ? 'Top Rated' :
             (isFreeShip ? 'Free Shipping' : null)),
      source: 'aliexpress',
      sourceName: 'AliExpress',
      brand: p.store?.name || p.storeName || null,
      isPrime: false,
      deliveryInfo: {
        isFree: isFreeShip,
        cost: shipFee || 0,
        date: deliv.estimateDelivery || null,
        dateRange: null,
        fastest: null,
        threshold: null,
        isPrimeDelivery: false,
        raw: null
      }
    };
  }

  normalizeProduct(d) {
    try { return this._normalizeProductInner(d); }
    catch (e) { logger.error('aliexpress', 'normalizeProduct error', { error: e.message }); return this._normalizeProductFallback(d); }
  }

  _normalizeProductInner(d) {
    const p = emptyProduct();
    p.source = 'aliexpress';
    p.sourceName = 'AliExpress';

    // item_detail_2 shape: data has { item, sku, seller, shipping, ... }
    // Legacy shape: data IS the product directly
    const item = d.item || d;
    const skuData = d.sku || item.sku || d.skuModule || {};
    const sellerData = d.seller || d.store || d.storeModule || {};
    const shippingData = d.shipping || d.shippingModule || d.deliveryModule || {};

    p.sourceId = String(item.itemId || item.productId || d.itemId || d.productId || '');
    p.title = item.title || item.subject || d.title || d.subject || '';
    p.brand = sellerData.storeName || sellerData.name || d.storeName || d.store?.name || null;
    // Breadcrumbs — item_detail_2 has item.breadcrumbs[]
    if (item.breadcrumbs?.length) {
      p.breadcrumbs = item.breadcrumbs.map(b => {
        if (typeof b === 'string') return b;
        return b.title || b.name || null;
      }).filter(Boolean);
    } else if (d.breadcrumbs?.length) {
      p.breadcrumbs = d.breadcrumbs.map(b => {
        if (typeof b === 'string') return b;
        return b.name || b.title || null;
      }).filter(Boolean);
    } else if (d.crossLinkGroupList?.length) {
      p.breadcrumbs = d.crossLinkGroupList.map(g => g.name).filter(Boolean);
    }

    // Category — prefer readable name from breadcrumbs, fall back to API fields
    p.category = d.categoryName || (p.breadcrumbs.length ? p.breadcrumbs[p.breadcrumbs.length - 1] : null);

    // Description — only use string values (item_detail_6 returns {html, images} object — handled by _enrichFromDetail6)
    const descParts = [];
    if (d.description && typeof d.description === 'string' && d.description !== '[object Object]') descParts.push(d.description);
    if (item.description && typeof item.description === 'string' && item.description !== '[object Object]') descParts.push(item.description);
    if (d.descriptionModule?.description) descParts.push(d.descriptionModule.description);
    if (d.descriptionModule?.descriptionUrl) descParts.push('[Full description available]');
    // Properties/specs
    if (d.properties?.length) {
      const specLines = d.properties.filter(sp => sp.name && sp.value).map(sp => `${sp.name}: ${sp.value}`);
      if (specLines.length) descParts.push(specLines.join('\n'));
    }
    if (d.productPropModule?.props?.length) {
      const specLines = d.productPropModule.props.filter(sp => sp.attrName && sp.attrValue).map(sp => `${sp.attrName}: ${sp.attrValue}`);
      if (specLines.length) descParts.push(specLines.join('\n'));
    }
    if (d.pageModule?.description) descParts.push(d.pageModule.description);
    // Also try item.specs or item.itemProperties for specs-based description
    if (item.itemProperties?.length) {
      const specLines = item.itemProperties.filter(sp => sp.name && sp.value).map(sp => `${sp.name}: ${sp.value}`);
      if (specLines.length) descParts.push(specLines.join('\n'));
    }
    if (item.specs?.length) {
      const specLines = item.specs.filter(sp => sp.attrName && sp.attrValue).map(sp => `${sp.attrName}: ${sp.attrValue}`);
      if (specLines.length) descParts.push(specLines.join('\n'));
    }
    p.description = descParts.join('\n\n') || '';
    // Fallback: if no description, build one from available data (title, category, options)
    if (!p.description && p.title) {
      const descFallback = [];
      descFallback.push(p.title);
      // Only join string breadcrumbs to avoid [object Object]
      const readableCrumbs = (p.breadcrumbs || []).filter(b => typeof b === 'string' && b.length > 0);
      if (readableCrumbs.length) descFallback.push('Category: ' + readableCrumbs.join(' > '));
      p.description = descFallback.join('. ');
    }

    // Bullets
    p.bullets = [];
    if (Array.isArray(d.features)) {
      p.bullets = d.features.filter(f => f && typeof f === 'string' && f.trim().length > 0);
    }
    if (d.properties?.length) {
      d.properties.forEach(sp => {
        if (sp.name && sp.value) p.bullets.push(`${sp.name}: ${sp.value}`);
      });
    }
    if (d.productPropModule?.props?.length) {
      d.productPropModule.props.forEach(sp => {
        if (sp.attrName && sp.attrValue) p.bullets.push(`${sp.attrName}: ${sp.attrValue}`);
      });
    }
    if (d.titleModule?.subject && d.titleModule.subject !== p.title) {
      p.bullets.unshift(d.titleModule.subject);
    }

    // Images — item_detail_2 has item.images[]
    const imgSources = item.images || d.images || d.imagePathList || d.imageModule?.imagePathList || [];
    p.images = imgSources.map(img => {
      if (typeof img === 'string') return img;
      return img.imgUrl || img.imageUrl || '';
    }).filter(Boolean);
    p.images = p.images.map(url => url.startsWith('//') ? 'https:' + url : url);
    p.primaryImage = p.images[0] || '';

    // Price — item_detail_2: sku.def.price (can be range "20.91 - 34.71"), sku.def.promotionPrice
    // Also check item.sku (some API responses nest sku inside item)
    const skuDef = skuData.def || item.sku?.def || {};

    // Log price diagnostic info
    logger.info('aliexpress', 'Price extraction debug', {
      productId: p.sourceId,
      hasSkuData: !!d.sku,
      hasItemSku: !!item.sku,
      skuDefKeys: Object.keys(skuDef).join(',') || 'empty',
      itemKeys: Object.keys(item).slice(0, 15).join(','),
      itemPrice: item.price || item.salePrice || item.promotionPrice || 'none',
      dPrice: d.price || 'none',
      settingsPrice: d.settings?.price || 'none'
    });

    const defPrice = typeof skuDef.price === 'string' && skuDef.price.includes('-')
      ? skuDef.price.split('-')[0].trim() // Take low end of range
      : skuDef.price;
    const defPromoPrice = typeof skuDef.promotionPrice === 'string' && skuDef.promotionPrice.includes('-')
      ? skuDef.promotionPrice.split('-')[0].trim()
      : skuDef.promotionPrice;

    p.price = parsePrice(
      defPromoPrice || defPrice ||
      item.sku?.def?.promotionPrice || item.sku?.def?.price ||
      item.price || item.salePrice || item.promotionPrice ||
      d.price?.minPrice || d.price?.minAmount?.value || d.currentPrice ||
      d.salePrice || d.priceModule?.minPrice || d.priceModule?.actMinPrice
    );
    const origPriceRaw = typeof skuDef.price === 'string' && skuDef.price.includes('-')
      ? skuDef.price.split('-')[1].trim() // Take high end as "original"
      : skuDef.price;
    p.originalPrice = parsePrice(
      origPriceRaw || item.sku?.def?.price ||
      item.originalPrice || item.retailPrice ||
      d.price?.maxPrice || d.price?.maxAmount?.value || d.originalPrice ||
      d.retailPrice || d.priceModule?.maxPrice
    );
    if (p.originalPrice && p.price && p.originalPrice <= p.price) p.originalPrice = null;

    // Rating
    p.rating = item.averageStarRate ? parseFloat(item.averageStarRate) :
               d.evaluation?.starRating ? parseFloat(d.evaluation.starRating) :
               d.averageRating ? parseFloat(d.averageRating) :
               d.titleModule?.feedbackRating?.averageStar ? parseFloat(d.titleModule.feedbackRating.averageStar) : null;
    p.reviews = d.evaluation?.totalCount || d.reviews ||
                d.titleModule?.feedbackRating?.totalValidNum || 0;

    // Badge
    const salesCount = item.sales || d.trade?.tradeCount || d.titleModule?.tradeCount || 0;
    const salesNum = typeof salesCount === 'string' ? parseInt(salesCount.replace(/[^0-9]/g, '')) || 0 : salesCount;
    p.badge = salesNum > 10000 ? 'Best Seller' :
              salesNum > 1000 ? 'Popular' :
              (p.rating && p.rating >= 4.8 ? 'Top Rated' : null);

    // Availability — item_detail_2 has item.available
    p.availability = item.available === false ? 'Out of Stock' : 'In Stock';
    p.stockSignal = item.available === false ? 'out_of_stock' : 'in_stock';
    if (skuDef.quantity === 0 || d.quantityModule?.totalAvailQuantity === 0 || d.inventory === 0) {
      p.availability = 'Out of Stock';
      p.stockSignal = 'out_of_stock';
    }

    // Variants — item_detail_2: sku.base[] with { skuId, propMap, price, promotionPrice, quantity }
    // Also sku.props[] for option definitions
    // Build propId:valueId → readable name mapping for resolving coded variant titles
    const propIdMap = {};    // e.g. "14:200003699" → "black"
    const propImageMap = {}; // e.g. "14:200003699" → "https://..."

    if (skuData.props?.length) {
      skuData.props.forEach(prop => {
        const pid = String(prop.pid || prop.skuPropertyId || '');
        const values = prop.values || prop.skuPropertyValues || [];
        const option = {
          name: prop.name || prop.skuPropertyName || 'Option',
          values: values.map(v => {
            const vid = String(v.vid || v.id || v.propertyValueId || '');
            const valName = v.name || v.propertyValueDefinitionName || v.propertyValueName || '';
            const img = v.image ? (v.image.startsWith('//') ? 'https:' + v.image : v.image) :
                        v.skuPropertyImagePath ? (v.skuPropertyImagePath.startsWith('//') ? 'https:' + v.skuPropertyImagePath : v.skuPropertyImagePath) : null;
            // Build mapping: "pid:vid" → readable name and image
            if (pid && vid && valName) {
              propIdMap[`${pid}:${vid}`] = valName;
              if (img) propImageMap[`${pid}:${vid}`] = img;
            }
            return { value: valName, image: img, id: vid || null, selected: false };
          })
        };
        if (option.values.length) p.options.push(option);
      });
    }
    // Legacy: productSKUPropertyList
    if (!p.options.length && d.skuModule?.productSKUPropertyList) {
      d.skuModule.productSKUPropertyList.forEach(prop => {
        const pid = String(prop.skuPropertyId || '');
        const values = prop.skuPropertyValues || [];
        const option = {
          name: prop.skuPropertyName || 'Option',
          values: values.map(v => {
            const vid = String(v.propertyValueId || '');
            const valName = v.propertyValueDefinitionName || v.propertyValueName || '';
            const img = v.skuPropertyImagePath ? (v.skuPropertyImagePath.startsWith('//') ? 'https:' + v.skuPropertyImagePath : v.skuPropertyImagePath) : null;
            if (pid && vid && valName) {
              propIdMap[`${pid}:${vid}`] = valName;
              if (img) propImageMap[`${pid}:${vid}`] = img;
            }
            return { value: valName, image: img, id: vid || null, selected: false };
          })
        };
        p.options.push(option);
      });
    }

    // Filter "Ships From" / "Shipped From" out of visible options — use it for origin classification instead
    const shipsFromOption = p.options.find(o => /ships?\s*from/i.test(o.name));
    if (shipsFromOption) {
      // Extract the US warehouse info for origin classification
      const usValue = shipsFromOption.values.find(v => /united\s*states|US\b/i.test(v.value));
      if (usValue) {
        // Store this info so classifyOrigin can pick it up
        p.rawSourceMeta = p.rawSourceMeta || {};
        p.rawSourceMeta.shipsFrom = usValue.value;
        if (!p.shippingData.shipsFrom) p.shippingData.shipsFrom = usValue.value;
      }
      // Remove "Ships From" from customer-visible options
      p.options = p.options.filter(o => !/ships?\s*from/i.test(o.name));
      logger.info('aliexpress', 'Filtered "Ships From" from variant options', {
        productId: p.sourceId, hadUSValue: !!usValue
      });
    }

    // Helper: resolve coded propMap like "14:200003699;5:100014065" to "black / S"
    function resolvePropMap(propMap) {
      if (!propMap || !Object.keys(propIdMap).length) return propMap || '';
      const parts = propMap.split(';').map(part => {
        const key = part.trim();
        return propIdMap[key] || key; // fallback to raw key if not found
      });
      return parts.join(' / ');
    }

    // Helper: find first image from propMap segments
    function resolveVariantImage(propMap) {
      if (!propMap || !Object.keys(propImageMap).length) return null;
      for (const part of propMap.split(';')) {
        const img = propImageMap[part.trim()];
        if (img) return img;
      }
      return null;
    }

    // SKU variants — resolve coded titles to human-readable names
    if (skuData.base?.length) {
      p.variants = skuData.base.map(sku => ({
        id: String(sku.skuId || ''),
        title: resolvePropMap(sku.propMap),
        price: parsePrice(sku.promotionPrice || sku.price) || p.price,
        image: resolveVariantImage(sku.propMap),
        available: (sku.quantity || 0) > 0
      }));
    } else if (d.skuModule?.skuPriceList) {
      p.variants = d.skuModule.skuPriceList.map(sku => ({
        id: String(sku.skuId || ''),
        title: resolvePropMap(sku.skuAttr || sku.skuPropIds || ''),
        price: parsePrice(sku.skuVal?.actSkuCalPrice || sku.skuVal?.skuCalPrice) || p.price,
        image: resolveVariantImage(sku.skuAttr || sku.skuPropIds || ''),
        available: (sku.skuVal?.availQuantity || 0) > 0
      }));
    }

    // Shipping — item_detail_2 returns delivery.shippingList[] with per-carrier data
    const deliveryData = d.delivery || shippingData || {};
    const shippingList = deliveryData.shippingList || [];

    if (shippingList.length > 0) {
      // Real carrier-level shipping data from item_detail_2
      p.shippingOptions = shippingList.map(opt => ({
        company: opt.shippingCompany || opt.company || 'Standard',
        fee: parseFloat(opt.shippingFee || opt.freightAmount || 0) || 0,
        feeLabel: parseFloat(opt.shippingFee || 0) === 0 ? 'FREE' : `$${parseFloat(opt.shippingFee).toFixed(2)}`,
        time: opt.shippingTime || null,
        estimateDelivery: opt.estimateDelivery || null,
        estimateDeliveryDate: opt.estimateDeliveryDate || null,
        tracking: opt.trackingAvailable || false,
        from: opt.shippingFrom || deliveryData.shippingFrom || null,
        fromCode: opt.shippingFromCode || deliveryData.shippingFromCode || null
      }));

      // Best option: cheapest free, or cheapest overall, with fastest delivery
      const freeOpts = p.shippingOptions.filter(o => o.fee === 0);
      const bestOpt = freeOpts.length > 0
        ? freeOpts.reduce((a, b) => parseInt(a.time || 999) < parseInt(b.time || 999) ? a : b)
        : p.shippingOptions.reduce((a, b) => a.fee < b.fee ? a : b);

      p.shippingData.cost = bestOpt.fee;
      p.shippingData.method = bestOpt.company;
      p.shippingData.isFree = bestOpt.fee === 0;
      p.shippingData.shipsFrom = bestOpt.from || deliveryData.shippingFrom || null;
      p.shippingData.note = bestOpt.fee === 0 ? `FREE ${bestOpt.company}` : `Shipping: $${bestOpt.fee.toFixed(2)}`;

      // Parse delivery time from best option
      const timeStr = bestOpt.time; // e.g. "2-6" or "10-25"
      if (timeStr && timeStr.includes('-')) {
        const parts = timeStr.split('-');
        p.deliveryEstimate.minDays = parseInt(parts[0]) || 7;
        p.deliveryEstimate.maxDays = parseInt(parts[1]) || 21;
      } else if (timeStr) {
        p.deliveryEstimate.minDays = parseInt(timeStr) || 7;
        p.deliveryEstimate.maxDays = p.deliveryEstimate.minDays + 5;
      } else {
        p.deliveryEstimate.minDays = 7;
        p.deliveryEstimate.maxDays = 21;
      }
      p.deliveryEstimate.label = `${p.deliveryEstimate.minDays}-${p.deliveryEstimate.maxDays} business days`;

      // Use estimateDeliveryDate if available
      if (bestOpt.estimateDeliveryDate) {
        p.deliveryEstimate.estimateDeliveryDate = bestOpt.estimateDeliveryDate;
      }

      logger.info('aliexpress', 'Extracted real shipping from shippingList', {
        productId: p.sourceId,
        optionsCount: p.shippingOptions.length,
        bestCompany: bestOpt.company,
        bestFee: bestOpt.fee,
        shipsFrom: p.shippingData.shipsFrom
      });
    } else if (shippingData && Object.keys(shippingData).length) {
      // Legacy shipping data (no shippingList but has basic fields)
      p.shippingData.cost = shippingData.freightAmount != null ? parseFloat(shippingData.freightAmount) :
                            shippingData.shippingFee != null ? parseFloat(shippingData.shippingFee) : null;
      p.shippingData.method = shippingData.deliveryProviderName || shippingData.company || 'Standard';
      p.shippingData.note = (p.shippingData.cost === 0 || shippingData.isFreeShipping || shippingData.freeShipping)
        ? 'FREE Shipping' : 'Shipping calculated at checkout';
      p.shippingData.shipsFrom = deliveryData.shippingFrom || null;
      p.deliveryEstimate.minDays = shippingData.deliveryMinDay || shippingData.deliveryDayMin || 7;
      p.deliveryEstimate.maxDays = shippingData.deliveryMaxDay || shippingData.deliveryDayMax || 21;
      p.deliveryEstimate.label = `${p.deliveryEstimate.minDays}-${p.deliveryEstimate.maxDays} business days`;
      if (p.shippingData.cost == null && shippingData.shippingPrice != null) {
        p.shippingData.cost = parseFloat(shippingData.shippingPrice);
      }
      if (p.shippingData.cost != null && p.shippingData.cost > 0) {
        p.shippingData.note = `Shipping: $${p.shippingData.cost.toFixed(2)}`;
      }
    } else {
      p.deliveryEstimate = { minDays: 10, maxDays: 25, label: '10-25 business days' };
      p.shippingData.note = 'International Shipping';
    }
    // Build formatted delivery dates for PDP
    { const _an=new Date(),_ami=new Date(_an),_amx=new Date(_an);
      _ami.setDate(_ami.getDate()+(p.deliveryEstimate.minDays||10));
      _amx.setDate(_amx.getDate()+(p.deliveryEstimate.maxDays||25));
      const _af=d=>d.toLocaleDateString('en-US',{month:'short',day:'numeric'});
      p.deliveryEstimate.earliestDate=_af(_ami); p.deliveryEstimate.latestDate=_af(_amx);
      p.deliveryEstimate.formattedRange=`${_af(_ami)} – ${_af(_amx)}`; }

    // Return policy
    p.returnPolicy = { window: 15, summary: 'Returns accepted within 15 days' };
    if (d.buyerProtectionModule?.freightCommitment) {
      p.returnPolicy.summary = 'Free returns within 15 days';
    }

    // Seller — item_detail_2 has seller object with storeTitle, sellerId, storeId, storeUrl, storeImage
    if (sellerData && (sellerData.storeTitle || sellerData.storeName || sellerData.name)) {
      p.sellerData.name = sellerData.storeTitle || sellerData.storeName || sellerData.name || null;
      p.sellerData.rating = sellerData.positiveRate ? parseFloat(sellerData.positiveRate) :
                            sellerData.positiveNum ? parseFloat(sellerData.positiveNum) : null;
      p.sellerData.id = sellerData.sellerId ? String(sellerData.sellerId) : null;
      p.sellerData.storeId = sellerData.storeId ? String(sellerData.storeId) : null;
      p.sellerData.storeUrl = sellerData.storeUrl ? (sellerData.storeUrl.startsWith('//') ? 'https:' + sellerData.storeUrl : sellerData.storeUrl) : null;
    } else if (sellerData && (sellerData.name || sellerData.storeName)) {
      p.sellerData.name = sellerData.storeName || sellerData.name || null;
      p.sellerData.rating = sellerData.positiveRate ? parseFloat(sellerData.positiveRate) :
                            sellerData.positiveNum ? parseFloat(sellerData.positiveNum) : null;
    }

    const itemUrl = item.itemUrl || d.itemUrl || '';
    p.sourceUrl = itemUrl ? (itemUrl.startsWith('//') ? 'https:' + itemUrl : itemUrl) :
                  `https://www.aliexpress.com/item/${p.sourceId}.html`;
    p.normalizedHandle = this._makeHandle(p.title);

    // Sprint 3: Rich PDP fields for AliExpress
    // A+ Content / Description images (from descriptionModule or item_description endpoint)
    p.aplusImages = [];
    if (d.descriptionModule?.descriptionUrl) {
      // Store the URL for lazy loading description content
      p.descriptionUrl = d.descriptionModule.descriptionUrl;
    }
    if (d.descriptionImages && Array.isArray(d.descriptionImages)) {
      p.aplusImages = d.descriptionImages.filter(Boolean);
    }

    // Specifications as structured data
    p.specifications = [];
    const props = d.productPropModule?.props || d.properties || item.properties || [];
    if (Array.isArray(props)) {
      p.specifications = props
        .filter(prop => prop && (prop.attrName || prop.name) && (prop.attrValue || prop.value))
        .map(prop => ({
          name: (prop.attrName || prop.name || '').trim(),
          value: (prop.attrValue || prop.value || '').trim()
        }));
    }
    p.quickSpecs = p.specifications.slice(0, 10);

    // Rating distribution (AliExpress may not always provide this)
    p.ratingDistribution = null;
    if (d.feedbackModule?.ratingDistribution || d.ratingDistribution) {
      const rd = d.feedbackModule?.ratingDistribution || d.ratingDistribution;
      p.ratingDistribution = {};
      for (let i = 1; i <= 5; i++) {
        p.ratingDistribution[i] = rd[i] || rd[String(i)] || 0;
      }
    }

    // Top reviews (from item_review if available)
    p.topReviews = [];
    const reviews = d.reviews || d.feedbackModule?.reviews || [];
    if (Array.isArray(reviews)) {
      p.topReviews = reviews.slice(0, 8).map(r => ({
        title: '',
        comment: r.reviewContent || r.content || r.buyerFeedback || '',
        rating: r.reviewStar || r.buyerEval || 0,
        date: r.reviewDate || r.evalDate || '',
        author: r.buyerName || r.anonymous ? 'Buyer' : '',
        avatar: r.buyerHeadPortrait || null,
        images: Array.isArray(r.reviewImages || r.images) ? (r.reviewImages || r.images) : [],
        isVerified: true,
        helpfulVotes: '',
        variant: r.skuInfo || null,
        country: r.buyerCountry || null
      })).filter(r => r.comment);
    }

    // Frequently bought together (AliExpress typically doesn't provide this directly)
    p.frequentlyBoughtTogether = [];

    // Sales volume
    p.salesVolume = salesNum > 0 ? `${salesNum}+ sold` : null;

    // Product condition (AliExpress items are generally new)
    p.productCondition = 'New';

    // Videos
    p.videos = [];
    const videoUrl = item.video || d.imageModule?.videoUrl || d.videoModule?.videoUrl || null;
    if (videoUrl) {
      p.videos.push(videoUrl.startsWith('//') ? 'https:' + videoUrl : videoUrl);
    }
    p.hasVideo = p.videos.length > 0;

    // Buyer protection details
    if (d.buyerProtectionModule) {
      const bpm = d.buyerProtectionModule;
      if (bpm.returnDays) {
        p.returnPolicy.window = parseInt(bpm.returnDays) || 15;
        p.returnPolicy.summary = `Returns accepted within ${p.returnPolicy.window} days`;
      }
      if (bpm.freightCommitment) {
        p.returnPolicy.summary = `Free returns within ${p.returnPolicy.window} days`;
      }
    }

    p.upc = null;
    p.productSlug = null;

    // Raw source meta
    p.rawSourceMeta = {
      itemId: p.sourceId,
      salesCount: salesNum,
      totalAvailQuantity: skuDef.quantity || d.quantityModule?.totalAvailQuantity || null,
      storeId: sellerData.storeId || d.storeModule?.storeId || null,
      storeName: p.sellerData.name,
      storePositiveRate: p.sellerData.rating,
      storeFollowers: sellerData.followers || d.storeModule?.followingNumber || null,
      buyerProtection: d.buyerProtectionModule?.desc || null,
      freightCommitment: d.buyerProtectionModule?.freightCommitment || false,
      descriptionUrl: d.descriptionModule?.descriptionUrl || null,
      categoryId: item.catId || d.categoryId || null,
      wishlistCount: d.wishListModule?.itemWishCount || d.wishCount || null,
      originCountry: d.originModule?.originCountry || deliveryData.shippingFrom || null,
      shipsFrom: deliveryData.shippingFrom || null,
      shipsFromCode: deliveryData.shippingFromCode || null,
      shippingOptionsCount: p.shippingOptions.length,
      hasVideo: !!(item.video || d.imageModule?.videoUrl || d.videoModule),
      videoUrl: item.video || d.imageModule?.videoUrl || d.videoModule?.videoUrl || null,
      skuCount: (skuData.base?.length || d.skuModule?.skuPriceList?.length || 0),
      available: item.available
    };

    return p;
  }

  _normalizeProductFallback(d) {
    const p = emptyProduct();
    p.source = 'aliexpress';
    const item = d.item || d;
    p.sourceId = String(item.itemId || item.productId || d.itemId || d.productId || '');
    p.sourceName = 'AliExpress';
    p.title = item.title || item.subject || d.title || d.subject || '';
    p.brand = d.storeName || d.store?.name || null;
    p.description = d.description || item.description || '';
    p.bullets = Array.isArray(d.features) ? d.features : [];
    const imgs = item.images || d.images || d.imagePathList || [];
    p.images = imgs.map(img => typeof img === 'string' ? img : (img.imgUrl || '')).filter(Boolean);
    p.images = p.images.map(url => url.startsWith('//') ? 'https:' + url : url);
    p.primaryImage = p.images[0] || '';
    const skuDef = d.sku?.def || {};
    const defPrice = typeof skuDef.price === 'string' && skuDef.price.includes('-') ? skuDef.price.split('-')[0].trim() : skuDef.price;
    p.price = parsePrice(defPrice || d.price?.minPrice || d.salePrice || d.currentPrice);
    p.originalPrice = parsePrice(d.price?.maxPrice || d.originalPrice);
    p.rating = item.averageStarRate ? parseFloat(item.averageStarRate) :
               d.evaluation?.starRating ? parseFloat(d.evaluation.starRating) : null;
    p.reviews = d.evaluation?.totalCount || 0;
    p.availability = item.available === false ? 'Out of Stock' : 'In Stock';
    p.stockSignal = item.available === false ? 'out_of_stock' : 'in_stock';
    { const _n2=new Date(),_a2=new Date(_n2),_b2=new Date(_n2); _a2.setDate(_a2.getDate()+10); _b2.setDate(_b2.getDate()+25);
      const _f2=d=>d.toLocaleDateString('en-US',{month:'short',day:'numeric'});
      p.deliveryEstimate={minDays:10,maxDays:25,label:'10-25 business days',earliestDate:_f2(_a2),latestDate:_f2(_b2),formattedRange:`${_f2(_a2)} – ${_f2(_b2)}`}; }
    p.shippingData.note = 'International Shipping';
    p.returnPolicy = { window: 15, summary: 'Returns accepted within 15 days' };
    const itemUrl = item.itemUrl || '';
    p.sourceUrl = itemUrl ? (itemUrl.startsWith('//') ? 'https:' + itemUrl : itemUrl) :
                  `https://www.aliexpress.com/item/${p.sourceId}.html`;
    p.normalizedHandle = this._makeHandle(p.title);
    return p;
  }

  // Convert a search result card into a full product object (for fallback when detail fails)
  _searchResultToProduct(sr) {
    const p = emptyProduct();
    p.source = 'aliexpress';
    p.sourceId = sr.id || '';
    p.sourceName = 'AliExpress';
    p.title = sr.title || '';
    p.brand = sr.brand || null;
    p.price = parsePrice(sr.price);
    p.originalPrice = parsePrice(sr.originalPrice);
    p.images = sr.image ? [sr.image] : [];
    p.primaryImage = p.images[0] || '';
    p.rating = sr.rating || null;
    p.reviews = sr.reviews || 0;
    p.badge = sr.badge || null;
    p.availability = 'In Stock';
    p.stockSignal = 'in_stock';
    { const _n3=new Date(),_a3=new Date(_n3),_b3=new Date(_n3); _a3.setDate(_a3.getDate()+10); _b3.setDate(_b3.getDate()+25);
      const _f3=d=>d.toLocaleDateString('en-US',{month:'short',day:'numeric'});
      p.deliveryEstimate={minDays:10,maxDays:25,label:'10-25 business days',earliestDate:_f3(_a3),latestDate:_f3(_b3),formattedRange:`${_f3(_a3)} – ${_f3(_b3)}`}; }
    p.shippingData.note = 'International Shipping';
    p.returnPolicy = { window: 15, summary: 'Returns accepted within 15 days' };
    p.sourceUrl = sr.url || `https://www.aliexpress.com/item/${p.sourceId}.html`;
    p.normalizedHandle = this._makeHandle(p.title);
    return p;
  }

  // Fill missing price from search results (detail API sometimes omits price/sku data)
  async _fillPriceFromSearch(product, productId) {
    try {
      const searchResults = await this.search(productId, 5);
      const match = searchResults.find(r => String(r.id) === String(productId));
      if (match) {
        if (!product.price && match.price) product.price = parsePrice(match.price);
        if (!product.originalPrice && match.originalPrice) product.originalPrice = parsePrice(match.originalPrice);
        if (!product.rating && match.rating) product.rating = match.rating;
        if (!product.reviews && match.reviews) product.reviews = match.reviews;
        if (!product.badge && match.badge) product.badge = match.badge;
        if (!product.primaryImage && match.image) {
          product.primaryImage = match.image;
          if (!product.images.length) product.images = [match.image];
        }
        logger.info('aliexpress', 'Filled missing price from search', { productId, price: product.price });
      }
    } catch (e) {
      logger.warn('aliexpress', 'Price fill from search failed', { productId, error: e.message });
    }
    return product;
  }

  _makeHandle(title) {
    return (title || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').substring(0, 100);
  }
}

module.exports = AliExpressAdapter;
