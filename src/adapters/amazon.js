// ============================================================
// DealsHub — Amazon Adapter (Real-Time Amazon Data via RapidAPI)
// ============================================================
const { BaseAdapter, emptySearchResult, emptyProduct } = require('./base');
const { parsePrice } = require('../utils/pricing');
const logger = require('../utils/logger');

const API_HOST = 'real-time-amazon-data.p.rapidapi.com';

// ---- Offers cache (1 hour TTL) ----
const offersCache = new Map();
const OFFERS_CACHE_TTL = 3600000; // 1 hour

class AmazonAdapter extends BaseAdapter {
  constructor(config) {
    super('amazon', config);
  }

  async search(query, limit = 12, options = {}) {
    const pageNum = options.page || 1;
    let url = `https://${API_HOST}/search?query=${encodeURIComponent(query)}&page=${pageNum}&country=US&sort_by=RELEVANCE`;
    // Add category_id if provided (e.g. 'electronics', 'fashion-womens', 'shoes')
    if (options.categoryId && options.categoryId !== 'aps') {
      url += `&category_id=${encodeURIComponent(options.categoryId)}`;
    }
    const data = await this.fetchWithRetry(url, { headers: this.rapidHeaders(API_HOST) }, 1, 2000);
    if (!data || !data.data?.products) return [];
    return data.data.products.slice(0, limit).map(p => this.normalizeSearchResult(p)).filter(Boolean);
  }

  // ---- Best Sellers (Amazon /best-sellers endpoint) ----
  // Types: BEST_SELLERS, NEW_RELEASES, MOST_WISHED_FOR, GIFT_IDEAS
  // Categories: aps, electronics, beauty, fashion, garden, sporting, videogames, baby-products, etc.
  async getBestSellers(type = 'BEST_SELLERS', category = 'aps', limit = 20) {
    try {
      const url = `https://${API_HOST}/best-sellers?type=${encodeURIComponent(type)}&category=${encodeURIComponent(category)}&page=1&country=US`;
      const data = await this.fetchWithRetry(url, { headers: this.rapidHeaders(API_HOST) }, 1, 5000);
      if (!data || !data.data?.best_sellers) {
        logger.warn('amazon', `getBestSellers returned no data for type=${type}, category=${category}`);
        return [];
      }
      return data.data.best_sellers.slice(0, limit).map(p => this.normalizeBestSeller(p, type)).filter(Boolean);
    } catch (e) {
      logger.error('amazon', `getBestSellers error: ${e.message}`);
      return [];
    }
  }

  normalizeBestSeller(p, type) {
    if (!p || !p.asin) return null;
    return {
      id: p.asin,
      title: p.product_title || '',
      price: parsePrice(p.product_price),
      originalPrice: parsePrice(p.product_original_price),
      image: p.product_photo || '',
      url: p.product_url || '',
      rating: p.product_star_rating ? parseFloat(p.product_star_rating) : null,
      reviews: p.product_num_ratings || 0,
      badge: type === 'BEST_SELLERS' ? 'Best Seller' : (type === 'MOST_WISHED_FOR' ? 'Most Wished' : (type === 'GIFT_IDEAS' ? 'Gift Idea' : 'New')),
      source: 'amazon',
      sourceName: 'Amazon',
      rank: p.rank || null,
      salesVolume: (p.sales_volume || '').replace(/on Amazon\s*/gi, '').replace(/New\s+in past month/i, 'New this month').trim() || null,
      isPrime: p.is_prime || false,
      bestSellerType: type
    };
  }

  // ---- Product Offers: real shipping/seller data from /product-offers ----
  async getProductOffers(asin) {
    const cached = offersCache.get(asin);
    if (cached && Date.now() - cached.timestamp < OFFERS_CACHE_TTL) {
      return cached.data;
    }
    try {
      const url = `https://${API_HOST}/product-offers?asin=${encodeURIComponent(asin)}&country=US&limit=10&page=1`;
      const data = await this.fetchWithRetry(url, { headers: this.rapidHeaders(API_HOST) }, 0, 0);
      const offers = data?.data?.product_offers || [];
      offersCache.set(asin, { data: offers, timestamp: Date.now() });
      logger.info('amazon', `Got ${offers.length} offers for ${asin}`);
      return offers;
    } catch (err) {
      logger.warn('amazon', `Failed to get offers for ${asin}`, { error: err.message });
      return [];
    }
  }

