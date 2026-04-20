// ============================================================
// StyleHub — AutoDS Integration Service
// ============================================================
// Handles: product registration, order webhooks, CSV export,
// and future API integration for automatic fulfillment.
//
// AutoDS Flow:
//   1. Product synced to Shopify (prepare-cart) → registered here
//   2. Order webhook from Shopify → order routing created
//   3. AutoDS picks up orders via its Shopify connection
//   4. Products linked in AutoDS via bulk CSV or manual connection
//
// Future: When AutoDS API ($5k activation) is available,
// this service can call it directly to register products.
// ============================================================

const logger = require('../utils/logger');
const { getDb } = require('../utils/db');

// ---- CONFIG ----
const AUTODS_API_KEY = () => process.env.AUTODS_API_KEY || '';
const AUTODS_API_URL = () => process.env.AUTODS_API_URL || 'https://api.autods.com/v1';
const AUTODS_STORE_ID = () => process.env.AUTODS_STORE_ID || '';
const AUTODS_ENABLED = () => process.env.AUTODS_ENABLED === 'true';

// ---- SOURCE URL BUILDERS (variant-aware) ----
// Each builder accepts (productId, variantId?) and returns the canonical
// supplier URL that AutoDS uses as "Buy ID". When variantId is provided,
// the builder returns a variant-specific URL so AutoDS imports the exact
// color/size/option the customer ordered.
//
// To add a new source in the future:
//   1. Add an entry to SOURCE_URL_BUILDERS with the variant-aware URL logic
//   2. Add the display name to AUTODS_SUPPLIER_MAP below
//   3. Add the SKU prefix pattern to the SKU parser regex (extractSourceInfo)
const SOURCE_URL_BUILDERS = {
  // Amazon: variants are child ASINs (different from parent ASIN). When we
  // have a child ASIN in variantId, we use IT as the URL target — that's the
  // actual buyable page. Parent ASIN is just a grouping and may not have a PDP.
  amazon: (id, variantId) => {
    const asin = (variantId && variantId !== id) ? variantId : id;
    return `https://www.amazon.com/dp/${asin}`;
  },
  // AliExpress: variants are sku_id query params on the base product URL.
  aliexpress: (id, variantId) => {
    const base = `https://www.aliexpress.com/item/${id}.html`;
    return variantId ? `${base}?sku_id=${encodeURIComponent(variantId)}` : base;
  },
  // Sephora: variants are skuId query params.
  sephora: (id, variantId) => {
    const base = `https://www.sephora.com/product/${id}`;
    return variantId ? `${base}?skuId=${encodeURIComponent(variantId)}` : base;
  },
  // Macy's: variant param convention varies; we append ?variantId= as a best-effort
  // hint. AutoDS operator should verify color/size on import for Macy's orders.
  macys: (id, variantId) => {
    const base = `https://www.macys.com/shop/product/${id}`;
    return variantId ? `${base}?variantId=${encodeURIComponent(variantId)}` : base;
  },
  // SHEIN: variants are skuId query params.
  shein: (id, variantId) => {
    const base = `https://us.shein.com/product-p-${id}.html`;
    return variantId ? `${base}?skuId=${encodeURIComponent(variantId)}` : base;
  }
};

/**
 * Build a source-specific product URL, preferring a variant-aware URL when
 * variantId is provided.
 *
 * @param {string} source     - 'amazon' | 'aliexpress' | 'sephora' | 'macys' | 'shein'
 * @param {string} sourceId   - Product ID on the source platform
 * @param {string?} existingUrl - Pre-existing URL (used when variantId is absent)
 * @param {string?} variantId - Source-side variant ID (sku_id, skuId, child ASIN, etc.)
 * @returns {string} Canonical buy URL for AutoDS
 */
