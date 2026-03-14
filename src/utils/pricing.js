// ============================================================
// DealsHub — Pricing Engine
// ============================================================
// Controls markup, margins, rounding, compare-at logic

const DEFAULT_RULES = {
  amazon:     { markupPct: 12, minMarginPct: 8,  roundTo: 0.99 },
  aliexpress: { markupPct: 25, minMarginPct: 15, roundTo: 0.99 },
  sephora:    { markupPct: 10, minMarginPct: 5,  roundTo: 0.99 },
  macys:      { markupPct: 10, minMarginPct: 5,  roundTo: 0.99 },
  shein:      { markupPct: 30, minMarginPct: 18, roundTo: 0.99 }
};

function getPricingRule(source) {
  return DEFAULT_RULES[source] || { markupPct: 15, minMarginPct: 10, roundTo: 0.99 };
}

function calculateFinalPrice(sourcePrice, source, opts = {}) {
  if (!sourcePrice || sourcePrice <= 0) return { price: null, compareAt: null };
  const rule = getPricingRule(source);
  const shippingCost = opts.shippingCost || 0;
  const fees = opts.fees || 0;
  const landedCost = sourcePrice + shippingCost + fees;
  const markupMultiplier = 1 + (rule.markupPct / 100);
  let finalPrice = landedCost * markupMultiplier;

  // Apply rounding (e.g., $24.99)
  if (rule.roundTo) {
    finalPrice = Math.floor(finalPrice) + rule.roundTo;
  }

  // Compare-at price: original retail price with higher markup for perceived discount
  let compareAt = null;
  if (opts.originalPrice && opts.originalPrice > sourcePrice) {
    compareAt = (opts.originalPrice * markupMultiplier * 1.05).toFixed(2);
    compareAt = Math.floor(parseFloat(compareAt)) + rule.roundTo;
  }

  return {
    price: parseFloat(finalPrice.toFixed(2)),
    compareAt: compareAt ? parseFloat(compareAt.toFixed(2)) : null,
    landedCost: parseFloat(landedCost.toFixed(2)),
    margin: parseFloat((finalPrice - landedCost).toFixed(2)),
    marginPct: parseFloat(((1 - landedCost / finalPrice) * 100).toFixed(1)),
    rule: source
  };
}

function parsePrice(priceStr) {
  if (!priceStr) return null;
  if (typeof priceStr === 'number') return priceStr;
  const cleaned = String(priceStr).replace(/[^0-9.]/g, '');
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}

module.exports = { calculateFinalPrice, parsePrice, getPricingRule };
