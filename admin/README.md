# DealsHub Admin Operations Panel

A comprehensive, production-ready single-page application (SPA) for managing the DealsHub / StyleHub Miami hybrid commerce operations platform.

## Overview

The admin panel is a full-featured dashboard providing complete visibility and control over:
- Product synchronization from multiple external sources
- Pricing rules and margin management
- Shipping configuration and rules
- Order routing and fulfillment
- Error monitoring and system health
- Real-time operational metrics

## Features

### 8 Core Modules

#### 1. Dashboard (📊)
**Real-time operational overview**
- Stats cards: Total Products Synced, Orders Today, Active Sources, Average Margin
- Source health indicators with response times and product counts
- Recent sync activity feed (last 10 actions)
- Failure alerts with unresolved count
- Auto-refresh every 30 seconds

#### 2. Product Sync Center (🔄)
**Manage product mappings between external sources and Shopify**
- View all source → Shopify product mappings
- Search and filter by source, product ID, or handle
- Resync individual products on demand
- Delete mappings
- Manual sync trigger for any source product
- Status badges showing sync state

#### 3. Costs & Margins (💰)
**Control pricing and profitability**
- View and manage pricing rules per source/category/brand
- Set markup percentages, minimum margins, price floors
- Define rounding rules ($0.01, $X.99, $1)
- Price simulator: input source price to see calculated final price
- Active/inactive rule toggle

#### 4. Shipping Rules (📦)
**Configure shipping options and costs**
- Rules per source, region, and shipping method
- Define costs, delivery windows (min/max days)
- Customizable labels (e.g., "Arrives in 3-7 days")
- Per-region shipping summary cards
- Active/inactive rule toggle

#### 5. Source Mapping (🗺️)
**Detailed product mapping visibility**
- Complete source → Shopify mapping table
- Direct links to both source URLs and Shopify product pages
- Mapping statistics with visual distribution by source
- Duplicate detection capabilities
- Mapping date tracking

#### 6. Order Routing (📮)
**Manage order fulfillment workflow**
- Track orders from placement through delivery
- Status indicators: pending, processing, shipped, delivered, issue
- Supplier order IDs and tracking numbers
- Internal notes for each order
- Create new routing entries
- Filter by status

#### 7. Error Monitor (📋)
**Track and resolve system failures**
- Sync logs: timestamp, source, product ID, action, status, details
- Source failures table: source, endpoint, error type, message
- Resolve failures individually
- Filter by source and status
- Limit: 50 most recent entries

#### 8. Settings (⚙️)
**System administration**
- Clear all caches
- Run source health checks
- System information: version, uptime, environment, API base
- Real-time status of all sources

## Architecture

### Design Principles
- **Single-file SPA**: All HTML, CSS, and JavaScript in one file for simplicity
- **No external frameworks**: Pure vanilla JavaScript for minimal dependencies
- **Responsive design**: Mobile-first, works on all screen sizes
- **Professional aesthetics**: Shopify Polaris-inspired design system
- **Production-ready**: Error handling, loading states, empty states

### Technology Stack
- **Frontend**: Vanilla JavaScript, HTML5, CSS3
- **Architecture**: Modular SPA with tab-based navigation
- **API Communication**: Fetch API with error handling
- **State Management**: Module-level state tracking
- **Styling**: CSS custom properties for theming

### Color Scheme
- **Primary**: #5C6AC4 (Shopify Purple)
- **Success**: #008060 (Green)
- **Danger**: #DE3618 (Red)
- **Warning**: #FFA500 (Orange)
- **Dark Background**: #1a1a2e (Sidebar)
- **Light Background**: #f5f5f7

## Usage

### Opening the Panel
1. Navigate to `/admin/index.html` or wherever deployed
2. The dashboard loads automatically
3. Sidebar navigation allows switching between modules

### Module Navigation
- Click any sidebar button to switch modules
- Active module is highlighted in blue
- Selected content updates dynamically

### Working with Data

