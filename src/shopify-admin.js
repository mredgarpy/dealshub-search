// ============================================================
// StyleHub — Shopify Admin API Helper
// ============================================================
const SHOPIFY_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN || '1rnmax-5z.myshopify.com';
const SHOPIFY_ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;

async function shopifyAdmin(method, apiPath, body = null) {
  if (!SHOPIFY_ADMIN_TOKEN) throw new Error('SHOPIFY_ADMIN_TOKEN not configured');

  const opts = {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': SHOPIFY_ADMIN_TOKEN
    }
  };
  if (body && method !== 'GET' && method !== 'DELETE') {
    opts.body = JSON.stringify(body);
  }

  const url = `https://${SHOPIFY_DOMAIN}/admin/api/2024-01${apiPath}`;
  const resp = await fetch(url, opts);

  if (method === 'DELETE' && resp.ok) return { success: true };

  const text = await resp.text();
  if (!text || text.trim() === '') {
    if (resp.ok) return { success: true };
    throw new Error(`Empty response with status ${resp.status}`);
  }
  const data = JSON.parse(text);
  if (!resp.ok) {
    throw new Error(JSON.stringify(data.errors || data));
  }
  return data;
}

module.exports = { shopifyAdmin };
