/* One-time mailbox check for Microsoft sign-ins (see netlify/lib/ms-verify.js).
 *
 * POST /api/ms-verify   Authorization: Bearer <Firebase ID token>
 *   { action: 'send', code? }
 *       Makes a random secret, keeps only its SHA-256 in
 *       msVerifyPending/{uid}, and has Firebase send its verification email to
 *       the account's address with continueUrl <site>/?msv=<secret>, plus
 *       &c=<code> when the app says which program they were joining, so the
 *       window the link opens in can carry on with that join. The secret is
 *       never returned: it exists only in that email. <site> is the address
 *       the person is using when it is one of this site's own (see
 *       netlify/lib/http.js), else Netlify's URL for the site; never the Host
 *       header, so the link cannot be sent anywhere else. Once a minute, 5 a day.
 *   { action: 'confirm', t }
 *       Checks t against the stored hash (same account, same email, within
 *       an hour, 10 wrong tries at most) and writes msVerified/{uid}.
 *
 * Only Microsoft sign-ins use this; anything else is refused.
 *
 * Env: FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY, and
 * Netlify's own URL. The web API key is the app's public one for the project.
 */
const crypto = require('crypto');
const { db, auth, missingEnv } = require('../lib/firebase-admin');
const { isMicrosoft, isConfirmed } = require('../lib/ms-verify');
const { withCors, ownOrigin } = require('../lib/http');
const { allow, clientIp, HOUR } = require('../lib/rate-limit');

// The same public web API keys the app ships with, per project.
const WEB_KEYS = {
  'jj-playbook-dev': 'AIzaSyBuWZtJiL6Plizs6GkAtZvvipBy9Cs5KJY',
  'test-6b2ab': 'AIzaSyAgcRPj65snd_CxN-zs8v3EXiOsDcLaxI4'
};
const LINK_MS = 60 * 60 * 1000;
const GAP_MS = 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_SENDS = 5;
const MAX_FAILS = 10;

const CORS = {
  'Content-Type': 'application/json'
};
const reply = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });
const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');
// Same as /api/join and the app, character for character.
const cleanCode = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
const same = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

/* Where the emailed link returns: the address the person is using, when it
   is one of this site's own (signed-in state is per address, so the link
   must come back to the same one), else Netlify's URL for the site. Never
   the Host header, and never an address outside that list. */
function siteUrl(event) {
  const own = ownOrigin(event);
  if (own) return own;
  const u = String(process.env.URL || '').replace(/\/+$/, '');
  return /^https:\/\/[a-z0-9.-]+$/i.test(u) ? u : '';
}

exports.handler = withCors('POST, OPTIONS', 'Content-Type, Authorization', async function (event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return reply(405, { error: 'POST only' });
  const missing = missingEnv();
  if (missing.length) return reply(500, { error: 'Server is not configured (' + missing.join(', ') + ')' });
  if ((event.body || '').length > 2000) return reply(413, { error: 'Too long' });
  // Per address, on top of the per-account limits below.
  if (!(await allow('ms-verify', clientIp(event), 30, HOUR)))
    return reply(429, { error: 'Too many tries from here. Wait an hour and try again.', code: 'wait' });

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

    if (body.action === 'send') {
      const site = siteUrl(event);
      const key = WEB_KEYS[process.env.FIREBASE_PROJECT_ID];
      if (!site || !key) return reply(500, { error: 'Server is not configured (URL or project key)' });
      const snap = await ref.get();
      const p = snap.exists ? snap.data() : {};
      if (p.sentAt && now - p.sentAt < GAP_MS)
        return reply(429, { error: 'A link was just sent. Wait a minute before sending another.', code: 'wait' });
      const fresh = !p.windowStart || now - p.windowStart > DAY_MS;
      const sends = fresh ? 0 : (p.sends || 0);
      if (sends >= MAX_SENDS)
        return reply(429, { error: 'Too many links today. Try again tomorrow.', code: 'wait' });

      const secret = crypto.randomBytes(24).toString('base64url');
      await ref.set({ email, hash: sha(secret), exp: now + LINK_MS, sentAt: now,
        sends: sends + 1, windowStart: fresh ? now : p.windowStart, fails: 0 });
      const r = await fetch('https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=' + key, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestType: 'VERIFY_EMAIL', idToken: m[1],
          continueUrl: site + '/?msv=' + secret + (cleanCode(body.code) ? '&c=' + cleanCode(body.code) : '') })
      });
      if (!r.ok) {
        let why = ''; try { why = (await r.json()).error.message; } catch (e) {}
        console.error('ms-verify send', tok.uid, r.status, why);
        await ref.set({ sentAt: 0 }, { merge: true });
        return reply(502, { error: 'Could not send the email. Try again in a moment.' });
      }
      return reply(200, { ok: true, sent: true, email });
    }

    if (body.action === 'confirm') {
      const t = String(body.t || '');
      if (!/^[A-Za-z0-9_-]{20,64}$/.test(t)) return reply(400, { error: 'That link is not valid.', code: 'bad-link' });
      const snap = await ref.get();
      if (!snap.exists) return reply(400, { error: 'That link is not valid any more. Send a new one.', code: 'bad-link' });
      const p = snap.data();
      if (p.email !== email) return reply(400, { error: 'That link was for a different address. Send a new one.', code: 'bad-link' });
      if (!p.exp || now > p.exp) return reply(410, { error: 'That link has expired. Send a new one.', code: 'expired' });
      if (!same(sha(t), String(p.hash || ''))) {
        const fails = (p.fails || 0) + 1;
        if (fails >= MAX_FAILS) await ref.delete(); else await ref.set({ fails }, { merge: true });
        return reply(400, { error: 'That link is not valid. Use the newest email, or send a new one.', code: 'bad-link' });
      }
      await db().collection('msVerified').doc(tok.uid).set({ email, at: now });
      await ref.delete();
      return reply(200, { ok: true, verified: true });
    }

    return reply(400, { error: 'Unknown action' });
  } catch (e) {
    console.error('ms-verify', tok.uid, e);
    return reply(500, { error: 'Could not check your email right now. Try again in a moment.' });
  }
});
