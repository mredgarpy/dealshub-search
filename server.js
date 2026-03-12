const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json());

const RAPIDAPI_KEY          = process.env.RAPIDAPI_KEY;
const MARKUP_PERCENT        = parseFloat(process.env.MARKUP_PERCENT || '12');
const SHOPIFY_STORE_DOMAIN  = process.env.SHOPIFY_STORE_DOMAIN;
const SHOPIFY_ADMIN_TOKEN   = process.env.SHOPIFY_ADMIN_TOKEN;

// OAuth credentials (for token capture flow)
const SHOPIFY_CLIENT_ID     = '5bcd017d59287f7c9d7ab012b67d4e5b';
const SHOPIFY_CLIENT_SECRET = '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';

// ─── OAUTH CALLBACK (one-time token capture) ────────────────────────

app.get('/oauth/callback', async (req, res) => {
  const { code, shop } = req.query;
  if (!code || !shop) {
    return res.status(400).json({ error: 'Missing code or shop' });
  }
  try {
    const response = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id:     SHOPIFY_CLIENT_ID,
        client_secret: SHOPIFY_CLIENT_SECRET,
        code
      })
    });
    const data = await response.json();
    console.log('=== SHOPIFY ACCESS TOKEN ===');
    console.log(JSON.stringify(data));
    console.log('============================');
    // Display token in browser for easy copy
    res.send(`<html><body style="font-family:monospace;padding:20px">
      <h2>Access Token Captured!</h2>
      <p><strong>Shop:</strong> ${shop}</p>
      <p><strong>Token:</strong> <code style="background:#f0f0f0;padding:8px;display:block;margin:8px 0;word-break:break-all">${data.access_token}</code></p>
      <p><strong>Scopes:</strong> ${data.scope}</p>
      <p>Copy the token above and add it as SHOPIFY_ADMIN_TOKEN in Render env vars.</p>
    </body></html>`);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── SEARCH ───────────────────────────────────────────────

app.get('/search', async (req, res) => {
  const { q } = req.query;
  if (!q) return res.json([]);
  const markup = 1 + MARKUP_PERCENT / 100;
  try {
    const [amazonRes, sheinRes] = await Promise.allSettled([
      searchAmazon(q),
      searchShein(q)
    ]);
    const products = [
      ...(amazonRes.status === 'fulfilled' ? amazonRes.value : []),
      ...(sheinRes.status === 'fulfilled'  ? sheinRes.value  : [])
    ];
    const withMarkup = products.map(p => ({
      ...p,
      originalPrice: p.price,
      price: parseFloat((p.price * markup).toFixed(2))
    }));
    res.json(withMarkup.slice(0, 20));
  } catch (err) {
    console.error('Search error:', err);
    res.status(500).json({ error: 'Search failed' });
  }
});

// ─── CREATE PRODUCT ON-THE-FLY ──────────────────────────────────────────

app.post('/create-and-add', async (req, res) => {
  const { title, price, originalPrice, image, sourceUrl, sourcePlatform } = req.body;
  if (!SHOPIFY_ADMIN_TOKEN || !SHOPIFY_STORE_DOMAIN) {
    return res.status(500).json({ error: 'Shopify Admin API not configured' });
  }
  try {
    const payload = {
      product: {
        title,
        body_html: `<p>Imported via DealsHub from ${sourcePlatform || 'external'}</p>`,
        vendor: sourcePlatform || 'DealsHub',
        product_type: 'DealsHub Import',
        status: 'draft',
        published: false,
        variants: [{
          price: parseFloat(price).toFixed(2),
          requires_shipping: true,
          taxable: true,
          inventory_management: null,
          fulfillment_service: 'manual'
        }],
        images: image ? [{ src: image }] : [],
        metafields: [
          { namespace: 'dealshub', key: 'source_url',      value: sourceUrl || '',        type: 'single_line_text_field' },
          { namespace: 'dealshub', key: 'source_platform', value: sourcePlatform || '',   type: 'single_line_text_field' },
          { namespace: 'dealshub', key: 'original_price',  value: String(originalPrice || price), type: 'single_line_text_field' }
        ]
      }
    };
    const response = await fetch(
      `https://${SHOPIFY_STORE_DOMAIN}/admin/api/2024-01/products.json`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': SHOPIFY_ADMIN_TOKEN
        },
        body: JSON.stringify(payload)
      }
    );
    if (!response.ok) {
      const errText = await response.text();
      return res.status(500).json({ error: 'Shopify product creation failed', details: errText });
    }
    const data = await response.json();
    const variantId = data.product.variants[0].id;
    const productId = data.product.id;
    console.log(`Created product ${productId} (variant ${variantId}) from ${sourcePlatform}: ${title}`);
    res.json({ variantId, productId, success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── AMAZON ───────────────────────────────────────────────────────────────────

async function searchAmazon(query) {
  const url = `https://real-time-amazon-data.p.rapidapi.com/search?query=${encodeURIComponent(query)}&page=1&country=US&sort_by=RELEVANCE&product_condition=ALL&is_prime=false`;
  const response = await fetch(url, {
    headers: {
      'x-rapidapi-key':  RAPIDAPI_KEY,
      'x-rapidapi-host': 'real-time-amazon-data.p.rapidapi.com'
    }
  });
  const data = await response.json();
  if (!data.data?.products) return [];
  return data.data.products
    .filter(p => p.product_price && p.product_title)
    .slice(0, 10)
    .map(p => ({
      id:     p.asin,
      title:  p.product_title,
      price:  parseFloat(p.product_price.replace(/[^0-9.]/g, '')) || 0,
      image:  p.product_photo || '',
      url:    p.product_url || `https://www.amazon.com/dp/${p.asin}`,
      source: 'amazon',
      rating: p.product_star_rating || null
    }));
}

// ─── SHEIN ────────────────────────────────────────────────────────────────────

async function searchShein(query) {
  const url = `https://shein.p.rapidapi.com/search?q=${encodeURIComponent(query)}&page=1&limit=10&language=en&currency=USD&country=US`;
  const response = await fetch(url, {
    headers: {
      'x-rapidapi-key':  RAPIDAPI_KEY,
      'x-rapidapi-host': 'shein.p.rapidapi.com'
    }
  });
  const data = await response.json();
  const items = data.info?.products || data.goods_list || data.data?.goods || [];
  return items
    .filter(p => p.retailPrice || p.salePrice || p.price)
    .slice(0, 10)
    .map(p => ({
      id:     String(p.goods_id || p.id || Math.random()),
      title:  p.goods_name || p.name || 'SHEIN Product',
      price:  parseFloat(p.retailPrice?.amount || p.salePrice?.amount || p.price || 0),
      image:  p.goods_img || p.image || '',
      url:    `https://www.shein.com/${p.goods_url_name || 'item'}-p-${p.goods_id || p.id}.html`,
      source: 'shein',
      rating: null
    }));
}

// ─── HEALTH ────────────────────────────────────────────────────────────────────

app.get('/health', (req, res) => {
  res.json({ status: 'ok', rapidapi: !!RAPIDAPI_KEY, shopify: !!SHOPIFY_ADMIN_TOKEN });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`DealsHub backend on port ${PORT}`));
