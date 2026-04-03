// pricing.js — Apply markup and format prices for Shopify display
// Updated 2026-04-02: Raised markups to support Meta Ads profitability
// Source-specific markups: Amazon 40%, AliExpress 50%, Sephora 35%, Macys 35%, Shein 50%
// Impulse buys under $5 get 60% markup

const DEFAULT_MARKUP = parseFloat(process.env.MARKUP_PERCENT || '40');

// Source-specific markup overrides
const SOURCE_MARKUPS = {
  amazon:     parseFloat(process.env.MARKUP_AMAZON || '40'),
  aliexpress: parseFloat(process.env.MARKUP_ALIEXPRESS || '50'),
  sephora:    parseFloat(process.env.MARKUP_SEPHORA || '35'),
  macys:      parseFloat(process.env.MARKUP_MACYS || '35'),
  shein:      parseFloat(process.env.MARKUP_SHEIN || '50')
};

/**
 * Get markup percentage for a given source and price
 */
function getMarkupPct(source, price) {
  let pct = SOURCE_MARKUPS[source] || DEFAULT_MARKUP;
  // Impulse buys under $5 get higher markup
  if (price > 0 && price < 5) pct = Math.max(pct, 60);
  return pct;
}

/**
 * Apply markup to a source price
 * @param {number|string} sourcePrice — original price from source
 * @param {string} [source] — source store name
 * @returns {number} — price with markup, rounded to .99
 */
function applyMarkup(sourcePrice, source) {
  const price = parseFloat(sourcePrice);
  if (isNaN(price) || price <= 0) return 0;
  const pct = getMarkupPct(source, price);
  const marked = price * (1 + pct / 100);
  // Round to .99
  return parseFloat((Math.floor(marked) + 0.99).toFixed(2));
}

/**
 * Format a price as USD string
 */
function formatPrice(price) {
  return parseFloat(price).toFixed(2);
}

/**
 * Apply markup to a full product object
 * Expects product to have a `price` field and optionally `source` field
 */
function markupProduct(product) {
  const source = (product.source || product.sourceName || '').toLowerCase();
  const pct = getMarkupPct(source, parseFloat(product.price || 0));
  return {
    ...product,
    original_price: formatPrice(product.price || 0),
    price:          formatPrice(applyMarkup(product.price || 0, source)),
    markup_percent: pct,
  };
}

module.exports = { applyMarkup, formatPrice, markupProduct, getMarkupPct };
