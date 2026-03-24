// ============================================================
// DealsHub — Shipping Rules Engine v2.0
// ============================================================
// Real shipping rules per source store, verified March 2026.
// Amazon: parsed from rawSourceMeta.delivery (API real data)
// AliExpress: FREE (included in price)
// SHEIN: $3.99 standard, FREE >= $29
// Macy's: $10.95 standard, FREE >= $25
// Sephora: FREE (Beauty Insider account)
// ============================================================

const logger = require('../utils/logger');

/**
 * Calculate shipping for a product based on store rules + API data.
 * @param {string} store - Source store name
 * @param {number} sourcePrice - Original source price (before markup)
 * @param {object} apiData - Full product data from adapter (includes rawSourceMeta, deliveryEstimate, options)
 * @param {boolean} customerIsPlus - Whether customer has StyleHub Plus
 * @returns {object} Shipping calculation result
 */
function calculateShipping(store, sourcePrice, apiData, customerIsPlus = false) {
  // StyleHub Plus = FREE shipping on everything
  if (customerIsPlus) {
    return {
      cost: 0,
      label: 'FREE',
      method: 'StyleHub Plus',
      isFree: true,
      isPlus: true,
      delivery: _getDelivery(store, apiData),
      plusSaves: 0,
      returnWindow: _getReturnWindow(store, true)
    };
  }

  switch (store.toLowerCase()) {
    case 'amazon':
      return _amazonShipping(sourcePrice, apiData);
    case 'aliexpress':
      return _aliexpressShipping(sourcePrice, apiData);
    case 'shein':
      return _sheinShipping(sourcePrice, apiData);
    case 'macys':
      return _macysShipping(sourcePrice, apiData);
    case 'sephora':
      return _sephoraShipping(sourcePrice, apiData);
    default:
      return _defaultShipping(sourcePrice, apiData);
  }
}

// ---- AMAZON: Use real /product-offers data when available, fallback to delivery text ----
function _amazonShipping(sourcePrice, apiData) {
  const raw = apiData?.rawSourceMeta?.delivery || '';
  const isPrime = apiData?.rawSourceMeta?.isPrime === true;
  const primaryDeliveryTime = apiData?.rawSourceMeta?.primaryDeliveryTime || '';

  // v2.1: Check for real offer data from /product-offers endpoint
  const bestOfferIsFBA = apiData?.rawSourceMeta?.bestOfferIsFBA === true;
  const bestOfferDeliveryPrice = apiData?.rawSourceMeta?.bestOfferDeliveryPrice;
  const bestOfferDeliveryTime = apiData?.rawSourceMeta?.bestOfferDeliveryTime;
  const bestOfferSeller = apiData?.rawSourceMeta?.bestOfferSeller;
  const bestOfferShipsFrom = apiData?.rawSourceMeta?.bestOfferShipsFrom;
  const hasOfferData = apiData?.rawSourceMeta?.offersCount > 0;

  let cost = 0;
  let method = 'Standard Shipping';
  let shipsFrom = null;
  let seller = null;
  let isFBA = false;

  if (hasOfferData) {
    // Use real offer data
    isFBA = bestOfferIsFBA;
    shipsFrom = bestOfferShipsFrom || null;
    seller = bestOfferSeller || null;

    if (isFBA) {
      cost = 0;
      method = 'Amazon Prime';
    } else if (bestOfferDeliveryPrice) {
      const isFree = bestOfferDeliveryPrice === 'FREE' || bestOfferDeliveryPrice === '$0.00';
      cost = isFree ? 0 : parseFloat(bestOfferDeliveryPrice.replace('$', '').replace(',', '')) || 0;
      method = isFree ? 'Free Shipping' : 'Seller Shipping';
    }
  } else {
    // Fallback: parse from delivery text (legacy behavior)
    if (isPrime || /free\s*delivery/i.test(raw)) {
      cost = 0;
      method = isPrime ? 'Prime Shipping' : 'Free Shipping';
    } else if (raw) {
      const priceMatch = raw.match(/\$([0-9]+(?:\.[0-9]{1,2})?)/);
      if (priceMatch) {
        cost = parseFloat(priceMatch[1]);
        method = 'Amazon Shipping';
      }
    }
  }

  // Delivery dates: prefer offer data, then primary_delivery_time, then API estimate
  const deliverySource = bestOfferDeliveryTime || primaryDeliveryTime;
  const delivery = _parseAmazonDelivery(deliverySource, apiData?.deliveryEstimate);

  return {
    cost,
    label: cost === 0 ? 'FREE' : `$${cost.toFixed(2)}`,
    method,
    isFree: cost === 0,
    isFBA,
    shipsFrom,
    seller,
    delivery,
    threshold: null,
    remaining: null,
    thresholdNote: null,
    plusSaves: cost,
    returnWindow: _getReturnWindow('amazon', false)
  };
}