#### Dashboard
- Automatically refreshes every 30 seconds
- Click "Run Health Check" in Settings to manually verify source status
- Failure alerts show count of unresolved errors

#### Product Sync
- Use search bar to find products
- Filter by source dropdown
- Click "Resync" to trigger immediate sync
- Click "Delete" to remove mapping
- Click "+ Manual Sync" to add a new source product

#### Pricing
- Click "+ Add Pricing Rule" to create rules
- Configure by source, category, or brand
- Use price simulator to preview calculations
- Rules marked "Active" apply; "Inactive" are stored but not used

#### Shipping
- Click "+ Add Shipping Rule" for new rules
- Define per source and region
- Supports multiple methods (Standard, Express, etc.)
- Label is customer-facing description

#### Order Routing
- Click "+ New Routing Entry" to track orders
- Update status as orders progress
- Add tracking numbers as they arrive
- Internal notes stay in admin panel only

#### Logs
- View all sync operations with status
- Filter by source and status
- Failed syncs show error details
- Click "Resolve" to mark failures as handled

#### Settings
- Use "Clear All Caches" to force data refresh
- "Run Health Check" pings all sources
- System info shows current deployment status

## API Integration

### Expected Endpoints

The panel makes fetch() calls to these endpoints:

```
GET  /api/admin/dashboard          → Dashboard stats and metrics
GET  /api/admin/mappings?limit=100 → Product mappings
GET  /api/admin/pricing-rules      → Pricing rule definitions
GET  /api/admin/shipping-rules     → Shipping rule definitions
GET  /api/admin/orders             → Order routing entries
GET  /api/admin/sync-logs?limit=50 → Sync operation logs
GET  /api/admin/failures?limit=50  → System failure records
GET  /api/admin/source-health      → Source status check
GET  /api/admin/stats              → System statistics

POST /api/admin/sync/resync/:source/:sourceId → Trigger manual sync
POST /api/admin/pricing-rules                 → Create/update rule
POST /api/admin/shipping-rules                → Create/update rule
POST /api/admin/orders                        → Create routing entry
POST /api/admin/cache/clear                   → Clear all caches
POST /api/admin/failures/:id/resolve          → Mark failure resolved

DELETE /api/admin/mappings/:id                → Remove mapping
DELETE /api/admin/pricing-rules/:id           → Delete pricing rule
DELETE /api/admin/shipping-rules/:id          → Delete shipping rule
```

### Response Formats

**Dashboard Response:**
```json
{
  "productsSynced": 1250,
  "productsSyncedToday": 42,
  "ordersToday": 15,
  "revenueTodayAmount": 1250.50,
  "activeSources": 5,
  "averageMargin": 28.5,
  "failureCount": 0,
  "sourceStatus": {
    "amazon": {
      "status": "online",
      "productsCount": 300,
      "responseTime": 120
    }
  },
  "recentActivity": [
    {
      "timestamp": "2026-03-15T14:30:00Z",
      "source": "amazon",
      "productId": "B0973L1NVT",
      "action": "sync",
      "status": "success"
    }
  ]
}
```

**Mappings Response:**
```json
{
  "mappings": [
    {
      "id": "map_123",
      "source": "amazon",
      "sourceId": "B0973L1NVT",
      "shopifyProductId": "gid://shopify/Product/123",
      "handle": "example-product",
      "price": 49.99,
      "status": "synced",
      "lastSync": "2026-03-15T12:00:00Z",
      "sourceUrl": "https://amazon.com/...",
      "shopifyUrl": "https://shop.myshopify.com/products/...",
      "mappedAt": "2026-03-10T10:00:00Z"
    }
  ]
}
```

## Customization

### Styling
Edit CSS variables in `<style>` tag:
```css
:root {
  --primary: #5C6AC4;           /* Main brand color */
  --primary-dark: #4A56A8;      /* Hover/active state */
  --accent: #008060;            /* Success/positive state */
  --danger: #DE3618;            /* Error/destructive state */
  --warning: #FFA500;           /* Warning state */
  --dark-bg: #1a1a2e;          /* Sidebar background */
  --light-bg: #f5f5f7;          /* Card/table backgrounds */
}
```