  selectBestOffer(productOffers) {
    if (!productOffers || productOffers.length === 0) return null;

    // Helper: check if ships_from starts with "Amazon.com" (may contain newlines)
    const isFBAOffer = o => (o.ships_from || '').split('\n')[0].trim() === 'Amazon.com';

    // Priority 1: FBA (ships from Amazon.com) with condition New
    const fbaNew = productOffers.find(o =>
      isFBAOffer(o) &&
      (o.product_condition === 'New' || !o.product_condition)
    );
    if (fbaNew) return { ...fbaNew, isFBA: true };

    // Priority 2: Any FBA
    const fba = productOffers.find(o => isFBAOffer(o));
    if (fba) return { ...fba, isFBA: true };

    // Priority 3: Seller with best rating and FREE delivery
    const freeShipping = productOffers
      .filter(o => o.delivery_price === 'FREE' || o.delivery_price === '$0.00')
      .sort((a, b) => parseFloat(b.seller_star_rating || 0) - parseFloat(a.seller_star_rating || 0));
    if (freeShipping.length > 0) return { ...freeShipping[0], isFBA: false };

    // Priority 4: Seller with best rating (any shipping)
    const sorted = [...productOffers]
      .sort((a, b) => parseFloat(b.seller_star_rating || 0) - parseFloat(a.seller_star_rating || 0));
    return { ...sorted[0], isFBA: false };
  }

  extractShippingFromOffer(offer) {
    if (!offer) return null;

    const deliveryPrice = offer.delivery_price || '';
    const isFree = deliveryPrice === 'FREE' || deliveryPrice === '$0.00' || deliveryPrice === '';
    const cost = isFree ? 0 : parseFloat(deliveryPrice.replace('$', '').replace(',', '')) || 0;

    // Clean ships_from: API may return "bjkrTrf\nShips from China." — extract name only
    const rawShipsFrom = offer.ships_from || '';
    const shipsFromClean = rawShipsFrom.split('\n')[0].trim() || null;
    const shipsFromOrigin = rawShipsFrom.includes('\n') ? rawShipsFrom.split('\n').slice(1).join(' ').trim() : null;

    return {
      cost,
      isFree,
      label: isFree ? 'FREE' : deliveryPrice,
      method: offer.isFBA ? 'Amazon Prime' : 'Seller Shipping',
      deliveryTime: offer.delivery_time || null,
      shipsFrom: shipsFromClean,
      shipsFromOrigin,
      isFBA: offer.isFBA || false,
      seller: {
        name: offer.seller || null,
        id: offer.seller_id || null,
        rating: offer.seller_star_rating || null,
        ratingInfo: offer.seller_star_rating_info || null,
        link: offer.seller_link || null
      },
      condition: offer.product_condition || 'New'
    };
  }

