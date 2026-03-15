// ============================================================
// DealsHub — SHEIN Adapter (via RapidAPI)
// ============================================================
const { BaseAdapter, emptySearchResult, emptyProduct } = require('./base');
const { parsePrice } = require('../utils/pricing');

const API_HOST = 'unofficial-shein.p.rapidapi.com';

class SheinAdapter extends BaseAdapter {
  constructor(config) { super('shein', config); }

  async search(query, limit = 12) {
    const url = `https://${API_HOST}/products/search?keywords=${encodeURIComponent(query)}&language=en&country=US&currency=USD&page=1&limit=${limit}`;
    const data = await this.fetchJSON(url, { headers: this.rapidHeaders(API_HOST) });
    if (!data?.info?.products) return [];
    return data.info.products.slice(0, limit).map(p => this.normalizeSearchResult(p)).filter(Boolean);
  }

  async getProduct(productId) {
    const url = `https://${API_HOST}/products/detail?goods_id=${encodeURIComponent(productId)}&language=en&country=US&currency=USD`;
    const data = await this.fetchJSON(url, { headers: this.rapidHeaders(API_HOST) });
    if (!data?.info) {
      // Fallback to search
      const searchUrl = `https://${API_HOST}/products/search?keywords=${encodeURIComponent(productId)}&language=en&country=US&currency=USD&page=1&limit=1`;
      const sData = await this.fetchJSON(searchUrl, { headers: this.rapidHeaders(API_HOST) });
      if (sData?.info?.products?.[0]) return this.normalizeProductFromSearch(sData.info.products[0]);
      return null;
    }
    return this.normalizeProduct(data.info);
  }

  normalizeSearchResult(p) {
    if (!p) return null;
    const price = parsePrice(p.salePrice?.amount || p.retailPrice?.amount);
    const origPrice = parsePrice(p.retailPrice?.amount);
    return {
      id: String(p.goods_id || ''),
      title: p.goods_name || '',
      price: price ? `$${price.toFixed(2)}` : null,
      originalPrice: origPrice && origPrice > (price || 0) ? `$${origPrice.toFixed(2)}` : null,
      image: p.goods_img || '',
      url: `https://us.shein.com/${(p.goods_url_name || 'product')}-p-${p.goods_id}.html`,
      rating: p.comment?.comment_rank ? parseFloat(p.comment.comment_rank) : null,
      reviews: p.comment?.comment_num || 0,
      badge: p.promotionInfo?.length ? 'Deal' : null,
      source: 'shein',
      sourceName: 'SHEIN',
      brand: 'SHEIN'
    };
  }

  normalizeProduct(d) {
    const p = emptyProduct();
    p.source = 'shein';
    p.sourceId = String(d.goods_id || d.productRelationID || '');
    p.sourceName = 'SHEIN';
    p.title = d.goods_name || '';
    p.brand = 'SHEIN';
    p.category = d.cat_name || null;
    p.breadcrumbs = d.parentCats?.map(c => c.cat_name) || [];
    p.description = d.detail?.description || d.goods_desc || '';
    p.bullets = d.detail?.goods_desc_bullet || [];

    // Images
    p.images = (d.goods_imgs?.detail_image || []).map(img => img.origin_image || img.medium_image || '').filter(Boolean);
    if (d.goods_img) p.images.unshift(d.goods_img);
    p.primaryImage = p.images[0] || '';

    // Price
    p.price = parsePrice(d.salePrice?.amount || d.retailPrice?.amount);
    p.originalPrice = parsePrice(d.retailPrice?.amount);
    p.rating = d.comment_info?.comment_rank ? parseFloat(d.comment_info.comment_rank) : null;
    p.reviews = d.comment_info?.comment_num || 0;
    p.availability = 'In Stock';
    p.stockSignal = 'in_stock';

    // Variants (size, color)
    if (d.productDetails?.saleAttr) {
      Object.values(d.productDetails.saleAttr).forEach(attr => {
        p.options.push({
          name: attr.attr_name || 'Option',
          values: (attr.attr_value_list || []).map(v => ({
            value: v.attr_value_name || '',
            image: v.attr_image || null,
            selected: v.is_default === '1'
          }))
        });
      });
    }

    if (d.productDetails?.skuList) {
      p.variants = d.productDetails.skuList.map(sku => ({
        id: sku.sku_id || '',
        title: Object.values(sku.sku_sale_attr || {}).map(a => a.attr_value_name).join(' / ') || 'Default',
        price: parsePrice(sku.price?.amount) || p.price,
        image: null,
        available: sku.stock > 0
      }));
    }

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
    product.images = [p.goods_img].filter(Boolean);
    product.primaryImage = product.images[0] || '';
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
