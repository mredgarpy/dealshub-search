// ============================================================
// DealsHub — Pricing Engine v3.0 (Tiered Multiplier System)
// ============================================================
// Controls markup via multiplier tiers per source & price range.
// Admin panel controls multipliers in real-time.
// Fallback chain: DB tiers → hardcoded default tiers.
//
// HOW IT WORKS:
// - Each source (amazon, aliexpress, sephora, macys, shein) has
//   multiplier tiers by price range (e.g., $0-$3 = 2.50x, $3-$10 = 1.70x).
// - For most sources: finalPrice = cost × multiplier (rounded to .99)
// - For AliExpress: the API returns MSRP as "price" and wholesale as "sourceCost".
//   The multiplier applies to sourceCost (wholesale), and MSRP becomes compare-at.
// - Price floor of $2.99 for AliExpress prevents selling below shipping cost.

const logger = require('./logger');

// Hardcoded default tiers (used when DB is empty or unavailable)
const DEFAULT_TIERS = {
  amazon:     [1.70, 1.35, 1.25, 1.20, 1.15, 1.10, 1.07, 1.05],
  aliexpress: [2.50, 1.70, 1.50, 1.40, 1.30, 1.22, 1.15, 1.10],
  sephora:    [1.50, 1.30, 1.22, 1.18, 1.12, 1.08, 1.06, 1.05],
  macys:      [1.50, 1.30, 1.22, 1.18, 1.12, 1.08, 1.06, 1.05],
  shein:      [2.50, 1.70, 1.50, 1.40, 1.30, 1.22, 1.15, 1.10],
  default:    [1.70, 1.35, 1.25, 1.20, 1.15, 1.10, 1.07, 1.05]
};
const TIER_RANGES = [
  { min: 0, max: 3 },
  { min: 3, max: 10 },
  { min: 10, max: 25 },
  { min: 25, max: 50 },
  { min: 50, max: 100 },
  { min: 100, max: 200 },
  { min: 200, max: 500 },
  { min: 500, max: 999999 }
];

// Sources that use MSRP-based pricing: API returns MSRP as "price".
// For these sources, the cost base is estimated as MSRP × RETAIL_FACTOR.
// AliExpress API's "promotionPrice" is a wholesale/dropship rate ($2-$5),
// NOT the actual AliExpress retail price ($11-$15). The real AliExpress
// customer price is approximately MSRP × 0.42.
// We use this estimated retail as cost base, then apply tier multiplier.
const MSRP_SOURCES = new Set(['aliexpress']);

// Factor to estimate the real AliExpress retail price from MSRP.
// Based on observed data: AliExpress retail ≈ MSRP × 0.40-0.45
// Using 0.42 as conservative estimate to stay above AliExpress prices.
const MSRP_RETAIL_FACTOR = 0.42;

// Price floors per source (minimum selling price)
const PRICE_FLOORS = { aliexpress: 4.99 };

// Cache DB tiers in memory (refreshed every 5 min)
let _tiersCache = null;
let _tiersCacheTime = 0;
const TIERS_TTL = 300000;

function _loadTiers() {
  if (_tiersCache && Date.now() - _tiersCacheTime < TIERS_TTL) {
    return _tiersCache;
  }
  try {
    const { getTierMultiplier } = require('./db');
    // Test if DB is working by fetching one tier
    const test = getTierMultiplier('default', 10);
    if (test !== null) {
      _tiersCache = 'db'; // marker that DB is available
      _tiersCacheTime = Date.now();
      return 'db';
    }
  } catch (e) {
    // DB not available
  }
  return null;
}

/**
 * Get the multiplier for a source at a given cost.
 * Tries DB first, then falls back to hardcoded defaults.
 */
function getMultiplier(source, cost) {
  const tiersAvailable = _loadTiers();

  if (tiersAvailable === 'db') {
    try {
      const { getTierMultiplier } = require('./db');
      const mult = getTierMultiplier(source, cost);
      if (mult !== null) return mult;
    } catch (e) {
      // Fall through to defaults
    }
  }

  // Fallback to hardcoded defaults
  const sourceTiers = DEFAULT_TIERS[source] || DEFAULT_TIERS['default'];
  for (let i = 0; i < TIER_RANGES.length; i++) {
    if (cost >= TIER_RANGES[i].min && cost < TIER_RANGES[i].max) {
      return sourceTiers[i];
    }
  }
  return sourceTiers[sourceTiers.length - 1];
}

