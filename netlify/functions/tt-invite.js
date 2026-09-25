/* Email invites to Twin Thieves Leadership, sent from Studio.
 *
 * POST /api/tt-invite   Authorization: Bearer <Firebase ID token of an admin>
 *   { action:'send',    program:'TT36'|'TT10', emails:[...] }   up to 100
 *   { action:'resend',  program, email }      a fresh link; the old one stops working
 *   { action:'cancel',  program, email }
 *   { action:'preview', program }             the email as it would look, sample values
 *
 * Only admins (not through Microsoft) may call it. 30 calls an hour per
 * connection, and 200 invite emails an hour per admin.
 *
 * Each invite is jj_playbook/ttinv:<program>:<sha256(email) first 32>, holding
 * only the email and the invite's status: { email, program, status, sentAt,
 * expiresAt, joinedAt, delivery, sendCount }, plus a top-level tokenHash:
 * the SHA-256 of the link's secret. The secret itself exists only in the
 * email. The link is <site>/?tti=<secret>&ttc=<code>; /api/tt-join accepts it
 * once, before it expires (linkDays in invite-products.js), and only for the
 * invited address.
 *
 * Sending follows INVITE_SEND_MODE, and anything but these fails closed:
 *   off  (or unset)  nothing is sent. The invite is recorded with
 *                    delivery 'off' and the email logged without its link.
 *   test             sent only to addresses in INVITE_TEST_RECIPIENTS
 *                    (comma-separated); any other address is refused, not
 *                    recorded.
 *   on               sent to anyone.
 * Mail goes through INVITE_SMTP_URL (a Google Workspace app password for the
 * sender in invite-products.js).
 *
 * Env: FIREBASE_*, INVITE_SEND_MODE, INVITE_TEST_RECIPIENTS, INVITE_SMTP_URL, URL.
 */
const crypto = require('crypto');
const { db, auth, missingEnv } = require('../lib/firebase-admin');
const { isMicrosoft } = require('../lib/ms-verify');
const { withCors, ownOrigin } = require('../lib/http');
const { ADMINS } = require('../lib/admins');
const { allow, clientIp, HOUR } = require('../lib/rate-limit');
const { render, PRODUCTS } = require('../lib/invite-email');

const COLL = 'jj_playbook';
const PRODUCT = 'tt';
const MAX_PER_CALL = 100;
const HDR = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
const reply = (statusCode, body) => ({ statusCode, headers: HDR, body: JSON.stringify(body) });

const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const cleanEmail = e => { const s = String(e || '').trim().toLowerCase(); return /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(s) ? s : ''; };
const inviteId = (program, email) => 'ttinv:' + program + ':' + sha(email).slice(0, 32);
function parseVal(snap) {
  if (!snap || !snap.exists) return null;
  const raw = snap.get('value');
  if (typeof raw !== 'string') return null;
  try { const v = JSON.parse(raw); return v && typeof v === 'object' ? v : null; } catch (e) { return null; }
}
function sendMode() {
  const m = String(process.env.INVITE_SEND_MODE || '').trim().toLowerCase();
  return m === 'on' || m === 'test' ? m : 'off';
}
const testList = () => String(process.env.INVITE_TEST_RECIPIENTS || '').split(',').map(cleanEmail).filter(Boolean);
function siteUrl(event) {
  const own = ownOrigin(event);
  if (own) return own;
  const u = String(process.env.URL || '').replace(/\/+$/, '');
  return /^https:\/\/[a-z0-9.-]+$/i.test(u) ? u : '';
}

let transport = null;
function mailer() {
  if (transport) return transport;
  const url = String(process.env.INVITE_SMTP_URL || '');
  if (!url) return null;
  transport = require('nodemailer').createTransport(url);
  return transport;
}

/* Record (and, if the mode allows, send) one invite. Returns { email, result }. */
async function inviteOne(program, email, site, uid, mode) {
  const p = PRODUCTS[PRODUCT];
  const col = db().collection(COLL);
  const org = parseVal(await col.doc('org:' + program).get());
  if (!org || org.product !== 'tt' || !org.joinCode) return { email, result: 'no-program' };
  if (mode === 'test' && testList().indexOf(email) < 0) return { email, result: 'not-a-test-recipient' };
  if (!(await allow('tt-invite-mail', uid, 200, HOUR))) return { email, result: 'rate-limited' };
  const secret = crypto.randomBytes(32).toString('base64url');
  const now = Date.now(), expiresAt = now + p.linkDays * 24 * 60 * 60 * 1000;
  const link = site + '/?tti=' + secret + '&ttc=' + encodeURIComponent(org.joinCode);
  const mail = render(PRODUCT, program, { email, link, code: org.joinCode, site, expiresAt });
  let delivery = 'off';
  if (mode === 'on' || mode === 'test') {
    const t = mailer();
    if (!t) return { email, result: 'no-mail-setup' };
    try { await t.sendMail({ from: mail.from, replyTo: p.fromEmail, to: email, subject: mail.subject, text: mail.text, html: mail.html }); delivery = 'sent'; }
    catch (e) { console.error('tt-invite send', e && (e.code || e.responseCode)); return { email, result: 'send-failed' }; }
  } else {
    console.log('tt-invite (sending off): to', email, '| subject:', mail.subject, '| link not logged');
  }
  const ref = col.doc(inviteId(program, email));
  const prev = parseVal(await ref.get());
  await ref.set({ value: JSON.stringify({ email, program, status: 'invited', sentAt: now, expiresAt, joinedAt: null,
    delivery, sendCount: ((prev && prev.sendCount) || 0) + 1 }), tokenHash: sha(secret) });
  return { email, result: delivery === 'sent' ? 'sent' : 'recorded-not-sent', expiresAt };
}

