// ============================================================
// DealsHub — Memory + Disk Cache (survives cold starts)
// ============================================================
const fs = require('fs');
const path = require('path');
const logger = require('./logger');

const CACHE_DIR = path.join(__dirname, '..', '..', 'cache');
try { if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true }); } catch(e) {}

class MemoryCache {
  constructor(defaultTTL = 300000) {
    this.store = new Map();
    this.defaultTTL = defaultTTL;
    this.name = 'cache';
  }

  get size() { return this.store.size; }

  get(key) {
    // 1. Memory
    const entry = this.store.get(key);
    if (entry && Date.now() < entry.expiresAt) return entry.value;
    if (entry) this.store.delete(key);

    // 2. Disk fallback
    try {
      const file = path.join(CACHE_DIR, this._fileKey(key) + '.json');
      if (fs.existsSync(file)) {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (raw && Date.now() < raw.expiresAt) {
          this.store.set(key, raw);
          return raw.value;
        }
        try { fs.unlinkSync(file); } catch(e) {}
      }
    } catch(e) {}

    return null;
  }

  set(key, value, ttl) {
    const expiresAt = Date.now() + (ttl || this.defaultTTL);
    const entry = { value, expiresAt };
    this.store.set(key, entry);

    // Write to disk (async, non-blocking)
    try {
      const file = path.join(CACHE_DIR, this._fileKey(key) + '.json');
      fs.writeFile(file, JSON.stringify(entry), 'utf8', () => {});
    } catch(e) {}
  }

  del(key) {
    this.store.delete(key);
    try {
      const file = path.join(CACHE_DIR, this._fileKey(key) + '.json');
      if (fs.existsSync(file)) fs.unlinkSync(file);
    } catch(e) {}
  }

  clear() {
    this.store.clear();
    try {
      const files = fs.readdirSync(CACHE_DIR);
      files.forEach(f => {
        try { fs.unlinkSync(path.join(CACHE_DIR, f)); } catch(e) {}
      });
    } catch(e) {}
  }

  _fileKey(key) {
    return key.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 100);
  }
}

// Search cache: 6 hours (trending, bestsellers, etc.)
const searchCache = new MemoryCache(21600000);

// Product cache: 4 hours (individual PDP)
const productCache = new MemoryCache(14400000);

// Load disk cache into memory on startup
try {
  const files = fs.readdirSync(CACHE_DIR);
  let loaded = 0;
  files.forEach(f => {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, f), 'utf8'));
      if (raw && raw.expiresAt > Date.now()) {
        const key = f.replace('.json', '').replace(/_/g, ':');
        // Guess which cache based on prefix
        if (key.startsWith('product') || key.startsWith('reviews')) {
          productCache.store.set(key, raw);
        } else {
          searchCache.store.set(key, raw);
        }
        loaded++;
      }
    } catch(e) {}
  });
  if (loaded > 0) {
    console.log('[cache] Loaded ' + loaded + ' entries from disk');
  }
} catch(e) {}

module.exports = { searchCache, productCache };
