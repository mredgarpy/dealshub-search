// ============================================================
// StyleHub — Shipping Estimation Service v2.0 (FASE 4)
// ============================================================
// Two-layer shipping: Customer-facing + Supplier-side
// Dynamic integration with source API data
// ============================================================

const logger = require('../utils/logger');

// ============================================================
// LAYER 1 — CUSTOMER-FACING SHIPPING PROFILES
// What the customer sees in the PDP and checkout
// ============================================================
const CUSTOMER_SHIPPING_PROFILES = {
  amazon: {
    standard: { cost: 0,    minDays: 3,  maxDays: 7,  label: 'Free Shipping',        method: 'Standard' },
    express:  { cost: 5.99, minDays: 1,  maxDays: 3,  label: 'Express Shipping',      method: 'Express' },
    prime:    { cost: 0,    minDays: 1,  maxDays: 2,  label: 'Priority Shipping',     method: 'Priority' }
  },
  aliexpress: {
    standard: { cost: 0,    minDays: 12, maxDays: 25, label: 'Free Shipping',        method: 'Standard' },
    premium:  { cost: 4.99, minDays: 7,  maxDays: 15, label: 'Premium Shipping',     method: 'Premium' }
  },
  sephora: {
    standard: { cost: 0,    minDays: 3,  maxDays: 7,  label: 'Free Shipping',        method: 'Standard' },
    express:  { cost: 5.95, minDays: 1,  maxDays: 3,  label: 'Express Shipping',      method: 'Express' }
  },
  macys: {
    standard: { cost: 0,    minDays: 3,  maxDays: 8,  label: 'Free Shipping',        method: 'Standard' },
    express:  { cost: 7.99, minDays: 1,  maxDays: 3,  label: 'Express Shipping',      method: 'Express' }
  },
  shein: {
    standard: { cost: 0,    minDays: 7,  maxDays: 14, label: 'Free Shipping',        method: 'Standard' },
    express:  { cost: 4.99, minDays: 3,  maxDays: 7,  label: 'Express Shipping',      method: 'Express' }
  }
};

// ============================================================
// LAYER 2 — SUPPLIER-SIDE SHIPPING COSTS (internal ops)
// What it actually costs us per source — used for landed cost
// ============================================================
const SUPPLIER_SHIPPING_COSTS = {
  amazon:     { typicalCost: 0,    maxCost: 5.99,  freeAbove: 35  },
  aliexpress: { typicalCost: 2.00, maxCost: 8.99,  freeAbove: 10  },
  sephora:    { typicalCost: 0,    maxCost: 5.95,  freeAbove: 35  },
  macys:      { typicalCost: 0,    maxCost: 7.99,  freeAbove: 25  },
  shein:      { typicalCost: 0,    maxCost: 4.99,  freeAbove: 49  }
};

// ============================================================
// RETURN POLICIES BY SOURCE
// ============================================================
const RETURN_POLICIES = {
  amazon:     { window: 30, summary: 'Easy returns within 30 days',   freeReturn: true,  label: '30-Day Free Returns' },
  aliexpress: { window: 15, summary: 'Returns within 15 days',        freeReturn: false, label: '15-Day Returns' },
  sephora:    { window: 30, summary: 'Free returns within 30 days',   freeReturn: true,  label: '30-Day Free Returns' },
  macys:      { window: 30, summary: 'Free returns within 30 days',   freeReturn: true,  label: '30-Day Free Returns' },
  shein:      { window: 45, summary: 'Free returns within 45 days',   freeReturn: true,  label: '45-Day Free Returns' }
};

// ============================================================
// DELIVERY PROMISE CALCULATION
// Merges source API data with our profiles for best accuracy
// ============================================================
function calculateDeliveryEstimate(source, productData = {}) {
  const profile = CUSTOMER_SHIPPING_PROFILES[source] || getDefaultProfile();
  const standard = profile.standard;

  // If the source API returned actual delivery data, merge it
  const apiDelivery = productData.deliveryEstimate || productData.delivery || {};
  let minDays = standard.minDays;
  let maxDays = standard.maxDays;
  let label = standard.label;

  if (apiDelivery.minDays && apiDelivery.maxDays) {
    // Use API data but apply sanity bounds
    minDays = Math.max(1, Math.min(apiDelivery.minDays, 60));
    maxDays = Math.max(minDays + 1, Math.min(apiDelivery.maxDays, 90));
    label = apiDelivery.label || `Estimated ${minDays}-${maxDays} business days`;
  }

  // Add processing buffer (1-2 days for our ops)
  const processingDays = (source === 'aliexpress' || source === 'shein') ? 2 : 1;
  minDays += processingDays;
  maxDays += processingDays;

  // Build human-readable delivery promise
  const deliveryPromise = buildDeliveryPromise(minDays, maxDays);

  return {
    minDays,
    maxDays,
    label: deliveryPromise.label,
    dateRange: deliveryPromise.dateRange,
    note: standard.cost === 0 ? 'FREE Shipping' : `Shipping: $${standard.cost.toFixed(2)}`,
    freeShipping: standard.cost === 0,
    method: standard.method,
    source
  };
}

