# Admin API — Quick Reference Card

## Base URL
```
http://localhost:10000/admin/api
```

## Pricing Rules

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/pricing-rules` | List all pricing rules |
| POST | `/pricing-rules` | Create/update pricing rule |
| DELETE | `/pricing-rules/:id` | Delete pricing rule |

**POST/PUT Body:**
```json
{
  "id": null,
  "source_store": "amazon|aliexpress|sephora|macys|shein",
  "category": "electronics",
  "brand": null,
  "markup_pct": 12,
  "min_margin_pct": 8,
  "round_to": 0.99,
  "price_floor": 9.99,
  "is_active": true
}
```

---

## Shipping Rules

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/shipping-rules` | List all shipping rules |
| POST | `/shipping-rules` | Create/update shipping rule |
| DELETE | `/shipping-rules/:id` | Delete shipping rule |

**POST/PUT Body:**
```json
{
  "id": null,
  "source_store": "amazon|aliexpress|sephora|macys|shein",
  "region": "domestic",
  "method": "standard|express|prime",
  "cost": 0,
  "min_days": 2,
  "max_days": 5,
  "label": "Standard",
  "is_active": true
}
```

---

## Order Routing

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/orders?status=pending&limit=50&page=1` | List orders |
| POST | `/orders` | Create order routing |
| PUT | `/orders/:id` | Update order routing |

**POST Body:**
```json
{
  "shopify_order_id": 123456,
  "shopify_order_number": "#1001",
  "source_store": "amazon|aliexpress|...",
  "source_product_id": "PROD123",
  "source_variant_id": null,
  "status": "pending|shipped|delivered|failed",
  "supplier_order_id": null,
  "supplier_tracking": null,
  "notes": "Manual order"
}
```

**PUT Body (any fields):**
```json
{
  "status": "shipped",
  "supplier_order_id": "SUP-001",
  "supplier_tracking": "TRK-123",
  "notes": "Shipped today"
}
```

**Query Parameters:**
- `status`: Filter by status
- `limit`: Records per page (default 50, max 200)
- `page`: Page number (default 1)

---

## Source Failures

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/failures?resolved=false&limit=50&page=1` | List failures |
| POST | `/failures/:id/resolve` | Mark failure resolved |

**Query Parameters:**
- `resolved`: true/false (default false)
- `limit`: Records per page (default 50, max 200)
- `page`: Page number (default 1)

---

## Sync Management

| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | `/sync/resync/:source/:sourceId` | Manually resync product |
| DELETE | `/mappings/:id` | Delete product mapping |

**Example Resync:**
```
POST /sync/resync/amazon/B0973L1NVT
```

**Response:**
```json
{
  "success": true,
  "shopifyProductId": 7654321,
  "shopifyVariantId": 8765432,
  "handle": "amazon-b0973l1nvt"
}
```

---

## Dashboard & Analytics

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/dashboard` | Get all stats |
| GET | `/logs?limit=100` | Get sync logs |
| GET | `/mappings?limit=50&page=1` | Get product mappings |

**Dashboard Response Includes:**
- `mappingCount` - Total products synced
- `syncLogCount` - Total sync operations
- `orderCount` - Total orders routed
- `failureCount` - Unresolved failures
- `recentSyncs` - Activity by source (24h)
- `mappingsBySource` - Count by source
- `ordersBySource` - Orders by source & status

---

## Default Seeded Data

### Pricing Rules
```
amazon:     12% markup,  8% margin
aliexpress: 25% markup, 15% margin
sephora:    10% markup,  5% margin
macys:      10% markup,  5% margin
shein:      30% markup, 18% margin
```

### Shipping Rules
```
amazon standard:    $0,  2-5 days
amazon prime:       $0,  1-2 days
aliexpress:       $2.50, 15-30 days
sephora:           $5,  3-7 days
macys:             $5,  5-7 days
shein:             $3, 10-20 days
```

---

## Common cURL Examples

### Get all pricing rules
```bash
curl http://localhost:10000/admin/api/pricing-rules
```

### Update Amazon markup to 15%
```bash
curl -X POST http://localhost:10000/admin/api/pricing-rules \
  -H "Content-Type: application/json" \
  -d '{"id":1,"source_store":"amazon","markup_pct":15,"min_margin_pct":10,"is_active":true}'
