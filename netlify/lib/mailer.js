/* Plain-text email from our own Google Workspace mailbox, for mail Firebase
 * cannot send (Firebase only sends its own templates).
 *
 * Netlify → Site configuration → Environment variables (both sites):
 *   SMTP_USER   the Workspace mailbox, e.g. noreply@jadin-jones.com
 *   SMTP_PASS   an app password for it (2-Step Verification on)
 *   MAIL_FROM   e.g. JJ Playbook <noreply@jadin-jones.com>; defaults to
 *               "JJ Playbook" <SMTP_USER>
 * Sent through smtp.gmail.com:465. jadin-jones.com's SPF already includes
 * Google and Google signs it with DKIM, so nothing else is needed.
 *
 * sendMail() resolves true, or throws an Error whose message is safe to log:
 * it never holds the password.
 */
const nodemailer = require('nodemailer');

const envValue = k => {
  const s = String(process.env[k] || '').trim();
  return /^(["']).*\1$/s.test(s) ? s.slice(1, -1).trim() : s;
};

function missingMailEnv() {
  return ['SMTP_USER', 'SMTP_PASS'].filter(k => !envValue(k));
}

let transport = null;
function getTransport() {
  if (transport) return transport;
  transport = nodemailer.createTransport({
    host: 'smtp.gmail.com', port: 465, secure: true,
    // Google shows app passwords in groups of four; the spaces are not part of it.
    auth: { user: envValue('SMTP_USER'), pass: envValue('SMTP_PASS').replace(/\s+/g, '') },
    connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000
  });
  return transport;
}

async function sendMail({ to, subject, text }) {
  const missing = missingMailEnv();
  if (missing.length) throw new Error('mail not configured: missing ' + missing.join(', '));
  const from = envValue('MAIL_FROM') || ('"JJ Playbook" <' + envValue('SMTP_USER') + '>');
  try {
    const info = await getTransport().sendMail({ from, to, subject, text });
    if (info && Array.isArray(info.rejected) && info.rejected.length) throw new Error('recipient rejected');
    return true;
  } catch (e) {
    // Only what SMTP said, never the credentials.
    const bits = [e.code, e.responseCode, e.command, String(e.response || e.message || '').slice(0, 200)].filter(Boolean);
    throw new Error('smtp: ' + bits.join(' | '));
  }
}

module.exports = { sendMail, missingMailEnv };
