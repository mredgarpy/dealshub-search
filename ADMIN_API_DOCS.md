# DealsHub Admin Operations API Documentation

## Overview

The Admin Operations API provides comprehensive backend management for the DealsHub hybrid commerce platform. It handles pricing rules, shipping rules, order routing, sync management, and operational analytics.

**Base URL:** `/admin/api`

---

## Authentication Note

These endpoints should be protected by authentication middleware (not yet implemented in Phase 1). Add JWT/API key validation before deploying to production.

---

## Database Schema

### Tables Created

#### `order_routing`
Tracks Shopify orders mapped to their source suppliers and fulfillment status.

```sql
CREATE TABLE order_routing (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shopify_order_id INTEGER,
  shopify_order_number TEXT,
  source_store TEXT,
  source_product_id TEXT,
  source_variant_id TEXT,
  status TEXT DEFAULT 'pending',
  supplier_order_id TEXT,
  supplier_tracking TEXT,
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
```

#### `source_failures`
Logs operational failures and errors from external sources.

```sql
CREATE TABLE source_failures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_store TEXT,
  endpoint TEXT,
  error_type TEXT,
  error_message TEXT,
  resolved INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);
```

### Existing Tables Enhanced

#### `pricing_rules`
Already created. Stores markup percentages and margin rules per source.

**Default Seeded Rules:**
- Amazon: 12% markup, 8% min margin
- AliExpress: 25% markup, 15% min margin
- Sephora: 10% markup, 5% min margin
- Macy's: 10% markup, 5% min margin
- SHEIN: 30% markup, 18% min margin

#### `shipping_rules`
Already created. Stores shipping costs, delivery times, and labels per source.

**Default Seeded Rules:**
- Amazon Standard: $0, 2-5 days
- Amazon Prime: $0, 1-2 days
- AliExpress Standard: $2.50, 15-30 days
- Sephora Standard: $5, 3-7 days
- Macy's Standard: $5, 5-7 days
- SHEIN Standard: $3, 10-20 days

---

## API Endpoints

### PRICING RULES

#### GET `/pricing-rules`
Retrieve all pricing rules.

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "source_store": "amazon",
      "category": null,
      "brand": null,
      "markup_pct": 12,
      "min_margin_pct": 8,
      "round_to": 0.99,
      "price_floor": null,
      "is_active": 1,
      "created_at": "2026-03-15T10:00:00",
      "updated_at": "2026-03-15T10:00:00"
    }
  ],
  "count": 5
}
```

#### POST `/pricing-rules`
Create or update a pricing rule.

**Request Body:**
```json
{
  "id": null,
  "source_store": "amazon",
  "category": "electronics",
  "brand": null,
  "markup_pct": 15,
  "min_margin_pct": 10,
  "round_to": 0.99,
  "price_floor": 9.99,
  "is_active": true
}
```

**Response:**
```json
{
  "success": true,
  "message": "Pricing rule created",
  "id": 6
}
```

#### DELETE `/pricing-rules/:id`
Delete a pricing rule.

**Response:**
```json
{
  "success": true,
  "message": "Pricing rule deleted"
}
```

---

### SHIPPING RULES

#### GET `/shipping-rules`
Retrieve all shipping rules.

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "source_store": "amazon",
      "region": "domestic",
      "method": "standard",
      "cost": 0,
      "min_days": 2,
      "max_days": 5,
      "label": "Standard",
      "is_active": 1,
      "created_at": "2026-03-15T10:00:00"
    }
  ],
  "count": 6
}
```

#### POST `/shipping-rules`
Create or update a shipping rule.

**Request Body:**
```json
{
  "id": null,
  "source_store": "aliexpress",
  "region": "domestic",
  "method": "express",
  "cost": 5.99,
  "min_days": 7,
  "max_days": 14,
  "label": "Express Shipping",
  "is_active": true
}
```

**Response:**
```json
{
  "success": true,
  "message": "Shipping rule created",
  "id": 7
}
```

#### DELETE `/shipping-rules/:id`
Delete a shipping rule.

**Response:**
```json
{
  "success": true,
  "message": "Shipping rule deleted"
}
```

---

### ORDER ROUTING

#### GET `/orders`
List order routing entries with optional filtering.

**Query Parameters:**
- `status`: Filter by status (pending, shipped, delivered, failed)
- `limit`: Number of results (default: 50, max: 200)
- `page`: Page number (default: 1)