// ---- Build delivery date range from business days ----
function buildDeliveryPromise(minDays, maxDays) {
  const now = new Date();
  const minDate = addBusinessDays(now, minDays);
  const maxDate = addBusinessDays(now, maxDays);

  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  const minStr = `${months[minDate.getMonth()]} ${minDate.getDate()}`;
  const maxStr = `${months[maxDate.getMonth()]} ${maxDate.getDate()}`;

  return {
    label: `Arrives ${minStr} - ${maxStr}`,
    dateRange: { from: minDate.toISOString(), to: maxDate.toISOString() }
  };
}

function addBusinessDays(date, days) {
  const result = new Date(date);
  let added = 0;
  while (added < days) {
    result.setDate(result.getDate() + 1);
    const day = result.getDay();
    if (day !== 0 && day !== 6) added++;
  }
  return result;
}

// ============================================================
// SHIPPING OPTIONS (all tiers for a source)
// ============================================================
function getShippingOptions(source, region = 'domestic') {
  const profile = CUSTOMER_SHIPPING_PROFILES[source];
  if (!profile) return getDefaultProfile();

  // Return all options as array
  return Object.entries(profile).map(([key, opt]) => ({
    id: key,
    ...opt
  }));
}

// ============================================================
// SHIPPING ESTIMATE (default/standard tier)
// ============================================================
function getShippingEstimate(source, price = 0) {
  const profile = CUSTOMER_SHIPPING_PROFILES[source] || getDefaultProfile();
  const standard = profile.standard || Object.values(profile)[0];

  return {
    cost: standard.cost,
    freeShipping: standard.cost === 0,
    minDays: standard.minDays,
    maxDays: standard.maxDays,
    label: standard.label,
    note: standard.cost === 0 ? 'FREE Shipping' : `Shipping: $${standard.cost.toFixed(2)}`
  };
}

// ============================================================
// RETURN POLICY
// ============================================================
function getReturnPolicy(source) {
  return RETURN_POLICIES[source] || {
    window: 14,
    summary: 'Contact us for return details',
    freeReturn: false,
    label: '14-Day Returns'
  };
}

// ============================================================
// SUPPLIER SHIPPING COST (for landed cost calculation)
// ============================================================
function getSupplierShippingCost(source, productPrice = 0, apiShippingCost = null) {
  const costs = SUPPLIER_SHIPPING_COSTS[source] || { typicalCost: 4.99, maxCost: 9.99, freeAbove: 50 };

  // If API returned actual shipping cost, use it
  if (apiShippingCost !== null && apiShippingCost !== undefined && !isNaN(apiShippingCost)) {
    return parseFloat(apiShippingCost);
  }

  // Otherwise estimate based on profile
  if (productPrice >= costs.freeAbove) {
    return 0;
  }
  return costs.typicalCost;
}

// ============================================================
// SHIPPING MARKUP FOR PRICING
// ============================================================
function calculateShippingMarkup(source, shippingCost = 0) {
  const threshold = {
    amazon: 0,
    aliexpress: 2,
    sephora: 0,
    macys: 0,
    shein: 0
  };
  const absorbed = threshold[source] || 0;
  return Math.max(0, shippingCost - absorbed);
}

// ============================================================
// FULL SHIPPING SUMMARY FOR PDP DISPLAY
// ============================================================
function getShippingSummaryForPDP(source, productData = {}) {
  const delivery = calculateDeliveryEstimate(source, productData);
  const returnPolicy = getReturnPolicy(source);
  const options = getShippingOptions(source);

  return {
    delivery,
    returnPolicy,
    options,
    trustBadges: {
      freeShipping: delivery.freeShipping,
      freeReturns: returnPolicy.freeReturn,
      secureCheckout: true,
      returnWindow: returnPolicy.window
    }
  };
}

function getDefaultProfile() {
  return {
    standard: { cost: 4.99, minDays: 5, maxDays: 12, label: 'Standard Shipping', method: 'Standard' }
  };
}

module.exports = {
  calculateDeliveryEstimate,
  getShippingOptions,
  getShippingEstimate,
  getReturnPolicy,
  getSupplierShippingCost,
  calculateShippingMarkup,
  getShippingSummaryForPDP,
  CUSTOMER_SHIPPING_PROFILES,
  RETURN_POLICIES,
  SUPPLIER_SHIPPING_COSTS
};