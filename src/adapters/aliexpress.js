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
    // Try primary search endpoint
    const url = `https://${SEARCH_HOST}/item/search?q=${encodeURIComponent(query)}&page=1&sort=default`;
    const data = await this.fetchJSON(url, { headers: this.rapidHeaders(SEARCH_HOST) });
    if (data?.result?.resultList) {
      return data.result.resultList.slice(0, limit).map(p => this.normalizeSearchResult(p.item || p)).filter(Boolean);
    }
    // Fallback: try /item/search2
    const url2 = `https://${SEARCH_HOST}/item/search2?q=${encodeURIComponent(query)}&page=1&sort=default`;
    const data2 = await this.fetchJSON(url2, { headers: this.rapidHeaders(SEARCH_HOST) });
    if (data2?.result?.resultList) {
      return data2.result.resultList.slice(0, limit).map(p => this.normalizeSearchResult(p.item || p)).filter(Boolean);
    }
    // Fallback: try alternative response shapes
    if (data?.result?.items) {
      return data.result.items.slice(0, limit).map(p => this.normalizeSearchResult(p)).filter(Boolean);
    }
    logger.warn('aliexpress', 'Search returned no results', { query });
    return [];
  }

  async getProduct(productId) {
    const url = `https://${SEARCH_HOST}/item/detail?itemId=${encodeURIComponent(productId)}`;
    const data = await this.fetchJSON(url, { headers: this.rapidHeaders(SEARCH_HOST) });
    if (data?.result) return this.normalizeProduct(data.result);
    // Fallback: try v2 endpoint
    const url2 = `https://${SEARCH_HOST}/item/detail2?itemId=${encodeURIComponent(productId)}`;
    const data2 = await this.fetchJSON(url2, { headers: this.rapidHeaders(SEARCH_HOST) });
    if (data2?.result) return this.normalizeProduct(data2.result);
    logger.warn('aliexpress', `Product not found: ${productId}`);
    return null;
  }

  normalizeSearchResult(p) {
    if (!p) return null;
    const price = parsePrice(p.price?.minPrice || p.price?.minAmount?.value || p.salePrice || p.sku?.def?.price);
    const origPrice = parsePrice(p.price?.maxPrice || p.price?.maxAmount?.value || p.originalPrice);
    const tradeCount = p.trade?.tradeCount || p.trade?.tradeDesc || 0;
    const tradeNum = typeof tradeCount === 'string' ? parseInt(tradeCount.replace(/[^0-9]/g, '')) || 0 : tradeCount;
    return {
      id: String(p.itemId || p.productId || ''),
      title: p.title || p.displayTitle || '',
      price: price ? `$${price.toFixed(2)}` : null,
      originalPrice: origPrice && origPrice > (price || 0) ? `$${origPrice.toFixed(2)}` : null,
      image: p.image || (p.images?.[0]) || '',
      url: `https://www.aliexpress.com/item/${p.itemId || p.productId}.html`,
      rating: p.evaluation?.starRating ? parseFloat(p.evaluation.starRating) : null,
      reviews: p.evaluation?.totalCount || p.trade?.reviewCount || 0,
      badge: tradeNum > 1000 ? 'Popular' : (p.evaluation?.starRating >= 4.5 ? 'Top Rated' : null),
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
    p.sourceId = String(d.itemId || d.productId || d.item?.itemId || '');
    p.sourceName = 'AliExpress';
    p.title = d.title || d.subject || d.item?.title || '';
    p.brand = d.storeName || d.store?.name || d.storeModule?.storeName || null;
    p.category = d.categoryName || d.item?.categoryName || null;

    // Breadcrumbs — try multiple shapes
    if (d.breadcrumbs?.length) {
      p.breadcrumbs = d.breadcrumbs.map(b => b.name || b.title || b).filter(Boolean);
    } else if (d.crossLinkGroupList?.length) {
      p.breadcrumbs = d.crossLinkGroupList.map(g => g.name).filter(Boolean);
    }

    // Description — combine all available text fields
    const descParts = [];
    if (d.description) descParts.push(d.description);
    if (d.item?.description) descParts.push(d.item.description);
    // descriptionModule often has HTML content URL — store it in rawSourceMeta
    if (d.descriptionModule?.descriptionUrl) {
      descParts.push('[Full description available]');
    }
    if (d.descriptionModule?.description) descParts.push(d.descriptionModule.description);
    // productPropModule has key-value specs
    if (d.productPropModule?.props?.length) {
      const specLines = d.productPropModule.props
        .filter(sp => sp.attrName && sp.attrValue)
        .map(sp => `${sp.attrName}: ${sp.attrValue}`);
      if (specLines.length) descParts.push(specLines.join('\n'));
    }
    // pageModule may have description
    if (d.pageModule?.description) descParts.push(d.pageModule.description);
    p.description = descParts.join('\n\n') || '';

    // Bullets — features array, specs, key attributes
    p.bullets = [];
    if (Array.isArray(d.features) && d.features.length) {
      p.bullets = d.features.filter(f => f && typeof f === 'string' && f.trim().length > 0);
    }
    // Add specs as bullets if description is short
    if (d.productPropModule?.props?.length) {
      d.productPropModule.props.forEach(sp => {
        if (sp.attrName && sp.attrValue) {
          p.bullets.push(`${sp.attrName}: ${sp.attrValue}`);
        }
      });
    }
    // titleModule may have subject (subtitle)
    if (d.titleModule?.subject && d.titleModule.subject !== p.title) {
      p.bullets.unshift(d.titleModule.subject);
    }

    // Images — multiple sources
    const imgSources = d.images || d.imagePathList || d.imageModule?.imagePathList || [];
    p.images = imgSources.map(img => {
      if (typeof img === 'string') return img;
      return img.imgUrl || img.imageUrl || '';
    }).filter(Boolean);
    // Ensure HTTPS
    p.images = p.images.map(url => url.startsWith('//') ? 'https:' + url : url);
    p.primaryImage = p.images[0] || '';

    // Price — multiple response shapes
    p.price = parsePrice(
      d.price?.minPrice || d.price?.minAmount?.value || d.currentPrice ||
      d.salePrice || d.priceModule?.minPrice || d.priceModule?.actMinPrice
    );
    p.originalPrice = parsePrice(
      d.price?.maxPrice || d.price?.maxAmount?.value || d.originalPrice ||
      d.retailPrice || d.priceModule?.maxPrice
    );
    // If originalPrice equals or is less than price, null it
    if (p.originalPrice && p.price && p.originalPrice <= p.price) p.originalPrice = null;

    // Rating
    p.rating = d.evaluation?.starRating ? parseFloat(d.evaluation.starRating) :
               d.averageRating ? parseFloat(d.averageRating) :
               d.titleModule?.feedbackRating?.averageStar ? parseFloat(d.titleModule.feedbackRating.averageStar) : null;
    p.reviews = d.evaluation?.totalCount || d.reviews ||
                d.titleModule?.feedbackRating?.totalValidNum || 0;

    // Badge
    const tradeCount = d.trade?.tradeCount || d.titleModule?.tradeCount || 0;
    const tradeNum = typeof tradeCount === 'string' ? parseInt(tradeCount.replace(/[^0-9]/g, '')) || 0 : tradeCount;
    p.badge = tradeNum > 10000 ? 'Best Seller' :
              tradeNum > 1000 ? 'Popular' :
              (p.rating && p.rating >= 4.8 ? 'Top Rated' : null);

    p.availability = 'In Stock';
    p.stockSignal = 'in_stock';
    if (d.quantityModule?.totalAvailQuantity === 0 || d.inventory === 0) {
      p.availability = 'Out of Stock';
      p.stockSignal = 'out_of_stock';
    }

    // Variants / SKU — skuModule (detail endpoint) or productSKUPropertyList
    if (d.skuModule?.productSKUPropertyList) {
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

    if (d.skuModule?.skuPriceList) {
      p.variants = d.skuModule.skuPriceList.map(sku => ({
        id: String(sku.skuId || ''),
        title: sku.skuAttr || sku.skuPropIds || '',
        price: parsePrice(sku.skuVal?.actSkuCalPrice || sku.skuVal?.skuCalPrice || sku.skuVal?.actSkuMultiCurrencyCalPrice) || p.price,
        image: null,
        available: (sku.skuVal?.availQuantity || 0) > 0
      }));
    }

    // Shipping — shippingModule or deliveryModule
    const ship = d.shippingModule || d.deliveryModule;
    if (ship) {
      p.shippingData.cost = ship.freightAmount != null ? parseFloat(ship.freightAmount) : null;
      p.shippingData.method = ship.deliveryProviderName || ship.company || 'Standard';
      p.shippingData.note = (p.shippingData.cost === 0 || ship.isFreeShipping) ? 'FREE Shipping' : 'Shipping calculated at checkout';
      p.deliveryEstimate.minDays = ship.deliveryMinDay || ship.deliveryDayMin || 7;
      p.deliveryEstimate.maxDays = ship.deliveryMaxDay || ship.deliveryDayMax || 21;
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
    if (d.store || d.storeModule) {
      const store = d.store || d.storeModule || {};
      p.sellerData.name = store.name || store.storeName || null;
      p.sellerData.rating = store.positiveRate ? parseFloat(store.positiveRate) :
                            store.positiveNum ? parseFloat(store.positiveNum) : null;
    }

    p.sourceUrl = `https://www.aliexpress.com/item/${p.sourceId}.html`;
    p.normalizedHandle = this._makeHandle(p.title);

    // Raw source meta — all extra fields for operations layer
    p.rawSourceMeta = {
      itemId: p.sourceId,
      tradeCount: tradeNum,
      totalAvailQuantity: d.quantityModule?.totalAvailQuantity || null,
      storeId: d.store?.storeId || d.storeModule?.storeId || null,
      storeName: p.sellerData.name,
      storePositiveRate: p.sellerData.rating,
      storeFollowers: d.store?.followers || d.storeModule?.followingNumber || null,
      buyerProtection: d.buyerProtectionModule?.desc || null,
      freightCommitment: d.buyerProtectionModule?.freightCommitment || false,
      descriptionUrl: d.descriptionModule?.descriptionUrl || null,
      categoryId: d.categoryId || null,
      wishlistCount: d.wishListModule?.itemWishCount || d.wishCount || null,
      originCountry: d.originModule?.originCountry || null,
      hasVideo: !!(d.imageModule?.videoUrl || d.videoModule),
      videoUrl: d.imageModule?.videoUrl || d.videoModule?.videoUrl || null
    };

    return p;
  }

  _normalizeProductFallback(d) {
    const p = emptyProduct();
    p.source = 'aliexpress';
    p.sourceId = String(d.itemId || d.productId || '');
    p.sourceName = 'AliExpress';
    p.title = d.title || d.subject || '';
    p.brand = d.storeName || d.store?.name || null;
    p.description = d.description || '';
    p.bullets = Array.isArray(d.features) ? d.features : [];
    const imgs = d.images || d.imagePathList || [];
    p.images = imgs.map(img => typeof img === 'string' ? img : (img.imgUrl || '')).filter(Boolean);
    p.images = p.images.map(url => url.startsWith('//') ? 'https:' + url : url);
    p.primaryImage = p.images[0] || '';
    p.price = parsePrice(d.price?.minPrice || d.salePrice || d.currentPrice);
    p.originalPrice = parsePrice(d.price?.maxPrice || d.originalPrice);
    p.rating = d.evaluation?.starRating ? parseFloat(d.evaluation.starRating) : null;
    p.reviews = d.evaluation?.totalCount || 0;
    p.availability = 'In Stock';
    p.stockSignal = 'in_stock';
    p.deliveryEstimate = { minDays: 10, maxDays: 25, label: '10-25 business days' };
    p.shippingData.note = 'International Shipping';
    p.returnPolicy = { window: 15, summary: 'Returns accepted within 15 days' };
    p.sourceUrl = `https://www.aliexpress.com/item/${p.sourceId}.html`;
    p.normalizedHandle = this._makeHandle(p.title);
    return p;
  }

  _makeHandle(title) {
    return (title || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').substring(0, 100);
  }
}

module.exports = AliExpressAdapter;
