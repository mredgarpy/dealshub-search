// ============================================================
// StyleHub — AutoDS Automated Sync Service
// ============================================================
// Automates registration of Shopify products in AutoDS via:
//   1. CSV generation in AutoDS Untracked Products format
//   2. Puppeteer browser automation to upload CSV
//   3. Cron-based scheduling (runs every 30 min)
//
// Flow:
//   - Query DB for products synced to Shopify but NOT yet in AutoDS
//   - Generate CSV: ProductId,BuyId,Supplier,SupplierRegion,VariantSKU
//   - Use Puppeteer to login to AutoDS → Untracked → Upload CSV
//   - Mark products as 'csv_uploaded' in DB
//   - On success, mark as 'linked' when AutoDS confirms
//
// Config (env vars):
//   AUTODS_EMAIL        — AutoDS login email
//   AUTODS_PASSWORD     — AutoDS login password
//   AUTODS_SYNC_ENABLED — 'true' to enable auto-sync
//   AUTODS_SYNC_BATCH   — max products per CSV batch (default 50)
//   AUTODS_HEADLESS     — 'false' to show browser (debug)
// ============================================================

const logger = require('../utils/logger');
const { getDb } = require('../utils/db');
const path = require('path');
const fs = require('fs');
const os = require('os');

// ---- CONFIG ----
const CONFIG = {
  email: () => process.env.AUTODS_EMAIL || '',
  password: () => process.env.AUTODS_PASSWORD || '',
  enabled: () => process.env.AUTODS_SYNC_ENABLED === 'true',
  batchSize: () => parseInt(process.env.AUTODS_SYNC_BATCH || '50', 10),
  headless: () => process.env.AUTODS_HEADLESS !== 'false',
  loginUrl: 'https://platform.autods.com/login',
  untrackedUrl: 'https://platform.autods.com/untracked',
  productsUrl: 'https://platform.autods.com/products',
  sessionDir: () => path.join(os.tmpdir(), 'autods-session'),
};

// ---- SUPPLIER MAPPINGS ----
const SUPPLIER_MAP = {
  amazon: { name: 'amazon', region: 'us' },
  aliexpress: { name: 'aliexpress', region: 'cn' },
  sephora: { name: 'sephora', region: 'us' },
  macys: { name: 'macys', region: 'us' },
  shein: { name: 'shein', region: 'cn' },
};

// ---- BUY ID SANITIZER ----
// Extracts clean source product ID for AutoDS CSV BuyId column
// AutoDS expects: ASIN for Amazon, item ID for AliExpress, etc. — NOT full URLs
function sanitizeBuyId(source, rawId) {
  const id = String(rawId || '').trim();
  const src = (source || '').toLowerCase();

  if (src === 'amazon') {
    // Extract ASIN: 10-char alphanumeric (e.g. B0F4RM7Y2L)
    // Handle duplicated ASINs like "B0F4RM7Y2L-B0F4RM7Y2L"
    // Handle full URLs like "https://www.amazon.com/dp/B0F4RM7Y2L"
    const asinMatch = id.match(/\b([A-Z0-9]{10})\b/);
    if (asinMatch) return asinMatch[1];
    // Fallback: take first segment before hyphen if it looks like ASIN
    const parts = id.split('-');
    if (parts[0] && /^[A-Z0-9]{10}$/.test(parts[0])) return parts[0];
  }

  if (src === 'aliexpress') {
    // Extract numeric item ID (e.g. 3256811722821342)
    // Handle URLs like "https://www.aliexpress.com/item/3256811722821342.html"
    const numMatch = id.match(/(\d{10,20})/);
    if (numMatch) return numMatch[1];
  }

  if (src === 'sephora') {
    // Extract product slug (e.g. P461134)
    const sephoraMatch = id.match(/(P\d+)/i);
    if (sephoraMatch) return sephoraMatch[1];
  }

  // For macys, shein, or unknown: strip URL parts, return clean ID
  if (id.startsWith('http')) {
    const urlParts = id.split('/');
    return urlParts[urlParts.length - 1].replace(/\.html$/, '');
  }

  // Handle duplicated IDs (e.g. "ID-ID" pattern)
  if (id.includes('-')) {
    const parts = id.split('-');
    if (parts.length === 2 && parts[0] === parts[1]) return parts[0];
  }

  return id;
}

