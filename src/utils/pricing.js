// ============================================================
// DealsHub — Pricing Engine v3.0
// ============================================================
// Controls markup, margins, rounding, compare-at logic
// Reads from settings.json first, then DB rules, then defaults
// Supports: source rules, category rules, brand rules, price floors
// v3.0: Fixed markup values for Meta Ads profitability
//        Added tiered markup for low-cost products
//        Added settings.json integration for admin control
// ============================================================

const logger = require('./logger');
const path = require('path');
const fs = require('fs');

// ---- SETTINGS FILE (editable from admin) ----
const SETTINGS_FILE = path.join(__dirname, '..', '..', 'data', 'settings.json');

function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    }
  } catch (e) {
    logger.debug('pricing', `Settings load failed: ${e.message}`);
  }
  return null;
}

// ---- DEFAULT MARKUP RULES (Meta Ads profitable) ----
const DEFAULT_RULES = {
  amazon:     { markupPct: 40, minMarginPct: 25, roundTo: 0.99, priceFloor: 2.99 },
  aliexpress: { markupPct: 50, minMarginPct: 30, roundTo: 0.99, priceFloor: 2.99 },
  sephora:    { markupPct: 35, minMarginPct: 22, roundTo: 0.99, priceFloor: 4.99 },
  macys:      { markupPct: 35, minMarginPct: 22, roundTo: 0.99, priceFloor: 4.99 },
  shein:      { markupPct: 50, minMarginPct: 30, roundTo: 0.99, priceFloor: 1.99 }
};

// Tiered rules for low-cost products (absolute margin too small otherwise)
const TIERED_RULES = {
  under_3: { markupPct: 100, minMarginPct: 40 },  // $2 cost -> $3.99 sale
  under_5: { markupPct: 60,  minMarginPct: 30 }   // $4 cost -> $6.39 -> $6.99
};

let _dbRulesCache = null;
let _dbRulesCacheTime = 0;
const DB_RULES_TTL = 300000; // 5 min cache

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
    // DB not available, use defaults
  }
  return null;
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

// ---- GET PRICING RULE (settings.json > DB > defaults) ----
function getPricingRule(source, opts = {}) {
  const sourcePrice = opts.sourcePrice || 0;

  // 1. Try settings.json first (admin-editable)
  const settings = loadSettings();
  if (settings && settings.markup && settings.markup[source] !== undefined) {
    let markupPct = parseFloat(settings.markup[source]);

    // Apply tiered rules for cheap products
    const tiered = settings.markup_rules || TIERED_RULES;
    if (sourcePrice > 0 && sourcePrice < 3 && tiered.under_3) {
      markupPct = parseFloat(tiered.under_3);
    } else if (sourcePrice > 0 && sourcePrice < 5 && tiered.under_5) {
      markupPct = parseFloat(tiered.under_5);
    }

    return {
      markupPct,
      minMarginPct: markupPct * 0.6,  // ~60% of markup as min margin
      roundTo: settings.pricing?.round_to_99 !== false ? 0.99 : 0,
      priceFloor: null,
      ruleType: 'settings'
    };
  }

  // 2. Try DB rules (brand > category > source)
  const dbRules = _loadDbRules();
  if (dbRules && dbRules.length > 0) {
    const { category, brand } = opts;
    if (brand) {
      const brandRule = dbRules.find(r =>
        r.source_store === source && r.brand && r.brand.toLowerCase() === brand.toLowerCase()
      );
      if (brandRule) return _dbToRule(brandRule);
    }
    if (category) {
      const catRule = dbRules.find(r =>
        r.source_store === source && r.category && r.category.toLowerCase() === category.toLowerCase() && !r.brand
      );
      if (catRule) return _dbToRule(catRule);
    }
    const sourceRule = dbRules.find(r =>
      r.source_store === source && !r.category && !r.brand
    );
    if (sourceRule) return _dbToRule(sourceRule);
  }

  // 3. Apply tiered rules for cheap products on defaults
  let defaultRule = DEFAULT_RULES[source] || { markupPct: 40, minMarginPct: 25, roundTo: 0.99, priceFloor: 2.99 };
  if (sourcePrice > 0 && sourcePrice < 3) {
    defaultRule = { ...defaultRule, markupPct: TIERED_RULES.under_3.markupPct, minMarginPct: TIERED_RULES.under_3.minMarginPct };
  } else if (sourcePrice > 0 && sourcePrice < 5) {
    defaultRule = { ...defaultRule, markupPct: TIERED_RULES.under_5.markupPct, minMarginPct: TIERED_RULES.under_5.minMarginPct };
  }

  return defaultRule;
}

