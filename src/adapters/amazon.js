// ============================================================
// DealsHub — Amazon Adapter (Real-Time Amazon Data via RapidAPI)
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
    try { return this._normalizeProductInner(d); }
    catch (e) { logger.error('amazon', 'normalizeProduct error', { error: e.message }); return this.normalizeProductFromSearch(d); }
  }

  _normalizeProductInner(d) {
    const p = emptyProduct();
    p.source = 'amazon';
    p.sourceId = d.asin || '';
    p.sourceName = 'Amazon';
    p.title = d.product_title || '';
    p.brand = d.product_brand || null;
    p.category = d.product_category || null;
    p.breadcrumbs = d.product_category ? d.product_category.split(' > ') : [];

    // Description — combine about_item bullets + product_description + product_information
    const descParts = [];
    if (d.product_description) descParts.push(d.product_description);
    if (d.product_information && typeof d.product_information === 'object') {
      const infoLines = Object.entries(d.product_information)
        .filter(([k, v]) => v && typeof v === 'string')
        .map(([k, v]) => `${k}: ${v}`);
      if (infoLines.length) descParts.push(infoLines.join('\n'));
    }
    p.description = descParts.join('\n\n') || '';

    // Bullets from about_item array
    p.bullets = [];
    if (Array.isArray(d.about_item)) {
      p.bullets = d.about_item.filter(b => b && typeof b === 'string' && b.trim().length > 0);
    }
    // Also extract from product_details if available
    if (d.product_details && typeof d.product_details === 'object') {
      Object.entries(d.product_details).forEach(([k, v]) => {
        if (v && typeof v === 'string') p.bullets.push(`${k}: ${v}`);
      });
    }

    // Images — product_photos is primary, fallback to product_photo
    p.images = [];
    if (Array.isArray(d.product_photos)) {
      p.images = d.product_photos.filter(Boolean);
    } else if (d.product_photo) {
      p.images = [d.product_photo];
    }
    p.primaryImage = p.images[0] || '';

    // Price
    p.price = parsePrice(d.product_price);
    p.originalPrice = parsePrice(d.product_original_price);
    if (!p.originalPrice && d.product_original_price_raw) {
      p.originalPrice = parsePrice(d.product_original_price_raw);
    }

    // Rating & reviews
    p.rating = d.product_star_rating ? parseFloat(d.product_star_rating) : null;
    p.reviews = d.product_num_ratings || d.product_num_reviews || 0;

    // Badge
    p.badge = d.is_best_seller ? 'Best Seller' : (d.is_amazon_choice ? "Amazon's Choice" : null);
    if (!p.badge && d.climate_pledge_friendly) p.badge = 'Climate Pledge';

    // Availability
    p.availability = d.product_availability || null;
    p.stockSignal = d.product_availability?.toLowerCase().includes('in stock') ? 'in_stock' :
                    d.product_availability?.toLowerCase().includes('out') ? 'out_of_stock' : 'unknown';

    // Variants from Amazon (can be array, object, or undefined)
    const variations = Array.isArray(d.product_variations) ? d.product_variations :
                       (d.product_variations && typeof d.product_variations === 'object') ?
                         Object.values(d.product_variations).flat().filter(v => v && typeof v === 'object') : [];
    if (variations.length > 0) {
      const groups = {};
      variations.forEach(v => {
        if (!v || typeof v !== 'object') return;
        const name = v.name || 'Option';
        if (!groups[name]) groups[name] = { name, values: [] };
        groups[name].values.push({
          value: v.value || '', image: v.photo || v.image || null,
          asin: v.asin || null,
          image: v.image || null,
          selected: v.is_selected || false
        });
      });
      p.options = Object.values(groups);
      p.variants = variations.filter(v => v && typeof v === 'object').map(v => ({
        id: v.asin || '',
        title: `${v.name || 'Option'}: ${v.value || ''}`,
        price: parsePrice(v.price) || p.price,
        image: v.image || null,
        available: true
      }));
    }

    // Shipping & delivery
    if (d.delivery_info) {
      p.deliveryEstimate.label = d.delivery_info;
      // Try to parse min/max from "Delivery by Mon, Jan 5 - Fri, Jan 9" format
      const match = d.delivery_info.match(/(\d+)\s*-\s*(\d+)/);
      if (match) {
        p.deliveryEstimate.minDays = parseInt(match[1]);
        p.deliveryEstimate.maxDays = parseInt(match[2]);
      }
    }
    if (!p.deliveryEstimate.label) {
      p.deliveryEstimate = { minDays: 3, maxDays: 7, label: '3-7 business days' };
    }
    p.shippingData.note = d.is_prime ? 'FREE Prime Shipping' : 'Standard Shipping';
    p.shippingData.cost = d.is_prime ? 0 : null;
    p.shippingData.method = d.is_prime ? 'Prime' : 'Standard';

    // Return policy
    p.returnPolicy.summary = 'Free returns within 30 days';
    p.returnPolicy.window = 30;

    // Seller info
    if (d.sold_by) p.sellerData.name = d.sold_by;
    if (d.fulfilled_by) p.sellerData.fulfilled = d.fulfilled_by;

    p.sourceUrl = d.product_url || `https://www.amazon.com/dp/${p.sourceId}`;
    p.normalizedHandle = this._makeHandle(p.title);
    p.rawSourceMeta = {
      asin: d.asin,
      isPrime: d.is_prime || false,
      isBestSeller: d.is_best_seller || false,
      isAmazonChoice: d.is_amazon_choice || false,
      climatePledge: d.climate_pledge_friendly || false,
      soldBy: d.sold_by || null,
      fulfilledBy: d.fulfilled_by || null,
      productDimensions: d.product_dimensions || null,
      itemWeight: d.item_weight || null,
      itemModelNumber: d.item_model_number || null,
      manufacturer: d.manufacturer || null,
      countryOfOrigin: d.country_of_origin || null,
      dateFirstAvailable: d.date_first_available || null
    };
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
    product.description = p.product_description || '';
    product.bullets = Array.isArray(p.about_item) ? p.about_item : [];
    product.sourceUrl = p.product_url || `https://www.amazon.com/dp/${product.sourceId}`;
    product.normalizedHandle = this._makeHandle(product.title);
    product.returnPolicy = { summary: 'Free returns within 30 days', window: 30 };
    product.shippingData.note = p.is_prime ? 'FREE Prime Shipping' : 'Standard Shipping';
    product.deliveryEstimate = { minDays: 3, maxDays: 7, label: '3-7 business days' };
    return product;
  }

  _makeHandle(title) {
    return (title || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').substring(0, 100);
  }
}

module.exports = AmazonAdapter;