function buildSourceUrl(source, sourceId, existingUrl, variantId) {
  // When an explicit variantId is provided, ALWAYS rebuild to guarantee the
  // URL carries the variant param — otherwise AutoDS may import the wrong
  // color/size. This is stricter than preferring existingUrl.
  if (variantId) {
    const builder = SOURCE_URL_BUILDERS[source.toLowerCase()];
    if (builder) return builder(sourceId, variantId);
  }
  // No variantId → prefer existing URL if it looks valid.
  if (existingUrl && existingUrl.startsWith('http')) return existingUrl;
  const builder = SOURCE_URL_BUILDERS[source.toLowerCase()];
  return builder ? builder(sourceId) : '';
}

// ---- AUTODS SUPPLIER NAME MAPPING ----
const AUTODS_SUPPLIER_MAP = {
  amazon: 'Amazon',
  aliexpress: 'AliExpress',
  sephora: 'Sephora',
  macys: "Macy's",
  shein: 'SHEIN'
};

// ---- DB SCHEMA EXTENSION ----
function initAutodsSchema() {
  const db = getDb();
  if (!db) return;

  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS autods_products (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_store TEXT NOT NULL,
        source_product_id TEXT NOT NULL,
        source_url TEXT,
        shopify_product_id INTEGER,
        shopify_variant_id INTEGER,
        shopify_handle TEXT,
        autods_product_id TEXT,
        autods_status TEXT DEFAULT 'pending',
        autods_linked_at TEXT,
        buy_id TEXT,
        supplier_name TEXT,
        warehouse_region TEXT DEFAULT 'US',
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        UNIQUE(source_store, source_product_id)
      );

      CREATE INDEX IF NOT EXISTS idx_autods_shopify
        ON autods_products(shopify_product_id);

      CREATE INDEX IF NOT EXISTS idx_autods_status
        ON autods_products(autods_status);

      CREATE TABLE IF NOT EXISTS autods_orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        shopify_order_id INTEGER NOT NULL,
        shopify_order_number TEXT,
        shopify_order_name TEXT,
        customer_email TEXT,
        customer_name TEXT,
        total_price REAL,
        currency TEXT DEFAULT 'USD',
        financial_status TEXT,
        fulfillment_status TEXT,
        autods_status TEXT DEFAULT 'pending',
        autods_order_id TEXT,
        items_json TEXT,
        shipping_address_json TEXT,
        notes TEXT,
        error_message TEXT,
        processed_at TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        UNIQUE(shopify_order_id)
      );

      CREATE INDEX IF NOT EXISTS idx_autods_orders_status
        ON autods_orders(autods_status);

      CREATE INDEX IF NOT EXISTS idx_autods_orders_shopify
        ON autods_orders(shopify_order_id);

      CREATE TABLE IF NOT EXISTS autods_order_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        autods_order_id INTEGER REFERENCES autods_orders(id),
        shopify_line_item_id INTEGER,
        shopify_product_id INTEGER,
        shopify_variant_id INTEGER,
        source_store TEXT,
        source_product_id TEXT,
        source_url TEXT,
        buy_id TEXT,
        quantity INTEGER DEFAULT 1,
        price REAL,
        variant_title TEXT,
        autods_item_status TEXT DEFAULT 'pending',
        supplier_order_id TEXT,
        supplier_tracking TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_autods_items_order
        ON autods_order_items(autods_order_id);
    `);
    logger.info('autods', 'AutoDS schema initialized');
  } catch (e) {
    logger.warn('autods', `AutoDS schema init failed: ${e.message}`);
  }
}

// ---- REGISTER PRODUCT (called after Shopify sync) ----
function registerProduct({ source, sourceId, sourceUrl, shopifyProductId, shopifyVariantId, shopifyHandle }) {
  const db = getDb();
  if (!db) return null;

  const buyId = buildSourceUrl(source, sourceId, sourceUrl);
  const supplierName = AUTODS_SUPPLIER_MAP[source.toLowerCase()] || source;

  try {
    const stmt = db.prepare(`
      INSERT INTO autods_products (
        source_store, source_product_id, source_url, shopify_product_id,
        shopify_variant_id, shopify_handle, buy_id, supplier_name,
        autods_status, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', datetime('now'))
      ON CONFLICT(source_store, source_product_id) DO UPDATE SET
        source_url = excluded.source_url,
        shopify_product_id = excluded.shopify_product_id,
        shopify_variant_id = excluded.shopify_variant_id,
        shopify_handle = excluded.shopify_handle,
        buy_id = excluded.buy_id,
        supplier_name = excluded.supplier_name,
        updated_at = datetime('now')
    `);
    const result = stmt.run(source, String(sourceId), buyId, shopifyProductId, shopifyVariantId, shopifyHandle, buyId, supplierName);
    logger.info('autods', 'Product registered for AutoDS', { source, sourceId, shopifyProductId, buyId });

    // If AutoDS API is enabled, try to register via API
    if (AUTODS_ENABLED() && AUTODS_API_KEY()) {
      registerProductViaAPI({ source, sourceId, buyId, supplierName, shopifyProductId })
        .catch(e => logger.warn('autods', `API registration failed (non-blocking): ${e.message}`));
    }

    return result;
  } catch (e) {
    logger.error('autods', 'Product registration failed', { error: e.message, source, sourceId });
    return null;
  }
}

// ---- FUTURE: AUTODS API REGISTRATION ----
async function registerProductViaAPI({ source, sourceId, buyId, supplierName, shopifyProductId }) {
  // This will be implemented when AutoDS API access is activated ($5k fee)
  // For now, it's a stub that logs the attempt
  const apiKey = AUTODS_API_KEY();
  const storeId = AUTODS_STORE_ID();

  if (!apiKey || !storeId) {
    logger.debug('autods', 'API not configured — skipping API registration');
    return null;
  }

  try {
    const fetch = require('node-fetch');
    const response = await fetch(`${AUTODS_API_URL()}/products/import`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'X-Store-Id': storeId
      },
      body: JSON.stringify({
        supplier: supplierName,
        product_url: buyId,
        source_id: sourceId,
        import_to_store: true
      })
    });

    if (response.ok) {
      const data = await response.json();
      // Update local record with AutoDS product ID
      const db = getDb();
      if (db && data.product_id) {
        db.prepare(`
          UPDATE autods_products SET autods_product_id = ?, autods_status = 'linked', autods_linked_at = datetime('now')
          WHERE source_store = ? AND source_product_id = ?
        `).run(data.product_id, source, String(sourceId));
      }
      logger.info('autods', 'Product registered via AutoDS API', { autodsProductId: data.product_id });
      return data;
    } else {
      const errText = await response.text();
      throw new Error(`AutoDS API ${response.status}: ${errText.substring(0, 200)}`);
    }
  } catch (e) {
    logger.error('autods', 'AutoDS API call failed', { error: e.message });
    throw e;
  }
}

// ---- PROCESS SHOPIFY ORDER WEBHOOK ----
async function processOrderWebhook(orderData) {
  const db = getDb();
  if (!db) {
    logger.error('autods', 'Cannot process order webhook — DB not available');
    return null;
  }

  const {
    id: shopifyOrderId,
    order_number: orderNumber,
    name: orderName,
    email,
    total_price: totalPrice,
    currency,
    financial_status: financialStatus,
    fulfillment_status: fulfillmentStatus,
    line_items: lineItems,
    shipping_address: shippingAddress,
    customer
  } = orderData;

  logger.info('autods', 'Processing order webhook', { orderId: shopifyOrderId, orderName, items: lineItems?.length });

  try {
    // 1. Create/update order record
    const customerName = customer
      ? `${customer.first_name || ''} ${customer.last_name || ''}`.trim()
      : '';

    const orderStmt = db.prepare(`
      INSERT INTO autods_orders (
        shopify_order_id, shopify_order_number, shopify_order_name,
        customer_email, customer_name, total_price, currency,
        financial_status, fulfillment_status, items_json,
        shipping_address_json, autods_status, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'processing', datetime('now'))
      ON CONFLICT(shopify_order_id) DO UPDATE SET
        financial_status = excluded.financial_status,
        fulfillment_status = excluded.fulfillment_status,
        updated_at = datetime('now')
    `);

    // ── WRAP ALL DB OPERATIONS IN A TRANSACTION ──
    const itemResults = [];
    let autodsOrderId = null;
    let finalStatus = 'no_mapping';

    const runTransaction = db.transaction(() => {
      orderStmt.run(
        shopifyOrderId,
        String(orderNumber || ''),
        orderName || '',
        email || '',
        customerName,
        parseFloat(totalPrice) || 0,
        currency || 'USD',
        financialStatus || '',
        fulfillmentStatus || '',
        JSON.stringify(lineItems || []),
        JSON.stringify(shippingAddress || {}),
      );

      // 2. Get the autods_order record
      const autodsOrder = db.prepare('SELECT id FROM autods_orders WHERE shopify_order_id = ?').get(shopifyOrderId);
      if (!autodsOrder) throw new Error('Failed to create autods_order record');
      autodsOrderId = autodsOrder.id;

      // 3. Process each line item — extract source info
      for (const item of (lineItems || [])) {
        const sourceInfo = extractSourceInfo(item, db);

        if (sourceInfo) {
          const itemStmt = db.prepare(`
            INSERT OR REPLACE INTO autods_order_items (
              autods_order_id, shopify_line_item_id, shopify_product_id,
              shopify_variant_id, source_store, source_product_id, source_url,
              buy_id, quantity, price, variant_title, autods_item_status, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', datetime('now'))
          `);

          itemStmt.run(
            autodsOrder.id,
            item.id,
            item.product_id,
            item.variant_id,
            sourceInfo.source,
            sourceInfo.sourceId,
            sourceInfo.sourceUrl,
            sourceInfo.buyId,
            item.quantity || 1,
            parseFloat(item.price) || 0,
            item.variant_title || '',
          );

          itemResults.push({
            lineItemId: item.id,
            source: sourceInfo.source,
            sourceId: sourceInfo.sourceId,
            buyId: sourceInfo.buyId,
            status: 'ready'
          });

          // ── AUTO-REGISTER product in autods_products if missing ──
          try {
            registerProduct({
              source: sourceInfo.source,
              sourceId: sourceInfo.sourceId,
              sourceUrl: sourceInfo.sourceUrl || '',
              shopifyProductId: item.product_id,
              shopifyVariantId: item.variant_id,
              shopifyHandle: ''
            });
            logger.info('autods', `Auto-registered product from order: ${sourceInfo.source}/${sourceInfo.sourceId}`);
          } catch (regErr) {
            logger.debug('autods', `Product registration from order failed (non-blocking): ${regErr.message}`);
          }

          // Also create order_routing entry for the operations layer
          const { createOrderRouting } = require('../utils/db');
          createOrderRouting({
            shopify_order_id: shopifyOrderId,
            shopify_order_number: orderName || String(orderNumber),
            source_store: sourceInfo.source,
            source_product_id: sourceInfo.sourceId,
            source_variant_id: sourceInfo.sourceVariantId || null,
            status: 'pending',
            notes: `AutoDS Buy ID: ${sourceInfo.buyId}`
          });
        } else {
          itemResults.push({
            lineItemId: item.id,
            productId: item.product_id,
            status: 'no_source_mapping',
            title: item.title
          });
          logger.warn('autods', 'No source mapping found for line item', {
            lineItemId: item.id, productId: item.product_id, title: item.title
          });
        }
      }

      // 4. Determine overall order status
      const allReady = itemResults.every(r => r.status === 'ready');
      const someReady = itemResults.some(r => r.status === 'ready');
      finalStatus = allReady ? 'ready' : someReady ? 'partial' : 'no_mapping';

      db.prepare('UPDATE autods_orders SET autods_status = ?, processed_at = datetime(\'now\'), updated_at = datetime(\'now\') WHERE id = ?')
        .run(finalStatus, autodsOrder.id);
    });

    // Execute the transaction
    runTransaction();

    logger.info('autods', 'Order processed', {
      orderId: shopifyOrderId,
      orderName,
      status: finalStatus,
      items: itemResults.length,
      readyItems: itemResults.filter(r => r.status === 'ready').length
    });

    return {
      orderId: shopifyOrderId,
      orderName,
      status: finalStatus,
      items: itemResults
    };
  } catch (e) {
    logger.error('autods', 'Order webhook processing failed', { error: e.message, orderId: shopifyOrderId });

    // Record error
    try {
      db.prepare('UPDATE autods_orders SET autods_status = \'error\', error_message = ?, updated_at = datetime(\'now\') WHERE shopify_order_id = ?')
        .run(e.message, shopifyOrderId);
    } catch (_) {}

    throw e;
  }
}

// ---- EXTRACT SOURCE INFO FROM LINE ITEM ----
function extractSourceInfo(lineItem, db) {
  // Guard: validate input
  if (!lineItem || typeof lineItem !== 'object') {
    logger.warn('autods', 'extractSourceInfo called with invalid lineItem');
    return null;
  }

  // Strategy 1: Line item properties (set during add-to-cart)
  const props = {};
  if (Array.isArray(lineItem.properties)) {
    for (const prop of lineItem.properties) {
      if (prop && prop.name != null) {
        props[prop.name] = prop.value;
      }
    }
  }

  // Common extras available on every Shopify line item — passed through on
  // every return path so downstream (CSV, HTML, DB) has variant context.
  const variantTitle = lineItem.variant_title && lineItem.variant_title !== 'Default Title'
    ? lineItem.variant_title
    : null;
  const shopifySku = lineItem.sku || null;
  const shopifyVariantId = lineItem.variant_id || null;

  if (props._source_store && props._source_id) {
    const source = String(props._source_store).trim();
    const sourceId = String(props._source_id).trim();
    if (!source || !sourceId) return null; // Empty after trim = invalid

    // Variant resolution — try properties first, then fall back to SKU parsing.
    // Why the fallback: some prepare-cart flows (notably older Amazon sync)
    // set _source_store and _source_id but forget _source_variant_id. The
    // Shopify SKU is the authoritative fallback because it's generated at
    // sync time as DH-{SOURCE}-{productId}-{variantId} and survives even
    // when properties drift. Without this, we'd end up with sourceVariantId:
    // null → CSV URL lacks the variant param → AutoDS imports wrong variant.
    let sourceVariantId = props._source_variant_id
      ? String(props._source_variant_id).trim() || null
      : null;

    if (!sourceVariantId && shopifySku) {
      const skuMatch = shopifySku.match(/^DH-(\w+)-([^-]+)(?:-(.+))?$/);
      if (skuMatch && skuMatch[1].toLowerCase() === source.toLowerCase() && skuMatch[3]) {
        sourceVariantId = skuMatch[3];
      }
    }

    const sourceUrl = buildSourceUrl(source, sourceId, null, sourceVariantId);
    return {
      source,
      sourceId,
      sourceVariantId,
      sourceUrl,
      buyId: sourceUrl,
      variantTitle,
      shopifySku,
      shopifyVariantId,
      method: sourceVariantId && !props._source_variant_id
        ? 'line_item_properties+sku_fallback'
        : 'line_item_properties'
    };
  }

  // Strategy 2: SKU parsing
  // Formats supported:
  //   Legacy:  DH-AMAZON-B0D9F5K3X1            (productId only)
  //   Current: DH-ALIEXPRESS-{productId}-{variantId}
  // The productId segment never contains a dash across current sources
  // (ASINs, numeric IDs, Sephora P-codes). The variantId segment may contain
  // dashes in future sources, so we capture everything after the 3rd hyphen.
  if (lineItem.sku) {
    const skuMatch = lineItem.sku.match(/^DH-(\w+)-([^-]+)(?:-(.+))?$/);
    if (skuMatch) {
      const source = skuMatch[1].toLowerCase();
      const sourceId = skuMatch[2];
      const sourceVariantId = skuMatch[3] || null;
      const sourceUrl = buildSourceUrl(source, sourceId, null, sourceVariantId);
      return {
        source,
        sourceId,
        sourceVariantId,
        sourceUrl,
        buyId: sourceUrl,
        variantTitle,
        shopifySku,
        shopifyVariantId,
        method: 'sku_parse'
      };
    }
  }

  // Strategy 3: DB mapping via shopify_product_id
  if (lineItem.product_id && db) {
    try {
      const mapping = db.prepare(
        'SELECT * FROM product_mappings WHERE shopify_product_id = ?'
      ).get(lineItem.product_id);

      if (mapping) {
        const sourceUrl = buildSourceUrl(
          mapping.source_store,
          mapping.source_product_id,
          null,
          mapping.source_variant_id
        );
        return {
          source: mapping.source_store,
          sourceId: mapping.source_product_id,
          sourceVariantId: mapping.source_variant_id,
          sourceUrl,
          buyId: sourceUrl,
          variantTitle,
          shopifySku,
          shopifyVariantId,
          method: 'db_mapping'
        };
      }
    } catch (e) {
      logger.debug('autods', `DB mapping lookup failed: ${e.message}`);
    }
  }

  // Strategy 4: AutoDS products table
  if (lineItem.product_id && db) {
    try {
      const autodsProduct = db.prepare(
        'SELECT * FROM autods_products WHERE shopify_product_id = ?'
      ).get(lineItem.product_id);

      if (autodsProduct) {
        return {
          source: autodsProduct.source_store,
          sourceId: autodsProduct.source_product_id,
          sourceVariantId: null,
          sourceUrl: autodsProduct.source_url || autodsProduct.buy_id,
          buyId: autodsProduct.buy_id,
          variantTitle,
          shopifySku,
          shopifyVariantId,
          method: 'autods_products'
        };
      }
    } catch (e) {
      logger.debug('autods', `AutoDS product lookup failed: ${e.message}`);
    }
  }

  return null;
}

// ---- GENERATE CSV FOR AUTODS BULK IMPORT ----
function generateAutodsCSV(filters = {}) {
  const db = getDb();
  if (!db) return { csv: '', count: 0 };

  try {
    let query = 'SELECT * FROM autods_products';
    const conditions = [];
    const params = [];

    if (filters.status) {
      conditions.push('autods_status = ?');
      params.push(filters.status);
    }
    if (filters.source) {
      conditions.push('source_store = ?');
      params.push(filters.source);
    }

    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }
    query += ' ORDER BY created_at DESC';

    if (filters.limit) {
      query += ' LIMIT ?';
      params.push(filters.limit);
    }

    const products = db.prepare(query).all(...params);

    if (products.length === 0) return { csv: '', count: 0 };

    // AutoDS CSV format for bulk import
    // Columns: Product URL, Supplier, Warehouse Region
    const header = 'Product URL,Supplier,Warehouse Region';
    const rows = products.map(p => {
      const url = p.buy_id || p.source_url || buildSourceUrl(p.source_store, p.source_product_id);
      const supplier = p.supplier_name || AUTODS_SUPPLIER_MAP[p.source_store] || p.source_store;
      const region = p.warehouse_region || 'US';
      return `"${url}","${supplier}","${region}"`;
    });

    return {
      csv: [header, ...rows].join('\n'),
      count: products.length,
      products: products.map(p => ({
        source: p.source_store,
        sourceId: p.source_product_id,
        buyId: p.buy_id,
        supplier: p.supplier_name,
        shopifyProductId: p.shopify_product_id,
        status: p.autods_status
      }))
    };
  } catch (e) {
    logger.error('autods', 'CSV generation failed', { error: e.message });
    return { csv: '', count: 0, error: e.message };
  }
}

// ---- GENERATE AUTODS VARIANT MAPPING CSV ----
// For linking existing Shopify products to suppliers in AutoDS
function generateVariantMappingCSV(filters = {}) {
  const db = getDb();
  if (!db) return { csv: '', count: 0 };

  try {
    let query = `
      SELECT ap.*, pm.shopify_handle, pm.last_price
      FROM autods_products ap
      LEFT JOIN product_mappings pm ON ap.source_store = pm.source_store
        AND ap.source_product_id = pm.source_product_id
    `;
    const conditions = [];
    const params = [];

    if (filters.unlinkedOnly) {
      conditions.push("ap.autods_status = 'pending'");
    }
    if (filters.source) {
      conditions.push('ap.source_store = ?');
      params.push(filters.source);
    }

    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }
    query += ' ORDER BY ap.created_at DESC LIMIT 500';

    const products = db.prepare(query).all(...params);

    // Extended CSV: Shopify Handle, Source URL, Supplier, Source ID, Status
    const header = 'Shopify Handle,Shopify Product ID,Source URL,Supplier,Source ID,Region,AutoDS Status';
    const rows = products.map(p => {
      const url = p.buy_id || p.source_url || '';
      const supplier = p.supplier_name || '';
      return `"${p.shopify_handle || ''}",${p.shopify_product_id || ''},"${url}","${supplier}","${p.source_product_id}","${p.warehouse_region || 'US'}","${p.autods_status}"`;
    });

    return {
      csv: [header, ...rows].join('\n'),
      count: products.length
    };
  } catch (e) {
    logger.error('autods', 'Variant mapping CSV failed', { error: e.message });
    return { csv: '', count: 0, error: e.message };
  }
}

// ---- MARK PRODUCT AS LINKED IN AUTODS ----
function markProductLinked(source, sourceId, autodsProductId = null) {
  const db = getDb();
  if (!db) return false;

  try {
    db.prepare(`
      UPDATE autods_products
      SET autods_status = 'linked', autods_product_id = ?, autods_linked_at = datetime('now'), updated_at = datetime('now')
      WHERE source_store = ? AND source_product_id = ?
    `).run(autodsProductId, source, String(sourceId));
    logger.info('autods', 'Product marked as linked', { source, sourceId, autodsProductId });
    return true;
  } catch (e) {
    logger.error('autods', 'markProductLinked failed', { error: e.message });
    return false;
  }
}

// ---- BULK MARK PRODUCTS AS LINKED ----
function bulkMarkLinked(ids) {
  const db = getDb();
  if (!db) return 0;

  try {
    const stmt = db.prepare(`
      UPDATE autods_products
      SET autods_status = 'linked', autods_linked_at = datetime('now'), updated_at = datetime('now')
      WHERE id = ?
    `);
    let count = 0;
    for (const id of ids) {
      const result = stmt.run(id);
      if (result.changes > 0) count++;
    }
    logger.info('autods', `Bulk marked ${count} products as linked`);
    return count;
  } catch (e) {
    logger.error('autods', 'bulkMarkLinked failed', { error: e.message });
    return 0;
  }
}

// ---- GET AUTODS DASHBOARD STATS ----
function getAutodsStats() {
  const db = getDb();
  if (!db) return {};

  try {
    const productsByStatus = db.prepare(`
      SELECT autods_status, COUNT(*) as count
      FROM autods_products
      GROUP BY autods_status
    `).all();

    const productsBySource = db.prepare(`
      SELECT source_store, autods_status, COUNT(*) as count
      FROM autods_products
      GROUP BY source_store, autods_status
    `).all();

    const ordersByStatus = db.prepare(`
      SELECT autods_status, COUNT(*) as count
      FROM autods_orders
      GROUP BY autods_status
    `).all();

    const recentOrders = db.prepare(`
      SELECT shopify_order_id, shopify_order_name, customer_email,
             total_price, autods_status, created_at
      FROM autods_orders
      ORDER BY created_at DESC
      LIMIT 20
    `).all();

    const pendingProducts = db.prepare(`
      SELECT id, source_store, source_product_id, buy_id, supplier_name,
             shopify_product_id, shopify_handle, created_at
      FROM autods_products
      WHERE autods_status = 'pending'
      ORDER BY created_at DESC
      LIMIT 50
    `).all();

    const totalProducts = db.prepare('SELECT COUNT(*) as c FROM autods_products').get().c;
    const linkedProducts = db.prepare("SELECT COUNT(*) as c FROM autods_products WHERE autods_status = 'linked'").get().c;
    const totalOrders = db.prepare('SELECT COUNT(*) as c FROM autods_orders').get().c;
    const readyOrders = db.prepare("SELECT COUNT(*) as c FROM autods_orders WHERE autods_status = 'ready'").get().c;

    return {
      summary: {
        totalProducts,
        linkedProducts,
        pendingProducts: totalProducts - linkedProducts,
        linkRate: totalProducts > 0 ? ((linkedProducts / totalProducts) * 100).toFixed(1) + '%' : '0%',
        totalOrders,
        readyOrders,
        apiEnabled: AUTODS_ENABLED()
      },
      productsByStatus,
      productsBySource,
      ordersByStatus,
      recentOrders,
      pendingProducts,
      timestamp: new Date().toISOString()
    };
  } catch (e) {
    logger.error('autods', 'getAutodsStats failed', { error: e.message });
    return { error: e.message };
  }
}

// ---- GET ORDERS WITH ITEMS ----
function getAutodsOrders(limit = 50, status = null) {
  const db = getDb();
  if (!db) return [];

  try {
    let query = 'SELECT * FROM autods_orders';
    const params = [];
    if (status) {
      query += ' WHERE autods_status = ?';
      params.push(status);
    }
    query += ' ORDER BY created_at DESC LIMIT ?';
    params.push(limit);

    const orders = db.prepare(query).all(...params);

    // Attach items to each order
    const itemStmt = db.prepare('SELECT * FROM autods_order_items WHERE autods_order_id = ?');
    return orders.map(order => ({
      ...order,
      items: itemStmt.all(order.id)
    }));
  } catch (e) {
    logger.error('autods', 'getAutodsOrders failed', { error: e.message });
    return [];
  }
}

// ---- GET PENDING (UNLINKED) PRODUCTS ----
function getPendingProducts(limit = 100, source = null) {
  const db = getDb();
  if (!db) return [];

  try {
    let query = "SELECT * FROM autods_products WHERE autods_status = 'pending'";
    const params = [];
    if (source) {
      query += ' AND source_store = ?';
      params.push(source);
    }
    query += ' ORDER BY created_at DESC LIMIT ?';
    params.push(limit);

    return db.prepare(query).all(...params);
  } catch (e) {
    logger.error('autods', 'getPendingProducts failed', { error: e.message });
    return [];
  }
}

// ---- VERIFY WEBHOOK HMAC (Shopify webhook authentication) ----
const crypto = require('crypto');
function verifyShopifyWebhook(rawBody, hmacHeader) {
  const secret = process.env.SHOPIFY_WEBHOOK_SECRET;
  if (!secret) {
    logger.warn('autods', 'SHOPIFY_WEBHOOK_SECRET not set — skipping verification');
    return true; // Allow in dev, but log warning
  }
  const hash = crypto.createHmac('sha256', secret).update(rawBody, 'utf8').digest('base64');
  return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(hmacHeader));
}

module.exports = {
  initAutodsSchema,
  registerProduct,
  processOrderWebhook,
  generateAutodsCSV,
  generateVariantMappingCSV,
  markProductLinked,
  bulkMarkLinked,
  getAutodsStats,
  getAutodsOrders,
  getPendingProducts,
  verifyShopifyWebhook,
  buildSourceUrl,
  extractSourceInfo,
  SOURCE_URL_BUILDERS,
  AUTODS_SUPPLIER_MAP
};
