// shein.js — SHEIN adapter via RapidAPI
// RapidAPI product to subscribe: "SHEIN Product Search" or "Shein Scraper"
// Dashboard: https://rapidapi.com/search/shein
const axios = require('axios');

const RAPIDAPI_KEY  = process.env.RAPIDAPI_KEY;
const RAPIDAPI_HOST = process.env.SHEIN_API_HOST || 'shein-scraper-api.p.rapidapi.com';

/**
 * Search SHEIN for products
 * @param {string} query
 * @param {number} limit
 * @returns {Array} normalized product objects
 */
async function searchShein(query, limit = 10) {
  if (!RAPIDAPI_KEY) {
    console.warn('⚠️  RAPIDAPI_KEY not set — SHEIN search skipped');
    return [];
  }

  try {
    const response = await axios.get(
      `https://${RAPIDAPI_HOST}/products/search`,
      {
        params: {
          q:      query,
          limit:  limit,
          page:   1,
          currency: 'USD',
          language: 'en',
          country: 'US',
        },
        headers: {
          'X-RapidAPI-Key':  RAPIDAPI_KEY,
          'X-RapidAPI-Host': RAPIDAPI_HOST,
        },
        timeout: 8000,
      }
    );

    const items = response.data?.products || response.data?.result || response.data || [];

    return normalizeResults(Array.isArray(items) ? items : []);

  } catch (err) {
    if (err.response?.status === 429) {
      console.warn('⚠️  SHEIN rate limit hit');
    } else {
      console.error('SHEIN search error:', err.message);
    }
    return [];
  }
}

function normalizeResults(items) {
  return items.map(item => ({
    id:          item.goods_id || item.id || item.productId || String(Math.random()),
    title:       item.goods_name || item.name || item.title || 'Product',
    price:       parseFloat(item.salePrice?.amount || item.price || item.retailPrice || 0),
    currency:    'USD',
    image:       item.goods_img || item.imgUrl || item.mainImage || '',
    url:         buildSheinUrl(item),
    store:       'SHEIN',
    rating:      parseFloat(item.commentInfo?.commentRankAverage || item.rating || 0),
    review_count: parseInt(item.commentInfo?.commentNum || item.reviewCount || 0),
  })).filter(p => p.price > 0);
}

function buildSheinUrl(item) {
  const goodsId = item.goods_id || item.id;
  if (!goodsId) return 'https://www.shein.com';
  // Standard SHEIN product URL format
  const slug = (item.goods_name || item.name || 'product')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 60);
  return `https://www.shein.com/p/${slug}-p-${goodsId}.html`;
}

module.exports = { searchShein };
