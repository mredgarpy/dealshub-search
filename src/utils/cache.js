// ============================================================
// DealsHub — In-Memory Cache with TTL
// ============================================================
class MemoryCache {
  constructor(defaultTTL = 300000) { // 5 min default
    this.store = new Map();
    this.defaultTTL = defaultTTL;
    // Cleanup expired entries every 60s
    setInterval(() => this._cleanup(), 60000);
  }

  get(key) {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  set(key, value, ttl) {
    this.store.set(key, {
      value,
      expiresAt: Date.now() + (ttl || this.defaultTTL)
    });
  }

  del(key) { this.store.delete(key); }

  has(key) {
    const v = this.get(key);
    return v !== null;
  }

  clear() { this.store.clear(); }

  _cleanup() {
    const now = Date.now();
    for (const [key, entry] of this.store) {
      if (now > entry.expiresAt) this.store.delete(key);
    }
  }

  get size() { return this.store.size; }
}

// Shared cache instances
const searchCache = new MemoryCache(300000);  // 5 min for search
const productCache = new MemoryCache(600000); // 10 min for product detail
const syncCache = new MemoryCache(3600000);   // 1hr for sync mappings

module.exports = { MemoryCache, searchCache, productCache, syncCache };
