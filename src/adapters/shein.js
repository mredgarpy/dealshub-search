// ============================================================
// DealsHub - SHEIN Adapter (via RapidAPI)
// ============================================================
const { BaseAdapter, emptySearchResult, emptyProduct } = require('./base');
const { parsePrice } = require('../utils/pricing');
const logger = require('../utils/logger');

const API_HOST = 'unofficial-shein.p.rapidapi.com';

class SheinAdapter extends BaseAdapter {
  constructor(config) { super('shein', { ...config, timeout: 20000 }); }

  async search(query, limit = 12) {
    // Retry up to 2 times for intermittent SHEIN API failures
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const url = `https://${API_HOST}/products/search?keywords=${encodeURIComponent(query)}&language=en&country=US&currency=USD&page=1&limit=${limit}`;
        const data = await this.fetchJSON(url, { headers: this.rapidHeaders(API_HOST) });

        // Log raw response keys for diagnostics
        if (data) {
          const topKeys = Object.keys(data).join(',');
          logger.info('shein', `Search response`, { query, attempt, topKeys, code: data.code, msg: data.msg });
        }

        // Try multiple response shapes
        if (data?.info?.products?.length) {
          return data.info.products.slice(0, limit).map(p => this.normalizeSearchResult(p)).filter(Boolean);
        }
        if (data?.products?.length) {
          return data.products.slice(0, limit).map(p => this.normalizeSearchResult(p)).filter(Boolean);
        }
        if (data?.data?.products?.length) {
          return data.data.products.slice(0, limit).map(p => this.normalizeSearchResult(p)).filter(Boolean);
        }
        // Response came back but empty - could be transient
        if (data && attempt < 2) {
          logger.warn('shein', `Search returned empty on attempt ${attempt}, retrying...`, { query });
          await new Promise(r => setTimeout(r, 1000)); // Brief delay before retry
          continue;
        }
        return [];
      } catch (e) {
        if (attempt < 2) {
          logger.warn('shein', `Search attempt ${attempt} failed, retrying...`, { error: e.message, query });
          await new Promise(r => setTimeout(r, 1000));
          continue;
        }
        logger.error('shein', 'Search failed after retries', { error: e.message, query });
        return [];
      }
    }
    return [];
  }

  async getProduct(productId) {
    // Try multiple detail endpoint variations
    const detailEndpoints = [
      `https://${API_HOST}/products/detail?goods_id=${encodeURIComponent(productId)}&language=en&country=US&currency=USD`,
      `https://${API_HOST}/products/detail?goods_id=${encodeURIComponent(productId)}&language=en&country=US&currency=USD&with_price=true`,
    ];

    for (const url of detailEndpoints) {
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const data = await this.fetchJSON(url, { headers: this.rapidHeaders(API_HOST) });

          // Log raw response structure for diagnostics
          if (data) {
            const topKeys = Object.keys(data).join(',');
            const infoKeys = data.info ? Object.keys(data.info).slice(0, 20).join(',') : 'no-info';
            logger.info('shein', `Detail response`, { productId, attempt, topKeys, infoKeys, hasInfo: !!data.info, code: data.code, msg: data.msg });
          } else {
            logger.warn('shein', `Detail returned null`, { productId, attempt, endpoint: url.split('?')[0] });
          }

          if (data?.info) return this.normalizeProduct(data.info);
          // Some SHEIN API responses nest data differently
          if (data?.data) {
            logger.info('shein', `Detail has data key instead of info`, { productId, dataKeys: Object.keys(data.data).slice(0, 15).join(',') });
            return this.normalizeProduct(data.data);
          }
          if (data && attempt < 2) {
            await new Promise(r => setTimeout(r, 1000));
            continue;
          }
        } catch (e) {
          logger.warn('shein', `Detail attempt ${attempt} failed`, { error: e.message, productId });
          if (attempt < 2) {
            await new Promise(r => setTimeout(r, 1000));
            continue;
          }
        }
      }
    }

    // Fallback to search by ID
    logger.warn('shein', `All detail endpoints failed for ${productId}, trying search fallback`);
    const searchUrl = `https://${API_HOST}/products/search?keywords=${encodeURIComponent(productId)}&language=en&country=US&currency=USD&page=1&limit=5`;
    const sData = await this.fetchJSON(searchUrl, { headers: this.rapidHeaders(API_HOST) });

    // Log search fallback response
    const products = sData?.info?.products || sData?.products || [];
    logger.info('shein', `Search fallback response`, { productId, resultCount: products.length, topKeys: sData ? Object.keys(sData).join(',') : 'null' });

    if (products.length) {
      // Only return exact ID match
      const exact = products.find(p => String(p.goods_id) === String(productId));
      if (exact) {
        logger.info('shein', `Search fallback found exact match for ${productId}`);
        return this.normalizeProductFromSearch(exact);
      }
      logger.warn('shein', `Search fallback found no exact ID match for ${productId}`);
    }
    return null;
  }

  normalizeSearchResult(p) {
    if (!p) return null;
    const price = parsePrice(p.salePrice?.amount || p.sale_price?.amount || p.retailPrice?.amount);
    const origPrice = parsePrice(p.retailPrice?.amount || p.retail_price?.amount);
    const reviews = p.comment?.comment_num || p.comment_num || 0;
    return {
      id: String(p.goods_id || p.goods_sn || ''),
      title: p.goods_name || p.goods_title || '',
      price: price ? `$${price.toFixed(2)}` : null,
      originalPrice: origPrice && origPrice > (price || 0) ? `$${origPrice.toFixed(2)}` : null,
      image: p.goods_img || p.goods_thumb || '',
      url: `https://us.shein.com/${(p.goods_url_name || 'product')}-p-${p.goods_id}.html`,
      rating: p.comment?.comment_rank ? parseFloat(p.comment.comment_rank) : null,
      reviews: reviews,
      badge: p.promotionInfo?.length ? 'Deal' : (reviews > 500 ? 'Popular' : null),
      source: 'shein',
      sourceName: 'SHEIN',
      brand: 'SHEIN'
    };
  }

  normalizeProduct(d) {
    try { return this._normalizeProductInner(d); }
    catch (e) { logger.error('shein', 'normalizeProduct error', { error: e.message }); return this._normalizeProductFallback(d); }
  }

  _normalizeProductInner(d) {
    const p = emptyProduct();
    p.source = 'shein';
    p.sourceId = String(d.goods_id || d.productRelationID || '');
    p.sourceName = 'SHEIN';
    p.title = d.goods_name || d.goods_title || '';
    p.brand = 'SHEIN';
    p.category = d.cat_name || d.cate_name || null;

    // Breadcrumbs
    if (d.parentCats?.length) {
      p.breadcrumbs = d.parentCats.map(c => c.cat_name || c.name).filter(Boolean);
    } else if (d.cat_name) {
      p.breadcrumbs = [d.cat_name];
    }

    // Description - combine all available text sources
    const descParts = [];
    if (d.detail?.description) descParts.push(d.detail.description);
    if (d.goods_desc && d.goods_desc !== d.detail?.description) descParts.push(d.goods_desc);
    // Product attributes (material, pattern, style, etc.)
    if (d.detail?.productDetails?.length) {
      const attrLines = d.detail.productDetails
        .filter(attr => attr.attr_name && attr.attr_value)
        .map(attr => `${attr.attr_name}: ${attr.attr_value}`);
      if (attrLines.length) descParts.push(attrLines.join('\n'));
    }
    // Alternate: productIntroData may have structured description
    if (d.productIntroData?.description) descParts.push(d.productIntroData.description);
    // Size & fit info
    if (d.detail?.sizeTemplate) descParts.push(`Size Guide: ${d.detail.sizeTemplate}`);
    p.description = descParts.join('\n\n') || '';

    // Bullets - structured product attributes + description bullets
    p.bullets = [];
    if (Array.isArray(d.detail?.goods_desc_bullet) && d.detail.goods_desc_bullet.length) {
      p.bullets = d.detail.goods_desc_bullet.filter(b => b && typeof b === 'string');
    }
    // Add product attribute details as bullets
    if (d.detail?.productDetails?.length) {
      d.detail.productDetails.forEach(attr => {
        if (attr.attr_name && attr.attr_value) {
          const bullet = `${attr.attr_name}: ${attr.attr_value}`;
          if (!p.bullets.includes(bullet)) p.bullets.push(bullet);
        }
      });
    }
    // Alternate attributes from different response shapes
    if (d.productDetails?.attrList?.length) {
      d.productDetails.attrList.forEach(attr => {
        if (attr.attr_name && attr.attr_value) {
          const bullet = `${attr.attr_name}: ${attr.attr_value}`;
          if (!p.bullets.includes(bullet)) p.bullets.push(bullet);
        }
      });
    }
    // Material/Composition from common SHEIN fields
    if (d.detail?.materialComposition) p.bullets.push(`Material: ${d.detail.materialComposition}`);
    if (d.detail?.fabricType) p.bullets.push(`Fabric: ${d.detail.fabricType}`);
    if (d.detail?.style) p.bullets.push(`Style: ${d.detail.style}`);
    if (d.detail?.pattern) p.bullets.push(`Pattern: ${d.detail.pattern}`);
    if (d.detail?.neckline) p.bullets.push(`Neckline: ${d.detail.neckline}`);
    if (d.detail?.sleeveLength) p.bullets.push(`Sleeve: ${d.detail.sleeveLength}`);

    // Images - multiple sources
    p.images = [];
    if (d.goods_imgs?.detail_image?.length) {
      p.images = d.goods_imgs.detail_image
        .map(img => img.origin_image || img.medium_image || img.thumbnail || '')
        .filter(Boolean);
    }
    // Main goods_img at front
    if (d.goods_img && !p.images.includes(d.goods_img)) p.images.unshift(d.goods_img);
    // Additional gallery images
    if (d.goods_imgs?.gallery_image?.length) {
      d.goods_imgs.gallery_image.forEach(img => {
        const url = img.origin_image || img.medium_image || '';
        if (url && !p.images.includes(url)) p.images.push(url);
      });
    }
    p.primaryImage = p.images[0] || '';

    // Price
    p.price = parsePrice(d.salePrice?.amount || d.sale_price?.amount || d.retailPrice?.amount);
    p.originalPrice = parsePrice(d.retailPrice?.amount || d.retail_price?.amount);
    if (p.originalPrice && p.price && p.originalPrice <= p.price) p.originalPrice = null;

    // Rating & reviews
    p.rating = d.comment_info?.comment_rank ? parseFloat(d.comment_info.comment_rank) :
               d.comment?.comment_rank ? parseFloat(d.comment.comment_rank) : null;
    p.reviews = d.comment_info?.comment_num || d.comment?.comment_num || 0;

    // Badge
    const promos = d.promotionInfo || [];
    p.badge = promos.length ? 'Deal' :
              p.reviews > 1000 ? 'Best Seller' :
              p.reviews > 500 ? 'Popular' :
              (p.rating && p.rating >= 4.8 ? 'Top Rated' : null);

    // Availability
    p.availability = d.is_on_sale === 0 ? 'Out of Stock' : 'In Stock';
    p.stockSignal = d.is_on_sale === 0 ? 'out_of_stock' : 'in_stock';

    // Variants (size, color) - saleAttr shape
    if (d.productDetails?.saleAttr) {
      const saleAttr = d.productDetails.saleAttr;
      const attrEntries = typeof saleAttr === 'object' ? Object.values(saleAttr) : [];
      attrEntries.forEach(attr => {
        if (!attr?.attr_name) return;
        p.options.push({
          name: attr.attr_name || 'Option',
          values: (attr.attr_value_list || []).map(v => ({
            value: v.attr_value_name || v.attr_value || '',
            image: v.attr_image || null,
            selected: v.is_default === '1' || v.is_default === 1
          }))
        });
      });
    }
    // Alternate variant shape: relation_color
    if (d.relation_color?.length && !p.options.some(o => o.name.toLowerCase() === 'color')) {
      p.options.push({
        name: 'Color',
        values: d.relation_color.map(c => ({
          value: c.goods_title || c.color_name || '',
          image: c.goods_color_image || c.goods_thumb || null,
          selected: String(c.goods_id) === p.sourceId
        }))
      });
    }

    if (d.productDetails?.skuList?.length) {
      p.variants = d.productDetails.skuList.map(sku => {
        const attrs = sku.sku_sale_attr || {};
        const title = Object.values(attrs).map(a => a.attr_value_name || a.attr_value).filter(Boolean).join(' / ') || 'Default';
        return {
          id: String(sku.sku_id || ''),
          title: title,
          price: parsePrice(sku.price?.amount || sku.sale_price?.amount) || p.price,
          image: null,
          available: (sku.stock || sku.sku_stock) > 0
        };
      });
    }

    // Shipping
    p.shippingData.note = 'Standard Shipping (7-14 days)';
    p.shippingData.method = 'Standard';
    p.shippingData.cost = null;
    if (d.shippingInfo) {
      if (d.shippingInfo.free_shipping) {
        p.shippingData.note = 'FREE Standard Shipping';
        p.shippingData.cost = 0;
      }
      if (d.shippingInfo.delivery_days_min) p.deliveryEstimate.minDays = d.shippingInfo.delivery_days_min;
      if (d.shippingInfo.delivery_days_max) p.deliveryEstimate.maxDays = d.shippingInfo.delivery_days_max;
    }
    p.deliveryEstimate.minDays = p.deliveryEstimate.minDays || 7;
    p.deliveryEstimate.maxDays = p.deliveryEstimate.maxDays || 14;
    p.deliveryEstimate.label = `${p.deliveryEstimate.minDays}-${p.deliveryEstimate.maxDays} business days`;

    // Return policy
    p.returnPolicy = { window: 45, summary: 'Free returns within 45 days' };

    // Seller
    p.sellerData.name = 'SHEIN';

    p.sourceUrl = `https://us.shein.com/${(d.goods_url_name || 'product')}-p-${p.sourceId}.html`;
    p.normalizedHandle = this._makeHandle(p.title);

    // Raw source meta
    p.rawSourceMeta = {
      goods_id: p.sourceId,
      goods_sn: d.goods_sn || null,
      productRelationID: d.productRelationID || null,
      cat_id: d.cat_id || null,
      cat_name: d.cat_name || null,
      is_on_sale: d.is_on_sale,
      stock: d.stock || null,
      totalStock: d.productDetails?.skuList?.reduce((sum, s) => sum + (s.stock || 0), 0) || null,
      commentCount: p.reviews,
      commentRank: p.rating,
      promotionCount: promos.length,
      colorCount: d.relation_color?.length || 0,
      skuCount: d.productDetails?.skuList?.length || 0,
      hasVideo: !!(d.goods_imgs?.video_url || d.video_url),
      videoUrl: d.goods_imgs?.video_url || d.video_url || null,
      goodsUrlName: d.goods_url_name || null,
      materialComposition: d.detail?.materialComposition || null,
      fabricType: d.detail?.fabricType || null
    };

    return p;
  }

  _normalizeProductFallback(d) {
    const p = emptyProduct();
    p.source = 'shein';
    p.sourceId = String(d.goods_id || '');
    p.sourceName = 'SHEIN';
    p.title = d.goods_name || '';
    p.brand = 'SHEIN';
    p.description = d.detail?.description || d.goods_desc || '';
    p.bullets = Array.isArray(d.detail?.goods_desc_bullet) ? d.detail.goods_desc_bullet : [];
    p.images = [d.goods_img].filter(Boolean);
    p.primaryImage = p.images[0] || '';
    p.price = parsePrice(d.salePrice?.amount || d.retailPrice?.amount);
    p.originalPrice = parsePrice(d.retailPrice?.amount);
    p.rating = d.comment_info?.comment_rank ? parseFloat(d.comment_info.comment_rank) : null;
    p.reviews = d.comment_info?.comment_num || 0;
    p.availability = 'In Stock';
    p.stockSignal = 'in_stock';
    p.shippingData.note = 'Standard Shipping (7-14 days)';
    p.deliveryEstimate = { minDays: 7, maxDays: 14, label: '7-14 business days' };
    p.returnPolicy = { window: 45, summary: 'Free returns within 45 days' };
    p.sourceUrl = `https://us.shein.com/${(d.goods_url_name || 'product')}-p-${p.sourceId}.html`;
    p.normalizedHandle = this._makeHandle(p.title);
    return p;
  }

  normalizeProductFromSearch(p) {
    const product = emptyProduct();
    product.source = 'shein';
    product.sourceId = String(p.goods_id || '');
    product.sourceName = 'SHEIN';
    product.title = p.goods_name || '';
    product.brand = 'SHEIN';
    product.price = parsePrice(p.salePrice?.amount || p.retailPrice?.amount);
    product.originalPrice = parsePrice(p.retailPrice?.amount);
    if (product.originalPrice && product.price && product.originalPrice <= product.price) product.originalPrice = null;
    product.images = [p.goods_img].filter(Boolean);
    product.primaryImage = product.images[0] || '';
    product.rating = p.comment?.comment_rank ? parseFloat(p.comment.comment_rank) : null;
    product.reviews = p.comment?.comment_num || 0;
    product.availability = 'In Stock';
    product.stockSignal = 'in_stock';
    product.shippingData.note = 'Standard Shipping (7-14 days)';
    product.deliveryEstimate = { minDays: 7, maxDays: 14, label: '7-14 business days' };
    product.returnPolicy = { window: 45, summary: 'Free returns within 45 days' };
    product.normalizedHandle = this._makeHandle(product.title);
    return product;
  }

  _makeHandle(title) {
    return (title || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').substring(0, 100);
  }
}

module.exports = SheinAdapter;
