// ============================================================
// DealsHub â AliExpress Adapter (AliExpress DataHub via RapidAPI)
// Corrected: underscore URL paths, new response shapes
// Working endpoints: item_search_3, item_detail_2
// ============================================================
const { BaseAdapter, emptySearchResult, emptyProduct } = require('./base');
const { parsePrice } = require('../utils/pricing');
const logger = require('../utils/logger');

const SEARCH_HOST = 'aliexpress-datahub.p.rapidapi.com';

// Endpoint fallback chains â ordered by reliability
const SEARCH_ENDPOINTS = [
  '/item_search_3',  // Confirmed working 2026-03-17
  '/item_search_2',  // Returns 5003 intermittently
  '/item_search_5',  // Alternate
  '/item_search_4',  // Alternate
];

const DETAIL_ENDPOINTS = [
  '/item_detail_2',  // Confirmed working 2026-03-17
  '/item_detail_3',  // Alternate
  '/item_detail_6',  // Alternate
];

class AliExpressAdapter extends BaseAdapter {
  constructor(config) {
    super('aliexpress', { ...config, timeout: 20000 });
  }

  async search(query, limit = 12) {
    // Try each search endpoint with retry logic
    for (const endpoint of SEARCH_ENDPOINTS) {
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const url = `https://${SEARCH_HOST}${endpoint}?q=${encodeURIComponent(query)}&page=1&sort=default`;
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

    // SHAPE 1 (PRIMARY): result.resultList â array of { item: {...} }
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

  async getProduct(productId) {
    // Try each detail endpoint in fallback chain
    for (const endpoint of DETAIL_ENDPOINTS) {
      try {
        const url = `https://${SEARCH_HOST}${endpoint}?itemId=${encodeURIComponent(productId)}`;
        const data = await this.fetchJSON(url, { headers: this.rapidHeaders(SEARCH_HOST) });
        if (!data?.result) continue;

        // Check for API-level error
        if (data.result.status?.data === 'error' || data.result.status?.code >= 5000) {
          logger.warn('aliexpress', `${endpoint} returned error`, { productId });
          continue;
        }

        // item_detail_2 shape: { result: { status, settings, item: {...}, sku: {...}, ... } }
        if (data.result.item) {
          logger.info('aliexpress', `Detail success via ${endpoint}`, { productId });
          return this.normalizeProduct(data.result);
        }

        // Legacy shape: result directly is the product data
        if (data.result.itemId || data.result.title) {
          return this.normalizeProduct(data.result);
        }
      } catch (e) {
        logger.warn('aliexpress', `${endpoint} failed`, { error: e.message, productId });
      }
    }

    // Final fallback: search by productId
    logger.warn('aliexpress', `All detail endpoints failed for ${productId}, trying search fallback`);
    const searchResults = await this.search(productId, 3);
    if (searchResults.length > 0) {
      // Return first result as a product (limited data)
      const best = searchResults.find(r => String(r.id) === String(productId)) || searchResults[0];
      return this._searchResultToProduct(best);
    }

    return null;
  }

  // Normalize search result item â handles both new (item_search_3) and legacy shapes
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
             (p.delivery?.freeShipping ? 'Free Shipping' : null)),
      source: 'aliexpress',
      sourceName: 'AliExpress',
      brand: p.store?.name || p.storeName || null
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
    const skuData = d.sku || d.skuModule || {};
    const sellerData = d.seller || d.store || d.storeModule || {};
    const shippingData = d.shipping || d.shippingModule || d.deliveryModule || {};

    p.sourceId = String(item.itemId || item.productId || d.itemId || d.productId || '');
    p.title = item.title || item.subject || d.title || d.subject || '';
    p.brand = sellerData.storeName || sellerData.name || d.storeName || d.store?.name || null;
    p.category = item.catId ? `Category ${item.catId}` : d.categoryName || null;

    // Breadcrumbs â item_detail_2 has item.breadcrumbs[]
    if (item.breadcrumbs?.length) {
      p.breadcrumbs = item.breadcrumbs.map(b => b.title || b.name || b).filter(Boolean);
    } else if (d.breadcrumbs?.length) {
      p.breadcrumbs = d.breadcrumbs.map(b => b.name || b.title || b).filter(Boolean);
    } else if (d.crossLinkGroupList?.length) {
      p.breadcrumbs = d.crossLinkGroupList.map(g => g.name).filter(Boolean);
    }

    // Description
    const descParts = [];
    if (d.description) descParts.push(d.description);
    if (item.description) descParts.push(item.description);
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
    p.description = descParts.join('\n\n') || '';

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

    // Images â item_detail_2 has item.images[]
    const imgSources = item.images || d.images || d.imagePathList || d.imageModule?.imagePathList || [];
    p.images = imgSources.map(img => {
      if (typeof img === 'string') return img;
      return img.imgUrl || img.imageUrl || '';
    }).filter(Boolean);
    p.images = p.images.map(url => url.startsWith('//') ? 'https:' + url : url);
    p.primaryImage = p.images[0] || '';

    // Price â item_detail_2: sku.def.price (can be range "20.91 - 34.71"), sku.def.promotionPrice
    const skuDef = skuData.def || {};
    const defPrice = typeof skuDef.price === 'string' && skuDef.price.includes('-')
      ? skuDef.price.split('-')[0].trim() // Take low end of range
      : skuDef.price;
    const defPromoPrice = typeof skuDef.promotionPrice === 'string' && skuDef.promotionPrice.includes('-')
      ? skuDef.promotionPrice.split('-')[0].trim()
      : skuDef.promotionPrice;

    p.price = parsePrice(
      defPromoPrice || defPrice ||
      d.price?.minPrice || d.price?.minAmount?.value || d.currentPrice ||
      d.salePrice || d.priceModule?.minPrice || d.priceModule?.actMinPrice
    );
    const origPriceRaw = typeof skuDef.price === 'string' && skuDef.price.includes('-')
      ? skuDef.price.split('-')[1].trim() // Take high end as "original"
      : skuDef.price;
    p.originalPrice = parsePrice(
      origPriceRaw || d.price?.maxPrice || d.price?.maxAmount?.value || d.originalPrice ||
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

    // Availability â item_detail_2 has item.available
    p.availability = item.available === false ? 'Out of Stock' : 'In Stock';
    p.stockSignal = item.available === false ? 'out_of_stock' : 'in_stock';
    if (skuDef.quantity === 0 || d.quantityModule?.totalAvailQuantity === 0 || d.inventory === 0) {
      p.availability = 'Out of Stock';
      p.stockSignal = 'out_of_stock';
    }

    // Variants â item_detail_2: sku.base[] with { skuId, propMap, price, promotionPrice, quantity }
    // Also sku.props[] for option definitions
    if (skuData.props?.length) {
      skuData.props.forEach(prop => {
        const option = {
          name: prop.name || prop.skuPropertyName || 'Option',
          values: (prop.values || prop.skuPropertyValues || []).map(v => ({
            value: v.name || v.propertyValueDefinitionName || v.propertyValueName || '',
            image: v.image ? (v.image.startsWith('//') ? 'https:' + v.image : v.image) :
                   v.skuPropertyImagePath ? (v.skuPropertyImagePath.startsWith('//') ? 'https:' + v.skuPropertyImagePath : v.skuPropertyImagePath) : null,
            id: v.id || v.propertyValueId || null,
            selected: false
          }))
        };
        if (option.values.length) p.options.push(option);
      });
    }
    // Legacy: productSKUPropertyList
    if (!p.options.length && d.skuModule?.productSKUPropertyList) {
      d.skuModule.productSKUPropertyList.forEach(prop => {
        const option = {
          name: prop.skuPropertyName || 'Option',
          values: (prop.skuPropertyValues || []).map(v => ({
            value: v.propertyValueDefinitionName || v.propertyValueName || '',
            image: v.skuPropertyImagePath ? (v.skuPropertyImagePath.startsWith('//') ? 'https:' + v.skuPropertyImagePath : v.skuPropertyImagePath) : null,
            id: v.propertyValueId || null,
            selected: false
          }))
        };
        p.options.push(option);
      });
    }

    // SKU variants
    if (skuData.base?.length) {
      p.variants = skuData.base.map(sku => ({
        id: String(sku.skuId || ''),
        title: sku.propMap || '',
        price: parsePrice(sku.promotionPrice || sku.price) || p.price,
        image: null,
        available: (sku.quantity || 0) > 0
      }));
    } else if (d.skuModule?.skuPriceList) {
      p.variants = d.skuModule.skuPriceList.map(sku => ({
        id: String(sku.skuId || ''),
        title: sku.skuAttr || sku.skuPropIds || '',
        price: parsePrice(sku.skuVal?.actSkuCalPrice || sku.skuVal?.skuCalPrice) || p.price,
        image: null,
        available: (sku.skuVal?.availQuantity || 0) > 0
      }));
    }

    // Shipping
    if (shippingData && Object.keys(shippingData).length) {
      p.shippingData.cost = shippingData.freightAmount != null ? parseFloat(shippingData.freightAmount) :
                            shippingData.shippingFee != null ? parseFloat(shippingData.shippingFee) : null;
      p.shippingData.method = shippingData.deliveryProviderName || shippingData.company || 'Standard';
      p.shippingData.note = (p.shippingData.cost === 0 || shippingData.isFreeShipping || shippingData.freeShipping)
        ? 'FREE Shipping' : 'Shipping calculated at checkout';
      p.deliveryEstimate.minDays = shippingData.deliveryMinDay || shippingData.deliveryDayMin || 7;
      p.deliveryEstimate.maxDays = shippingData.deliveryMaxDay || shippingData.deliveryDayMax || 21;
      p.deliveryEstimate.label = `${p.deliveryEstimate.minDays}-${p.deliveryEstimate.maxDays} business days`;
    } else {
      p.deliveryEstimate = { minDays: 10, maxDays: 25, label: '10-25 business days' };
      p.shippingData.note = 'International Shipping';
    }

    // Return policy
    p.returnPolicy = { window: 15, summary: 'Returns accepted within 15 days' };
    if (d.buyerProtectionModule?.freightCommitment) {
      p.returnPolicy.summary = 'Free returns within 15 days';
    }

    // Seller
    if (sellerData && (sellerData.name || sellerData.storeName)) {
      p.sellerData.name = sellerData.storeName || sellerData.name || null;
      p.sellerData.rating = sellerData.positiveRate ? parseFloat(sellerData.positiveRate) :
                            sellerData.positiveNum ? parseFloat(sellerData.positiveNum) : null;
    }

    const itemUrl = item.itemUrl || d.itemUrl || '';
    p.sourceUrl = itemUrl ? (itemUrl.startsWith('//') ? 'https:' + itemUrl : itemUrl) :
                  `https://www.aliexpress.com/item/${p.sourceId}.html`;
    p.normalizedHandle = this._makeHandle(p.title);

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
      originCountry: d.originModule?.originCountry || null,
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
    p.deliveryEstimate = { minDays: 10, maxDays: 25, label: '10-25 business days' };
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
    p.deliveryEstimate = { minDays: 10, maxDays: 25, label: '10-25 business days' };
    p.shippingData.note = 'International Shipping';
    p.returnPolicy = { window: 15, summary: 'Returns accepted within 15 days' };
    p.sourceUrl = sr.url || `https://www.aliexpress.com/item/${p.sourceId}.html`;
    p.normalizedHandle = this._makeHandle(p.title);
    return p;
  }

  _makeHandle(title) {
    return (title || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').substring(0, 100);
  }
}

module.exports = AliExpressAdapter;
