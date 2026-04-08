// blacklist.js — DMCA / Copyright Protection System
// Blocks products, brands, and keywords from appearing in search results,
// PDP pages, and sync-on-demand flows.
// Updated: 2026-04-08 — Created in response to Shopify DMCA takedown notices

const fs = require('fs');
const path = require('path');

const BLACKLIST_FILE = path.join(__dirname, '..', 'data', 'blacklist.json');

// Default empty blacklist structure
const DEFAULT_BLACKLIST = {
  // Products blocked by source + id (e.g., ASIN for Amazon)
  // Format: { source: "amazon", id: "B0973L1NVT", reason: "DMCA", addedAt: "2026-04-08" }
  products: [],

  // Entire brands blocked (case-insensitive match on title or brand field)
  // Format: { name: "BrandName", source: "all"|"amazon"|"shein", reason: "DMCA", addedAt: "2026-04-08" }
  brands: [],

  // Keywords that should never appear in search or results
  // Format: { term: "keyword", reason: "DMCA", addedAt: "2026-04-08" }
  keywords: [],

  // Seller IDs blocked by source
  // Format: { source: "amazon", sellerId: "A1B2C3", reason: "DMCA", addedAt: "2026-04-08" }
  sellers: [],

  // DMCA ticket tracking
  // Format: { ticketId: "xxx", source: "shopify", products: [...ids], date: "2026-04-08", status: "active" }
  dmcaTickets: [],
};

let _blacklist = null;

// ─────────────────────────────────────────────
//  PERSISTENCE
// ─────────────────────────────────────────────

