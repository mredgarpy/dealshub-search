# PASO 9: Shopify Shipping Settings

## Current State (March 23, 2026)

### Shipping Zones
1. **Estados Unidos** (US only) — Economy: FREE, Return Shipping: FREE ✅
2. **NACIONAL** (DE, ES, US) — $4.90 under $35, free over $35 ⚠️ overlap with US

### Why This Works
Pricing engine bakes shipping into product prices. Shopify checkout = $0 always.

### Manual Actions in Shopify Admin (Settings > Shipping)
1. Remove US from NACIONAL zone (avoid rate conflict)
2. Rename zones/rates to English
3. Verify checkout shows $0 for synced products

### Future: Carrier Service for dynamic rates if needed
