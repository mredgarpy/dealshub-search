// ============================================================
// DealsHub — Pricing Engine v2.0 (FASE 4)
// ============================================================
// Controls markup, margins, rounding, compare-at logic,
// landed cost, price floors, promotional pricing, overrides
// ============================================================

// ---- DEFAULT PRICING RULES BY SOURCE ----
const DEFAULT_RULES = {
  amazon:     { markupPct: 12, minMarginPct: 8,  roundTo: 0.99, priceFloor: 4.99,  maxMarkupPct: 40 },
  aliexpress: { markupPct: 25, minMarginPct: 15, roundTo: 0.99, priceFloor: 2.99,  maxMarkupPct: 60 },
  sephora:    { markupPct: 10, minMarginPct: 5,  roundTo: 0.99, priceFloor: 9.99,  maxMarkupPct: 30 },
  macys:      { markupPct: 10, minMarginPct: 5,  roundTo: 0.99, priceFloor: 9.99,  maxMarkupPct: 30 },
  shein:      { markupPct: 30, minMarginPct: 18, roundTo: 0.99, priceFloor: 3.99,  maxMarkupPct: 65 }
};

// ---- SHIPPING COST ABSORPTION THRESHOLDS ----
// How much shipping cost the store absorbs per source before passing to customer
const SHIPPING_ABSORPTION = {
  amazon:     { absorbUpTo: 0,    passThrough: 0 },     // Amazon mostly free shipping
  aliexpress: { absorbUpTo: 2.00, passThrough: 0.5 },   // Absorb first $2, pass 50% of rest
  sephora:    { absorbUpTo: 0,    passThrough: 0 },     // Sephora usually free
  macys:      { absorbUpTo: 0,    passThrough: 0 },     // Macy's usually free
  shein:      { absorbUpTo: 0,    passThrough: 0 }      // SHEIN usually free
};

// ---- PROMOTIONAL PRICING TIERS ----
// Apply extra discount for perceived value
const PROMO_TIERS = {
  flash_deal:   { extraDiscountPct: 5,  compareAtBoost: 1.15 },
  clearance:    { extraDiscountPct: 10, compareAtBoost: 1.25 },
  new_arrival:  { extraDiscountPct: 0,  compareAtBoost: 1.05 },
  default:      { extraDiscountPct: 0,  compareAtBoost: 1.05 }
};

// In-memory pricing overrides (loaded from DB/admin in the future)
let pricingOverrides = new Map(); // key: source:sourceId -> { fixedPrice, fixedMarkup, disabled }

function getPricingRule(source) {
  return DEFAULT_RULES[source] || { markupPct: 15, minMarginPct: 10, roundTo: 0.99, priceFloor: 4.99, maxMarkupPct: 50 };
}

function getShippingAbsorption(source) {
  return SHIPPING_ABSORPTION[source] || { absorbUpTo: 0, passThrough: 0 };
}

function getPromoTier(promoType) {
  return PROMO_TIERS[promoType] || PROMO_TIERS.default;
}