exports.handler = withCors('POST, OPTIONS', 'Content-Type, Authorization', async function (event) {
  if (event.httpMethod !== 'POST') return reply(405, { error: 'POST only' });
  const missing = missingEnv();
  if (missing.length) return reply(500, { error: 'Server is not configured (' + missing.join(', ') + ')' });
  if ((event.body || '').length > 20000) return reply(413, { error: 'Too long' });
  if (!(await allow('tt-invite-ip', clientIp(event), 30, HOUR))) return reply(429, { error: 'Too many requests. Try again later.', code: 'wait' });

  const h = event.headers || {};
  const m = /^Bearer\s+(.+)$/i.exec(h.authorization || h.Authorization || '');
  if (!m) return reply(401, { error: 'Sign in first' });
  let tok;
  try { tok = await auth().verifyIdToken(m[1], true); }
  catch (e) { return reply(401, { error: 'Your sign-in has expired. Sign in again.' }); }
  const me = String(tok.email || '').trim().toLowerCase();
  if (tok.email_verified !== true || ADMINS.indexOf(me) < 0 || isMicrosoft(tok)) return reply(403, { error: 'Admins only' });

  let body;
  try { body = JSON.parse(event.body || '{}') || {}; } catch (e) { return reply(400, { error: 'Bad JSON' }); }
  const program = String(body.program || '');
  if (!PRODUCTS[PRODUCT].programs[program]) return reply(400, { error: 'Pick the 36- or 10-lesson version' });
  const mode = sendMode(), site = siteUrl(event);
  if (!site) return reply(500, { error: 'Server is not configured (site address)' });
  const col = db().collection(COLL);

  try {
    if (body.action === 'preview') {
      const org = parseVal(await col.doc('org:' + program).get());
      const code = (org && org.joinCode) || 'TWINTHIEVES' + PRODUCTS[PRODUCT].programs[program].lessonCount;
      const mail = render(PRODUCT, program, { email: 'student@example.org', link: site + '/?tti=PREVIEW&ttc=' + code, code, site,
        expiresAt: Date.now() + PRODUCTS[PRODUCT].linkDays * 86400000 });
      return reply(200, { ok: true, mode, subject: mail.subject, html: mail.html, text: mail.text });
    }

    if (body.action === 'send') {
      const raw = Array.isArray(body.emails) ? body.emails : [];
      if (raw.length > MAX_PER_CALL) return reply(400, { error: 'Up to ' + MAX_PER_CALL + ' addresses at a time' });
      const seen = new Set(), results = [];
      for (const r of raw) {
        const email = cleanEmail(r);
        if (!email) { if (String(r || '').trim()) results.push({ email: String(r).trim().slice(0, 120), result: 'not-an-email' }); continue; }
        if (seen.has(email)) { results.push({ email, result: 'duplicate' }); continue; }
        seen.add(email);
        const mem = await db().collection('ttmembers').doc(email).get();
        const orgs = mem.exists ? mem.get('orgs') : null;
        if (Array.isArray(orgs) && orgs.indexOf(program) >= 0) { results.push({ email, result: 'already-a-member' }); continue; }
        const cur = parseVal(await col.doc(inviteId(program, email)).get());
        if (cur && cur.status === 'invited' && cur.expiresAt > Date.now()) { results.push({ email, result: 'already-invited' }); continue; }
        results.push(await inviteOne(program, email, site, tok.uid, mode));
      }
      return reply(200, { ok: true, mode, results });
    }

    const email = cleanEmail(body.email);
    if (!email) return reply(400, { error: 'No email' });
    const ref = col.doc(inviteId(program, email));
    const cur = parseVal(await ref.get());
    if (!cur) return reply(404, { error: 'No invite for ' + email });

    if (body.action === 'resend') {
      if (cur.status === 'joined') return reply(409, { error: email + ' has already joined' });
      const r = await inviteOne(program, email, site, tok.uid, mode);
      return reply(200, { ok: true, mode, results: [r] });
    }
    if (body.action === 'cancel') {
      if (cur.status === 'joined') return reply(409, { error: email + ' has already joined' });
      await ref.set({ value: JSON.stringify(Object.assign({}, cur, { status: 'cancelled' })), tokenHash: '' });
      return reply(200, { ok: true });
    }
    return reply(400, { error: 'Unknown action' });
  } catch (e) {
    console.error('tt-invite', e && (e.code || e.name));
    return reply(500, { error: 'Could not do that right now. Try again in a moment.' });
  }
});

module.exports._inviteId = inviteId;
