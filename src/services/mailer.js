// ============================================================
// StyleHub — Generic SMTP Mailer (Zoho-compatible)
// ============================================================
// Thin wrapper around nodemailer. Reads config from env vars
// and exposes a single sendMail(opts) function.
//
// Env vars (all optional — module will log-and-skip if missing):
//   MAILER_ENABLED=true           enables actual sending
//   SMTP_HOST=smtp.zoho.com       SMTP server
//   SMTP_PORT=465                 SMTP port (465 SSL / 587 TLS)
//   SMTP_SECURE=true              'true' for SSL (port 465)
//   SMTP_USER=noreply@stylehubmiami.com
//   SMTP_PASS=<zoho app password>
//   MAIL_FROM_NAME=StyleHub Miami
//   MAIL_FROM_ADDRESS=noreply@stylehubmiami.com
// ============================================================

const logger = require('../utils/logger');

// Lazy-require nodemailer so the module loads even if the package
// isn't installed yet (fail soft during migrations).
let nodemailer = null;
try {
  // eslint-disable-next-line global-require
  nodemailer = require('nodemailer');
} catch (e) {
  logger.warn('mailer', 'nodemailer not installed — mailer disabled until `npm i nodemailer`');
}

let cachedTransport = null;

function getConfig() {
  return {
    enabled: String(process.env.MAILER_ENABLED || '').toLowerCase() === 'true',
    host: process.env.SMTP_HOST || 'smtp.zoho.com',
    port: parseInt(process.env.SMTP_PORT || '465', 10),
    secure: String(process.env.SMTP_SECURE || 'true').toLowerCase() === 'true',
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    fromName: process.env.MAIL_FROM_NAME || 'StyleHub Miami',
    fromAddress: process.env.MAIL_FROM_ADDRESS || process.env.SMTP_USER || 'noreply@stylehubmiami.com'
  };
}

function getTransport() {
  if (cachedTransport) return cachedTransport;
  if (!nodemailer) return null;

  const cfg = getConfig();
  if (!cfg.user || !cfg.pass) {
    logger.warn('mailer', 'SMTP credentials missing — set SMTP_USER and SMTP_PASS');
    return null;
  }

  cachedTransport = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: { user: cfg.user, pass: cfg.pass },
    // Small timeouts so we fail fast in Render rather than hang the event loop.
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 20000
  });

  return cachedTransport;
}

/**
 * Send an email via configured SMTP.
 * Returns { ok: true, messageId } on success,
 * { ok: false, reason } on failure.
 * Never throws — callers can ignore the result if they want fire-and-forget.
 */
async function sendMail({ to, subject, html, text, attachments, replyTo, cc, bcc }) {
  const cfg = getConfig();

  if (!cfg.enabled) {
    logger.info('mailer', `(dry-run) Would send to ${to}: ${subject}`);
    return { ok: false, reason: 'mailer_disabled', dryRun: true };
  }

  const transport = getTransport();
  if (!transport) {
    logger.warn('mailer', 'No transport available — email skipped');
    return { ok: false, reason: 'no_transport' };
  }

  const from = `"${cfg.fromName}" <${cfg.fromAddress}>`;
  try {
    const info = await transport.sendMail({
      from,
      to,
      cc,
      bcc,
      replyTo: replyTo || cfg.fromAddress,
      subject,
      text,
      html,
      attachments
    });
    logger.info('mailer', `Sent to ${to}: ${subject} (messageId=${info.messageId})`);
    return { ok: true, messageId: info.messageId, response: info.response };
  } catch (e) {
    logger.error('mailer', `Send failed to ${to}: ${e.message}`);
    return { ok: false, reason: 'send_failed', error: e.message };
  }
}

/** Quick health check — useful from admin endpoints. */
async function verifyConnection() {
  const transport = getTransport();
  if (!transport) return { ok: false, reason: 'no_transport' };
  try {
    await transport.verify();
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: 'verify_failed', error: e.message };
  }
}

module.exports = { sendMail, verifyConnection, getConfig };
