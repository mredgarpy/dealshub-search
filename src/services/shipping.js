// ============================================================
// StyleHub — Shipping Estimation Service
// Calculates shipping costs and delivery estimates by source
// ============================================================

const SHIPPING_PROFILES = {
  amazon: {
    domestic: {
      standard: { cost: 0, minDays: 3, maxDays: 7, label: 'Standard Shipping (3-7 days)' },
      express:  { cost: 5.99, minDays: 1, maxDays: 3, label: 'Express (1-3 days)' },
      prime:    { cost: 0, minDays: 1, maxDays: 2, label: 'Prime (1-2 days)' }
    },
    international: {
      standard: { cost: 8.99, minDays: 7, maxDays: 14, label: 'International Standard (7-14 days)' },
      express:  { cost: 19.99, minDays: 3, maxDays: 7, label: 'International Express (3-7 days)' }
    }
  },
  aliexpress: {
    domestic: {
      standard: { cost: 0, minDays: 15, maxDays: 30, label: 'AliExpress Standard (15-30 days)' },
      premium:  { cost: 4.99, minDays: 7, maxDays: 15, label: 'AliExpress Premium (7-15 days)' }
    },
    international: {
      standard: { cost: 0, minDays: 20, maxDays: 40, label: 'China-US Shipping (20-40 days)' },
      express:  { cost: 9.99, minDays: 10, maxDays: 20, label: 'China-US Express (10-20 days)' }
    }
  },
  sephora: {
    domestic: {
      standard: { cost: 0, minDays: 3, maxDays: 7, label: 'Free Shipping (3-7 days)' },
      express:  { cost: 5.95, minDays: 1, maxDays: 3, label: 'Express (1-3 days)' }
    },
    international: {
      standard: { cost: 12.99, minDays: 7, maxDays: 14, label: 'International (7-14 days)' }
    }
  },
  macys: {
    domestic: {
      standard: { cost: 0, minDays: 3, maxDays: 8, label: 'Free Shipping (3-8 days)' },
      express:  { cost: 7.99, minDays: 1, maxDays: 3, label: 'Express (1-3 days)' }
    },
    international: {
      standard: { cost: 14.99, minDays: 10, maxDays: 18, label: 'International (10-18 days)' }
    }
  },
  shein: {
    domestic: {
      standard: { cost: 0, minDays: 7, maxDays: 14, label: 'SHEIN Standard (7-14 days)' },
      express:  { cost: 4.99, minDays: 3, maxDays: 7, label: 'SHEIN Express (3-7 days)' }
    },
    international: {
      standard: { cost: 0, minDays: 10, maxDays: 20, label: 'International Shipping (10-20 days)' }
    }
  }
};

const RETURN_POLICIES = {
  amazon:     { window: 30, summary: 'Free returns within 30 days', freeReturn: true },
  aliexpress: { window: 15, summary: 'Returns within 15 days (shipping costs apply)', freeReturn: false },
  sephora:    { window: 30, summary: 'Free returns within 30 days', freeReturn: true },
  macys:      { window: 30, summary: 'Free returns within 30 days', freeReturn: true },
  shein:      { window: 45, summary: 'Free returns within 45 days', freeReturn: true }
};

function getShippingOptions(source, region = 'domestic') {
  const profile = SHIPPING_PROFILES[source];
  if (!profile) return getDefaultShipping();
  return profile[region] || profile.domestic || getDefaultShipping();
}

function getShippingEstimate(source, price = 0) {
  const options = getShippingOptions(source, 'domestic');
  const standard = options.standard || Object.values(options)[0];

  return {
    cost: standard.cost,
    freeShipping: standard.cost === 0,
    minDays: standard.minDays,
    maxDays: standard.maxDays,
    label: standard.label,
    note: standard.cost === 0 ? 'FREE Shipping' : `Shipping: $${standard.cost.toFixed(2)}`
  };
}

function getReturnPolicy(source) {
  return RETURN_POLICIES[source] || { window: 14, summary: 'Contact us for return policy details', freeReturn: false };
}

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

function getDefaultShipping() {
  return {
    standard: { cost: 4.99, minDays: 5, maxDays: 12, label: 'Standard Shipping (5-12 days)' }
  };
}

module.exports = {
  getShippingOptions,
  getShippingEstimate,
  getReturnPolicy,
  calculateShippingMarkup,
  SHIPPING_PROFILES,
  RETURN_POLICIES
};