// ---- SKU BUILDER ----
// Format: DH-{SOURCE}-{SOURCE_ID}-{SOURCE_VARIANT_ID}
function buildVariantSKU(source, sourceId, sourceVariantId) {
  const src = (source || '').toUpperCase();
  const pid = sanitizeBuyId(source, sourceId);
  const vid = sourceVariantId ? String(sourceVariantId) : pid;
  return `DH-${src}-${pid}-${vid}`;
}

// ============================================================
// 1. GET PENDING PRODUCTS (synced to Shopify, not in AutoDS)
// ============================================================
function getPendingForAutoDS(limit = 50) {
  const db = getDb();
  if (!db) return [];

  try {
    // Products in autods_products with status 'pending' (never uploaded)
    // These were registered when the product was synced to Shopify
    const products = db.prepare(`
      SELECT
        ap.id,
        ap.source_store,
        ap.source_product_id,
        ap.source_url,
        ap.shopify_product_id,
        ap.shopify_variant_id,
        ap.shopify_handle,
        ap.buy_id,
        ap.supplier_name,
        ap.warehouse_region,
        ap.autods_status,
        ap.created_at
      FROM autods_products ap
      WHERE ap.autods_status = 'pending'
      ORDER BY ap.created_at ASC
      LIMIT ?
    `).all(limit);

    return products;
  } catch (e) {
    logger.error('autods-sync', 'getPendingForAutoDS failed', { error: e.message });
    return [];
  }
}

// ============================================================
// 2. GENERATE UNTRACKED CSV
// ============================================================
// AutoDS Untracked Products CSV format:
// ProductId,BuyId,Supplier,SupplierRegion,VariantSKU
//
// - ProductId = Shopify Product ID (numeric)
// - BuyId = Source product identifier (ASIN for Amazon, item ID for AliExpress, etc.)
// - Supplier = amazon | aliexpress | sephora | macys | shein
// - SupplierRegion = us | cn | etc.
// - VariantSKU = optional, our internal SKU format
function generateUntrackedCSV(products) {
  if (!products || products.length === 0) {
    return { csv: '', count: 0, productIds: [] };
  }

  const header = 'ProductId,BuyId,Supplier,SupplierRegion,VariantSKU';
  const rows = [];
  const productIds = [];
  const skipped = [];

  for (const p of products) {
    // Validate required fields
    if (!p.shopify_product_id) {
      skipped.push({ id: p.id, reason: 'missing shopify_product_id' });
      continue;
    }
    if (!p.source_product_id) {
      skipped.push({ id: p.id, reason: 'missing source_product_id' });
      continue;
    }

    const source = (p.source_store || '').toLowerCase();
    const supplierInfo = SUPPLIER_MAP[source];

    if (!supplierInfo) {
      skipped.push({ id: p.id, reason: `unknown source: ${source}` });
      continue;
    }

    const productId = String(p.shopify_product_id);
    const buyId = sanitizeBuyId(source, p.source_product_id);
    const supplier = supplierInfo.name;
    // AutoDS region must match the supplier's actual region, not the DB warehouse_region
    // Amazon US = 'us', AliExpress CN = 'cn', etc.
    const region = supplierInfo.region;
    const sku = buildVariantSKU(source, p.source_product_id, p.shopify_variant_id);

    rows.push(`${productId},${buyId},${supplier},${region},${sku}`);
    productIds.push(p.id);
  }

  const csv = rows.length > 0 ? [header, ...rows].join('\n') : '';

  return {
    csv,
    count: rows.length,
    productIds,
    skipped,
  };
}

// ============================================================
// 3. WRITE CSV TO TEMP FILE
// ============================================================
function writeCSVToFile(csv) {
  const dir = os.tmpdir();
  const filename = `autods_import_${Date.now()}.csv`;
  const filepath = path.join(dir, filename);

  fs.writeFileSync(filepath, csv, 'utf-8');
  logger.info('autods-sync', `CSV written to ${filepath}`);

  return filepath;
}

// ============================================================
// 4. PUPPETEER BROWSER AUTOMATION
// ============================================================
// Handles: login, session persistence, CSV upload, status check

let puppeteer = null;

function getPuppeteer() {
  if (!puppeteer) {
    try {
      puppeteer = require('puppeteer');
    } catch (e) {
      logger.error('autods-sync', 'Puppeteer not installed. Run: npm install puppeteer');
      return null;
    }
  }
  return puppeteer;
}