  async getProduct(asin) {
    // Fetch product details AND offers in parallel (Option B from spec)
    const detailsPromise = this.fetchWithRetry(
      `https://${API_HOST}/product-details?asin=${encodeURIComponent(asin)}&country=US`,
      { headers: this.rapidHeaders(API_HOST) }
    );
    const offersPromise = this.getProductOffers(asin);

    const [data, offers] = await Promise.all([detailsPromise, offersPromise]);

    if (!data || !data.data) {
      logger.warn('amazon', `Product not found: ${asin}`);
      const searchUrl = `https://${API_HOST}/search?query=${encodeURIComponent(asin)}&page=1&country=US`;
      const searchData = await this.fetchJSON(searchUrl, { headers: this.rapidHeaders(API_HOST) });
      if (searchData?.data?.products?.length > 0) {
        return this.normalizeProductFromSearch(searchData.data.products[0]);
      }
      return null;
    }

    const product = this.normalizeProduct(data.data);

    // Enrich product with real offers data
    if (product && offers && offers.length > 0) {
      const bestOffer = this.selectBestOffer(offers);
      const offerShipping = this.extractShippingFromOffer(bestOffer);

      if (bestOffer) {
        product.bestOffer = {
          seller: bestOffer.seller || null,
          sellerId: bestOffer.seller_id || null,
          sellerRating: bestOffer.seller_star_rating || null,
          sellerRatingInfo: bestOffer.seller_star_rating_info || null,
          shipsFrom: (bestOffer.ships_from || '').split('\n')[0].trim() || null,
          isFBA: bestOffer.isFBA || false,
          condition: bestOffer.product_condition || 'New',
          offerPrice: bestOffer.product_price || null,
          deliveryPrice: bestOffer.delivery_price || null,
          deliveryTime: bestOffer.delivery_time || null
        };
      }

      if (offerShipping) {
        // Override shipping data with real offer data
        product.shippingData.cost = offerShipping.cost;
        product.shippingData.isFree = offerShipping.isFree;
        product.shippingData.method = offerShipping.method;
        product.shippingData.note = offerShipping.isFree
          ? (offerShipping.isFBA ? 'FREE Prime Shipping' : 'FREE Shipping')
          : `Shipping: ${offerShipping.label}`;
        product.shippingData.shipsFrom = offerShipping.shipsFrom;
        product.shippingData.isFBA = offerShipping.isFBA;
        product.shippingData.seller = offerShipping.seller;

        // Override delivery time if offer has it
        if (offerShipping.deliveryTime) {
          product.deliveryEstimate.label = offerShipping.deliveryTime;
          // Re-parse delivery dates from offer time
          this._parseDeliveryDates(product, offerShipping.deliveryTime);
        }
      }

      // Store all offers for PDP display
      product.allOffers = offers.slice(0, 5).map(o => ({
        seller: o.seller || null,
        price: o.product_price || null,
        shipsFrom: (o.ships_from || '').split('\n')[0].trim() || null,
        deliveryPrice: o.delivery_price || null,
        deliveryTime: o.delivery_time || null,
        condition: o.product_condition || 'New',
        sellerRating: o.seller_star_rating || null,
        isFBA: (o.ships_from || '').split('\n')[0].trim() === 'Amazon.com'
      }));

      // Update rawSourceMeta with offer data for shipping-rules.js
      product.rawSourceMeta.offersCount = offers.length;
      product.rawSourceMeta.bestOfferShipsFrom = (bestOffer?.ships_from || '').split('\n')[0].trim() || null;
      product.rawSourceMeta.bestOfferIsFBA = bestOffer?.isFBA || false;
      product.rawSourceMeta.bestOfferDeliveryPrice = bestOffer?.delivery_price || null;
      product.rawSourceMeta.bestOfferDeliveryTime = bestOffer?.delivery_time || null;
      product.rawSourceMeta.bestOfferSeller = bestOffer?.seller || null;
      product.rawSourceMeta.bestOfferSellerRating = bestOffer?.seller_star_rating || null;
    }

    return product;
  }