// ---- MAIN PRICING FUNCTION ----
function calculateFinalPrice(sourcePrice, source, opts = {}) {
  if (!sourcePrice || sourcePrice <= 0) return { price: null, compareAt: null };

  const rule = getPricingRule(source);
  const absorption = getShippingAbsorption(source);

  // Check for manual override
  const overrideKey = opts.overrideKey || (source + ':' + (opts.sourceId || ''));
  const override = pricingOverrides.get(overrideKey);
  if (override && override.disabled) {
    return { price: null, compareAt: null, error: 'Product pricing disabled' };
  }

  // ---- LANDED COST CALCULATION ----
  const rawShippingCost = opts.shippingCost || 0;
  const fees = opts.fees || 0;

  // Calculate effective shipping cost after absorption
  let effectiveShipping = 0;
  if (rawShippingCost > absorption.absorbUpTo) {
    effectiveShipping = (rawShippingCost - absorption.absorbUpTo) * absorption.passThrough;
  }

  const landedCost = sourcePrice + effectiveShipping + fees;

  // ---- MARKUP CALCULATION ----
  let markupPct = rule.markupPct;

  // Apply override markup if exists
  if (override && override.fixedMarkup) {
    markupPct = override.fixedMarkup;
  }

  // Apply promo tier adjustment
  const promoTier = getPromoTier(opts.promoType);
  markupPct = Math.max(rule.minMarginPct, markupPct - promoTier.extraDiscountPct);

  // Cap markup
  markupPct = Math.min(markupPct, rule.maxMarkupPct);

  const markupMultiplier = 1 + (markupPct / 100);

  // ---- FINAL PRICE ----
  let finalPrice;

  if (override && override.fixedPrice && override.fixedPrice > 0) {
    // Manual fixed price override
    finalPrice = override.fixedPrice;
  } else {
    finalPrice = landedCost * markupMultiplier;

    // Apply rounding (e.g., $24.99)
    if (rule.roundTo) {
      finalPrice = Math.floor(finalPrice) + rule.roundTo;
    }

    // Apply price floor
    if (rule.priceFloor && finalPrice < rule.priceFloor) {
      finalPrice = rule.priceFloor;
    }
  }

  // ---- COMPARE-AT PRICE (strikethrough) ----
  let compareAt = null;
  if (opts.originalPrice && opts.originalPrice > sourcePrice) {
    compareAt = (opts.originalPrice * markupMultiplier * promoTier.compareAtBoost).toFixed(2);
    compareAt = Math.floor(parseFloat(compareAt)) + (rule.roundTo || 0.99);
    // Ensure compareAt is higher than final price
    if (compareAt <= finalPrice) {
      compareAt = finalPrice * 1.15;
      compareAt = Math.floor(compareAt) + (rule.roundTo || 0.99);
    }
  }

  // ---- MARGIN CALCULATIONS ----
  const margin = finalPrice - landedCost;
  const marginPct = landedCost > 0 ? ((1 - landedCost / finalPrice) * 100) : 0;
  const totalSourceCost = sourcePrice + rawShippingCost + fees;

  return {
    price: parseFloat(finalPrice.toFixed(2)),
    compareAt: compareAt ? parseFloat(compareAt.toFixed(2)) : null,
    landedCost: parseFloat(landedCost.toFixed(2)),
    totalSourceCost: parseFloat(totalSourceCost.toFixed(2)),
    margin: parseFloat(margin.toFixed(2)),
    marginPct: parseFloat(marginPct.toFixed(1)),
    effectiveShipping: parseFloat(effectiveShipping.toFixed(2)),
    absorbedShipping: parseFloat((rawShippingCost - effectiveShipping).toFixed(2)),
    markupApplied: markupPct,
    rule: source,
    promoType: opts.promoType || null,
    hasOverride: !!override
  };
}

// ---- BATCH PRICING ----
function calculateBatchPricing(items) {
  return items.map(item => ({
    ...item,
    pricing: calculateFinalPrice(item.sourcePrice, item.source, {
      originalPrice: item.originalPrice,
      shippingCost: item.shippingCost,
      fees: item.fees,
      promoType: item.promoType,
      sourceId: item.sourceId
    })
  }));
}

// ---- PRICING OVERRIDES MANAGEMENT ----
function setPricingOverride(key, override) {
  pricingOverrides.set(key, {
    fixedPrice: override.fixedPrice || null,
    fixedMarkup: override.fixedMarkup || null,
    disabled: override.disabled || false,
    updatedAt: new Date().toISOString()
  });
}

function removePricingOverride(key) {
  return pricingOverrides.delete(key);
}

function getAllOverrides() {
  const result = {};
  pricingOverrides.forEach((v, k) => { result[k] = v; });
  return result;
}

function getPricingRules() {
  return { ...DEFAULT_RULES };
}

// ---- PRICE PARSER ----
function parsePrice(priceStr) {
  if (!priceStr) return null;
  if (typeof priceStr === 'number') return priceStr;
  const cleaned = String(priceStr).replace(/[^0-9.]/g, '');
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}

// ---- MARGIN SIMULATOR ----
// Given source price and desired margin, calculate required final price
function simulatePrice(sourcePrice, source, targetMarginPct = null) {
  const rule = getPricingRule(source);
  const targetMargin = targetMarginPct || rule.minMarginPct;
  const requiredPrice = sourcePrice / (1 - targetMargin / 100);
  const rounded = Math.floor(requiredPrice) + (rule.roundTo || 0.99);
  return {
    sourcePrice,
    targetMarginPct: targetMargin,
    requiredPrice: parseFloat(rounded.toFixed(2)),
    actualMargin: parseFloat(((1 - sourcePrice / rounded) * 100).toFixed(1))
  };
}

module.exports = {
  calculateFinalPrice,
  calculateBatchPricing,
  parsePrice,
  getPricingRule,
  getPricingRules,
  getShippingAbsorption,
  setPricingOverride,
  removePricingOverride,
  getAllOverrides,
  simulatePrice,
  PROMO_TIERS
};
