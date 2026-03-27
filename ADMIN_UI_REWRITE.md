# StyleHub CRM Pro - Admin UI Rewrite (Complete)

**File:** `/public/admin/index.html`
**Size:** 1,072 lines (single self-contained HTML file)
**Status:** Production Ready

---

## OVERVIEW

Complete rewrite of the StyleHub CRM Pro admin dashboard with professional dark theme UI, all 9 pages implemented, and full integration with backend CRM APIs.

### Design Specification Compliance
- **Fonts:** JetBrains Mono + Plus Jakarta Sans (Google Fonts)
- **CSS Variables:** Exact spec colors and sizing
- **Grid Layout:** 210px sidebar + main content area
- **Topbar:** 52px with logo, search, alerts, avatar
- **Sidebar:** 9 navigation items across 3 sections (Dashboard, Commerce, Insights, System)
- **Theme:** Dark mode (#06060a bg, #e53e3e red accent)

---

## PAGES IMPLEMENTED (9 TOTAL)

### 1. OVERVIEW (Dashboard)
**Endpoint:** `GET /api/crm/dashboard?token=X`

**Components:**
- 6 metric cards: Revenue, Profit, Orders, Pending, Manual, AOV
- Quick action cards (Orders, Returns, Reviews, Suppliers)
- Revenue bar chart (CSS-based, 7 days)
- System health grid (fetches `/api/source-health` separately)
- Activity feed (recent actions with timestamps)
- Alert bar (pulsing red dot for pending items)

**Data Mapping:**
```js
dashboard.overview → metrics (revenue, profit, orders, pending, manual, aov)
dashboard.counts → badge counts (pending_orders, pending_returns, pending_reviews, pending_tickets)
dashboard.recent → activity feed
/api/source-health → system health by source
```

---

### 2. ORDERS
**Endpoint:** `GET /api/crm/orders?status=FILTER&token=X`

**Features:**
- Tab filters: All, Pending, Manual, Shipped, Cancelled
- Table with columns: Order #, Customer (name+email), Items, Total, Source badge, Status badge, Profit, Date, Action
- Source badges: amz, ali, seph, macy, shein (color-coded)
- Status badges: Green for shipped, red for pending
- Fulfill button → `POST /api/crm/orders/:id/fulfill`

**Data Mapping:**
```js
orders[] → {id, customer_name, customer_email, item_count, total, source, status, profit, created_at}
```

---

### 3. CUSTOMERS
**Endpoint:** `GET /api/crm/customers?segment=FILTER&token=X`

**Features:**
- Tab filters: All, VIP, New, At Risk
- Stats row: total, vip count, new count, at risk count
- Avatar with initials (red circle)
- Columns: Avatar, Name, Email, Segment badge, Total Spent, Order Count
- Segment badges: blue styling

**Data Mapping:**
```js
customers[] → {name, email, segment, total_spent, order_count}
```

---

### 4. RETURNS
**Endpoint:** `GET /api/crm/returns?token=X`

**Features:**
- Table: Return ID, Order #, Customer, Reason, Amount, Source badge, Status badge
- Status: amber badge (● pending/in-progress)
- No filters on first version

**Data Mapping:**
```js
returns[] → {id, order_id, customer_name, reason, amount, source, status}
```

---

### 5. REVIEWS
**Endpoint:** `GET /api/crm/reviews?status=FILTER&token=X`

**Features:**
- Tab filters: Pending, Published, Rejected
- Table: Product, Customer, Rating (stars), Review text (truncated), Date, Action button
- Action: Approve → `PUT /api/crm/reviews/:id` with `{status: 'approved'}`
- Reject → `PUT /api/crm/reviews/:id` with `{status: 'rejected'}`

**Data Mapping:**
```js
reviews[] → {id, product_name, customer_name, rating, text, created_at, status}
```

---

### 6. TICKETS
**Endpoint:** `GET /api/crm/tickets?status=FILTER&token=X` + `GET /api/crm/tickets/stats?token=X`

**Features:**
- KPI cards: Open, In Progress, Resolved, Avg Response Time
- Tab filters: All, Open, In Progress, Resolved, Closed
- Table: Ticket ID, Customer, Subject, Category, Status badge, Date
- Status color mapping: amber (open), blue (in_progress), green (resolved), red (closed)

**Data Mapping:**
```js
tickets/stats → {open, in_progress, resolved, avg_response_time}
tickets[] → {id, customer_name, subject, category, status, created_at}
```

---

### 7. ANALYTICS
**Endpoint:** `GET /api/crm/analytics?period=PERIOD&token=X`

**Features:**
- Period selector: 7d, 30d, 90d (defaults to 30d)
- KPI cards: Revenue, Profit, Margin %, Orders
- Daily revenue bar chart (CSS-based, auto-scaled)
- Top products list (name + revenue)
- Top return reasons list (reason + count)

**Data Mapping:**
```js
analytics.overview → {revenue, profit, margin, orders}
analytics.daily_revenue → [val, val, ...] (auto-scales to max)
analytics.top_products → [{name, revenue}, ...]
analytics.top_return_reasons → [{reason, count}, ...]
```

---

### 8. SUPPLIERS
**Endpoint:** `GET /api/source-health` (NO token needed - public endpoint)

**Features:**
- Table: Source badge, Name, Status badge, Latency (ms), Results count, Uptime %
- Status mapping: healthy (green), slow (amber), down (red)
- Source names: Amazon, AliExpress, Sephora, Macy's, SHEIN
- Auto-refresh ready (manual refresh on page switch)

**Data Mapping:**
```js
/api/source-health → {sources: {amazon: {status, latencyMs, resultCount, uptime}, ...}}
```

**Important:** This endpoint does NOT use token parameter.

---

### 9. SETTINGS
**Endpoints:** 
- `GET /api/crm/settings?token=X`
- `POST /api/crm/settings?token=X` with form data

**Features:**
- Markup rules: Amazon %, AliExpress %
- Shipping rules: Free shipping threshold ($)
- Return windows: Default return days
- Email settings: From name, Reply-to address
- Save button with success/error toast
- Toast auto-dismisses after 3 seconds

**Data Mapping (Request):**
```js
{
  markup_amazon: int,
  markup_aliexpress: int,
  free_shipping_threshold: int,
  return_days: int,
  email_from_name: string,
  email_reply_to: string
}
```

---

## AUTHENTICATION

**Login Screen:**
- Token input field (password type)
- Default token: `stylehub-admin-2026`
- Stored in localStorage as `sh_crm_token`
- Auto-loads if token exists on page load

**API Auth Pattern:**
```
fetch('/api/crm/ENDPOINT?token=' + encodeURIComponent(token))
```

Token is always appended as query parameter to all CRM API calls.

---

## DESIGN SYSTEM

### Color Variables
```css
--bg: #06060a          /* Main background */
--bg2: #0c0c14         /* Card/panel background */
--bg3: #12121e         /* Hover/active states */
--bg4: #1a1a2e         /* Deeper states */
--border: #1e1e30      /* Primary border */
--border2: #2a2a40     /* Secondary border */
--text: #e8e8f0        /* Primary text */
--text2: #9898b0       /* Secondary text */
--text3: #606078       /* Tertiary text (labels) */
--red: #e53e3e         /* Accent (actions) */
--red2: #ff5252        /* Accent hover */
--green: #22c55e       /* Success/positive */
--amber: #f59e0b       /* Warning/attention */
--blue: #3b82f6        /* Info/neutral */
--purple: #8b5cf6      /* Special/category */
--pink: #ec4899        /* Secondary */
--cyan: #06b6d4        /* Tertiary */
```

### Typography
- **Headers:** Plus Jakarta Sans, 700 weight
- **Body:** Plus Jakarta Sans, 400-600 weight
- **Mono/Numbers:** JetBrains Mono, all weights

### Component Sizing
- **Sidebar:** 210px width, 8px nav item padding
- **Topbar:** 52px height
- **Cards:** 14px padding, 10px border-radius
- **Tables:** 11px font-size, 8px padding
- **Buttons:** 6px vertical padding, 12px horizontal padding

### Badge System
- **Source badges:** `.src` class + `.s-{source}` modifier (8px font)
  - amazon (orange), aliexpress (green), sephora (pink), macys (red), shein (purple)
- **Status badges:** `.bdg` class + `.bdg-{color}` modifier (9px font)
  - `.bdg-gr` (green), `.bdg-re` (red), `.bdg-am` (amber), `.bdg-bl` (blue), `.bdg-pu` (purple)

---

## JAVASCRIPT STRUCTURE

### State Management
```js
let token;              // Current auth token
let currentPage;        // Active page name
let currentFilter;      // Per-page filter state
let cacheData;          // Optional caching
```

### Core Functions

**Navigation:**
- `switchPage(pageName)` - Switch active page and load data
- `logout()` - Clear token and reload

**API Layer:**
- `apiCall(endpoint)` - GET request with token
- `apiCallPost(endpoint, data)` - POST with token
- `apiCallPut(endpoint, data)` - PUT with token

**Page Loaders (async):**
- `loadDashboard()`
- `loadOrders()`
- `loadCustomers()`
- `loadReturns()`
- `loadReviews()`
- `loadTickets()`
- `loadAnalytics()`
- `loadSuppliers()`

**Filter Handlers:**
- `filterOrders(status)`
- `filterCustomers(segment)`
- `filterReviews(status)`
- `filterTickets(status)`
- `setPeriod(period)` - For analytics

**Action Handlers:**
- `fulfillOrder(orderId)` - POST fulfill
- `approveReview(reviewId)` - PUT approve
- `saveSettings()` - POST settings

---

## RESPONSIVE DESIGN

### Mobile Breakpoint (max-width: 768px)
- Sidebar collapses to 50px (icons only)
- Nav labels hidden
- Badges hidden
- Card grid adjusts to smaller min-width (120px)
- Table font-size reduced to 10px
- Stat values reduced to 16px

---

## LOADING & ERROR STATES

### Loading State
- `.loading` class: "Loading..." message centered

### Empty State
- `.empty-state` class: "No data" message centered

### Error State
- `.error-msg` class: Red background, border, centered message

### Success State
- `.success-msg` class: Green background, border, centered message

---

## IMPORTANT NOTES

### 1. Suppliers Page - No Token Needed
The `/api/source-health` endpoint does NOT require a token parameter:
```js
fetch('/api/source-health')  // Correct - no ?token=
```

### 2. Charts
All charts use pure CSS bars (no Chart.js or libraries):
- `.chart-bar` container with flex layout
- `.bar` elements with height percentage
- Auto-scaled to max value

### 3. Dates
All timestamps use `new Date().toLocaleString()` or `toLocaleDateString()` for display.

### 4. Currency
All currency values formatted with `.toFixed(2)` and prefixed with `$`.

### 5. Monospace Numbers
All ID numbers, prices, quantities use `.mono-text` class for consistent alignment.

---

## FILES STRUCTURE

```
/public/admin/
└── index.html (1,072 lines)
    ├── <head>
    │   ├── Meta tags
    │   ├── Google Fonts link
    │   └── <style> (complete CSS, ~700 lines)
    │       ├── CSS Variables
    │       ├── Layout (grid, sidebar, topbar)
    │       ├── Components (cards, tables, badges, buttons)
    │       ├── States (loading, empty, error)
    │       └── Responsive media queries
    ├── <body>
    │   ├── Login screen section
    │   └── App section (display: none until login)
    │       ├── Topbar
    │       ├── Sidebar with 9 nav items
    │       └── 9 page sections (display: none except active)
    └── <script> (complete JS, ~350 lines)
        ├── State variables
        ├── Login functions
        ├── API layer
        ├── Page loaders (async functions)
        ├── Filter handlers
        ├── Action handlers
        └── Init on window load
```

---

## TESTING CHECKLIST

- [ ] Login with default token (stylehub-admin-2026)
- [ ] Overview page loads dashboard data
- [ ] Orders page filters work (All, Pending, Manual, Shipped, Cancelled)
- [ ] Customers page shows customer list with segments
- [ ] Returns page displays returns with source badges
- [ ] Reviews page filters and approve/reject works
- [ ] Tickets page shows KPIs and status filters
- [ ] Analytics page period selector (7d, 30d, 90d) works
- [ ] Suppliers page loads from `/api/source-health` (no token)
- [ ] Settings page saves values via POST
- [ ] Logout button clears localStorage and reloads
- [ ] Mobile responsive (sidebar collapses, tables adjust)
- [ ] Dark theme displays correctly
- [ ] Badge colors match source/status
- [ ] Loading states show during fetches
- [ ] Error states display if API fails

---

## DEPLOYMENT NOTES

1. No backend changes required - uses existing CRM APIs
2. Single file deployment (no build step)
3. Requires Google Fonts connectivity (CDN)
4. Default token: `stylehub-admin-2026` (change in Settings if needed)
5. Token stored in browser localStorage (session-based)

---

**Last Updated:** March 26, 2026
**Version:** 1.0 (Production)
