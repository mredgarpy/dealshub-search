// shopify.js — Shopify helpers for search backend
// Used to check existing products and optionally sync results
require('dotenv').config();

const STORE   = process.env.SHOPIFY_STORE;
const TOKEN   = process.env.SHOPIFY_ACCESS_TOKEN;
const API_VER = '2024-01';

async function shopifyRequest(method, endpoint, body = null) {
  const url = `https://${STORE}/admin/api/${API_VER}${endpoint}`;
  const opts = {
    method,
    headers: {
      'X-Shopify-Access-Token': TOKEN,
      'Content-Type': 'application/json',
    },
  };
  if (body) opts.body = JSON.stringify(body);

  const res  = await fetch(url, opts);
  const text = await res.text();
  try { return JSON.parse(text); }
  catch { return { raw: text }; }
}

/**
 * Search Shopify products (for deduplication)
 */
async function searchProducts(query) {
  const data = await shopifyRequest('GET', `/products.json?title=${encodeURIComponent(query)}&limit=5`);
  return data.products || [];
}

module.exports = { searchProducts };
