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
 * sendMail({ to, subject, text }) sends plain text from MAIL_FROM. Optional:
 * html (a second, HTML part), replyTo, and fromName, which replaces only the
 * display name (the address stays MAIL_FROM's, else SMTP_USER: Gmail rewrites
 * any address the mailbox has no Send-as alias for). Twin Thieves invites use
 * all three; the Microsoft code email uses none, so it is unchanged.
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

/* The bare address in MAIL_FROM ("Name <a@b>" or "a@b"), else SMTP_USER. */
function fromAddress() {
  const f = envValue('MAIL_FROM');
  const m = /<([^<>\s]+@[^<>\s]+)>\s*$/.exec(f) || /^([^<>\s"]+@[^<>\s"]+)$/.exec(f);
  return m ? m[1] : envValue('SMTP_USER');
}

async function sendMail({ to, subject, text, html, replyTo, fromName }) {
  const missing = missingMailEnv();
  if (missing.length) throw new Error('mail not configured: missing ' + missing.join(', '));
  const name = String(fromName || '').replace(/["\r\n<>]/g, '').trim();
  const from = name ? '"' + name + '" <' + fromAddress() + '>'
    : (envValue('MAIL_FROM') || ('"JJ Playbook" <' + envValue('SMTP_USER') + '>'));
  const msg = { from, to, subject, text };
  if (html) msg.html = html;
  if (replyTo) msg.replyTo = replyTo;
  try {
    const info = await getTransport().sendMail(msg);
    if (info && Array.isArray(info.rejected) && info.rejected.length) throw new Error('recipient rejected');
    return true;
  } catch (e) {
    // Only what SMTP said, never the credentials.
    const bits = [e.code, e.responseCode, e.command, String(e.response || e.message || '').slice(0, 200)].filter(Boolean);
    throw new Error('smtp: ' + bits.join(' | '));
  }
}

module.exports = { sendMail, missingMailEnv };