function _parseAmazonDelivery(primaryDeliveryTime, deliveryEstimate) {
  if (primaryDeliveryTime) {
    return {
      label: primaryDeliveryTime,
      minDays: deliveryEstimate?.minDays || null,
      maxDays: deliveryEstimate?.maxDays || null,
      earliest: deliveryEstimate?.earliestDate || null,
      latest: deliveryEstimate?.latestDate || null,
      formattedRange: deliveryEstimate?.formattedRange || primaryDeliveryTime
    };
  }
  if (deliveryEstimate) {
    return {
      label: deliveryEstimate.label || '5-10 business days',
      minDays: deliveryEstimate.minDays,
      maxDays: deliveryEstimate.maxDays,
      earliest: deliveryEstimate.earliestDate || null,
      latest: deliveryEstimate.latestDate || null,
      formattedRange: deliveryEstimate.formattedRange || deliveryEstimate.label || '5-10 business days'
    };
  }
  return { label: '5-10 business days', minDays: 5, maxDays: 10, earliest: null, latest: null, formattedRange: '5-10 business days' };
}

// ---- ALIEXPRESS: FREE (included in price) ----
function _aliexpressShipping(sourcePrice, apiData) {
  const shipsFromUS = (apiData?.options || []).some(o =>
    /ships?\s*from/i.test(o.name || '') &&
    o.values?.some(v => /united\s*states|US\s*warehouse/i.test(v.value || ''))
  );

  const delivery = shipsFromUS
    ? { label: '3-7 business days', minDays: 3, maxDays: 7, earliest: null, latest: null, formattedRange: null }
    : (apiData?.deliveryEstimate || { label: '15-25 business days', minDays: 15, maxDays: 25, earliest: null, latest: null, formattedRange: null });

  // Calculate formatted dates if not already present
  if (!delivery.formattedRange && delivery.minDays && delivery.maxDays) {
    const now = new Date();
    const min = new Date(now); min.setDate(min.getDate() + delivery.minDays);
    const max = new Date(now); max.setDate(max.getDate() + delivery.maxDays);
    const fmt = d => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    delivery.earliest = fmt(min);
    delivery.latest = fmt(max);
    delivery.formattedRange = `${fmt(min)} – ${fmt(max)}`;
  }

  return {
    cost: 0,
    label: 'FREE',
    method: shipsFromUS ? 'US Warehouse' : 'AliExpress Standard',
    isFree: true,
    delivery,
    shipsFrom: shipsFromUS ? 'United States' : (apiData?.rawSourceMeta?.originCountry || 'China'),
    threshold: null,
    remaining: null,
    thresholdNote: null,
    plusSaves: 0,
    returnWindow: _getReturnWindow('aliexpress', false)
  };
}

// ---- SHEIN: $3.99, FREE >= $29 ----
function _sheinShipping(sourcePrice, apiData) {
  const isFree = sourcePrice >= 29;
  const cost = isFree ? 0 : 3.99;

  const delivery = apiData?.deliveryEstimate || { label: '7-14 business days', minDays: 7, maxDays: 14 };
  if (!delivery.formattedRange && delivery.minDays && delivery.maxDays) {
    const now = new Date();
    const min = new Date(now); min.setDate(min.getDate() + delivery.minDays);
    const max = new Date(now); max.setDate(max.getDate() + delivery.maxDays);
    const fmt = d => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    delivery.earliest = fmt(min);
    delivery.latest = fmt(max);
    delivery.formattedRange = `${fmt(min)} – ${fmt(max)}`;
  }

  return {
    cost,
    label: isFree ? 'FREE' : '$3.99',
    method: 'SHEIN Standard',
    isFree,
    delivery,
    threshold: 29,
    remaining: isFree ? 0 : Math.max(0, parseFloat((29 - sourcePrice).toFixed(2))),
    thresholdNote: isFree ? null : 'Free shipping on SHEIN orders over $29',
    plusSaves: cost,
    returnWindow: _getReturnWindow('shein', false)
  };
}