### Adding Modules
1. Add new sidebar button with `data-module="name"`
2. Create `<section class="content-section" id="name-section">`
3. Add async `loadName()` function
4. Add case in `loadModuleData(module)` switch statement

### API Base URL
Change `const API_BASE` at top of JavaScript:
```javascript
const API_BASE = 'https://dealshub-search.onrender.com/api/admin';
```

## Features in Detail

### Toast Notifications
- Success, error, and warning toasts appear top-right
- Auto-dismiss after 4 seconds
- Non-intrusive user feedback

### Modal Dialogs
- Click backdrop to close
- Click X button to close
- Keyboard escape not currently handled (can be added)

### Loading States
- Spinner animation during data fetch
- "Loading..." messages for transparency
- Graceful error handling with alert boxes

### Empty States
- Tables show "No data" messages when empty
- Clear guidance for user actions

### Responsive Behavior
- Sidebar becomes horizontal nav on mobile
- Stats cards stack to single column
- Table font reduces on smaller screens
- Modals adapt to viewport size

## Deployment Considerations

### File Size
- 1,956 lines of HTML
- ~80KB uncompressed
- ~15KB gzip compressed

### Browser Compatibility
- Modern browsers (Chrome, Firefox, Safari, Edge)
- ES6 JavaScript (const, arrow functions, template literals)
- CSS Grid and Flexbox
- Fetch API

### Security Notes
- No authentication built-in (should be added at server level)
- No CSRF protection (add server-side validation)
- Toast messages sanitize user input automatically

### Performance
- No external CDN dependencies
- Instant load time (single file)
- Minimal JavaScript overhead
- Auto-refresh dashboard every 30 seconds

## Common Tasks

### Sync a Product
1. Go to "Product Sync" module
2. Click "+ Manual Sync" button
3. Select source and enter product ID
4. Click "Sync Product"
5. Check dashboard for confirmation

### Create Pricing Rule
1. Go to "Costs & Margins"
2. Click "+ Add Pricing Rule"
3. Fill in source, markup %, minimum margin
4. Click "Save Rule"
5. Use price simulator to verify

### Check System Health
1. Go to "Settings"
2. Click "🏥 Run Health Check"
3. View real-time status of all sources
4. Green = Online, Red = Offline

### Clear Caches
1. Go to "Settings"
2. Click "🧹 Clear All Caches"
3. Confirm in dialog
4. Caches cleared immediately

## Troubleshooting

### "Failed to load data" error
- Check API base URL is correct
- Verify network connection
- Check browser console for CORS errors
- Ensure backend is running

### Data not updating
- Click module button to reload
- Manual refresh required (no polling for all modules)
- Dashboard auto-refreshes every 30 seconds

### Modals won't close
- Click anywhere outside modal (backdrop)
- Click X button in top-right

### API calls timing out
- Increase fetch timeout in JavaScript
- Check backend server response time
- Verify network connectivity

## Future Enhancements

Potential additions:
- User authentication and role-based access
- Export/import functionality (CSV, JSON)
- Real-time WebSocket updates instead of polling
- Advanced filtering and search
- Bulk operations (sync multiple products)
- Scheduled tasks UI
- Analytics dashboard with charts
- Email notifications for alerts
- Multi-language support
- Dark mode toggle

## File Structure

```
/admin/
├── index.html          # Complete admin panel (this file)
└── README.md           # Documentation
```

## Support

For issues or questions about the admin panel:
1. Check browser console for JavaScript errors
2. Verify API endpoints are responding
3. Ensure backend is deployed and running
4. Check network tab for failed requests

---

**Version**: 1.0.0
**Last Updated**: March 15, 2026
**Environment**: Production
**Status**: Ready for deployment
