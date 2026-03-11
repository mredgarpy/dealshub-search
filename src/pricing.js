// pricing.js — Apply markup and format prices for Shopify display

const MARKUP_PERCENT = parseFloat(process.env.MARKUP_PERCENT || '12');

/**
 * Apply markup to a source price
 * @param {number|string} sourcePrice — original price from SHEIN/Amazon/etc
 * @returns {number} — price with markup, rounded to 2 decimals
 */
function applyMarkup(sourcePrice) {
  const price = parseFloat(sourcePrice);
  if (isNaN(price) || price <= 0) return 0;
  return parseFloat((price * (1 + MARKUP_PERCENT / 100)).toFixed(2));
}

/**
 * Format a price as USD string
 */
function formatPrice(price) {
  return parseFloat(price).toFixed(2);
}

/**
 * Apply markup to a full product object
 * Expects product to have a `price` field (number or string)
 */
function markupProduct(product) {
  return {
    ...product,
    original_price: formatPrice(product.price || 0),
    price:          formatPrice(applyMarkup(product.price || 0)),
    markup_percent: MARKUP_PERCENT,
  };
}

module.exports = { applyMarkup, formatPrice, markupProduct };
