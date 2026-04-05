// ============================================================
// DealsHub - Pricing Engine v4.0 (Tiered Multiplier)
// ============================================================
// Priority chain:
//   1. settings.json markup_tiers (tiered multiplier by price band + source)
//   2. Legacy flat markup from settings.json (markup_amazon, etc.)
//   3. DB pricing_rules
//   4. DEFAULT_RULES hardcoded fallback
//
// Tiered system: cost x multiplier = final_price (rounded to .99)
// 8 price tiers x 6 sources (amazon, aliexpress, sephora, macys, shein, default)

const logger = require('./logger');
const path = require('path');
const fs = require('fs');

// -- Settings loader (cached, refreshes every 60s) -------------
let _settingsCache = null;
let _settingsCacheTime = 0;
const SETTINGS_TTL = 60000; // 1 min

function loadSettings() {
    if (_settingsCache && Date.now() - _settingsCacheTime < SETTINGS_TTL) {
          return _settingsCache;
    }
    try {
          const settingsPath = path.join(__dirname, '../../data/settings.json');
          if (fs.existsSync(settingsPath)) {
                  const raw = fs.readFileSync(settingsPath, 'utf8');
                  _settingsCache = JSON.parse(raw);
                  _settingsCacheTime = Date.now();
                  return _settingsCache;
          }
    } catch (e) {
          logger.warn('pricing: failed to load settings.json:', e.message);
    }
    return null;
}

// -- Tier definitions ------------------------------------------
const TIER_MAXES = [3, 10, 25, 50, 100, 200, 500, 999999];
const TIER_LABELS = ['$0-$3', '$3-$10', '$10-$25', '$25-$50', '$50-$100', '$100-$200', '$200-$500', '$500+'];
const TIER_SOURCES = ['amazon', 'aliexpress', 'sephora', 'macys', 'shein', 'default'];

// Default tier multipliers (cost x multiplier = final price)
const DEFAULT_TIERS = [
  { max: 3,      amazon: 3.00, aliexpress: 3.50, sephora: 2.80, macys: 2.80, shein: 3.50, default: 3.00 },
  { max: 10,     amazon: 2.20, aliexpress: 2.50, sephora: 2.00, macys: 2.00, shein: 2.50, default: 2.20 },
  { max: 25,     amazon: 1.80, aliexpress: 2.00, sephora: 1.70, macys: 1.70, shein: 2.00, default: 1.80 },
  { max: 50,     amazon: 1.55, aliexpress: 1.70, sephora: 1.50, macys: 1.50, shein: 1.70, default: 1.55 },
  { max: 100,    amazon: 1.40, aliexpress: 1.50, sephora: 1.35, macys: 1.35, shein: 1.50, default: 1.40 },
  { max: 200,    amazon: 1.30, aliexpress: 1.40, sephora: 1.28, macys: 1.28, shein: 1.40, default: 1.30 },
  { max: 500,    amazon: 1.22, aliexpress: 1.30, sephora: 1.20, macys: 1.20, shein: 1.30, default: 1.22 },
  { max: 999999, amazon: 1.15, aliexpress: 1.20, sephora: 1.15, macys: 1.15, shein: 1.20, default: 1.15 }
  ];

// -- Flat markup fallback defaults -----------------------------
const DEFAULT_RULES = {
    amazon:     { markupPct: 40, minMarginPct: 25, roundTo: 0.99, priceFloor: null },
    aliexpress: { markupPct: 50, minMarginPct: 30, roundTo: 0.99, priceFloor: null },
    sephora:    { markupPct: 35, minMarginPct: 20, roundTo: 0.99, priceFloor: null },
    macys:      { markupPct: 35, minMarginPct: 20, roundTo: 0.99, priceFloor: null },
    shein:      { markupPct: 50, minMarginPct: 30, roundTo: 0.99, priceFloor: null }
};

// -- DB rules cache --------------------------------------------
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
          // DB not available - use defaults
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

// -- Tier multiplier lookup ------------------------------------
/**
 * Get the tiered multiplier for a given source price and source.
 * Reads from settings.json markup_tiers first, falls back to DEFAULT_TIERS.
 * @param {number} sourcePrice - The cost/source price
 * @param {string} source - Source store key (amazon, aliexpress, etc.)
 * @returns {number} multiplier (e.g. 1.40 means cost x 1.40)
 */
function getTierMultiplier(sourcePrice, source) {
    const settings = loadSettings();
    const tiers = (settings && Array.isArray(settings.markup_tiers))
      ? settings.markup_tiers
          : DEFAULT_TIERS;

  const src = (source || 'default').toLowerCase();

  for (const tier of tiers) {
        if (sourcePrice <= tier.max) {
                return tier[src] || tier['default'] || 1.40;
        }
  }
    // If price exceeds all tiers, use the last tier
  const lastTier = tiers[tiers.length - 1];
    return lastTier[src] || lastTier['default'] || 1.15;
}