**Example:**
```
GET /orders?status=pending&limit=20&page=1
```

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "shopify_order_id": 123456,
      "shopify_order_number": "#1001",
      "source_store": "amazon",
      "source_product_id": "B0973L1NVT",
      "source_variant_id": null,
      "status": "pending",
      "supplier_order_id": null,
      "supplier_tracking": null,
      "notes": "Awaiting supplier confirmation",
      "created_at": "2026-03-15T10:30:00",
      "updated_at": "2026-03-15T10:30:00"
    }
  ],
  "count": 1,
  "page": 1,
  "limit": 50
}
```

#### POST `/orders`
Create a new order routing entry.

**Request Body:**
```json
{
  "shopify_order_id": 123456,
  "shopify_order_number": "#1001",
  "source_store": "amazon",
  "source_product_id": "B0973L1NVT",
  "source_variant_id": null,
  "status": "pending",
  "supplier_order_id": null,
  "supplier_tracking": null,
  "notes": "Manual entry"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Order routing created",
  "id": 1
}
```

#### PUT `/orders/:id`
Update an order routing entry.

**Request Body:**
```json
{
  "status": "shipped",
  "supplier_order_id": "SUP-001234",
  "supplier_tracking": "TRK-9876543210",
  "notes": "Shipped via Amazon Logistics"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Order routing updated"
}
```

---

### SOURCE FAILURES

#### GET `/failures`
List source failures.

**Query Parameters:**
- `resolved`: Filter by status (true/false, default: false)
- `limit`: Number of results (default: 50, max: 200)
- `page`: Page number (default: 1)

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "source_store": "amazon",
      "endpoint": "/search",
      "error_type": "RATE_LIMIT",
      "error_message": "429 Too Many Requests",
      "resolved": 0,
      "created_at": "2026-03-15T10:15:00"
    }
  ],
  "count": 1,
  "resolved": false,
  "page": 1,
  "limit": 50
}
```

#### POST `/failures/:id/resolve`
Mark a failure as resolved.

**Response:**
```json
{
  "success": true,
  "message": "Failure marked as resolved"
}
```

---

### SYNC MANAGEMENT

#### POST `/sync/resync/:source/:sourceId`
Manually trigger a resync of a product from source to Shopify.

**Path Parameters:**
- `source`: amazon, aliexpress, sephora, macys, or shein
- `sourceId`: The source product ID (e.g., B0973L1NVT)

**Example:**
```
POST /sync/resync/amazon/B0973L1NVT
```

**Response:**
```json
{
  "success": true,
  "message": "Product resynced successfully",
  "shopifyProductId": 7654321,
  "shopifyVariantId": 8765432,
  "handle": "amazon-b0973l1nvt"
}
```

**Error Response (if source product not found):**
```json
{
  "success": false,
  "error": "Product not found in source"
}
```

#### DELETE `/mappings/:id`
Delete a product mapping (breaks link between source and Shopify).

**Response:**
```json
{
  "success": true,
  "message": "Mapping deleted"
}
```

---

### DASHBOARD & STATS

#### GET `/dashboard`
Get comprehensive statistics for the admin dashboard.

**Response:**
```json
{
  "success": true,
  "data": {
    "mappingCount": 42,
    "syncLogCount": 156,
    "orderCount": 18,
    "failureCount": 2,
    "recentSyncs": [
      {
        "source_store": "amazon",
        "action": "create",
        "status": "success",
        "count": 8
      },
      {
        "source_store": "aliexpress",
        "action": "update",
        "status": "success",
        "count": 5
      }
    ],
    "mappingsBySource": [
      {
        "source_store": "amazon",
        "count": 15
      },
      {
        "source_store": "aliexpress",
        "count": 12
      }
    ],
    "ordersBySource": [
      {
        "source_store": "amazon",
        "status": "pending",
        "count": 8
      },
      {
        "source_store": "amazon",
        "status": "shipped",
        "count": 6
      }
    ],
    "timestamp": "2026-03-15T10:45:00Z"
  }
}
```

#### GET `/logs`
Retrieve recent sync logs.

**Query Parameters:**
- `limit`: Number of logs (default: 100, max: 500)

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "id": 156,
      "source_store": "amazon",
      "source_product_id": "B0973L1NVT",
      "action": "update",
      "status": "success",
      "details": "{\"shopifyProductId\":7654321,\"priceChange\":false}",
      "created_at": "2026-03-15T10:30:00"
    }
  ],
  "count": 10
}
```

#### GET `/mappings`
List product mappings with pagination.

**Query Parameters:**
- `limit`: Results per page (default: 50, max: 200)
- `page`: Page number (default: 1)

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "id": 42,
      "source_store": "amazon",
      "source_product_id": "B0973L1NVT",
      "source_variant_id": null,
      "shopify_product_id": 7654321,
      "shopify_variant_id": 8765432,
      "shopify_handle": "amazon-b0973l1nvt",
      "last_price": 29.99,
      "last_original_price": 39.99,
      "sync_hash": "abc123def456",
      "sync_status": "synced",
      "created_at": "2026-03-15T08:00:00",
      "updated_at": "2026-03-15T10:15:00"
    }
  ],
  "count": 25,
  "total": 42,
  "page": 1,
  "limit": 50
}
```

---

## Usage Examples

### Example 1: Adjust Markup for a Category

```bash
# Update pricing rule for Amazon electronics
curl -X POST http://localhost:10000/admin/api/pricing-rules \
  -H "Content-Type: application/json" \
  -d '{
    "id": 1,
    "source_store": "amazon",
    "category": "electronics",
    "brand": null,
    "markup_pct": 18,
    "min_margin_pct": 12,
    "round_to": 0.99,
    "price_floor": 14.99,
    "is_active": true
  }'
```

