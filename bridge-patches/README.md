# Bridge patches

Patches for `autods-local-bridge.js` (the Playwright-based AutoDS automation that
runs on Edgar's PC). Versioned so we can track what's deployed locally.

## How to apply

On Edgar's PC, in `Desktop\autods-extract\` (where `autods-local-bridge.js` lives):

```powershell
Invoke-WebRequest `
  -Uri "https://raw.githubusercontent.com/mredgarpy/dealshub-search/main/bridge-patches/patch-vX_Y.js" `
  -OutFile patch-vX_Y.js
node patch-vX_Y.js
```

Then restart the bridge: Ctrl+C → `node autods-local-bridge.js`.

Verify the version banner says the new version (e.g. `AutoDS Local Bridge v4.3 ready`).

## Patches

- **patch-v4_3.js** (2026-04-29) — fix `shopifyProductId` extraction after fast wizard
  completion (15s vs 3-4 min). Adds 3-attempt retry with progressive backoff in
  STEP 9 (View details modal read).
