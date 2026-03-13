const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const axios = require('axios');
const app = express();
app.use(cors());
app.use(express.json());

const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY;
const MARKUP_PERCENT = parseFloat(process.env.MARKUP_PERCENT || '12');
const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const SHOPIFY_ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;

// OAuth credentials (for token capture flow)
const SHOPIFY_CLIENT_ID = '5bcd017d59287f7c9d7ab012b67d4e5b';
const SHOPIFY_CLIENT_SECRET = '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';

// ─── DEBUG ENDPOINT ──────────────────────────────────────────────────────────
app.get('/debug-creds', (req, res) => {
  res.json({
    client_id: SHOPIFY_CLIENT_ID,
    client_id_length: SHOPIFY_CLIENT_ID.length,
    client_secret_prefix: SHOPIFY_CLIENT_SECRET.slice(0, 10),
    client_secret_length: SHOPIFY_CLIENT_SECRET.length,
    body_preview: `client_id=${SHOPIFY_CLIENT_ID}&client_secret=${SHOPIFY_CLIENT_SECRET.slice(0,6)}...&code=SAMPLE`
  });
});

// ─── OAUTH CALLBACK (one-time token capture) ─────────────────────────────────
app.get('/oauth/callback', async (req, res) => {
  const { code, shop } = req.query;
  if (!code || !shop) return res.status(400).json({ error: 'Missing code or shop' });

  try {
    // Per Shopify docs: only client_id, client_secret, code — NO redirect_uri
    const tokenUrl = `https://${shop}/admin/oauth/access_token`;
    const tokenBody = `client_id=${SHOPIFY_CLIENT_ID}&client_secret=${SHOPIFY_CLIENT_SECRET}&code=${code}`;

    console.log('=== TOKEN EXCHANGE (v3 - no redirect_uri) ===');
    console.log('URL:', tokenUrl);
    console.log('Shop:', shop);
    console.log('Code:', code.slice(0, 8) + '...');
    console.log('Body (redacted):', tokenBody.replace(SHOPIFY_CLIENT_SECRET, '[SECRET]'));
    console.log('Client ID:', SHOPIFY_CLIENT_ID);
    console.log('Secret len:', SHOPIFY_CLIENT_SECRET.length);

    // Try with axios first
    let axiosResult = null;
    try {
      const axiosResp = await axios.post(tokenUrl, tokenBody, {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
      });
      axiosResult = { status: axiosResp.status, data: axiosResp.data };
      console.log('AXIOS SUCCESS:', JSON.stringify(axiosResult));
    } catch (axiosErr) {
      axiosResult = {
        error: axiosErr.message,
        status: axiosErr.response?.status,
        data: axiosErr.response?.data
      };
      console.log('AXIOS ERROR:', JSON.stringify(axiosResult));
    }

    // Also try with node-fetch
    const fetchResp = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: tokenBody
    });
    const rawText = await fetchResp.text();
    console.log('FETCH STATUS:', fetchResp.status);
    console.log('FETCH BODY:', rawText.slice(0, 2000));

    let fetchData;
    try { fetchData = JSON.parse(rawText); } catch (e) { fetchData = { raw: rawText }; }

    const token = axiosResult?.data?.access_token || fetchData?.access_token;

    res.send(`<html><body style="font-family:monospace;padding:20px">
      <h2>${token ? '&#x2705; Token Captured!' : '&#x274C; No Token'}</h2>
      <p><strong>Shop:</strong> ${shop}</p>
      <p><strong>Token:</strong> <code style="background:#e8f5e9;padding:8px;display:block;word-break:break-all">${token || 'NOT FOUND'}</code></p>
      <h3>Axios Result:</h3>
      <pre style="background:#f0f0f0;padding:10px">${JSON.stringify(axiosResult, null, 2)}</pre>
      <h3>Fetch Result (status ${fetchResp.status}):</h3>
      <pre style="background:#f0f0f0;padding:10px">${JSON.stringify(fetchData, null, 2)}</pre>
    </body></html>`);
  } catch (err) {
    console.error('CALLBACK ERROR:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── HEALTH ──────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', rapidapi: !!RAPIDAPI_KEY, shopify: !!SHOPIFY_ADMIN_TOKEN }));