// -- Legacy flat pricing rule lookup ---------------------------
/**
 * Get flat pricing rule. Checks DB rules then hardcoded defaults.
 * Used as fallback when tiered system is disabled or unavailable.
 */
function getPricingRule(source, opts = {}) {
    // Check settings.json for flat markup overrides
  const settings = loadSettings();
    if (settings) {
          const key = 'markup_' + source;
          if (settings[key] !== undefined) {
                  const pct = parseFloat(settings[key]);
                  if (!isNaN(pct) && pct > 0) {
                            return {
                                        markupPct: pct,
                                        minMarginPct: Math.max(pct * 0.6, 10),
                                        roundTo: 0.99,
                                        priceFloor: null,
                                        ruleType: 'settings'
                            };
                  }
          }
    }

  // Check DB rules
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

  return DEFAULT_RULES[source] || { markupPct: 15, minMarginPct: 10, roundTo: 0.99, priceFloor: null };
}

// -- Main pricing function -------------------------------------
/**
 * Calculate the final price for a product.
 * Uses tiered multiplier system as primary, flat markup as fallback.
 */
function calculateFinalPrice(sourcePrice, source, opts = {}) {
    if (!sourcePrice || sourcePrice <= 0) return { price: null, compareAt: null };

  const shippingCost = opts.shippingCost || 0;
    const fees = opts.fees || 0;
    const landedCost = sourcePrice + shippingCost + fees;

  // -- Try tiered multiplier first --
  const settings = loadSettings();
    const useTiers = settings && Array.isArray(settings.markup_tiers) && settings.markup_tiers.length > 0;

  let finalPrice;
    let pricingMethod;

  if (useTiers) {
        const multiplier = getTierMultiplier(sourcePrice, source);
        finalPrice = landedCost * multiplier;
        pricingMethod = 'tiered';
  } else {
        // Fallback to flat markup
      const rule = getPricingRule(source, { category: opts.category, brand: opts.brand });
        const effectiveMarkupPct = (sourcePrice < 5) ? Math.max(rule.markupPct, 60) : rule.markupPct;
        const markupMultiplier = 1 + (effectiveMarkupPct / 100);
        finalPrice = landedCost * markupMultiplier;

      // Ensure minimum margin
      const minMargin = landedCost * (rule.minMarginPct / 100);
        if (finalPrice - landedCost < minMargin) {
                finalPrice = landedCost + minMargin;
        }

      // Apply price floor
      if (rule.priceFloor && finalPrice < rule.priceFloor) {
              finalPrice = rule.priceFloor;
      }
        pricingMethod = 'flat';
  }

  // Round to .99
  finalPrice = Math.floor(finalPrice) + 0.99;

  // Compare-at price: original retail with higher multiplier for perceived discount
  let compareAt = null;
    if (opts.originalPrice && opts.originalPrice > sourcePrice) {
          if (useTiers) {
                  const compMultiplier = getTierMultiplier(sourcePrice, source) * 1.10;
                  compareAt = opts.originalPrice * compMultiplier;
          } else {
                  const rule = getPricingRule(source, { category: opts.category, brand: opts.brand });
                  const markupMultiplier = 1 + (rule.markupPct / 100);
                  compareAt = opts.originalPrice * markupMultiplier * 1.05;
          }
          compareAt = Math.floor(compareAt) + 0.99;
          // Ensure compareAt > finalPrice
      if (compareAt <= finalPrice) {
              compareAt = finalPrice + Math.max(Math.floor(finalPrice * 0.15), 2) + 0.99;
      }
    }

  return {
        price: parseFloat(finalPrice.toFixed(2)),
        compareAt: compareAt ? parseFloat(compareAt.toFixed(2)) : null,
        landedCost: parseFloat(landedCost.toFixed(2)),
        margin: parseFloat((finalPrice - landedCost).toFixed(2)),
        marginPct: parseFloat(((1 - landedCost / finalPrice) * 100).toFixed(1)),
        rule: source,
        ruleId: null,
        ruleType: pricingMethod,
        multiplier: useTiers ? getTierMultiplier(sourcePrice, source) : null
  };
}

// -- Utilities -------------------------------------------------
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
    _settingsCache = null;
    _settingsCacheTime = 0;
}

function invalidateSettingsCache() {
    _settingsCache = null;
    _settingsCacheTime = 0;
}

module.exports = {
    calculateFinalPrice,
    parsePrice,
    getPricingRule,
    getTierMultiplier,
    invalidatePricingCache,
    invalidateSettingsCache,
    loadSettings,
    DEFAULT_TIERS,
    TIER_MAXES,
    TIER_LABELS,
    TIER_SOURCES
};