async function launchBrowser() {
  const pptr = getPuppeteer();
  if (!pptr) return null;

  const sessionDir = CONFIG.sessionDir();
  // Ensure session directory exists for persistent login
  if (!fs.existsSync(sessionDir)) {
    fs.mkdirSync(sessionDir, { recursive: true });
  }

  const browser = await pptr.launch({
    headless: CONFIG.headless() ? 'new' : false,
    userDataDir: sessionDir,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-default-apps',
      '--disable-sync',
      '--disable-translate',
      '--no-first-run',
      '--single-process',
      '--no-zygote',
      '--window-size=1280,800',
    ],
    defaultViewport: { width: 1280, height: 800 },
    protocolTimeout: 120000,
  });

  return browser;
}

async function ensureLoggedIn(page) {
  // Navigate to AutoDS and check if already logged in
  // Use 'domcontentloaded' instead of 'networkidle2' for faster loading on low-memory servers
  await page.goto(CONFIG.productsUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });

  // Check if we're on the login page
  const url = page.url();
  if (url.includes('/login') || url.includes('/signin') || url.includes('cognito')) {
    logger.info('autods-sync', 'Not logged in — performing login...');

    const email = CONFIG.email();
    const password = CONFIG.password();

    if (!email || !password) {
      throw new Error('AUTODS_EMAIL and AUTODS_PASSWORD env vars required for auto-login');
    }

    // Wait for login form (generous timeout for Render free tier)
    await page.waitForSelector('input[type="email"], input[name="email"], input[type="text"]', { timeout: 60000 });

    // Try to find and fill email field
    const emailInput = await page.$('input[type="email"]') || await page.$('input[name="email"]') || await page.$('input[type="text"]');
    if (emailInput) {
      await emailInput.click({ clickCount: 3 }); // Select all
      await emailInput.type(email, { delay: 50 });
    }

    // Find and fill password field
    const passInput = await page.$('input[type="password"]');
    if (passInput) {
      await passInput.click({ clickCount: 3 });
      await passInput.type(password, { delay: 50 });
    }

    // Click login/submit button
    const submitBtn = await page.$('button[type="submit"]') ||
                      await page.$('button:has-text("Log in")') ||
                      await page.$('button:has-text("Sign in")');
    if (submitBtn) {
      await submitBtn.click();
    } else {
      await page.keyboard.press('Enter');
    }

    // Wait for navigation after login
    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 90000 }).catch(() => {});

    // Verify we're logged in
    const postLoginUrl = page.url();
    if (postLoginUrl.includes('/login') || postLoginUrl.includes('/signin')) {
      throw new Error('Login failed — still on login page after submit');
    }

    logger.info('autods-sync', 'Login successful');
  } else {
    logger.info('autods-sync', 'Already logged in (session persisted)');
  }
}

