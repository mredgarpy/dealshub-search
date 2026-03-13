// sephora-macys.js — Sephora & Macy's via real-time-product-search (Google Shopping)
// Same RapidAPI provider (letscrape) as Amazon adapter — no extra subscription needed
const axios = require('axios');
const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY;
const SHOPPING_HOST = 'real-time-product-search.p.rapidapi.com';

async function searchStore(query, storeKeyword, storeName, limit) {
  if (!RAPIDAPI_KEY) return [];
  try {
    const response = await axios.get('https://' + SHOPPING_HOST + '/search', {
      params: {
        q: query + ' ' + storeKeyword,
        country: 'us',
        language: 'en',
        sort_by: 'BEST_MATCH',
        product_condition: 'ANY',
        limit: String(limit * 2),
      },
      headers: {
        'X-RapidAPI-Key': RAPIDAPI_KEY,
        'X-RapidAPI-Host': SHOPPING_HOST,
      },
      timeout: 8000,
    });

    const products = response.data?.data?.products
      || response.data?.products
      || [];

    // Prefer results from the target store
    const storeItems = products.filter(p =>
      (p.offer?.store_name || '').toLowerCase().includes(storeKeyword.toLowerCase())
    );
    const items = storeItems.length > 0 ? storeItems : products;
    return normalizeResults(items.slice(0, limit), storeName);
  } catch (err) {
    if (err.response?.status === 403 || err.response?.status === 401) {
      console.warn(storeName + ' search: RapidAPI subscription required');
    } else {
      console.error(storeName + ' search error:', err.response?.status, err.message);
    }
    return [];
  }
}

function normalizeResults(items, storeName) {
  return items.map(item => {
    const offer = item.offer || {};
    const rawPrice = offer.price
      || (item.product_price || '').replace(/[^0-9.]/g, '')
      || '0';
    const price = parseFloat(rawPrice) || 0;
    return {
      id: item.product_id || String(Math.random()),
      title: item.product_title || 'Product',
      price,
      currency: offer.currency || 'USD',
      image: (item.product_photos && item.product_photos[0])
        || item.product_photo || '',
      url: offer.offer_page_url || item.product_page_url || '',
      store: storeName,
      rating: parseFloat(item.product_rating || 0),
      review_count: parseInt(String(item.product_num_reviews || '0').replace(/,/g, ''), 10),
      description: item.product_description || '',
    };
  }).filter(p => p.price > 0);
}

async function searchSephora(query, limit = 8) {
  return searchStore(query, 'sephora', 'Sephora', limit);
}

async function searchMacys(query, limit = 8) {
  return searchStore(query, 'macys', "Macy's", limit);
}

module.exports = { searchSephora, searchMacys };