// ---- MAIN PRICING FUNCTION ----
function calculateFinalPrice(sourcePrice, source, opts = {}) {
  if (!sourcePrice || sourcePrice <= 0) return { price: null, compareAt: null };

  const rule = getPricingRule(source, {
    category: opts.category,
    brand: opts.brand,
    sourcePrice: sourcePrice
  });

  const shippingCost = opts.shippingCost || 0;
  const fees = opts.fees || 0;
  const landedCost = sourcePrice + shippingCost + fees;

  const markupMultiplier = 1 + (rule.markupPct / 100);
  let finalPrice = landedCost * markupMultiplier;

  // Enforce minimum margin
  const minMargin = landedCost * (rule.minMarginPct / 100);
  if (finalPrice - landedCost < minMargin) {
    finalPrice = landedCost + minMargin;
  }

  // Enforce price floor
  if (rule.priceFloor && finalPrice < rule.priceFloor) {
    finalPrice = rule.priceFloor;
  }

  // Round to .99
  if (rule.roundTo) {
    finalPrice = Math.floor(finalPrice) + rule.roundTo;
    // Ensure rounding didn't drop below landed cost + min margin
    if (finalPrice <= landedCost) {
      finalPrice = Math.floor(landedCost) + 1 + rule.roundTo;
    }
  }

  // Compare-at price (for showing "was $X" strikethrough)
  let compareAt = null;
  if (opts.originalPrice && opts.originalPrice > sourcePrice) {
    compareAt = (opts.originalPrice * markupMultiplier * 1.05).toFixed(2);
    compareAt = Math.floor(parseFloat(compareAt)) + (rule.roundTo || 0.99);
    // compareAt must be higher than finalPrice
    if (compareAt <= finalPrice) {
      compareAt = finalPrice + 1 + (rule.roundTo || 0);
    }
  }

  return {
    price: parseFloat(finalPrice.toFixed(2)),
    compareAt: compareAt ? parseFloat(compareAt.toFixed(2)) : null,
    landedCost: parseFloat(landedCost.toFixed(2)),
    margin: parseFloat((finalPrice - landedCost).toFixed(2)),
    marginPct: parseFloat(((1 - landedCost / finalPrice) * 100).toFixed(1)),
    rule: source,
    ruleId: rule.ruleId || null,
    ruleType: rule.ruleType || 'default',
    markupPctApplied: rule.markupPct
  };
}

function parsePrice(priceStr) {
  if (!priceStr) return null;
  if (typeof priceStr === 'number') return priceStr;
  const cleaned = String(priceStr).replace(/[^0-9.]/g, '');
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}

function invalidatePricingCache() {
  _dbRulesCache = null;
  _dbRulesCacheTime = 0;
}

// ---- PREVIEW FUNCTION (for admin) ----
function previewPricing(sourcePrice, source) {
  const result = calculateFinalPrice(sourcePrice, source, {});
  return {
    sourcePrice,
    source,
    finalPrice: result.price,
    margin: result.margin,
    marginPct: result.marginPct,
    markupPctApplied: result.markupPctApplied,
    ruleType: result.ruleType
  };
}

module.exports = {
  calculateFinalPrice,
  parsePrice,
  getPricingRule,
  invalidatePricingCache,
  previewPricing,
  loadSettings,
  DEFAULT_RULES,
  TIERED_RULES
};
