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
    const data = await this.fetchWithRetry(url, { headers: this.rapidHeaders(API_HOST) }, 1, 2000);
    if (!data || !data.data?.products) return [];
    return data.data.products.slice(0, limit).map(p => this.normalizeSearchResult(p)).filter(Boolean);
  }

  async getProduct(asin) {
    const url = `https://${API_HOST}/product-details?asin=${encodeURIComponent(asin)}&country=US`;
    const data = await this.fetchWithRetry(url, { headers: this.rapidHeaders(API_HOST) });
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

    // Variants from Amazon (can be array, object keyed by group name, or undefined)
    // When object: { "Size": [{asin, value, ...}], "Color": [{asin, value, ...}] }
    // When array: [{name, value, asin, ...}]
    const groups = {};
    const allVariants = [];

    if (d.product_variations && typeof d.product_variations === 'object' && !Array.isArray(d.product_variations)) {
      // Object keyed by group name (e.g., { "Size": [...], "Color": [...], "Carrier": [...] })
      for (const [groupName, items] of Object.entries(d.product_variations)) {
        if (!Array.isArray(items)) continue;
        const cleanName = this._formatGroupName(groupName.trim()) || 'Option';
        if (!groups[cleanName]) groups[cleanName] = { name: cleanName, values: [] };
        items.forEach(v => {
          if (!v || typeof v !== 'object') return;
          groups[cleanName].values.push({
            value: v.value || '',
            image: v.photo || v.image || null,
            asin: v.asin || null,
            selected: v.is_selected || false
          });
          allVariants.push({ ...v, _groupName: cleanName });
        });
      }
    } else if (Array.isArray(d.product_variations)) {
      // Flat array with name/value pairs
      d.product_variations.forEach(v => {
        if (!v || typeof v !== 'object') return;
        const name = v.name || this._inferOptionType(v.value) || 'Option';
        if (!groups[name]) groups[name] = { name, values: [] };
        groups[name].values.push({
          value: v.value || '',
          image: v.photo || v.image || null,
          asin: v.asin || null,
          selected: v.is_selected || false
        });
        allVariants.push({ ...v, _groupName: name });
      });
    }

    if (allVariants.length > 0) {
      // Deduplicate values within each group
      for (const g of Object.values(groups)) {
        const seen = new Set();
        g.values = g.values.filter(v => {
          const key = `${v.value}:${v.asin || ''}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
      }
      p.options = Object.values(groups);
      p.variants = allVariants.filter(v => v && typeof v === 'object').map(v => ({
        id: v.asin || '',
        title: `${v._groupName}: ${v.value || ''}`,
        price: parsePrice(v.price) || p.price,
        image: v.photo || v.image || null,
        available: true
      }));
    }

    // Shipping & delivery — v1.7b: use d.delivery and d.primary_delivery_time from Amazon API
    // d.delivery contains text like "$14.99 delivery April 10 - 24. Details" or "FREE delivery Tue, Apr 1"
    // d.primary_delivery_time contains "April 10 - 24" or similar date range
    const deliveryText = d.delivery || d.delivery_info || '';
    const primaryDeliveryTime = d.primary_delivery_time || '';

    // Extract shipping cost from delivery text (e.g., "$14.99 delivery...")
    if (deliveryText) {
      const costMatch = deliveryText.match(/\$(\d+(?:\.\d{1,2})?)\s*delivery/i);
      if (costMatch) {
        p.shippingData.cost = parseFloat(costMatch[1]);
        p.shippingData.note = `Shipping: $${p.shippingData.cost.toFixed(2)}`;
        p.shippingData.method = 'Standard';
      } else if (/free\s*delivery/i.test(deliveryText)) {
        p.shippingData.cost = 0;
        p.shippingData.note = 'FREE Delivery';
        p.shippingData.method = 'Standard';
      }
    }
    // Also check explicit shipping fields
    const rawShipCost = d.shipping_charge || d.shipping_cost || d.shipping_price || null;
    if (rawShipCost != null && p.shippingData.cost == null) {
      const parsedCost = parsePrice(rawShipCost);
      if (parsedCost != null) {
        p.shippingData.cost = parsedCost;
        p.shippingData.note = parsedCost === 0 ? 'FREE Shipping' : `Shipping: $${parsedCost.toFixed(2)}`;
      }
    }
    // Prime overrides
    if (d.is_prime) {
      p.shippingData.cost = 0;
      p.shippingData.note = 'FREE Prime Shipping';
      p.shippingData.method = 'Prime';
    } else if (p.shippingData.cost == null) {
      p.shippingData.method = 'Standard';
      p.shippingData.note = 'Standard Shipping';
    }

    // Delivery dates: use primary_delivery_time first, then parse from delivery text
    const dateSource = primaryDeliveryTime || deliveryText;
    if (dateSource) {
      p.deliveryEstimate.label = primaryDeliveryTime || deliveryText;
      // Parse "April 10 - 24" or "Apr 10 - Apr 24" or "April 10 - May 2"
      const months = { Jan:0,January:0,Feb:1,February:1,Mar:2,March:2,Apr:3,April:3,May:4,Jun:5,June:5,Jul:6,July:6,Aug:7,August:7,Sep:8,September:8,Oct:9,October:9,Nov:10,November:10,Dec:11,December:11 };
      // Pattern 1: "Month Day - Day" (same month) e.g. "April 10 - 24"
      const sameMonthMatch = dateSource.match(/([A-Z][a-z]+)\s+(\d{1,2})\s*[-–]\s*(\d{1,2})/);
      // Pattern 2: "Month Day - Month Day" (different months) e.g. "March 30 - April 5"
      const diffMonthMatch = dateSource.match(/([A-Z][a-z]+)\s+(\d{1,2})\s*[-–]\s*([A-Z][a-z]+)\s+(\d{1,2})/);

      const now = new Date();
      const year = now.getFullYear();
      const msPerDay = 86400000;

      if (diffMonthMatch) {
        const m1 = months[diffMonthMatch[1]];
        const d1 = parseInt(diffMonthMatch[2]);
        const m2 = months[diffMonthMatch[3]];
        const d2 = parseInt(diffMonthMatch[4]);
        if (m1 != null && m2 != null) {
          let minDate = new Date(year, m1, d1);
          let maxDate = new Date(year, m2, d2);
          if (minDate < now) minDate.setFullYear(year + 1);
          if (maxDate < now) maxDate.setFullYear(year + 1);
          p.deliveryEstimate.minDays = Math.max(1, Math.ceil((minDate - now) / msPerDay));
          p.deliveryEstimate.maxDays = Math.max(p.deliveryEstimate.minDays + 1, Math.ceil((maxDate - now) / msPerDay));
        }
      } else if (sameMonthMatch) {
        const m = months[sameMonthMatch[1]];
        const d1 = parseInt(sameMonthMatch[2]);
        const d2 = parseInt(sameMonthMatch[3]);
        if (m != null) {
          let minDate = new Date(year, m, d1);
          let maxDate = new Date(year, m, d2);
          if (minDate < now) minDate.setFullYear(year + 1);
          if (maxDate < now) maxDate.setFullYear(year + 1);
          p.deliveryEstimate.minDays = Math.max(1, Math.ceil((minDate - now) / msPerDay));
          p.deliveryEstimate.maxDays = Math.max(p.deliveryEstimate.minDays + 1, Math.ceil((maxDate - now) / msPerDay));
        }
      }
    }
    // Set defaults if still missing
    if (!p.deliveryEstimate.minDays) {
      p.deliveryEstimate.minDays = d.is_prime ? 1 : 3;
      p.deliveryEstimate.maxDays = d.is_prime ? 3 : 7;
    }
    if (!p.deliveryEstimate.label) {
      p.deliveryEstimate.label = d.is_prime ? '1-3 business days (Prime)' : '3-7 business days';
    }
    // Build formatted delivery dates for PDP
    const _now = new Date();
    const _minDel = new Date(_now); _minDel.setDate(_minDel.getDate() + p.deliveryEstimate.minDays);
    const _maxDel = new Date(_now); _maxDel.setDate(_maxDel.getDate() + p.deliveryEstimate.maxDays);
    const _fmt = d => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    p.deliveryEstimate.earliestDate = _fmt(_minDel);
    p.deliveryEstimate.latestDate = _fmt(_maxDel);
    p.deliveryEstimate.formattedRange = `${_fmt(_minDel)} – ${_fmt(_maxDel)}`;

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
      dateFirstAvailable: d.date_first_available || null,
      delivery: d.delivery || null,
      deliveryInfo: d.delivery_info || null,
      primaryDeliveryTime: d.primary_delivery_time || null,
      shippingCharge: d.shipping_charge || d.shipping_cost || null
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
    product.shippingData.cost = p.is_prime ? 0 : null;
    product.shippingData.method = p.is_prime ? 'Prime' : 'Standard';
    const minD = p.is_prime ? 1 : 3;
    const maxD = p.is_prime ? 3 : 7;
    product.deliveryEstimate = { minDays: minD, maxDays: maxD, label: `${minD}-${maxD} business days` };
    // Build formatted dates
    const _now = new Date();
    const _min = new Date(_now); _min.setDate(_min.getDate() + minD);
    const _max = new Date(_now); _max.setDate(_max.getDate() + maxD);
    const _fmt = d => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    product.deliveryEstimate.earliestDate = _fmt(_min);
    product.deliveryEstimate.latestDate = _fmt(_max);
    product.deliveryEstimate.formattedRange = `${_fmt(_min)} – ${_fmt(_max)}`;
    return product;
  }


  // Format API group names like "service_provider" -> "Carrier", "product_grade" -> "Condition"
  _formatGroupName(name) {
    if (!name) return null;
    const mappings = {
      'size': 'Storage',
      'color': 'Color',
      'colour': 'Color',
      'service_provider': 'Carrier',
      'carrier': 'Carrier',
      'product_grade': 'Condition',
      'condition': 'Condition',
      'style': 'Style',
      'pattern': 'Pattern',
      'material': 'Material',
      'configuration': 'Configuration',
      'flavor': 'Flavor',
      'scent': 'Scent',
      'count': 'Count',
      'wattage': 'Wattage',
      'voltage': 'Voltage',
      'length': 'Length',
      'width': 'Width'
    };
    const lower = name.toLowerCase();
    if (mappings[lower]) return mappings[lower];
    // Title-case fallback: "some_name" -> "Some Name"
    return name.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  }

  // Infer option type from value string when API doesn't provide group names
  _inferOptionType(value) {
    if (!value) return null;
    const v = value.trim();
    // Storage sizes
    if (/^\d+\s*(GB|TB|MB)$/i.test(v)) return 'Storage';
    // Colors
    const colors = ['black','white','red','blue','green','gold','silver','pink','purple','gray','grey',
      'midnight','starlight','space gray','space grey','graphite','sierra blue','alpine green',
      'deep purple','yellow','orange','coral','lavender','cream','titanium','natural titanium',
      'blue titanium','white titanium','black titanium','desert titanium','teal','ultramarine'];
    if (colors.some(c => v.toLowerCase() === c || v.toLowerCase().startsWith(c + ' '))) return 'Color';
    // Carriers
    const carriers = ['at&t','t-mobile','verizon','sprint','boost mobile','cricket','tracfone',
      'unlocked','metro','us cellular','visible','straight talk','xfinity','spectrum','mint mobile'];
    if (carriers.some(c => v.toLowerCase() === c)) return 'Carrier';
    // Condition
    if (/^(renewed|refurbished|new|used|renewed premium|certified refurbished|pre-owned|open box)$/i.test(v)) return 'Condition';
    // RAM
    if (/^\d+\s*GB\s*RAM$/i.test(v)) return 'RAM';
    return null;
  }

  async getReviews(asin, limit = 10) {
    const url = `https://${API_HOST}/product-reviews?asin=${encodeURIComponent(asin)}&country=US&sort_by=TOP_REVIEWS&page_size=${limit}&page=1`;
    const data = await this.fetchWithRetry(url, { headers: this.rapidHeaders(API_HOST) });
    if (!data || !data.data?.reviews) return { reviews: [], summary: null };
    return {
      summary: {
        rating: data.data.rating ? parseFloat(data.data.rating) : null,
        totalRatings: data.data.total_ratings || 0,
        totalReviews: data.data.total_reviews || 0,
        starsBreakdown: data.data.rating_breakdown || null
      },
      reviews: (data.data.reviews || []).slice(0, limit).map(r => ({
        id: r.review_id || '',
        title: r.review_title || '',
        body: r.review_comment || '',
        rating: r.review_star_rating ? parseFloat(r.review_star_rating) : null,
        author: r.review_author || 'Customer',
        date: r.review_date || '',
        verified: r.is_verified_purchase || false,
        helpful: r.helpful_vote_count || 0,
        images: Array.isArray(r.review_images) ? r.review_images : []
      }))
    };
  }

  _makeHandle(title) {
    return (title || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').substring(0, 100);
  }
}

module.exports = AmazonAdapter;
