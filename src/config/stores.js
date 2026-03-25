// ============================================================
// DealsHub — Store Configuration
// ============================================================
// Controls which stores are active and their classification.
// To reactivate a paused store, set active: true.
// DO NOT delete paused store code — just toggle the flag.
// ============================================================

const STORES = {
  amazon: {
    active: true,
    origin: 'USA',
    label: 'USA',
    deliveryEstimate: '2-7 days',
    flag: '\u{1F1FA}\u{1F1F8}',
    returnDays: 30,
    returnDaysPlus: 60
  },
  aliexpress: {
    active: true,
    origin: 'MIXED', // US warehouse = USA, China = INTL
    label: 'USA or International',
    deliveryEstimateUSA: '2-7 days',
    deliveryEstimateINTL: '10-25 days',
    flag: null, // depends on origin
    returnDays: 15,
    returnDaysPlus: 30
  },
  shein: {
    active: false,
    origin: 'INT',
    label: 'PAUSED',
    deliveryEstimate: '7-15 days',
    returnDays: 45,
    returnDaysPlus: 45
  },
  macys: {
    active: false,
    origin: 'USA',
    label: 'PAUSED',
    deliveryEstimate: '3-7 days',
    returnDays: 30,
    returnDaysPlus: 60
  },
  sephora: {
    active: false,
    origin: 'USA',
    label: 'PAUSED',
    deliveryEstimate: '3-7 days',
    returnDays: 30,
    returnDaysPlus: 60
  }
};

/**
 * Get only active store names
 * @returns {string[]} e.g. ['amazon', 'aliexpress']
 */
function getActiveStores() {
  return Object.entries(STORES)
    .filter(([_, config]) => config.active)
    .map(([name]) => name);
}

/**
 * Check if a store is active
 * @param {string} store
 * @returns {boolean}
 */
function isStoreActive(store) {
  const key = (store || '').toLowerCase();
  return STORES[key]?.active === true;
}

/**
 * Classify product origin: USA or INTL
 * Amazon = always USA
 * AliExpress = depends on shippingFromCode
 * @param {object} product - product with source and shipping data
 * @returns {object} { origin, badge, deliveryEstimate, flag }
 */
function classifyOrigin(product) {
  const store = (product.source || product.store || '').toLowerCase();

  if (store === 'amazon') {
    return {
      origin: 'USA',
      badge: 'USA',
      deliveryEstimate: '2-7 days',
      flag: '\u{1F1FA}\u{1F1F8}'
    };
  }

  if (store === 'aliexpress') {
    const fromCode = product.shippingData?.shipsFromCode
      || product.shipping?.shipsFromCode
      || product.delivery?.shippingFromCode
      || product.rawSourceMeta?.shipsFromCode
      || null;

    // Also check the shipsFrom text field (e.g. "United States")
    const fromText = product.shippingData?.shipsFrom
      || product.rawSourceMeta?.shipsFrom
      || product.shipping?.shipsFrom
      || '';

    const isUS = fromCode === 'US'
      || /united\s*states/i.test(fromText)
      || /^US$/i.test(fromText.trim());

    if (isUS) {
      return {
        origin: 'USA',
        badge: 'USA',
        deliveryEstimate: '2-7 days',
        flag: '\u{1F1FA}\u{1F1F8}'
      };
    }
    return {
      origin: 'INTL',
      badge: "Int'l",
      deliveryEstimate: '10-25 days',
      flag: '\u{1F30D}'
    };
  }

  // Fallback for paused or unknown stores
  const config = STORES[store];
  if (config) {
    return {
      origin: config.origin === 'USA' ? 'USA' : 'INTL',
      badge: config.origin === 'USA' ? 'USA' : "Int'l",
      deliveryEstimate: config.deliveryEstimate || '5-15 days',
      flag: config.origin === 'USA' ? '\u{1F1FA}\u{1F1F8}' : '\u{1F30D}'
    };
  }

  return { origin: 'UNKNOWN', badge: '\u2014', deliveryEstimate: null, flag: '' };
}

/**
 * Get store config
 * @param {string} store
 * @returns {object|null}
 */
function getStoreConfig(store) {
  return STORES[(store || '').toLowerCase()] || null;
}

module.exports = {
  STORES,
  getActiveStores,
  isStoreActive,
  classifyOrigin,
  getStoreConfig
};