async function uploadCSVToAutoDS(page, csvFilePath) {
  // Navigate to untracked products page
  await page.goto(CONFIG.untrackedUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForTimeout(5000);

  // Click "Import with CSV" button
  const importBtn = await page.waitForSelector('button:has-text("Import with CSV"), button:has(img[alt="plus"])', { timeout: 30000 }).catch(() => null);

  if (!importBtn) {
    // Try finding by text content
    const buttons = await page.$$('button');
    for (const btn of buttons) {
      const text = await page.evaluate(el => el.textContent, btn);
      if (text && text.includes('Import with CSV')) {
        await btn.click();
        break;
      }
    }
  } else {
    await importBtn.click();
  }

  // Wait for modal to appear
  await page.waitForTimeout(2000);

  // Find file input in the modal
  const fileInput = await page.$('input[type="file"]');
  if (!fileInput) {
    throw new Error('Could not find file input in Import CSV modal');
  }

  // Upload the CSV file
  await fileInput.uploadFile(csvFilePath);
  logger.info('autods-sync', 'CSV file uploaded to AutoDS modal');

  // Wait for file to be processed
  await page.waitForTimeout(2000);

  // Look for "Add" button and click it
  const addBtn = await page.$('button:has-text("Add")').catch(() => null);
  if (addBtn) {
    await addBtn.click();
    logger.info('autods-sync', 'Clicked Add button');
  } else {
    // The modal might auto-submit on file upload (observed behavior)
    logger.info('autods-sync', 'No Add button found — modal may have auto-submitted');
  }

  // Wait for import to be processed
  await page.waitForTimeout(5000);

  // Check for success/error indicators
  const pageContent = await page.content();
  const hasError = pageContent.includes('Internal Error') || pageContent.includes('error');
  const hasImport = pageContent.includes('Untracked Import');

  // Try to find the newest import notification
  const importNotifications = await page.$$eval(
    '[class*="import"], [class*="notification"], [class*="alert"]',
    els => els.map(el => el.textContent.trim()).filter(t => t.includes('Import') || t.includes('finished'))
  ).catch(() => []);

  return {
    success: !hasError || hasImport,
    notifications: importNotifications,
    url: page.url(),
  };
}

// ============================================================
// 5. MAIN SYNC ORCHESTRATOR
// ============================================================
async function runAutodsSync() {
  const startTime = Date.now();
  const results = {
    status: 'started',
    productsFound: 0,
    csvGenerated: false,
    uploadAttempted: false,
    uploadSuccess: false,
    error: null,
    duration: 0,
  };

  try {
    // Check if enabled
    if (!CONFIG.enabled()) {
      results.status = 'disabled';
      logger.info('autods-sync', 'AutoDS sync disabled (AUTODS_SYNC_ENABLED != true)');
      return results;
    }

    // 1. Get pending products
    const batchSize = CONFIG.batchSize();
    const pendingProducts = getPendingForAutoDS(batchSize);
    results.productsFound = pendingProducts.length;

    if (pendingProducts.length === 0) {
      results.status = 'no_pending';
      logger.info('autods-sync', 'No pending products to sync');
      return results;
    }

    logger.info('autods-sync', `Found ${pendingProducts.length} pending products for AutoDS sync`);

    // 2. Generate CSV
    const { csv, count, productIds, skipped } = generateUntrackedCSV(pendingProducts);
    results.csvCount = count;
    results.csvSkipped = skipped.length;

    if (count === 0) {
      results.status = 'csv_empty';
      logger.warn('autods-sync', 'CSV generation produced 0 valid rows', { skipped });
      return results;
    }

    results.csvGenerated = true;
    logger.info('autods-sync', `CSV generated: ${count} products, ${skipped.length} skipped`);

    // 3. Write CSV to temp file
    const csvFilePath = writeCSVToFile(csv);

    // 4. Launch browser and upload
    const browser = await launchBrowser();
    if (!browser) {
      results.status = 'puppeteer_unavailable';
      results.error = 'Puppeteer not available';
      // Even without Puppeteer, save the CSV for manual download
      results.csvFilePath = csvFilePath;
      return results;
    }

    results.uploadAttempted = true;

    try {
      const page = await browser.newPage();

      // Generous timeouts for Render free tier (512MB RAM, slow cold starts)
      page.setDefaultTimeout(90000);
      page.setDefaultNavigationTimeout(90000);

      // Login
      await ensureLoggedIn(page);

      // Upload CSV
      const uploadResult = await uploadCSVToAutoDS(page, csvFilePath);
      results.uploadSuccess = uploadResult.success;
      results.uploadNotifications = uploadResult.notifications;

      if (uploadResult.success) {
        // 5. Mark products as 'csv_uploaded' in DB
        markProductsAsUploaded(productIds);
        results.markedCount = productIds.length;
        logger.info('autods-sync', `Marked ${productIds.length} products as csv_uploaded`);
      }

      await page.close();
    } finally {
      await browser.close();
    }

    // 6. Cleanup temp file
    try {
      fs.unlinkSync(csvFilePath);
    } catch (_) {}

    results.status = results.uploadSuccess ? 'success' : 'upload_failed';
    results.duration = Date.now() - startTime;

    logger.info('autods-sync', `Sync completed: ${results.status}`, {
      products: count,
      duration: results.duration,
      success: results.uploadSuccess,
    });

    return results;

  } catch (e) {
    results.status = 'error';
    results.error = e.message;
    results.duration = Date.now() - startTime;
    logger.error('autods-sync', `Sync failed: ${e.message}`, { stack: e.stack?.substring(0, 500) });
    return results;
  }
}

// ============================================================
// 6. DB STATUS UPDATES
// ============================================================
function markProductsAsUploaded(productIds) {
  const db = getDb();
  if (!db || !productIds?.length) return 0;

  try {
    const stmt = db.prepare(`
      UPDATE autods_products
      SET autods_status = 'csv_uploaded', updated_at = datetime('now')
      WHERE id = ? AND autods_status = 'pending'
    `);

    let updated = 0;
    for (const id of productIds) {
      const r = stmt.run(id);
      if (r.changes > 0) updated++;
    }

    logger.info('autods-sync', `Marked ${updated}/${productIds.length} products as csv_uploaded`);
    return updated;
  } catch (e) {
    logger.error('autods-sync', `markProductsAsUploaded failed: ${e.message}`);
    return 0;
  }
}

function markProductAsLinked(shopifyProductId) {
  const db = getDb();
  if (!db) return false;

  try {
    db.prepare(`
      UPDATE autods_products
      SET autods_status = 'linked', autods_linked_at = datetime('now'), updated_at = datetime('now')
      WHERE shopify_product_id = ?
    `).run(shopifyProductId);
    return true;
  } catch (e) {
    logger.error('autods-sync', `markProductAsLinked failed: ${e.message}`);
    return false;
  }
}

// ============================================================
// 7. GENERATE CSV FOR MANUAL DOWNLOAD (NO PUPPETEER NEEDED)
// ============================================================
// This endpoint allows admin to download a ready-to-upload CSV
// in case Puppeteer automation is not available or fails.
function generateDownloadableCSV(limit = 100) {
  const products = getPendingForAutoDS(limit);
  if (products.length === 0) {
    return { csv: '', count: 0, message: 'No pending products' };
  }

  const { csv, count, productIds, skipped } = generateUntrackedCSV(products);

  return {
    csv,
    count,
    productIds,
    skipped,
    filename: `autods_import_${new Date().toISOString().split('T')[0]}.csv`,
    instructions: [
      '1. Download this CSV file',
      '2. Go to AutoDS → Products → Untracked Products',
      '3. Click "Import with CSV"',
      '4. Upload this file and click Add',
      '5. After success, call POST /api/admin/autods/mark-uploaded with the productIds',
    ],
  };
}

// ============================================================
// 8. SYNC STATUS / STATS
// ============================================================
function getSyncStats() {
  const db = getDb();
  if (!db) return {};

  try {
    const byStatus = db.prepare(`
      SELECT autods_status, COUNT(*) as count
      FROM autods_products
      GROUP BY autods_status
    `).all();

    const bySource = db.prepare(`
      SELECT source_store, autods_status, COUNT(*) as count
      FROM autods_products
      GROUP BY source_store, autods_status
    `).all();

    const recentUploads = db.prepare(`
      SELECT id, source_store, source_product_id, shopify_product_id, autods_status, updated_at
      FROM autods_products
      WHERE autods_status = 'csv_uploaded'
      ORDER BY updated_at DESC
      LIMIT 20
    `).all();

    const pending = db.prepare(`
      SELECT COUNT(*) as count FROM autods_products WHERE autods_status = 'pending'
    `).get();

    const uploaded = db.prepare(`
      SELECT COUNT(*) as count FROM autods_products WHERE autods_status = 'csv_uploaded'
    `).get();

    const linked = db.prepare(`
      SELECT COUNT(*) as count FROM autods_products WHERE autods_status = 'linked'
    `).get();

    return {
      summary: {
        pending: pending?.count || 0,
        csvUploaded: uploaded?.count || 0,
        linked: linked?.count || 0,
        total: (pending?.count || 0) + (uploaded?.count || 0) + (linked?.count || 0),
        syncEnabled: CONFIG.enabled(),
        puppeteerAvailable: !!getPuppeteer(),
      },
      byStatus,
      bySource,
      recentUploads,
      timestamp: new Date().toISOString(),
    };
  } catch (e) {
    logger.error('autods-sync', `getSyncStats failed: ${e.message}`);
    return { error: e.message };
  }
}

// ============================================================
// EXPORTS
// ============================================================
module.exports = {
  // Core sync
  runAutodsSync,
  getPendingForAutoDS,
  generateUntrackedCSV,

  // Manual CSV download
  generateDownloadableCSV,

  // Status management
  markProductsAsUploaded,
  markProductAsLinked,
  getSyncStats,

  // Helpers
  sanitizeBuyId,
  buildVariantSKU,
  writeCSVToFile,
  SUPPLIER_MAP,
  CONFIG,
};