/**
 * Calculate final price using the tiered multiplier system.
 *
 * @param {number} sourcePrice - The price from source API.
 *   For most sources: this is the selling price (= cost).
 *   For AliExpress: this is the MSRP (retail price).
 * @param {string} source - Source store name.
 * @param {object} opts - Options:
 *   - sourceCost: wholesale/actual cost (for AliExpress). If not provided, uses sourcePrice.
 *   - originalPrice: original/list price for compare-at (for non-MSRP sources).
 *   - shippingCost: supplier shipping cost.
 *   - fees: additional fees.
 *   - category: product category (for future use).
 *   - brand: product brand (for future use).
 */
function calculateFinalPrice(sourcePrice, source, opts = {}) {
  if (!sourcePrice || sourcePrice <= 0) return { price: null, compareAt: null };

  const isMSRP = MSRP_SOURCES.has(source);
  const shippingCost = opts.shippingCost || 0;
  const fees = opts.fees || 0;

  // Determine the actual cost to apply the multiplier to.
  // For AliExpress: sourcePrice is MSRP (~$28). The API returns two other prices:
  //   - promotionPrice: sometimes wholesale ($2), sometimes near retail ($11)
  //   - estimated retail: MSRP × 0.42 ≈ real AliExpress price
  // We use max(promotionPrice, MSRP × 0.42) to always pick the most accurate/safest value.
  // When promotionPrice IS the real retail → we use it (more precise).
  // When promotionPrice is wholesale → MSRP × 0.42 protects us from selling too low.
  let cost;
  if (isMSRP) {
    const msrpEstimate = sourcePrice * MSRP_RETAIL_FACTOR; // ~$11.76 for $28 MSRP
    const promoPrice = opts.sourceCost || 0;
    cost = Math.max(promoPrice, msrpEstimate) + shippingCost + fees;
  } else {
    // Amazon, Sephora, Macys, SHEIN: sourcePrice IS the cost
    cost = sourcePrice + shippingCost + fees;
  }

  // Look up tier multiplier
  const multiplier = getMultiplier(source, cost);

  // Calculate raw price
  let finalPrice = cost * multiplier;

  // Apply price floor
  const floor = PRICE_FLOORS[source] || null;
  if (floor && finalPrice < floor) {
    finalPrice = floor;
  }

  // Apply .99 rounding
  finalPrice = Math.floor(finalPrice) + 0.99;

  // Safety: never sell below cost
  if (finalPrice <= cost) {
    finalPrice = Math.floor(cost) + 1.99;
  }

  // Compare-at price (crossed-out price)
  let compareAt = null;
  if (isMSRP) {
    // MSRP model: sourcePrice is MSRP → show it as compare-at
    compareAt = Math.floor(sourcePrice) + 0.99;
    if (compareAt <= finalPrice) compareAt = null;
  } else if (opts.originalPrice && opts.originalPrice > sourcePrice) {
    // Other sources: if there's an original/list price higher than selling price
    compareAt = Math.floor(opts.originalPrice * multiplier * 1.05) + 0.99;
    if (compareAt <= finalPrice) compareAt = null;
  }

  const landedCost = parseFloat(cost.toFixed(2));

  return {
    price: parseFloat(finalPrice.toFixed(2)),
    compareAt: compareAt ? parseFloat(compareAt.toFixed(2)) : null,
    landedCost,
    margin: parseFloat((finalPrice - landedCost).toFixed(2)),
    marginPct: parseFloat(((1 - landedCost / finalPrice) * 100).toFixed(1)),
    multiplier: parseFloat(multiplier.toFixed(2)),
    rule: source,
    ruleType: 'tier'
  };
}

function parsePrice(priceStr) {
  if (!priceStr) return null;
  if (typeof priceStr === 'number') return priceStr;
  const cleaned = String(priceStr).replace(/[^0-9.]/g, '');
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}

// Invalidate cache (call after admin updates markup tiers)
function invalidatePricingCache() {
  _tiersCache = null;
  _tiersCacheTime = 0;
}

module.exports = { calculateFinalPrice, parsePrice, getMultiplier, invalidatePricingCache };
