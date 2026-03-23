/**
 * Product Images Route
 * POST /api/admin/product-images
 * Given an array of Shopify product IDs, returns a map of productId → imageUrl
 */
const express = require('express');
const router = express.Router();
const fetch = require('node-fetch');

const SHOPIFY_STORE = process.env.SHOPIFY_STORE || '1rnmax-5z.myshopify.com';
const SHOPIFY_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN || process.env.SHOPIFY_ACCESS_TOKEN;

router.post('/api/admin/product-images', async (req, res) => {
  try {
    const { productIds } = req.body;
    if (!productIds || !Array.isArray(productIds) || productIds.length === 0) {
      return res.json({ success: true, images: {} });
    }

    // Deduplicate and limit to 50 products max
    const uniqueIds = [...new Set(productIds.map(String))].slice(0, 50);
    const images = {};

    // Fetch in batches of 10 to avoid rate limits
    const batchSize = 10;
    for (let i = 0; i < uniqueIds.length; i += batchSize) {
      const batch = uniqueIds.slice(i, i + batchSize);
      const ids = batch.join(',');

      const url = `https://${SHOPIFY_STORE}/admin/api/2024-01/products.json?ids=${ids}&fields=id,image`;
      const resp = await fetch(url, {
        headers: {
          'X-Shopify-Access-Token': SHOPIFY_TOKEN,
          'Content-Type': 'application/json'
        }
      });
      const data = await resp.json();

      if (data.products) {
        data.products.forEach(p => {
          if (p.image && p.image.src) {
            images[String(p.id)] = p.image.src;
          }
        });
      }
    }

    return res.json({ success: true, images });
  } catch (err) {
    console.error('[product-images] Error:', err.message);
    return res.json({ success: true, images: {} });
  }
});

module.exports = router;