### Example 2: Monitor Order Status

```bash
# Get pending orders from AliExpress
curl http://localhost:10000/admin/api/orders?source_store=aliexpress&status=pending&limit=20
```

### Example 3: Resync a Product

```bash
# Manually resync an Amazon product
curl -X POST http://localhost:10000/admin/api/sync/resync/amazon/B0973L1NVT
```

### Example 4: Check Dashboard Stats

```bash
# Get operational dashboard
curl http://localhost:10000/admin/api/dashboard
```

### Example 5: Create Shipping Rule

```bash
# Add express shipping option for AliExpress
curl -X POST http://localhost:10000/admin/api/shipping-rules \
  -H "Content-Type: application/json" \
  -d '{
    "source_store": "aliexpress",
    "region": "domestic",
    "method": "express",
    "cost": 8.99,
    "min_days": 5,
    "max_days": 10,
    "label": "Express Shipping",
    "is_active": true
  }'
```

---

## Database Functions (src/utils/db.js)

All new database operations are exposed as functions:

### Pricing Rules
- `getPricingRules()` - Get all pricing rules
- `getPricingRuleById(id)` - Get single rule
- `upsertPricingRule(data)` - Create or update rule
- `deletePricingRule(id)` - Delete rule

### Shipping Rules
- `getShippingRules()` - Get all shipping rules
- `getShippingRuleById(id)` - Get single rule
- `upsertShippingRule(data)` - Create or update rule
- `deleteShippingRule(id)` - Delete rule

### Order Routing
- `getOrderRouting(limit, status, offset)` - List orders with optional filtering
- `getOrderRoutingById(id)` - Get single order
- `createOrderRouting(data)` - Create order entry
- `updateOrderRouting(id, data)` - Update order entry

### Source Failures
- `logSourceFailure(source, endpoint, errorType, errorMessage)` - Log failure
- `getSourceFailures(limit, resolved, offset)` - List failures
- `getSourceFailureById(id)` - Get single failure
- `resolveSourceFailure(id)` - Mark as resolved

### Analytics
- `getAdvancedStats()` - Get comprehensive dashboard stats
- `getRecentSyncLogs(limit)` - Get recent sync logs
- `getAllMappings(limit, offset)` - Get product mappings
- `getMappingCount()` - Total mapping count

### Utilities
- `deleteMapping(id)` - Delete a mapping

---

## Integration Points

### With shopify-sync.js
The `POST /sync/resync/:source/:sourceId` endpoint calls `prepareCart()` to:
1. Fetch fresh product data from source
2. Create/update product in Shopify
3. Create/update variant with correct pricing
4. Return Shopify IDs for linking

### With pricing.js
Pricing rules are used by `calculateFinalPrice()` to determine final prices and margins.

### With shipping.js
Shipping rules provide cost and time estimates displayed to customers.

### With adapters
All adapters support the `getProduct(id)` method used in resync operations.

---

## Error Handling

All endpoints return standardized error responses:

```json
{
  "success": false,
  "error": "Descriptive error message"
}
```

**Status Codes:**
- `200` - Success
- `400` - Bad request (missing/invalid parameters)
- `404` - Resource not found
- `500` - Server error

---

## Logging

All operations are logged via the logger utility:
- INFO level: Successful operations
- WARN level: Warnings and skipped operations
- ERROR level: Failures and exceptions

Check logs for troubleshooting and audit trails.

---

## Future Enhancements

1. **Authentication:** Add JWT or API key validation
2. **Rate Limiting:** Per-source rate limits
3. **Bulk Operations:** Bulk update pricing/shipping rules
4. **Webhooks:** Real-time notifications for failures
5. **Export:** CSV/JSON export of stats and logs
6. **Alerts:** Email/Slack alerts for critical failures
7. **Scheduling:** Automatic resync schedules
8. **Audit Log:** User action tracking with timestamps

---

## Testing

### Local Testing
```bash
# Start server
npm start

# In another terminal, test endpoints
curl http://localhost:10000/admin/api/dashboard
curl http://localhost:10000/admin/api/pricing-rules
curl http://localhost:10000/admin/api/shipping-rules
curl http://localhost:10000/admin/api/orders
curl http://localhost:10000/admin/api/failures
```

### Seeded Data
On first run, the system automatically seeds:
- 5 default pricing rules (one per source)
- 6 default shipping rules (multiple per source)

Check the database for verification:
```bash
sqlite3 stylehub.db "SELECT * FROM pricing_rules;"
sqlite3 stylehub.db "SELECT * FROM shipping_rules;"
```

---

## Database Location

Default: `/tmp/stylehub.db`

Can be overridden with `DB_PATH` environment variable:
```bash
export DB_PATH=/custom/path
npm start
```

---

## Summary

The Admin Operations API provides a complete backend management system for:
- ✓ Pricing strategy control
- ✓ Shipping configuration
- ✓ Order fulfillment tracking
- ✓ Operational monitoring
- ✓ Product sync management
- ✓ Comprehensive analytics

All data is persisted in SQLite with proper indexing for performance.