  // Parse delivery date range from offer delivery_time string
  _parseDeliveryDates(product, deliveryTimeStr) {
    if (!deliveryTimeStr) return;
    const months = { Jan:0,January:0,Feb:1,February:1,Mar:2,March:2,Apr:3,April:3,May:4,Jun:5,June:5,Jul:6,July:6,Aug:7,August:7,Sep:8,September:8,Oct:9,October:9,Nov:10,November:10,Dec:11,December:11 };
    const now = new Date();
    const year = now.getFullYear();
    const msPerDay = 86400000;

    // Pattern: "Month Day - Month Day" (different months)
    const diffMonthMatch = deliveryTimeStr.match(/([A-Z][a-z]+)\s+(\d{1,2})\s*[-–]\s*([A-Z][a-z]+)\s+(\d{1,2})/);
    // Pattern: "Month Day - Day" (same month)
    const sameMonthMatch = deliveryTimeStr.match(/([A-Z][a-z]+)\s+(\d{1,2})\s*[-–]\s*(\d{1,2})/);

    if (diffMonthMatch) {
      const m1 = months[diffMonthMatch[1]]; const d1 = parseInt(diffMonthMatch[2]);
      const m2 = months[diffMonthMatch[3]]; const d2 = parseInt(diffMonthMatch[4]);
      if (m1 != null && m2 != null) {
        let minDate = new Date(year, m1, d1);
        let maxDate = new Date(year, m2, d2);
        if (minDate < now) minDate.setFullYear(year + 1);
        if (maxDate < now) maxDate.setFullYear(year + 1);
        product.deliveryEstimate.minDays = Math.max(1, Math.ceil((minDate - now) / msPerDay));
        product.deliveryEstimate.maxDays = Math.max(product.deliveryEstimate.minDays + 1, Math.ceil((maxDate - now) / msPerDay));
        const fmt = d => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        product.deliveryEstimate.earliestDate = fmt(minDate);
        product.deliveryEstimate.latestDate = fmt(maxDate);
        product.deliveryEstimate.formattedRange = `${fmt(minDate)} – ${fmt(maxDate)}`;
      }
    } else if (sameMonthMatch) {
      const m = months[sameMonthMatch[1]]; const d1 = parseInt(sameMonthMatch[2]); const d2 = parseInt(sameMonthMatch[3]);
      if (m != null) {
        let minDate = new Date(year, m, d1);
        let maxDate = new Date(year, m, d2);
        if (minDate < now) minDate.setFullYear(year + 1);
        if (maxDate < now) maxDate.setFullYear(year + 1);
        product.deliveryEstimate.minDays = Math.max(1, Math.ceil((minDate - now) / msPerDay));
        product.deliveryEstimate.maxDays = Math.max(product.deliveryEstimate.minDays + 1, Math.ceil((maxDate - now) / msPerDay));
        const fmt = d => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        product.deliveryEstimate.earliestDate = fmt(minDate);
        product.deliveryEstimate.latestDate = fmt(maxDate);
        product.deliveryEstimate.formattedRange = `${fmt(minDate)} – ${fmt(maxDate)}`;
      }
    }
  }

  normalizeSearchResult(p) {
    if (!p) return null;
    const price = parsePrice(p.product_price);
    const origPrice = parsePrice(p.product_original_price);

    // Parse delivery text for real dates/costs
    const deliveryRaw = p.delivery || '';
    const delivery = this._parseDeliverySearchText(deliveryRaw);

    const discount = origPrice && origPrice > price ? Math.round((1 - price / origPrice) * 100) : 0;
    const savingsAmount = origPrice && origPrice > price ? (origPrice - price).toFixed(2) : null;

    return {
      id: p.asin || '',
      title: p.product_title || '',
      price: price ? `$${price.toFixed(2)}` : null,
      originalPrice: origPrice && origPrice > price ? `$${origPrice.toFixed(2)}` : null,
      discount: discount || null,
      savingsAmount: savingsAmount,
      image: p.product_photo || '',
      url: p.product_url || '',
      rating: p.product_star_rating || null,
      reviews: p.product_num_ratings || 0,
      badge: p.is_best_seller ? 'Best Seller' : (p.is_amazon_choice ? "Popular Choice" : null),
      source: 'amazon',
      sourceName: 'Amazon',
      brand: p.product_brand || null,
      isPrime: p.is_prime || false,
      salesVolume: (p.sales_volume || '').replace(/on Amazon\s*/gi, '').replace(/New\s+in past month/i, 'New this month').trim() || null,
      deliveryInfo: {
        isFree: delivery.isFree,
        cost: delivery.cost,
        date: delivery.standardDate || null,
        dateRange: delivery.dateRange || null,
        fastest: delivery.fastestDate || null,
        threshold: delivery.threshold || null,
        isPrimeDelivery: delivery.isPrimeDelivery,
        orderWithin: delivery.orderWithin || null,
        raw: deliveryRaw || null
      }
    };
  }

