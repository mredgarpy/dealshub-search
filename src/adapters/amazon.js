// amazon.js — Amazon adapter via RapidAPI
// RapidAPI product to subscribe: "Real-Time Amazon Data" or "Amazon Product Data"
// Dashboard: https://rapidapi.com/search/amazon+product
const axios = require('axios');

const RAPIDAPI_KEY  = process.env.RAPIDAPI_KEY;
const RAPIDAPI_HOST = process.env.AMAZON_API_HOST || 'real-time-amazon-data.p.rapidapi.com';

/**
 * Search Amazon for products
 * @param {string} query
 * @param {number} limit
 * @returns {Array} normalized product objects
 */
async function searchAmazon(query, limit = 10) {
  if (!RAPIDAPI_KEY) {
    console.warn('⚠️  RAPIDAPI_KEY not set — Amazon search skipped');
    return [];
  }

  try {
    const response = await axios.get(
      `https://${RAPIDAPI_HOST}/search`,
      {
        params: {
          query:       query,
          page:        '1',
          country:     'US',
          sort_by:     'RELEVANCE',
          product_condition: 'ALL',
        },
        headers: {
          'X-RapidAPI-Key':  RAPIDAPI_KEY,
          'X-RapidAPI-Host': RAPIDAPI_HOST,
        },
        timeout: 8000,
      }
    );

    const items = response.data?.data?.products ||
                  response.data?.products ||
                  response.data?.results || [];

    return normalizeResults(Array.isArray(items) ? items.slice(0, limit) : []);

  } catch (err) {
    if (err.response?.status === 429) {
      console.warn('⚠️  Amazon rate limit hit');
    } else {
      console.error('Amazon search error:', err.message);
    }
    return [];
  }
}

function normalizeResults(items) {
  return items.map(item => ({
    id:           item.asin || item.product_id || String(Math.random()),
    title:        item.product_title || item.title || 'Product',
    price:        parseFloat(
                    item.product_price?.replace(/[^0-9.]/g, '') ||
                    item.price?.replace(/[^0-9.]/g, '') ||
                    item.currentPrice || 0
                  ),
    currency:     'USD',
    image:        item.product_photo || item.thumbnail || item.image || '',
    url:          item.product_url || item.url || buildAmazonUrl(item.asin),
    store:        'Amazon',
    rating:       parseFloat(item.product_star_rating || item.rating || 0),
    review_count: parseInt(
                    String(item.product_num_ratings || item.reviewCount || '0').replace(/,/g, '')
                  ),
    prime:        item.is_prime || false,
  })).filter(p => p.price > 0);
}

function buildAmazonUrl(asin) {
  if (!asin) return 'https://www.amazon.com';
  return `https://www.amazon.com/dp/${asin}`;
}

module.exports = { searchAmazon };