// ─── SEARCH ──────────────────────────────────────────────────────────────────
app.get('/search', async (req, res) => {
  const query = req.query.q;
  if (!query) return res.status(400).json({ error: 'Missing query parameter q' });
  const markup = 1 + (MARKUP_PERCENT / 100);

  async function searchAmazon(q) {
    try {
      const r = await fetch(
        `https://real-time-amazon-data.p.rapidapi.com/search?query=${encodeURIComponent(q)}&page=1&country=US&sort_by=RELEVANCE`,
        { headers: { 'x-rapidapi-key': RAPIDAPI_KEY, 'x-rapidapi-host': 'real-time-amazon-data.p.rapidapi.com' } }
      );
      const d = await r.json();
      return (d.data?.products || []).slice(0, 5).map(p => ({
        title: p.product_title || 'Amazon Product',
        price: p.product_price ? parseFloat(p.product_price.replace(/[^0-9.]/g, '')) * markup : null,
        originalPrice: p.product_price ? parseFloat(p.product_price.replace(/[^0-9.]/g, '')) : null,
        image: p.product_photo || '',
        url: p.product_url || '',
        source: 'amazon'
      })).filter(p => p.price);
    } catch (e) { console.error('Amazon error:', e.message); return []; }
  }

  async function searchShein(q) {
    try {
      const r = await fetch(
        `https://shein-unofficial.p.rapidapi.com/search?q=${encodeURIComponent(q)}&page=1&limit=5&sort=7`,
        { headers: { 'x-rapidapi-key': RAPIDAPI_KEY, 'x-rapidapi-host': 'shein-unofficial.p.rapidapi.com' } }
      );
      const d = await r.json();
      const items = d.info?.products || d.data?.products || d.products || [];
      return items.slice(0, 5).map(p => {
        const rawPrice = p.salePrice?.amount || p.retailPrice?.amount || p.price || 0;
        const orig = parseFloat(rawPrice);
        return {
          title: p.goods_name || p.name || 'SHEIN Product',
          price: orig * markup,
          originalPrice: orig,
          image: p.goods_img || p.image || '',
          url: `https://www.shein.com/${p.goods_url_name || ''}-p-${p.goods_id || ''}.html`,
          source: 'shein'
        };
      }).filter(p => p.price);
    } catch (e) { console.error('SHEIN error:', e.message); return []; }
  }

  try {
    const [amazonResults, sheinResults] = await Promise.all([searchAmazon(query), searchShein(query)]);
    const combined = [...amazonResults, ...sheinResults];
    res.json({ results: combined, total: combined.length, markup: MARKUP_PERCENT });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── CREATE PRODUCT + RETURN VARIANT ID ──────────────────────────────────────
app.post('/create-and-add', async (req, res) => {
  const { title, price, originalPrice, image, sourceUrl, sourcePlatform } = req.body;
  if (!title || !price) return res.status(400).json({ error: 'Missing title or price' });
  if (!SHOPIFY_ADMIN_TOKEN || !SHOPIFY_STORE_DOMAIN) {
    return res.status(503).json({ error: 'Shopify admin not configured yet' });
  }
  try {
    const priceStr = parseFloat(price).toFixed(2);
    const productPayload = {
      product: {
        title, status: 'draft', published: false,
        variants: [{ price: priceStr, inventory_management: null }],
        images: image ? [{ src: image }] : [],
        metafields: [
          { namespace: 'dealshub', key: 'source_url', value: sourceUrl || '', type: 'single_line_text_field' },
          { namespace: 'dealshub', key: 'source_platform', value: sourcePlatform || '', type: 'single_line_text_field' },
          { namespace: 'dealshub', key: 'original_price', value: String(originalPrice || ''), type: 'single_line_text_field' }
        ]
      }
    };
    const r = await fetch(`https://${SHOPIFY_STORE_DOMAIN}/admin/api/2024-01/products.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': SHOPIFY_ADMIN_TOKEN },
      body: JSON.stringify(productPayload)
    });
    if (!r.ok) {
      const errText = await r.text();
      return res.status(r.status).json({ error: errText });
    }
    const data = await r.json();
    const product = data.product;
    const variantId = product.variants[0].id;
    res.json({ success: true, variantId, productId: product.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`DealsHub backend on port ${PORT}`));
