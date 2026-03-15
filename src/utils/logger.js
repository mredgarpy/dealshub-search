// ============================================================
// DealsHub — Structured Logger
// ============================================================
const LOG_LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const CURRENT_LEVEL = LOG_LEVELS[process.env.LOG_LEVEL || 'info'];

function log(level, category, message, meta = {}) {
  if (LOG_LEVELS[level] > CURRENT_LEVEL) return;
  const entry = {
    ts: new Date().toISOString(),
    level,
    cat: category,
    msg: message,
    ...meta
  };
  if (level === 'error') console.error(JSON.stringify(entry));
  else if (level === 'warn') console.warn(JSON.stringify(entry));
  else console.log(JSON.stringify(entry));
}

module.exports = {
  error: (cat, msg, meta) => log('error', cat, msg, meta),
  warn: (cat, msg, meta) => log('warn', cat, msg, meta),
  info: (cat, msg, meta) => log('info', cat, msg, meta),
  debug: (cat, msg, meta) => log('debug', cat, msg, meta)
};