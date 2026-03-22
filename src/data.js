// ============================================================
// StyleHub CRM — Persistent Data Layer (JSON on disk)
// ============================================================
const fs = require('fs');
const path = require('path');
const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function loadJSON(file, fallback = {}) {
  try {
    const p = path.join(DATA_DIR, file);
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    console.error(`[data] Load error for ${file}:`, e.message);
  }
  return typeof fallback === 'function' ? fallback() : JSON.parse(JSON.stringify(fallback));
}

function saveJSON(file, data) {
  try {
    fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(data, null, 2));
  } catch (e) {
    console.error(`[data] Save error for ${file}:`, e.message);
  }
}

const db = {
  orders: loadJSON('orders.json', {}),
  returns: loadJSON('returns.json', {}),
  reviews: loadJSON('reviews.json', [])
};

function save(key) {
  saveJSON(key + '.json', db[key]);
}

module.exports = { db, save, loadJSON, saveJSON };