// ---- MACY'S: $10.95, FREE >= $25 ----
function _macysShipping(sourcePrice, apiData) {
  const isFree = sourcePrice >= 25;
  const cost = isFree ? 0 : 10.95;

  const delivery = apiData?.deliveryEstimate || { label: '3-8 business days', minDays: 3, maxDays: 8 };
  if (!delivery.formattedRange && delivery.minDays && delivery.maxDays) {
    const now = new Date();
    const min = new Date(now); min.setDate(min.getDate() + delivery.minDays);
    const max = new Date(now); max.setDate(max.getDate() + delivery.maxDays);
    const fmt = d => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    delivery.earliest = fmt(min);
    delivery.latest = fmt(max);
    delivery.formattedRange = `${fmt(min)} – ${fmt(max)}`;
  }

  return {
    cost,
    label: isFree ? 'FREE' : '$10.95',
    method: "Macy's Standard",
    isFree,
    delivery,
    threshold: 25,
    remaining: isFree ? 0 : Math.max(0, parseFloat((25 - sourcePrice).toFixed(2))),
    thresholdNote: isFree ? null : "Free shipping on Macy's orders over $25",
    plusSaves: cost,
    returnWindow: _getReturnWindow('macys', false)
  };
}

// ---- SEPHORA: FREE (Beauty Insider) ----
function _sephoraShipping(sourcePrice, apiData) {
  return {
    cost: 0,
    label: 'FREE',
    method: 'Sephora Standard',
    isFree: true,
    delivery: { label: '3-5 business days', minDays: 3, maxDays: 5, earliest: null, latest: null, formattedRange: null },
    threshold: null,
    remaining: null,
    thresholdNote: null,
    plusSaves: 0,
    note: 'FREE shipping (Beauty Insider)',
    returnWindow: _getReturnWindow('sephora', false)
  };
}

// ---- DEFAULT ----
function _defaultShipping(sourcePrice, apiData) {
  return {
    cost: 5.00,
    label: '$5.00',
    method: 'Standard Shipping',
    isFree: false,
    delivery: { label: '5-14 business days', minDays: 5, maxDays: 14, earliest: null, latest: null, formattedRange: null },
    threshold: null,
    remaining: null,
    thresholdNote: null,
    plusSaves: 5.00,
    returnWindow: { days: 30, summary: '30-day returns' }
  };
}

function _getDelivery(store, apiData) {
  const de = apiData?.deliveryEstimate;
  if (de && de.label) return de;
  switch (store.toLowerCase()) {
    case 'amazon': return { label: '5-10 business days', minDays: 5, maxDays: 10 };
    case 'aliexpress': return { label: '15-25 business days', minDays: 15, maxDays: 25 };
    case 'shein': return { label: '7-14 business days', minDays: 7, maxDays: 14 };
    case 'macys': return { label: '3-8 business days', minDays: 3, maxDays: 8 };
    case 'sephora': return { label: '3-5 business days', minDays: 3, maxDays: 5 };
    default: return { label: '5-14 business days', minDays: 5, maxDays: 14 };
  }
}

function _getReturnWindow(store, isPlus) {
  if (isPlus) return { days: 60, summary: 'Extended 60-day returns (Plus benefit)' };
  switch (store.toLowerCase()) {
    case 'amazon': return { days: 30, summary: 'Free returns within 30 days' };
    case 'aliexpress': return { days: 15, summary: 'Returns accepted within 15 days' };
    case 'shein': return { days: 45, summary: 'Free returns within 45 days' };
    case 'macys': return { days: 30, summary: 'Free returns within 30 days' };
    case 'sephora': return { days: 30, summary: 'Free returns within 30 days' };
    default: return { days: 30, summary: '30-day returns' };
  }
}

/**
 * Get our actual shipping cost from supplier (for margin calculation).
 * This is different from what we CHARGE the customer.
 * We have Prime on Amazon, Beauty Insider on Sephora, etc.
 */
function getSupplierShippingCost(store, sourcePrice) {
  switch (store.toLowerCase()) {
    case 'amazon': return 0;     // We have Prime
    case 'aliexpress': return 0; // Included in price
    case 'shein': return sourcePrice >= 29 ? 0 : 3.99;
    case 'macys': return sourcePrice >= 25 ? 0 : 10.95;
    case 'sephora': return 0;    // Beauty Insider
    default: return 0;
  }
}

module.exports = { calculateShipping, getSupplierShippingCost };
