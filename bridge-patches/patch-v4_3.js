/**
 * patch-v4_3.js - Fix shopifyProductId extraction after fast wizard completion
 *
 * Bug found in production (2026-04-29 18:58 UTC):
 *   AutoDS sometimes finishes the import in 15 seconds instead of 3-4 min
 *   (when the product was already in their cache). Our STEP 9 logic clicked
 *   "View details" too eagerly, before the modal was fully rendered, so the
 *   numeric ID extraction returned null.
 *
 *   Log:
 *     banner found: job=#155004300 status=finished 1/1
 *     OK jobId=155004300 shopifyProductId=null detailsStatus=null
 *
 * v4.3 fix:
 *   - Retry the view-details click up to 3 times with progressive backoff
 *   - Wait longer between click and DOM read (2s -> 3.5s -> 5s)
 *   - Relax the modal match (any visible modal that mentions Import or
 *     Completed, not strictly the one containing the jobId — sometimes
 *     AutoDS shows the modal without the #jobId in the title text)
 *   - Try BOTH "matched-by-jobId" and "matched-by-visibility" strategies
 *     when clicking View details
 *   - Close any open modal between retries to reset state
 */

const fs = require('fs');
const file = 'autods-local-bridge.js';
let s = fs.readFileSync(file, 'utf8');

// Mark v4.3
s = s.replace(/AutoDS Local Bridge v4\.2/g, 'AutoDS Local Bridge v4.3');

// Locate the STEP 9 block to replace.
const startMarker = "    // STEP 9 - Open \"View details\" of the job banner to extract Sell Item ID";
const endMarker   = "    log('info', `[wizard ${tag}] OK jobId=${importJobId} shopifyProductId=${shopifyProductId} detailsStatus=${detailsStatus}`);";

const startIdx = s.indexOf(startMarker);
const endIdx   = s.indexOf(endMarker);
if (startIdx === -1 || endIdx === -1 || startIdx >= endIdx) {
  console.error('Patch v4.3 NOT applied - could not locate STEP 9 block.');
  console.error(`startIdx=${startIdx} endIdx=${endIdx}`);
  process.exit(1);
}

const newBlock = [
  '    // STEP 9 v4.3 - Open "View details" with retries + longer wait',
  '    let shopifyProductId = null;',
  '    let detailsStatus = null;',
  '',
  '    for (let attempt = 1; attempt <= 3 && !shopifyProductId; attempt++) {',
  '      const settleMs = 2000 + (attempt - 1) * 1500;',
  '      await page.waitForTimeout(settleMs);',
  '',
  '      // Click "View details" — try strict (banner with our jobId) then any visible',
  '      const clickStrategy = await page.evaluate((jobId) => {',
  '        const links = document.querySelectorAll(\'a, button, span\');',
  '        for (const l of links) {',
  '          const txt = (l.textContent || \'\').trim().toLowerCase();',
  '          if (txt === \'view details\' || txt.startsWith(\'view details\')) {',
  '            let node = l;',
  '            for (let i = 0; i < 10 && node; i++) {',
  '              if ((node.textContent || \'\').includes(\'#\' + jobId)) {',
  '                l.click();',
  '                return \'by-jobId\';',
  '              }',
  '              node = node.parentElement;',
  '            }',
  '          }',
  '        }',
  '        for (const l of links) {',
  '          const txt = (l.textContent || \'\').trim().toLowerCase();',
  '          if (txt === \'view details\' || txt.startsWith(\'view details\')) {',
  '            const r = l.getBoundingClientRect();',
  '            if (r.width > 0 && r.height > 0) { l.click(); return \'by-visibility\'; }',
  '          }',
  '        }',
  '        return null;',
  '      }, importJobId);',
  '',
  '      if (!clickStrategy) {',
  '        log(\'info\', `[wizard ${tag}] view-details not found (attempt ${attempt})`);',
  '        continue;',
  '      }',
  '      log(\'info\', `[wizard ${tag}] view-details clicked via ${clickStrategy} (attempt ${attempt})`);',
  '      await page.waitForTimeout(3500);',
  '',
  '      const detailsData = await page.evaluate((jobId) => {',
  '        const modals = document.querySelectorAll(\'.ant-modal, .ant-drawer, [role="dialog"]\');',
  '        let bestModal = null;',
  '        for (const m of modals) {',
  '          const r = m.getBoundingClientRect();',
  '          if (r.width === 0 || r.height === 0) continue;',
  '          const txt = (m.textContent || \'\').toLowerCase();',
  '          if (!txt) continue;',
  '          // Prefer the modal that mentions our jobId, fall back to any open import modal',
  '          if (txt.includes(\'#\' + jobId)) { bestModal = m; break; }',
  '          if (!bestModal && (txt.includes(\'import\') || txt.includes(\'completed\') || txt.includes(\'sell item\'))) {',
  '            bestModal = m;',
  '          }',
  '        }',
  '        if (!bestModal) return null;',
  '        const txt = (bestModal.textContent || \'\').toLowerCase();',
  '        const candidates = bestModal.querySelectorAll(\'a, span, td, div\');',
  '        const ids = new Set();',
  '        for (const c of candidates) {',
  '          const t = (c.textContent || \'\').trim();',
  '          if (/^\\d{10,15}$/.test(t)) ids.add(t);',
  '        }',
  '        return { ids: Array.from(ids), completed: txt.includes(\'completed\') };',
  '      }, importJobId);',
  '',
  '      if (detailsData && detailsData.ids.length > 0) {',
  '        shopifyProductId = detailsData.ids.sort((a, b) => b.length - a.length)[0];',
  '        detailsStatus = detailsData.completed ? \'completed\' : \'unknown\';',
  '        log(\'info\', `[wizard ${tag}] extracted shopifyProductId=${shopifyProductId} (ids=${detailsData.ids.join(\',\')})`);',
  '        break;',
  '      }',
  '      log(\'info\', `[wizard ${tag}] modal had no numeric IDs (attempt ${attempt})`);',
  '',
  '      // Close any open modal before retrying',
  '      await page.evaluate(() => {',
  '        const closeBtns = document.querySelectorAll(\'.ant-modal-close, .ant-drawer-close\');',
  '        for (const b of closeBtns) {',
  '          const r = b.getBoundingClientRect();',
  '          if (r.width > 0) { b.click(); break; }',
  '        }',
  '      });',
  '      await page.waitForTimeout(500);',
  '    }',
  '',
  '    log(\'info\', `[wizard ${tag}] OK jobId=${importJobId} shopifyProductId=${shopifyProductId} detailsStatus=${detailsStatus}`);'
].join('\n');

s = s.slice(0, startIdx) + newBlock + s.slice(endIdx + endMarker.length);

fs.writeFileSync(file, s);
console.log('Patched OK - bridge v4.3 with retry-based shopifyProductId extraction');
console.log('');
console.log('Restart bridge: Ctrl+C then  node autods-local-bridge.js');
