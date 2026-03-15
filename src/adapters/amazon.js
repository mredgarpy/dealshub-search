// ============================================================
// DealsHub â Amazon Adapter (Real-Time Amazon Data via RapidAPI)
// ============================================================
const { BaseAdapter, emptySearchResult, emptyProduct } = require('./base');
const { parsePrice } = require('../utils/pricing');
const logger = require('../utils/logger');

const API_HOST = 'real-time-amazon-data.p.rapidapi.com';

class AmazonAdapter extends BaseAdapter {
  constructor(config) {
    super('amazon', config);
  }

  async search(query, limit = 12) {
    const url = `https://${API_HOST}/search?query=${encodeURIComponent(query)}&page=1&country=US&sort_by=RELEVANCE`;
    const data = await this.fetchJSON(url, { headers: this.rapidHeaders(API_HOST) });
    if (!data || !data.data?.products) return [];
    return data.data.products.slice(0, limit).map(p => this.normalizeSearchResult(p)).filter(Boolean);
  }

  async getProduct(asin) {
    const url = `https://${API_HOST}/product-details?asin=${encodeURIComponent(asin)}&country=US`;
    const data = await this.fetchJSON(url, { headers: this.rapidHeaders(API_HOST) });
    if (!data || !data.data) {
      logger.warn('amazon', `Product not found: ${asin}`);
      // Fallback: try search by ASIN
      const searchUrl = `https://${API_HOST}/search?query=${encodeURIComponent(asin)}&page=1&country=US`;
      const searchData = await this.fetchJSON(searchUrl, { headers: this.rapidHeaders(API_HOST) });
      if (searchData?.data?.products?.length > 0) {
        return this.normalizeProductFromSearch(searchData.data.products[0]);
      }
      return null;
    }
    return this.normalizeProduct(data.data);
  }

  normalizeSearchResult(p) {
    if (!p) return null;
    const price = parsePrice(p.product_price);
    const origPrice = parsePrice(p.product_original_price);
    return {
      id: p.asin || '',
      title: p.product_title || '',
      price: price ? `$${price.toFixed(2)}` : null,
      originalPrice: origPrice && origPrice > price ? `$${origPrice.toFixed(2)}` : null,
      image: p.product_photo || '',
      url: p.product_url || '',
      rating: p.product_star_rating || null,
      reviews: p.product_num_ratings || 0,
      badge: p.is_best_seller ? 'Best Seller' : (p.is_amazon_choice ? "Amazon's Choice" : null),
      source: 'amazon',
      sourceName: 'Amazon',
      brand: p.product_brand || null
    };
  }

  normalizeProduct(d) {
    const p = emptyProduct();
    p.source = 'amazon';
    p.sourceId = d.asin || '';
    p.sourceName = 'Amazon';
    p.title = d.product_title || '';
    p.brand = d.product_brand || null;
    p.category = d.product_category || null;
    p.breadcrumbs = d.product_category ? d.product_category.split(' > ') : [];
    p.description = d.product_description || d.about_item?.join('\n') || '';
    p.bullets = d.about_item || [];
    p.images = d.product_photos || (d.product_photo ? [d.product_photo] : []);
    p.primaryImage = p.images[0] || '';
    p.price = parsePrice(d.product_price);
    p.originalPrice = parsePrice(d.product_original_price);
    p.rating = d.product_star_rating ? parseFloat(d.product_star_rating) : null;
    p.reviews = d.product_num_ratings || 0;
    p.badge = d.is_best_seller ? 'Best Seller' : (d.is_amazon_choice ? "Amazon's Choice" : null);
    p.availability = d.product_availability || null;
    p.stockSignal = d.product_availability?.toLowerCase().includes('in stock') ? 'in_stock' :
                    d.product_availability?.toLowerCase().includes('out') ? 'out_of_stock' : 'unknown';

    // Variants from Amazon
    if (d.product_variations && Array.isArray(d.product_variations)) {
      const groups = {};
      d.product_variations.forEach(v => {
        const name = v.name || 'Option';
        if (!groups[name]) groups[name] = { name, values: [] };
        groups[name].values.push({
          value: v.value || '',
          asin: v.asin || null,
          image: v.image || null,
          selected: v.is_selected || false
        });
      });
      p.options = Object.values(groups);
      p.variants = d.product_variations.map(v => ({
        id: v.asin || '',
        title: `${v.name}: ${v.value}`,
        price: parsePrice(v.price) || p.price,
        image: v.image || null,
        available: true
      }));
    }

    // Shipping
    if (d.delivery_info) {
      p.deliveryEstimate.label = d.delivery_info;
    }
    p.shippingData.note = d.is_prime ? 'FREE Prime Shipping' : 'Standard Shipping';

    // Return policy
    p.returnPolicy.summary = 'Free returns within 30 days';
    p.returnPolicy.window = 30;

    // Seller
    if (d.sold_by) p.sellerData.name = d.sold_by;

    p.sourceUrl = d.product_url || `https://www.amazon.com/dp/${p.sourceId}`;
    p.normalizedHandle = this._makeHandle(p.title);
    p.rawSourceMeta = { asin: d.asin, isPrime: d.is_prime };
    return p;
  }

  normalizeProductFromSearch(p) {
    const product = emptyProduct();
    product.source = 'amazon';
    product.sourceId = p.asin || '';
    product.sourceName = 'Amazon';
    product.title = p.product_title || '';
    product.brand = p.product_brand || null;
    product.images = p.product_photo ? [p.product_photo] : [];
    product.primaryImage = product.images[0] || '';
    product.price = parsePrice(p.product_price);
    product.originalPrice = parsePrice(p.product_original_price);
    product.rating = p.product_star_rating ? parseFloat(p.product_star_rating) : null;
    product.reviews = p.product_num_ratings || 0;
    product.badge = p.is_best_seller ? 'Best Seller' : (p.is_amazon_choice ? "Amazon's Choice" : null);
    product.availability = 'In Stock';
    product.stockSignal = 'in_stock';
    product.sourceUrl = p.product_url || `https://www.amazon.com/dp/${product.sourceId}`;
    product.normalizedHandle = this._makeHandle(product.title);
    product.returnPolicy.summary = 'Free returns within 30 days';
    product.shippingData.note = 'Standard Shipping';
    return product;
  }

  _makeHandle(title) {
    return (title || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').substring(0, 100);
  }
}

module.exports = AmazonAdapter;
