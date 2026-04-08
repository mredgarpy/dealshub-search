# DealsHub / StyleHub Miami — Changelog

Registro de todos los cambios realizados en el proyecto.

---

## [2026-04-08] v3.3.0 — Auditoría completa + Fix errores críticos + Limpieza UI

### Auditoría completa del sitio
- Auditoría de 19 hallazgos: 4 críticos, 5 altos, 6 medios, 4 bajos
- Verificación de todas las páginas (16 URLs testeadas)
- Verificación de todos los endpoints de API
- Prueba del flujo de compra completo (Amazon + AliExpress)
- Reporte generado: `AUDIT-REPORT-2026-04-08.md`

### Fix críticos del backend
- **Amazon adapter**: Detección de respuestas vacías de `product-details` con fallback a search API
- **AliExpress 404**: Respuesta mejorada con mensaje amigable + 6 productos alternativos
- **Recommendations**: Recupera keywords del cache cuando `title` está vacío; usa product ID como fallback
- **AliExpress reviews**: Manejo de múltiples formatos de respuesta; método público `getReviews` agregado

### Archivos modificados (backend)
- `server.js` — productDetailHandler 404 mejorado, recommendations con fallback
- `src/adapters/amazon.js` — getProduct() con detección de datos vacíos
- `src/adapters/aliexpress.js` — _fetchReviews mejorado, getReviews público

### Limpieza UI — Tiendas pausadas
- Removidas Sephora, Macy's y SHEIN del dropdown del hero search
- Removidas del chip filter de search results
- Removidas del browse page
- Link de Beauty en mobile drawer ya no apunta a `store=sephora`
- JS sources array reducido a `['amazon', 'aliexpress']`

### Archivos modificados (theme)
- `sections/hero-slider.liquid` — Store dropdown limpiado
- `sections/page-search-results.liquid` — Chips + JS sources
- `sections/api-browse.liquid` — Botón Sephora removido
- `assets/dealshub-mobile-fixes.js` — Link Beauty corregido

### Redirects creados en Shopify
- `/pages/about` → 301 → `/pages/about-us` (ID: 511162220675)
- `/policies/shipping-policy` → 301 → `/pages/shipping-policy` (ID: 511162253443)

### Sistema de backup creado
- `scripts/backup.js` — Backup, rollback, diff, versionado
- `VERSION.json` — Control de versión
- `CHANGELOG.md` — Este archivo

---

## [2026-04-07] v3.2.0 — Reviews restaurados + Variantes corregidas

### Reviews en PDP
- Amazon: fetch secuencial de `/product-reviews` después de details+offers (evita rate limits)
- AliExpress: método `_fetchReviews` + `_enrichFromReviews` agregados
- Frontend `dealshub-product.js` v3.0 subido con 14 secciones de PDP

### Variantes Amazon
- Cada color tiene ASIN y precio diferente
- `selectVariant()` carga producto completo por ASIN al cambiar color
- Precios se actualizan correctamente al cambiar variante

### Archivos modificados
- `src/adapters/amazon.js` — Reviews secuenciales, getReviews()
- `src/adapters/aliexpress.js` — _fetchReviews, _enrichFromReviews
- `assets/dealshub-product.js` — v3.0 con reviews + recommendations

---

## [2026-04-06] v3.1.0 — Pricing engine + Product detail + Search cache fallback

### Pricing engine
- Markup configurable por source y rango de precio
- Compare-at price para mostrar descuento
- AliExpress: pricing basado en costo mayorista vs MSRP

### Product detail handler
- Price recovery cascade (5 fallbacks)
- Search cache fallback para IDs de AliExpress
- URL params fallback como último recurso

### Search improvements
- Cache individual de resultados de búsqueda por source+id
- Fallback de product detail a search cache

---

## [2026-03-17] v2.0.0 — AliExpress integration

### AliExpress adapter
- Search via `item_search_3` con fallback chain
- Product detail via `item_detail_2` + `item_detail_6`
- Variantes, imágenes, shipping data
- Origin detection (USA vs International)

---

## [2026-03-01] v1.0.0 — Lanzamiento inicial

### Core
- Backend Node.js en Render
- Amazon adapter con search, product-details, offers
- Shopify theme 2.0 con PDP interna
- Home con trending, bestsellers, flash deals
- Prepare-cart con sync on-demand a Shopify
