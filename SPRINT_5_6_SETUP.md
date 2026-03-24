# StyleHub Sprint 5 + 6 — Setup & Delivery Notes

## What Was Built

### Sprint 5 — New Pages (5 pages, 15 files)
All theme files (sections, templates, JS) are already deployed to Shopify theme `157178462339`.

| Page | URL | Template | Section | JS |
|------|-----|----------|---------|-----|
| Deals | `/pages/deals` | `page.deals.json` | `dealshub-deals.liquid` | `dealshub-deals.js` |
| Best Sellers | `/pages/best-sellers` | `page.best-sellers.json` | `dealshub-bestsellers-page.liquid` | `dealshub-bestsellers-page.js` |
| New Arrivals | `/pages/new-arrivals` | `page.new-arrivals.json` | `dealshub-new-arrivals.liquid` | `dealshub-new-arrivals.js` |
| Most Wanted | `/pages/most-wanted` | `page.most-wanted.json` | `dealshub-most-wanted.liquid` | `dealshub-most-wanted.js` |
| Category | `/pages/category?cat={slug}` | `page.category.json` | `dealshub-category.liquid` | `dealshub-category.js` |

Category slugs: `electronics`, `fashion`, `beauty`, `home`, `sports`, `gaming`, `baby`

### Sprint 6 — Navigation + Polish
- Header category bar updated with links to all new pages
- Active state highlighting for current page
- Plus link in category bar
- `POST /api/admin/create-page` endpoint added to backend

---

## REQUIRED: Create Shopify Page Objects

The theme templates and sections are deployed, but Shopify still needs the **Page objects** created to serve them. This is because Shopify pages are a two-part system: the template (already deployed) and the page record.

### Option A: Via Backend API (after Render deploys)
Once the Render deploy completes with the `create-page` endpoint:

```bash
# Create all 5 pages
curl -X POST https://dealshub-search.onrender.com/api/admin/create-page \
  -H "Content-Type: application/json" \
  -d '{"title":"Deals","handle":"deals","template_suffix":"deals","body_html":""}'

curl -X POST https://dealshub-search.onrender.com/api/admin/create-page \
  -H "Content-Type: application/json" \
  -d '{"title":"Best Sellers","handle":"best-sellers","template_suffix":"best-sellers","body_html":""}'

curl -X POST https://dealshub-search.onrender.com/api/admin/create-page \
  -H "Content-Type: application/json" \
  -d '{"title":"New Arrivals","handle":"new-arrivals","template_suffix":"new-arrivals","body_html":""}'

curl -X POST https://dealshub-search.onrender.com/api/admin/create-page \
  -H "Content-Type: application/json" \
  -d '{"title":"Most Wanted","handle":"most-wanted","template_suffix":"most-wanted","body_html":""}'

curl -X POST https://dealshub-search.onrender.com/api/admin/create-page \
  -H "Content-Type: application/json" \
  -d '{"title":"Category","handle":"category","template_suffix":"category","body_html":""}'
```

### Option B: Via Shopify Admin (manual)
Go to **Shopify Admin → Online Store → Pages** and create each page:

1. **Deals** — Title: "Deals", Template: `deals`
2. **Best Sellers** — Title: "Best Sellers", Template: `best-sellers`
3. **New Arrivals** — Title: "New Arrivals", Template: `new-arrivals`
4. **Most Wanted** — Title: "Most Wanted", Template: `most-wanted`
5. **Category** — Title: "Category", Template: `category`

For each: click "Add page", enter the title, then in the right sidebar under "Theme template" select the matching template suffix. Save.

---

## Git Commits This Session

```
d0d72b6 — feat: Sprint 2 — Complete deep rebrand
a152bd9 — feat: Sprint 3 — PDP completo with 14 sections
ad682ef — feat: Sprint 4 — Home page with new sections + Amazon best-sellers endpoint
ccc5e6c — feat: Sprint 5 — New pages: Deals, Best Sellers, New Arrivals, Most Wanted, Category
36c5dad — feat: Sprint 6 — Navigation update + page creation endpoint
```

## APIs Used by New Pages

| Page | API Endpoint |
|------|-------------|
| Deals - Lightning | `GET /api/trending?limit=30` (filtered by discount >= 20%) |
| Deals - Under $X | `GET /api/best-value-intl?maxPrice={5,10,25}&limit=10` |
| Deals - USA | `GET /api/amazon-bestsellers?type=BEST_SELLERS&category=aps&limit=20` |
| Deals - Top Discount | `GET /api/search?q=deal+sale&store=amazon&limit=30` |
| Best Sellers | `GET /api/amazon-bestsellers?type=BEST_SELLERS&category={cat}&limit=30` |
| New Arrivals | `GET /api/amazon-bestsellers?type=NEW_RELEASES&category={cat}&limit=30` |
| Most Wanted | `GET /api/amazon-bestsellers?type=MOST_WISHED_FOR&category={cat}&limit=30` |
| Category - Bestsellers | `GET /api/amazon-bestsellers?type=BEST_SELLERS&category={cat}&limit=10` |
| Category - Grid | `GET /api/search?q={terms}&store=amazon&limit=30` + `store=aliexpress&limit=20` |
