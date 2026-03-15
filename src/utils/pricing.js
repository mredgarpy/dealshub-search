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
const SHIPPING_ABSORPTION = {
  amazon:     { absorbUpTo: 0,    passThrough: 0 },
  aliexpress: { absorbUpTo: 2.00, passThrough: 0.5 },
  sephora:    { absorbUpTo: 0,    passThrough: 0 },
  macys:      { absorbUpTo: 0,    passThrough: 0 },
  shein:      { absorbUpTo: 0,    passThrough: 0 }
};

const PROMO_TIERS = {
  flash_deal:   { extraDiscountPct: 5,  compareAtBoost: 1.15 },
  clearance:    { extraDiscountPct: 10, compareAtBoost: 1.25 },
  new_arrival:  { extraDiscountPct: 0,  compareAtBoost: 1.05 },
  default:      { extraDiscountPct: 0,  compareAtBoost: 1.05 }
};

let pricingOverrides = new Map();

function getPricingRule(source) {
  return DEFAULT_RULES[source] || { markupPct: 15, minMarginPct: 10, roundTo: 0.99, priceFloor: 4.99, maxMarkupPct: 50 };
}

function getShippingAbsorption(source) {
  return SHIPPING_ABSORPTION[source] || { absorbUpTo: 0, passThrough: 0 };
}

function getPromoTier(promoType) {
  return PROMO_TIERS[promoType] || PROMO_TIERS.default;
}

function calculateFinalPrice(sourcePrice, source, opts = {}) {
  if (!sourcePrice || sourcePrice <= 0) return { price: null, compareAt: null };
  const rule = getPricingRule(source);
  const absorption = getShippingAbsorption(source);
  const overrideKey = opts.overrideKey || (source + ':' + (opts.sourceId || ''));
  const override = pricingOverrides.get(overrideKey);
  if (override && override.disabled) return { price: null, compareAt: null, error: 'disabled' };
  const rawShippingCost = opts.shippingCost || 0;
  const fees = opts.fees || 0;
  let effectiveShipping = 0;
  if (rawShippingCost > absorption.absorbUpTo) {
    effectiveShipping = (rawShippingCost - absorption.absorbUpTo) * absorption.passThrough;
  }
  const landedCost = sourcePrice + effectiveShipping + fees;
  let markupPct = rule.markupPct;
  if (override && override.fixedMarkup) markupPct = override.fixedMarkup;
  const promoTier = getPromoTier(opts.promoType);
  markupPct = Math.max(rule.minMarginPct, markupPct - promoTier.extraDiscountPct);
  markupPct = Math.min(markupPct, rule.maxMarkupPct);
  const markupMultiplier = 1 + (markupPct / 100);
  let finalPrice;
  if (override && override.fixedPrice && override.fixedPrice > 0) {
    finalPrice = override.fixedPrice;
  } else {
    finalPrice = landedCost * markupMultiplier;
    if (rule.roundTo) finalPrice = Math.floor(finalPrice) + rule.roundTo;
    if (rule.priceFloor && finalPrice < rule.priceFloor) finalPrice = rule.priceFloor;
  }
  let compareAt = null;
  if (opts.originalPrice && opts.originalPrice > sourcePrice) {
    compareAt = Math.floor(opts.originalPrice * markupMultiplier * promoTier.compareAtBoost) + (rule.roundTo || 0.99);
    if (compareAt <= finalPrice) compareAt = Math.floor(finalPrice * 1.15) + (rule.roundTo || 0.99);
  }
  const margin = finalPrice - landedCost;
  return {
    price: parseFloat(finalPrice.toFixed(2)), compareAt: compareAt ? parseFloat(compareAt.toFixed(2)) : null,
    landedCost: parseFloat(landedCost.toFixed(2)), totalSourceCost: parseFloat((sourcePrice + rawShippingCost + fees).toFixed(2)),
    margin: parseFloat(margin.toFixed(2)), marginPct: parseFloat(((landedCost > 0 ? (1 - landedCost / finalPrice) * 100 : 0).toFixed(1)),
    effectiveShipping: parseFloat(effectiveShipping.toFixed(2)), absorbedShipping: parseFloat((rawShippingCost - effectiveShipping).toFixed(2)),
    markupApplied: markupPct, rule: source, promoType: opts.promoType || null, hasOverride: !!override
  };
}
function calculateBatchPricing(items) { return items.map(item => ({ ...item, pricing: calculateFinalPrice(item.sourcePrice, item.source, { originalPrice: item.originalPrice, shippingCost: item.shippingCost, fees: item.fees, promoType: item.promoType, sourceId: item.sourceId }) })); }
function setPricingOverride(key, ov) { pricingOverrides.set(key, { fixedPrice: ov.fixedPrice||null, fixedMarkup: ov.fixedMarkup||null, disabled: ov.disabled||false, updatedAt: new Date().toISOString() }); }
function removePricingOverride(key) { return pricingOverrides.delete(key); }
function getAllOverrides() { const r = {}; pricingOverrides.forEach((v,k) => { r[k] = v; }); return r; }
function getPricingRules() { return { ...DEFAULT_RULES }; }
function parsePrice(s) { if (!s) return null; if (typeof s === 'number') return s; const n = parseFloat(String(s).replace(/[^0-9.]/g, '')); return isNaN(n) ? null : n; }
function simulatePrice(sp, src, tmp = null) { const r = getPricingRule(src); const t = tmp || r.minMarginPct; const rp = sp / (1 - t / 100); const rnd = Math.floor(rp) + (r.roundTo || 0.99); return { sourcePrice: sp, targetMarginPct: t, requiredPrice: parseFloat(rnd.toFixed(2)), actualMargin: parseFloat(((1 - sp / rnd) * 100).toFixed(1)) }; }
module.exports = { calculateFinalPrice, calculateBatchPricing, parsePrice, getPricingRule, getPricingRules, getShippingAbsorption, setPricingOverride, removePricingOverride, getAllOverrides, simulatePrice, PROMO_TIERS };
