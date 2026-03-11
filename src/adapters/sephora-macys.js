// sephora-macys.js — Sephora & Macy's adapters via RapidAPI
// RapidAPI product to subscribe: "Sephora" and "Macy's" scrapers
// Dashboard: https://rapidapi.com/search/sephora
const axios = require('axios');

const RAPIDAPI_KEY     = process.env.RAPIDAPI_KEY;
const SEPHORA_HOST     = process.env.SEPHORA_API_HOST  || 'sephora12.p.rapidapi.com';
const MACYS_HOST       = process.env.MACYS_API_HOST    || 'macys-products.p.rapidapi.com';

// ─────────────────────────────────────────────
//  SEPHORA
// ─────────────────────────────────────────────
async function searchSephora(query, limit = 8) {
  if (!RAPIDAPI_KEY) {
    console.warn('⚠️  RAPIDAPI_KEY not set — Sephora search skipped');
    return [];
  }

  try {
    const response = await axios.get(
      `https://${SEPHORA_HOST}/products/search`,
      {
        params: { q: query, pageSize: limit, currentPage: 1 },
        headers: {
          'X-RapidAPI-Key':  RAPIDAPI_KEY,
          'X-RapidAPI-Host': SEPHORA_HOST,
        },
        timeout: 8000,
      }
    );

    const items = response.data?.products ||
                  response.data?.data?.products ||
                  response.data?.results || [];

    return normalizeSephora(Array.isArray(items) ? items.slice(0, limit) : []);

  } catch (err) {
    if (err.response?.status === 429) {
      console.warn('⚠️  Sephora rate limit hit');
    } else {
      console.error('Sephora search error:', err.message);
    }
    return [];
  }
}

function normalizeSephora(items) {
  return items.map(item => ({
    id:    item.productId || item.id || String(Math.random()),
    title: item.displayName || item.name || 'Product',
    brand: item.brandName || item.brand || '',
    price: parseFloat(item.currentSku?.listPrice || item.price || item.listPrice || 0),
    currency: 'USD',
    image: item.heroImage || item.image || item.imageUrl || '',
    url:   item.targetUrl
             ? `https://www.sephora.com${item.targetUrl}`
             : buildSephoraUrl(item),
    store: 'Sephora',
    rating:       parseFloat(item.rating || 0),
    review_count: parseInt(item.reviews || 0),
  })).filter(p => p.price > 0);
}

function buildSephoraUrl(item) {
  const id = item.productId || item.id;
  if (!id) return 'https://www.sephora.com';
  const slug = (item.displayName || item.name || 'product')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60);
  return `https://www.sephora.com/product/${slug}-P${id}`;
}

// ─────────────────────────────────────────────
//  MACY'S
// ─────────────────────────────────────────────
async function searchMacys(query, limit = 8) {
  if (!RAPIDAPI_KEY) {
    console.warn("⚠️  RAPIDAPI_KEY not set — Macy's search skipped");
    return [];
  }

  try {
    const response = await axios.get(
      `https://${MACYS_HOST}/products/search`,
      {
        params: { keyword: query, limit, page: 1 },
        headers: {
          'X-RapidAPI-Key':  RAPIDAPI_KEY,
          'X-RapidAPI-Host': MACYS_HOST,
        },
        timeout: 8000,
      }
    );

    const items = response.data?.products ||
                  response.data?.data?.products ||
                  response.data?.results || [];

    return normalizeMacys(Array.isArray(items) ? items.slice(0, limit) : []);

  } catch (err) {
    if (err.response?.status === 429) {
      console.warn("⚠️  Macy's rate limit hit");
    } else {
      console.error("Macy's search error:", err.message);
    }
    return [];
  }
}

function normalizeMacys(items) {
  return items.map(item => ({
    id:    item.id || item.productId || String(Math.random()),
    title: item.name || item.description || 'Product',
    brand: item.brand?.name || item.brandName || '',
    price: parseFloat(
             item.price?.lowest || item.price?.regular ||
             item.pricing?.price?.tieredPrice?.[0]?.values?.[0]?.value ||
             item.currentPrice || 0
           ),
    currency: 'USD',
    image: item.image?.filePath
             ? `https://slimages.macysassets.com/is/image/MCY/products/${item.image.filePath}`
             : (item.image || item.imageUrl || ''),
    url:   item.slug
             ? `https://www.macys.com/shop/product/${item.slug}/ID/${item.id}`
             : buildMacysUrl(item),
    store: "Macy's",
    rating:       parseFloat(item.rating || 0),
    review_count: parseInt(item.reviewCount || 0),
  })).filter(p => p.price > 0);
}

function buildMacysUrl(item) {
  const id = item.id || item.productId;
  if (!id) return 'https://www.macys.com';
  return `https://www.macys.com/shop/product/ID/${id}`;
}

module.exports = { searchSephora, searchMacys };
