// ============================================================
// DealsHub — Pricing Engine v2.0
// ============================================================
// Controls markup, margins, rounding, compare-at logic
// Now reads from DB rules with fallback to hardcoded defaults
// Supports: source rules, category rules, brand rules, price floors

const logger = require('./logger');

// Markup raised 2026-04-02 to support Meta Ads profitability
// Amazon 12→40%, AliExpress 25→50%, Sephora 10→35%, Macys 10→35%, Shein 30→50%
// Under-$5 impulse buys get 60% markup (handled in calculateFinalPrice)
const DEFAULT_RULES = {
  amazon:     { markupPct: 40, minMarginPct: 25, roundTo: 0.99, priceFloor: null },
  aliexpress: { markupPct: 50, minMarginPct: 30, roundTo: 0.99, priceFloor: null },
  sephora:    { markupPct: 35, minMarginPct: 20, roundTo: 0.99, priceFloor: null },
  macys:      { markupPct: 35, minMarginPct: 20, roundTo: 0.99, priceFloor: null },
  shein:      { markupPct: 50, minMarginPct: 30, roundTo: 0.99, priceFloor: null }
};

// Cache DB rules in memory (refreshed every 5 minutes)
let _dbRulesCache = null;
let _dbRulesCacheTime = 0;
const DB_RULES_TTL = 300000; // 5 min

function _loadDbRules() {
  if (_dbRulesCache && Date.now() - _dbRulesCacheTime < DB_RULES_TTL) {
    return _dbRulesCache;
  }
  try {
    const { getPricingRules } = require('./db');
    const rules = getPricingRules();
    if (rules && rules.length > 0) {
      _dbRulesCache = rules.filter(r => r.is_active);
      _dbRulesCacheTime = Date.now();
      return _dbRulesCache;
    }
  } catch (e) {
    // DB not available — use defaults
  }
  return null;
}

/**
 * Get the best pricing rule for a product.
 * Priority: brand+source > category+source > source-only > hardcoded default
 */
function getPricingRule(source, opts = {}) {
  const dbRules = _loadDbRules();
  if (dbRules && dbRules.length > 0) {
    const { category, brand } = opts;
    // Priority 1: brand + source match
    if (brand) {
      const brandRule = dbRules.find(r =>
        r.source_store === source && r.brand && r.brand.toLowerCase() === brand.toLowerCase()
      );
      if (brandRule) return _dbToRule(brandRule);
    }
    // Priority 2: category + source match
    if (category) {
      const catRule = dbRules.find(r =>
        r.source_store === source && r.category && r.category.toLowerCase() === category.toLowerCase() && !r.brand
      );
      if (catRule) return _dbToRule(catRule);
    }
    // Priority 3: source-only match (no category/brand)
    const sourceRule = dbRules.find(r =>
      r.source_store === source && !r.category && !r.brand
    );
    if (sourceRule) return _dbToRule(sourceRule);
  }
  return DEFAULT_RULES[source] || { markupPct: 15, minMarginPct: 10, roundTo: 0.99, priceFloor: null };
}

function _dbToRule(r) {
  return {
    markupPct: r.markup_pct,
    minMarginPct: r.min_margin_pct,
    roundTo: r.round_to || 0.99,
    priceFloor: r.price_floor || null,
    ruleId: r.id,
    ruleType: r.brand ? 'brand' : (r.category ? 'category' : 'source')
  };
}

function calculateFinalPrice(sourcePrice, source, opts = {}) {
  if (!sourcePrice || sourcePrice <= 0) return { price: null, compareAt: null };
  const rule = getPricingRule(source, { category: opts.category, brand: opts.brand });
  const shippingCost = opts.shippingCost || 0;
  const fees = opts.fees || 0;
  const landedCost = sourcePrice + shippingCost + fees;
  // Impulse buys under $5 get higher markup (60%) to maintain margin on cheap items
  const effectiveMarkupPct = (sourcePrice < 5) ? Math.max(rule.markupPct, 60) : rule.markupPct;
  const markupMultiplier = 1 + (effectiveMarkupPct / 100);
  let finalPrice = landedCost * markupMultiplier;

  // Ensure minimum margin
  const minMargin = landedCost * (rule.minMarginPct / 100);
  if (finalPrice - landedCost < minMargin) {
    finalPrice = landedCost + minMargin;
  }

  // Apply price floor
  if (rule.priceFloor && finalPrice < rule.priceFloor) {
    finalPrice = rule.priceFloor;
  }

  // Apply rounding (e.g., $24.99)
  if (rule.roundTo) {
    finalPrice = Math.floor(finalPrice) + rule.roundTo;
  }

  // Compare-at price: original retail price with higher markup for perceived discount
  let compareAt = null;
  if (opts.originalPrice && opts.originalPrice > sourcePrice) {
    compareAt = (opts.originalPrice * markupMultiplier * 1.05).toFixed(2);
    compareAt = Math.floor(parseFloat(compareAt)) + (rule.roundTo || 0.99);
  }

  return {
    price: parseFloat(finalPrice.toFixed(2)),
    compareAt: compareAt ? parseFloat(compareAt.toFixed(2)) : null,
    landedCost: parseFloat(landedCost.toFixed(2)),
    margin: parseFloat((finalPrice - landedCost).toFixed(2)),
    marginPct: parseFloat(((1 - landedCost / finalPrice) * 100).toFixed(1)),
    rule: source,
    ruleId: rule.ruleId || null,
    ruleType: rule.ruleType || 'default'
  };
}

function parsePrice(priceStr) {
  if (!priceStr) return null;
  if (typeof priceStr === 'number') return priceStr;
  const cleaned = String(priceStr).replace(/[^0-9.]/g, '');
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}

// Invalidate DB rules cache (call after admin updates pricing rules)
function invalidatePricingCache() {
  _dbRulesCache = null;
  _dbRulesCacheTime = 0;
}

module.exports = { calculateFinalPrice, parsePrice, getPricingRule, invalidatePricingCache };
