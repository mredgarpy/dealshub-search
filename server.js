// server.js — DealsHub Search Backend
// Real-time product search across SHEIN, Amazon, Sephora, Macy's
require('dotenv').config();

const express = require('express');
const cors    = require('cors');

const { markupProduct }  = require('./src/pricing');
const { searchShein }    = require('./src/adapters/shein');
const { searchAmazon }   = require('./src/adapters/amazon');
const { searchSephora, searchMacys } = require('./src/adapters/sephora-macys');

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// ─────────────────────────────────────────────
//  HEALTH
// ─────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({
    status:  'ok',
    version: '1.0.0',
    stores:  ['SHEIN', 'Amazon', 'Sephora', "Macy's"],
    markup:  `${process.env.MARKUP_PERCENT || 12}%`,
  });
});

// ─────────────────────────────────────────────
//  SEARCH
//  GET /api/search?q=dress&limit=20&store=all
// ─────────────────────────────────────────────
app.get('/api/search', async (req, res) => {
  const { q, limit = 20, store = 'all' } = req.query;

  if (!q || q.trim().length < 2) {
    return res.status(400).json({ error: 'Query must be at least 2 characters' });
  }

  const query    = q.trim();
  const maxItems = Math.min(parseInt(limit) || 20, 50);
  const perStore = Math.ceil(maxItems / 4);

  try {
    // Run all store searches in parallel (faster)
    const searches = [];

    const target = store.toLowerCase();
    if (target === 'all' || target === 'shein')   searches.push(searchShein(query, perStore).then(r => r.map(p => markupProduct(p))));
    if (target === 'all' || target === 'amazon')  searches.push(searchAmazon(query, perStore).then(r => r.map(p => markupProduct(p))));
    if (target === 'all' || target === 'sephora') searches.push(searchSephora(query, perStore).then(r => r.map(p => markupProduct(p))));
    if (target === 'all' || target === 'macys')   searches.push(searchMacys(query, perStore).then(r => r.map(p => markupProduct(p))));

    const results = await Promise.allSettled(searches);

    // Flatten and interleave results from all stores
    const allProducts = [];
    const arrays = results
      .filter(r => r.status === 'fulfilled')
      .map(r => r.value);

    const maxLen = Math.max(...arrays.map(a => a.length), 0);
    for (let i = 0; i < maxLen; i++) {
      for (const arr of arrays) {
        if (arr[i]) allProducts.push(arr[i]);
      }
    }

    res.json({
      query,
      results: allProducts.slice(0, maxItems),
      count:   allProducts.length,
    });

  } catch (err) {
    console.error('Search error:', err.message);
    res.status(500).json({ error: 'Search failed' });
  }
});

// ─────────────────────────────────────────────
//  START
// ─────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🔍 DealsHub Search running on port ${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/api/health`);
  console.log(`   Search: http://localhost:${PORT}/api/search?q=dress`);
});
