// ============================================================
// DealsHub — Shipping Estimation Service
// Calculates shipping costs and delivery estimates by source
// ============================================================

const SHIPPING_PROFILES = {
  amazon: {
    domestic: {
      standard: { cost: 0, minDays: 3, maxDays: 7, label: 'Standard (3-7 días)' },
      express:  { cost: 5.99, minDays: 1, maxDays: 3, label: 'Express (1-3 días)' },
      prime:    { cost: 0, minDays: 1, maxDays: 2, label: 'Prime (1-2 días)' }
    },
    international: {
      standard: { cost: 8.99, minDays: 7, maxDays: 14, label: 'Estándar Internacional (7-14 días)' },
      express:  { cost: 19.99, minDays: 3, maxDays: 7, label: 'Express Internacional (3-7 días)' }
    }
  },
  aliexpress: {
    domestic: {
      standard: { cost: 0, minDays: 15, maxDays: 30, label: 'AliExpress Standard (15-30 días)' },
      premium:  { cost: 4.99, minDays: 7, maxDays: 15, label: 'AliExpress Premium (7-15 días)' }
    },
    international: {
      standard: { cost: 0, minDays: 20, maxDays: 40, label: 'Envío China-US (20-40 días)' },
      express:  { cost: 9.99, minDays: 10, maxDays: 20, label: 'Express China-US (10-20 días)' }
    }
  },
  sephora: {
    domestic: {
      standard: { cost: 0, minDays: 3, maxDays: 7, label: 'Envío Gratis (3-7 días)' },
      express:  { cost: 5.95, minDays: 1, maxDays: 3, label: 'Express (1-3 días)' }
    },
    international: {
      standard: { cost: 12.99, minDays: 7, maxDays: 14, label: 'Internacional (7-14 días)' }
    }
  },
  macys: {
    domestic: {
      standard: { cost: 0, minDays: 3, maxDays: 8, label: 'Envío Gratis (3-8 días)' },
      express:  { cost: 7.99, minDays: 1, maxDays: 3, label: 'Express (1-3 días)' }
    },
    international: {
      standard: { cost: 14.99, minDays: 10, maxDays: 18, label: 'Internacional (10-18 días)' }
    }
  },
  shein: {
    domestic: {
      standard: { cost: 0, minDays: 7, maxDays: 14, label: 'Estándar SHEIN (7-14 días)' },
      express:  { cost: 4.99, minDays: 3, maxDays: 7, label: 'Express SHEIN (3-7 días)' }
    },
    international: {
      standard: { cost: 0, minDays: 10, maxDays: 20, label: 'Envío Internacional (10-20 días)' }
    }
  }
};

const RETURN_POLICIES = {
  amazon:     { window: 30, summary: 'Devolución gratis dentro de 30 días', freeReturn: true },
  aliexpress: { window: 15, summary: 'Devolución dentro de 15 días (costos de envío aplican)', freeReturn: false },
  sephora:    { window: 30, summary: 'Devolución gratis dentro de 30 días', freeReturn: true },
  macys:      { window: 30, summary: 'Devolución gratis dentro de 30 días', freeReturn: true },
  shein:      { window: 45, summary: 'Devolución gratis dentro de 45 días', freeReturn: true }
};

/**
 * Get shipping options for a source
 */
function getShippingOptions(source, region = 'domestic') {
  const profile = SHIPPING_PROFILES[source];
  if (!profile) return getDefaultShipping();
  return profile[region] || profile.domestic || getDefaultShipping();
}

/**
 * Get recommended shipping for display
 */
function getShippingEstimate(source, price = 0) {
  const options = getShippingOptions(source, 'domestic');
  const standard = options.standard || Object.values(options)[0];

  return {
    cost: standard.cost,
    freeShipping: standard.cost === 0,
    minDays: standard.minDays,
    maxDays: standard.maxDays,
    label: standard.label,
    note: standard.cost === 0 ? 'Envío GRATIS' : `Envío: $${standard.cost.toFixed(2)}`
  };
}

/**
 * Get return policy for a source
 */
function getReturnPolicy(source) {
  return RETURN_POLICIES[source] || { window: 14, summary: 'Consultar política de devolución', freeReturn: false };
}

/**
 * Calculate total cost including shipping markup
 */
function calculateShippingMarkup(source, shippingCost = 0) {
  // We absorb shipping into product markup, so no additional shipping charge
  // unless the source has a high base shipping cost
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
    standard: { cost: 4.99, minDays: 5, maxDays: 12, label: 'Envío Estándar (5-12 días)' }
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