function ensureDataDir() {
  const dir = path.dirname(BLACKLIST_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function loadBlacklist() {
  if (_blacklist) return _blacklist;

  try {
    ensureDataDir();
    if (fs.existsSync(BLACKLIST_FILE)) {
      const raw = fs.readFileSync(BLACKLIST_FILE, 'utf8');
      _blacklist = { ...DEFAULT_BLACKLIST, ...JSON.parse(raw) };
    } else {
      _blacklist = { ...DEFAULT_BLACKLIST };
      saveBlacklist();
    }
  } catch (err) {
    console.error('Error loading blacklist:', err.message);
    _blacklist = { ...DEFAULT_BLACKLIST };
  }

  return _blacklist;
}

function saveBlacklist() {
  try {
    ensureDataDir();
    fs.writeFileSync(BLACKLIST_FILE, JSON.stringify(_blacklist, null, 2), 'utf8');
  } catch (err) {
    console.error('Error saving blacklist:', err.message);
  }
}

function reloadBlacklist() {
  _blacklist = null;
  return loadBlacklist();
}

// ─────────────────────────────────────────────
//  CHECKS — Used by search, PDP, and cart flows
// ─────────────────────────────────────────────

/**
 * Check if a specific product is blacklisted
 * @param {string} source - store name (amazon, shein, etc.)
 * @param {string} productId - source product ID (ASIN, goods_id, etc.)
 * @returns {boolean}
 */
function isProductBlocked(source, productId) {
  const bl = loadBlacklist();
  if (!source || !productId) return false;

  const srcLower = source.toLowerCase();
  const idStr = String(productId);

  return bl.products.some(
    p => p.id === idStr && p.source.toLowerCase() === srcLower
  );
}

/**
 * Check if a brand is blacklisted
 * @param {string} brandName - brand or vendor name
 * @param {string} source - store name
 * @returns {boolean}
 */
function isBrandBlocked(brandName, source = 'all') {
  const bl = loadBlacklist();
  if (!brandName) return false;

  const brandLower = brandName.toLowerCase();
  const srcLower = (source || 'all').toLowerCase();

  return bl.brands.some(b => {
    const nameMatch = brandLower.includes(b.name.toLowerCase()) ||
                      b.name.toLowerCase().includes(brandLower);
    const sourceMatch = b.source === 'all' || b.source.toLowerCase() === srcLower;
    return nameMatch && sourceMatch;
  });
}

/**
 * Check if a product title contains blocked keywords
 * @param {string} title - product title
 * @returns {boolean}
 */
function hasBlockedKeyword(title) {
  const bl = loadBlacklist();
  if (!title) return false;

  const titleLower = title.toLowerCase();

  return bl.keywords.some(k =>
    titleLower.includes(k.term.toLowerCase())
  );
}

/**
 * Check if a seller is blocked
 * @param {string} source - store name
 * @param {string} sellerId - seller ID
 * @returns {boolean}
 */
function isSellerBlocked(source, sellerId) {
  const bl = loadBlacklist();
  if (!source || !sellerId) return false;

  return bl.sellers.some(
    s => s.sellerId === sellerId && s.source.toLowerCase() === source.toLowerCase()
  );
}

/**
 * Master filter — checks ALL blacklist rules against a product object
 * @param {Object} product - product object with id, title, store/source, brand fields
 * @returns {{ blocked: boolean, reason: string|null }}
 */
function checkProduct(product) {
  if (!product) return { blocked: false, reason: null };

  const source = (product.store || product.source || product.sourceName || '').toLowerCase();
  const id = String(product.id || product.sourceId || '');
  const title = product.title || '';
  const brand = product.brand || '';
  const sellerId = product.sellerId || product.seller_id || '';

  // Check product ID
  if (isProductBlocked(source, id)) {
    return { blocked: true, reason: 'product_blocked' };
  }

  // Check brand
  if (isBrandBlocked(brand, source)) {
    return { blocked: true, reason: 'brand_blocked' };
  }

  // Check title for brand matches too
  const bl = loadBlacklist();
  for (const b of bl.brands) {
    if (b.source === 'all' || b.source.toLowerCase() === source) {
      if (title.toLowerCase().includes(b.name.toLowerCase())) {
        return { blocked: true, reason: 'brand_in_title' };
      }
    }
  }

  // Check keywords
  if (hasBlockedKeyword(title)) {
    return { blocked: true, reason: 'keyword_blocked' };
  }

  // Check seller
  if (isSellerBlocked(source, sellerId)) {
    return { blocked: true, reason: 'seller_blocked' };
  }

  return { blocked: false, reason: null };
}

/**
 * Filter an array of products, removing all blacklisted ones
 * @param {Array} products - array of product objects
 * @returns {Array} - filtered array with only allowed products
 */
function filterProducts(products) {
  if (!Array.isArray(products)) return [];
  return products.filter(p => !checkProduct(p).blocked);
}

// ─────────────────────────────────────────────
//  MANAGEMENT — Add/remove items from blacklist
// ─────────────────────────────────────────────

function addProduct(source, id, reason = 'DMCA') {
  const bl = loadBlacklist();
  const exists = bl.products.some(
    p => p.id === String(id) && p.source.toLowerCase() === source.toLowerCase()
  );
  if (!exists) {
    bl.products.push({
      source: source.toLowerCase(),
      id: String(id),
      reason,
      addedAt: new Date().toISOString().split('T')[0],
    });
    saveBlacklist();
  }
  return !exists; // true if newly added
}

function removeProduct(source, id) {
  const bl = loadBlacklist();
  const before = bl.products.length;
  bl.products = bl.products.filter(
    p => !(p.id === String(id) && p.source.toLowerCase() === source.toLowerCase())
  );
  if (bl.products.length !== before) saveBlacklist();
  return bl.products.length !== before;
}

function addBrand(name, source = 'all', reason = 'DMCA') {
  const bl = loadBlacklist();
  const exists = bl.brands.some(
    b => b.name.toLowerCase() === name.toLowerCase() && b.source === source
  );
  if (!exists) {
    bl.brands.push({
      name,
      source,
      reason,
      addedAt: new Date().toISOString().split('T')[0],
    });
    saveBlacklist();
  }
  return !exists;
}

function removeBrand(name, source = 'all') {
  const bl = loadBlacklist();
  const before = bl.brands.length;
  bl.brands = bl.brands.filter(
    b => !(b.name.toLowerCase() === name.toLowerCase() && b.source === source)
  );
  if (bl.brands.length !== before) saveBlacklist();
  return bl.brands.length !== before;
}

function addKeyword(term, reason = 'DMCA') {
  const bl = loadBlacklist();
  const exists = bl.keywords.some(k => k.term.toLowerCase() === term.toLowerCase());
  if (!exists) {
    bl.keywords.push({
      term,
      reason,
      addedAt: new Date().toISOString().split('T')[0],
    });
    saveBlacklist();
  }
  return !exists;
}

function removeKeyword(term) {
  const bl = loadBlacklist();
  const before = bl.keywords.length;
  bl.keywords = bl.keywords.filter(k => k.term.toLowerCase() !== term.toLowerCase());
  if (bl.keywords.length !== before) saveBlacklist();
  return bl.keywords.length !== before;
}

function addSeller(source, sellerId, reason = 'DMCA') {
  const bl = loadBlacklist();
  const exists = bl.sellers.some(
    s => s.sellerId === sellerId && s.source.toLowerCase() === source.toLowerCase()
  );
  if (!exists) {
    bl.sellers.push({
      source: source.toLowerCase(),
      sellerId,
      reason,
      addedAt: new Date().toISOString().split('T')[0],
    });
    saveBlacklist();
  }
  return !exists;
}

function addDmcaTicket(ticketId, productIds = [], date = null) {
  const bl = loadBlacklist();
  bl.dmcaTickets.push({
    ticketId,
    source: 'shopify',
    products: productIds,
    date: date || new Date().toISOString().split('T')[0],
    status: 'active',
  });
  saveBlacklist();
}

/**
 * Get full blacklist for admin view
 */
function getBlacklist() {
  return loadBlacklist();
}

/**
 * Get blacklist stats
 */
function getStats() {
  const bl = loadBlacklist();
  return {
    products: bl.products.length,
    brands: bl.brands.length,
    keywords: bl.keywords.length,
    sellers: bl.sellers.length,
    dmcaTickets: bl.dmcaTickets.length,
  };
}

module.exports = {
  // Checks
  isProductBlocked,
  isBrandBlocked,
  hasBlockedKeyword,
  isSellerBlocked,
  checkProduct,
  filterProducts,

  // Management
  addProduct,
  removeProduct,
  addBrand,
  removeBrand,
  addKeyword,
  removeKeyword,
  addSeller,
  addDmcaTicket,

  // Admin
  getBlacklist,
  getStats,
  reloadBlacklist,
};