```

### Get pending orders
```bash
curl "http://localhost:10000/admin/api/orders?status=pending"
```

### Update order status
```bash
curl -X PUT http://localhost:10000/admin/api/orders/1 \
  -H "Content-Type: application/json" \
  -d '{"status":"shipped","supplier_tracking":"TRK-123"}'
```

### Get dashboard stats
```bash
curl http://localhost:10000/admin/api/dashboard
```

### Resync product
```bash
curl -X POST http://localhost:10000/admin/api/sync/resync/amazon/B0973L1NVT
```

### Mark failure resolved
```bash
curl -X POST http://localhost:10000/admin/api/failures/1/resolve
```

---

## HTTP Status Codes

| Code | Meaning |
|------|---------|
| 200 | Success |
| 400 | Bad request (validation error) |
| 404 | Not found |
| 500 | Server error |

## Response Format

**Success:**
```json
{
  "success": true,
  "data": {...},
  "message": "Operation successful"
}
```

**Error:**
```json
{
  "success": false,
  "error": "Descriptive error message"
}
```

---

## Database Functions

**Import in code:**
```javascript
const {
  // Pricing
  getPricingRules,
  upsertPricingRule,
  deletePricingRule,

  // Shipping
  getShippingRules,
  upsertShippingRule,
  deleteShippingRule,

  // Orders
  getOrderRouting,
  createOrderRouting,
  updateOrderRouting,

  // Failures
  logSourceFailure,
  getSourceFailures,
  resolveSourceFailure,

  // Analytics
  getAdvancedStats,
  getRecentSyncLogs,
  getAllMappings
} = require('./src/utils/db');
```

---

## Environment Setup

```bash
# Database location
export DB_PATH=/tmp

# Shopify
export SHOPIFY_STORE_DOMAIN=1rnmax-5z.myshopify.com
export SHOPIFY_ACCESS_TOKEN=shpat_xxxxx...

# RapidAPI
export RAPIDAPI_KEY=xxxxx...

# Start server
npm start
```

---

## Files Modified/Created

**Created:**
- `/src/routes/admin.js` - Admin API router
- `/ADMIN_API_DOCS.md` - Full documentation
- `/ADMIN_SETUP_GUIDE.md` - Setup guide

**Modified:**
- `/src/utils/db.js` - Extended with 30+ functions
- `/server.js` - Admin router mounted

**No breaking changes** to existing functionality.

---

## Query Parameter Patterns

### Pagination
```
?limit=50&page=1
?limit=20&page=2
```

### Filtering
```
?status=pending
?resolved=false
?source=amazon
```

### Combinations
```
?status=pending&limit=20&page=1
?resolved=false&source=amazon&limit=50
```

---

## Database Location

Default: `/tmp/stylehub.db`

Custom:
```bash
export DB_PATH=/data/production
npm start
```

---

## Troubleshooting

### Endpoints return 404
- Check server is running on port 10000
- Verify admin router is mounted in server.js
- Use full URL: `http://localhost:10000/admin/api/...`

### Database connection fails
- Check DB_PATH environment variable
- Verify write permissions to directory
- Check for existing database file

### Seeded data missing
- Delete database file: `rm /tmp/stylehub.db`
- Restart server: `npm start`
- Check logs for seeding messages

### Query timeouts
- Increase limit parameter
- Use pagination (page parameter)
- Check database file size

---

## Next Steps

1. **Add Authentication** - JWT or API key validation
2. **Embedded Dashboard** - Shopify Admin integration
3. **Advanced Features** - Bulk operations, exports, alerts
4. **Monitoring** - Metrics, alerts, webhooks

---

## Support

See `/ADMIN_API_DOCS.md` for complete documentation
See `/ADMIN_SETUP_GUIDE.md` for setup and testing