  // Parse Amazon search delivery text like:
  // "FREE delivery Mon, Mar 30Or fastest delivery Tomorrow, Mar 26"
  // "FREE delivery Mar 30 - Apr 1 on $35 of items shipped by Amazon"
  // "$6.41 delivery Wednesday, April 1"
  _parseDeliverySearchText(text) {
    if (!text) return { isFree: false, cost: 0 };
    const result = {
      isFree: /FREE\s*delivery/i.test(text),
      cost: 0,
      standardDate: null,
      dateRange: null,
      fastestDate: null,
      threshold: null,
      isPrimeDelivery: /Prime/i.test(text),
      orderWithin: null
    };
    // Extract cost: "$6.41 delivery" (but not when preceded by FREE)
    const costMatch = text.match(/\$([\d.]+)\s*delivery/);
    if (costMatch && !/FREE/i.test(text.substring(0, text.indexOf(costMatch[0])))) {
      result.cost = parseFloat(costMatch[1]);
      result.isFree = false;
    }
    // Extract standard date: "delivery Mon, Mar 30" or "delivery Wednesday, April 1"
    const dateMatch = text.match(/(?:FREE\s+)?delivery\s+((?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)(?:day)?,?\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\.?\s+\d+)/i);
    if (dateMatch) result.standardDate = dateMatch[1].trim();
    // Extract date range: "Mar 30 - Apr 1"
    const rangeMatch = text.match(/delivery\s+((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\.?\s+\d+)\s*[-–]\s*((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\.?\s+\d+)/i);
    if (rangeMatch) result.dateRange = rangeMatch[1] + ' – ' + rangeMatch[2];
    // Extract fastest: "fastest delivery Tomorrow, Mar 26"
    const fastMatch = text.match(/fastest\s+delivery\s+((?:Tomorrow|Today|(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)(?:day)?,?\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\.?\s+\d+)[^O]*)/i);
    if (fastMatch) result.fastestDate = fastMatch[1].trim();
    // Extract "Prime members get FREE delivery Tomorrow, March 26"
    const primeMatch = text.match(/Prime members?\s+get\s+FREE delivery\s+(.+?)(?:\.|Order|$)/i);
    if (primeMatch && !result.fastestDate) result.fastestDate = primeMatch[1].trim();
    // Extract threshold: "on $35 of items" or "over $35"
    const threshMatch = text.match(/(?:over|on)\s+\$([\d.]+)/i);
    if (threshMatch) result.threshold = parseFloat(threshMatch[1]);
    // Extract "Order within 9 hrs 49 mins"
    const withinMatch = text.match(/Order within\s+(.+?)(?:\.|$)/i);
    if (withinMatch) result.orderWithin = withinMatch[1].trim();
    return result;
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
    p.badge = d.is_best_seller ? 'Best Seller' : (d.is_amazon_choice ? "Popular Choice" : null);
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
            selected: v.is_selected || false,
            is_available: v.is_available !== false
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
          selected: v.is_selected || false,
          is_available: v.is_available !== false
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
        available: v.is_available !== false
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

    // Parsed delivery for PDP (same parser as search, applied to product detail delivery text)
    const pdpDeliveryParsed = this._parseDeliverySearchText(deliveryText);
    p.deliveryParsed = {
      standard: pdpDeliveryParsed.standardDate || (p.deliveryEstimate.formattedRange || null),
      fastest: pdpDeliveryParsed.fastestDate || null,
      cost: pdpDeliveryParsed.cost || (p.shippingData.cost || 0),
      isFree: pdpDeliveryParsed.isFree || p.shippingData.cost === 0,
      threshold: pdpDeliveryParsed.threshold || null,
      isPrime: d.is_prime || false,
      orderWithin: pdpDeliveryParsed.orderWithin || null,
      raw: deliveryText || null
    };

    // Return policy
    p.returnPolicy.summary = 'Free returns within 30 days';
    p.returnPolicy.window = 30;

    // Seller info
    if (d.sold_by) p.sellerData.name = d.sold_by;
    if (d.fulfilled_by) p.sellerData.fulfilled = d.fulfilled_by;

    p.sourceUrl = d.product_url || `https://www.amazon.com/dp/${p.sourceId}`;
    p.normalizedHandle = this._makeHandle(p.title);
    // Sprint 3: Rich PDP fields
    // A+ Content images (manufacturer description images)
    p.aplusImages = Array.isArray(d.aplus_images) ? d.aplus_images.filter(Boolean) : [];
    if (!p.aplusImages.length && Array.isArray(d.aplus_content)) {
      p.aplusImages = d.aplus_content.filter(Boolean);
    }

    // Product specifications as structured data (keep separate from description)
    p.specifications = [];
    if (d.product_information && typeof d.product_information === 'object') {
      p.specifications = Object.entries(d.product_information)
        .filter(([k, v]) => v && typeof v === 'string' && v.trim().length > 0)
        .map(([k, v]) => ({ name: k.trim(), value: v.trim() }));
    }

    // Raw product_information object for frontend (weight, material, dimensions etc.)
    p.productInformation = {};
    if (d.product_information && typeof d.product_information === 'object') {
      p.productInformation = { ...d.product_information };
    }

    // Quick specs (product_details) as structured data
    p.quickSpecs = [];
    if (d.product_details && typeof d.product_details === 'object') {
      p.quickSpecs = Object.entries(d.product_details)
        .filter(([k, v]) => v && typeof v === 'string' && v.trim().length > 0)
        .map(([k, v]) => ({ name: k.trim(), value: v.trim() }));
    }

    // Rating distribution (bar chart data)
    p.ratingDistribution = null;
    if (d.rating_distribution && typeof d.rating_distribution === 'object') {
      p.ratingDistribution = {};
      for (let i = 1; i <= 5; i++) {
        const val = d.rating_distribution[String(i)] || d.rating_distribution[i] || 0;
        p.ratingDistribution[i] = typeof val === 'string' ? parseInt(val) : val;
      }
    }

    // Top reviews
    p.topReviews = [];
    const reviewSource = d.top_reviews || d.top_reviews_global || [];
    if (Array.isArray(reviewSource)) {
      p.topReviews = reviewSource.slice(0, 8).map(r => ({
        title: r.review_title || '',
        comment: r.review_comment || '',
        rating: r.review_star_rating ? parseFloat(r.review_star_rating) : 0,
        date: r.review_date || '',
        author: r.review_author || '',
        avatar: r.review_author_avatar || null,
        images: Array.isArray(r.review_images) ? r.review_images : [],
        isVerified: r.is_verified_purchase || false,
        helpfulVotes: r.helpful_vote_statement || '',
        variant: r.reviewed_product_variant || null
      })).filter(r => r.comment || r.title);
    }

    // Frequently bought together
    p.frequentlyBoughtTogether = [];
    if (Array.isArray(d.frequently_bought_together)) {
      p.frequentlyBoughtTogether = d.frequently_bought_together.slice(0, 6).map(item => ({
        id: item.asin || '',
        title: item.product_title || item.title || '',
        price: parsePrice(item.product_price || item.price),
        image: item.product_photo || item.image || '',
        url: item.product_url || ''
      })).filter(item => item.id && item.title);
    }

    // Sales volume ("200+ bought in past month")
    p.salesVolume = (d.sales_volume || '').replace(/on Amazon\s*/gi, '').replace(/New\s+in past month/i, 'New this month').trim() || null;

    // Product condition
    p.productCondition = d.product_condition || null;

    // Videos
    p.videos = [];
    if (Array.isArray(d.product_videos)) {
      p.videos = d.product_videos.filter(Boolean);
    }
    p.hasVideo = d.has_video || p.videos.length > 0;

    // Product slug for SEO
    p.productSlug = d.product_slug || null;

    // UPC/EAN for schema.org
    p.upc = null;
    if (d.product_information && d.product_information['UPC']) p.upc = d.product_information['UPC'];
    if (!p.upc && d.product_details && d.product_details['UPC']) p.upc = d.product_details['UPC'];

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
      shippingCharge: d.shipping_charge || d.shipping_cost || null,
      parentAsin: d.parent_asin || null,
      offersCount: d.product_num_offers || null,
      hasAplus: d.has_aplus || p.aplusImages.length > 0,
      hasBrandStory: d.has_brandstory || false
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
    product.badge = p.is_best_seller ? 'Best Seller' : (p.is_amazon_choice ? "Popular Choice" : null);
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
      'size': 'Size',
      'size_name': 'Size',
      'shoe_size': 'Size',
      'color': 'Color',
      'color_name': 'Color',
      'colour': 'Color',
      'colour_name': 'Color',
      'service_provider': 'Carrier',
      'carrier': 'Carrier',
      'product_grade': 'Condition',
      'condition': 'Condition',
      'style': 'Style',
      'style_name': 'Style',
      'pattern': 'Pattern',
      'pattern_name': 'Pattern',
      'material': 'Material',
      'configuration': 'Configuration',
      'flavor': 'Flavor',
      'flavour': 'Flavor',
      'scent': 'Scent',
      'count': 'Count',
      'wattage': 'Wattage',
      'voltage': 'Voltage',
      'length': 'Length',
      'width': 'Width',
      'storage': 'Storage'
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
