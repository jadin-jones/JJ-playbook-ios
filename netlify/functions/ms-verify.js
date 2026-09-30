/* One-time mailbox check for Microsoft sign-ins (see netlify/lib/ms-verify.js),
 * with a 6-digit code typed on the same screen: no link, no second tab.
 *
 * POST /api/ms-verify   Authorization: Bearer <Firebase ID token>
 *   { action: 'status' }
 *       { ok, verified } — whether this account has confirmed its mailbox.
 *   { action: 'send' }
 *       Emails a fresh 6-digit code to the account's address from our own
 *       mailbox (netlify/lib/mailer.js) and keeps only a salted hash of it in
 *       msVerifyPending/{uid}: one active code per person, a new one replaces
 *       the old. Valid 10 minutes. A new code at most once a minute (429 with
 *       code 'wait' and retryIn seconds), 10 a day. If the email cannot be
 *       sent, nothing is kept, the reason goes to the function log (never the
 *       code or a password), and the app is told it was not sent.
 *   { action: 'verify', code }
 *       Checks the code: same account and email, within 10 minutes, 5 wrong
 *       tries at most (then the code is dropped and a new one is needed).
 *       Right → msVerified/{uid}, and /api/join and the rules let them in.
 *
 * Only Microsoft sign-ins use this; anything else is refused. It never makes
 * anyone an admin: isAdmin (rules) and the app refuse admin through Microsoft
 * whatever this says.
 *
 * Env: FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY, and
 * SMTP_USER, SMTP_PASS, MAIL_FROM (netlify/lib/mailer.js).
 */
const crypto = require('crypto');
const { db, auth, missingEnv } = require('../lib/firebase-admin');
const { isMicrosoft, isConfirmed } = require('../lib/ms-verify');
const { withCors } = require('../lib/http');
const { allow, clientIp, HOUR } = require('../lib/rate-limit');
const mailer = require('../lib/mailer');

const CODE_MS = 10 * 60 * 1000;
const RESEND_MS = 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_SENDS = 10;
const MAX_FAILS = 5;

const CORS = {
  'Content-Type': 'application/json'
};
const reply = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });
// Salted and tied to the account, so a copy of the record does not give the
// code away by a lookup table.
const codeHash = (salt, uid, code) => crypto.createHmac('sha256', salt).update(uid + ':' + code).digest('hex');
const same = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

exports.handler = withCors('POST, OPTIONS', 'Content-Type, Authorization', async function (event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return reply(405, { error: 'POST only' });
  const missing = missingEnv();
  if (missing.length) return reply(500, { error: 'Server is not configured (' + missing.join(', ') + ')' });
  if ((event.body || '').length > 2000) return reply(413, { error: 'Too long' });
  // Per address, on top of the per-account limits below.
  if (!(await allow('ms-verify', clientIp(event), 60, HOUR)))
    return reply(429, { error: 'Too many tries from here. Wait an hour and try again.', code: 'rate' });

  const h = event.headers || {};
  const m = /^Bearer\s+(.+)$/i.exec(h.authorization || h.Authorization || '');
  if (!m) return reply(401, { error: 'Sign in first' });
  let tok;
  try { tok = await auth().verifyIdToken(m[1], true); }
  catch (e) { return reply(401, { error: 'Your sign-in has expired. Sign in again.' }); }
  if (!isMicrosoft(tok)) return reply(400, { error: 'Only needed for Microsoft sign-in', code: 'not-microsoft' });
  const email = String(tok.email || '').trim().toLowerCase();
  if (!email) return reply(403, { error: 'Your account has no email address' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) { return reply(400, { error: 'Bad JSON' }); }

  try {
    if (await isConfirmed(tok.uid, email)) return reply(200, { ok: true, verified: true });
    const ref = db().collection('msVerifyPending').doc(tok.uid);
    const now = Date.now();

    if (body.action === 'status') return reply(200, { ok: true, verified: false });

    if (body.action === 'send') {
      const snap = await ref.get();
      const p = snap.exists ? snap.data() : {};
      if (p.email === email && p.sentAt && now - p.sentAt < RESEND_MS) {
        const retryIn = Math.ceil((RESEND_MS - (now - p.sentAt)) / 1000);
        return reply(429, { error: 'Code sent — check your inbox and Junk. You can ask for a new one in ' + retryIn + ' seconds.',
          code: 'wait', retryIn, active: !!(p.exp && p.exp > now) });
      }
      const fresh = !p.windowStart || now - p.windowStart > DAY_MS;
      const sends = fresh ? 0 : (p.sends || 0);
      if (sends >= MAX_SENDS)
        return reply(429, { error: 'Too many codes today. Try again tomorrow.', code: 'limit' });

      const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
      try {
        await mailer.sendMail({ to: email, subject: 'Your JJ Playbook code',
          text: 'Your JJ Playbook code is ' + code + '. It expires in 10 minutes.' });
      } catch (e) {
        console.error('ms-verify send failed', tok.uid, e && e.message);
        return reply(502, { error: 'We could not send the email just now. Nothing was sent — try again in a moment.', code: 'send-failed' });
      }
      const salt = crypto.randomBytes(16).toString('hex');
      await ref.set({ email, salt, hash: codeHash(salt, tok.uid, code), exp: now + CODE_MS,
        sentAt: now, sends: sends + 1, windowStart: fresh ? now : p.windowStart, fails: 0 });
      console.log('ms-verify code sent', tok.uid);
      return reply(200, { ok: true, sent: true, email, resendIn: RESEND_MS / 1000 });
    }

    if (body.action === 'verify') {
      const code = String(body.code || '').replace(/\D/g, '');
      if (code.length !== 6) return reply(400, { error: 'Enter the 6-digit code from the email.', code: 'bad-code' });
      const snap = await ref.get();
      const p = snap.exists ? snap.data() : null;
      if (!p || !p.hash || p.email !== email)
        return reply(400, { error: 'That code is not valid any more. Tap Resend code for a new one.', code: 'no-code' });
      if (!p.exp || now > p.exp) {
        await ref.set({ hash: '', exp: 0 }, { merge: true });
        return reply(410, { error: 'That code has expired. Tap Resend code for a new one.', code: 'expired' });
      }
      if (!same(codeHash(String(p.salt || ''), tok.uid, code), String(p.hash))) {
        const fails = (p.fails || 0) + 1;
        if (fails >= MAX_FAILS) {
          await ref.set({ hash: '', exp: 0, fails }, { merge: true });
          return reply(429, { error: 'Too many wrong tries. Tap Resend code for a new one.', code: 'too-many' });
        }
        await ref.set({ fails }, { merge: true });
        const left = MAX_FAILS - fails;
        return reply(400, { error: 'That code is not right. ' + left + (left === 1 ? ' try' : ' tries') + ' left.', code: 'wrong', left });
      }
      await db().collection('msVerified').doc(tok.uid).set({ email, at: now });
      await ref.delete();
      return reply(200, { ok: true, verified: true });
    }

    return reply(400, { error: 'Unknown action' });
  } catch (e) {
    console.error('ms-verify', tok.uid, e && (e.code || e.message));
    return reply(500, { error: 'Could not check your email right now. Try again in a moment.' });
  }
});
