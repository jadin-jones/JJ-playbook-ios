/* Email invites to Twin Thieves Leadership, sent from Studio.
 *
 * POST /api/tt-invite   Authorization: Bearer <Firebase ID token of an admin>
 *   { action:'send',    program:'TT36'|'TT10', emails:[...] }   up to 100
 *   { action:'resend',  program, email }      a fresh link; the old one stops working
 *   { action:'cancel',  program, email }
 *   { action:'preview', program }             the email as it would look, sample values
 *   { action:'restore', program, emails:[...] } give removed members their access back
 *   { action:'lastopened', emails:[...] }      up to 200: when each Twin Thieves
 *       member last used the app → { ok, times:{ email: ms or null } }
 *
 * Last opened (Studio's member list). The time is Firebase Auth's own
 * record of the account (lastRefreshTime: the app renews a sign-in when it
 * is opened and about hourly while it stays open; else lastSignInTime). An
 * address is answered only when its ttmembers/{email}.orgs holds TT36 or
 * TT10 today; any other address is left out, so this never reports on
 * someone outside Twin Thieves. Nothing is written or stored (apart from
 * the rate limit's own count), and nothing is logged about the addresses.
 *
 * Removed members. Studio's Remove writes rev:<program>:<idkey> (the marker
 * /api/tt-join refuses, so the code alone can't bring them back) and takes
 * the program out of ttmembers/{email}.orgs. Any one admin action restores
 * them: send or resend an invite to that address, save the program's
 * approved list with that address on it (Studio then calls restore), or
 * Studio's Restore access. Restoring re-adds the program to their
 * ttmembers (arrayUnion: their other programs and the Playbook are not
 * touched), keeps their ttm: record and its progress (or makes an empty one
 * if a Remove from before 12 Oct 2026 deleted it), and only then deletes
 * the marker.
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
 * Mail goes through netlify/lib/mailer.js, the same Workspace mailbox as the
 * Microsoft code email (SMTP_USER, SMTP_PASS, MAIL_FROM). It shows the
 * product's fromName with that mailbox's address, and replies go to the
 * product's fromEmail (invite-products.js).
 *
 * Env: FIREBASE_*, INVITE_SEND_MODE, INVITE_TEST_RECIPIENTS, SMTP_USER,
 * SMTP_PASS, MAIL_FROM, URL.
 */
const crypto = require('crypto');
const { admin, db, auth, missingEnv } = require('../lib/firebase-admin');
const { isMicrosoft } = require('../lib/ms-verify');
const { withCors, ownOrigin } = require('../lib/http');
const { ADMINS } = require('../lib/admins');
const { allow, clientIp, HOUR } = require('../lib/rate-limit');
const { render, PRODUCTS } = require('../lib/invite-email');
const { sendMail, missingMailEnv } = require('../lib/mailer');

const COLL = 'jj_playbook';
const PRODUCT = 'tt';
const MAX_PER_CALL = 100;
const MAX_LAST = 200, TT_PROGRAMS = ['TT36', 'TT10'];
const HDR = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
const reply = (statusCode, body) => ({ statusCode, headers: HDR, body: JSON.stringify(body) });

const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const cleanEmail = e => { const s = String(e || '').trim().toLowerCase(); return /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(s) ? s : ''; };
const inviteId = (program, email) => 'ttinv:' + program + ':' + sha(email).slice(0, 32);
// Same as the app and /api/tt-join, character for character.
const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
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

/* When each Twin Thieves member among emails last used the app (ms, or null
   when Auth has no time or no account). Reads ttmembers and Auth only. */
async function lastOpened(emails) {
  const snaps = await Promise.all(emails.map(e => db().collection('ttmembers').doc(e).get()));
  const tt = emails.filter((e, i) => { const o = snaps[i].exists ? snaps[i].get('orgs') : null;
    return Array.isArray(o) && o.some(c => TT_PROGRAMS.indexOf(c) >= 0); });
  const times = {};
  tt.forEach(e => { times[e] = null; });
  const ms = t => { const n = Date.parse(t || ''); return isFinite(n) ? n : 0; };
  for (let i = 0; i < tt.length; i += 100) {
    const res = await auth().getUsers(tt.slice(i, i + 100).map(email => ({ email })));
    (res.users || []).forEach(u => {
      const e = String(u.email || '').toLowerCase(); if (!(e in times)) return;
      const md = u.metadata || {}, t = Math.max(ms(md.lastRefreshTime), ms(md.lastSignInTime));
      if (t && t > (times[e] || 0)) times[e] = t; });
  }
  return times;
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
    if (missingMailEnv().length) return { email, result: 'no-mail-setup' };
    try { await sendMail({ to: email, subject: mail.subject, text: mail.text, html: mail.html, replyTo: p.fromEmail, fromName: p.fromName }); delivery = 'sent'; }
    // mailer.js errors never hold the password.
    catch (e) { console.error('tt-invite send', e && e.message); return { email, result: 'send-failed' }; }
  } else {
    console.log('tt-invite (sending off): to', email, '| subject:', mail.subject, '| link not logged');
  }
  const ref = col.doc(inviteId(program, email));
  const prev = parseVal(await ref.get());
  await ref.set({ value: JSON.stringify({ email, program, status: 'invited', sentAt: now, expiresAt, joinedAt: null,
    delivery, sendCount: ((prev && prev.sendCount) || 0) + 1 }), tokenHash: sha(secret) });
  return { email, result: delivery === 'sent' ? 'sent' : 'recorded-not-sent', expiresAt };
}

/* Give a removed member their access to one program back. Returns
   'restored', or 'not-removed' when there is no marker. The marker goes
   last, so a failure part-way leaves them still removed (safe to retry). */
async function restoreMember(col, program, email) {
  const idkey = slug(email);
  const rref = col.doc('rev:' + program + ':' + idkey);
  const rsnap = await rref.get();
  if (!rsnap.exists) return 'not-removed';
  const rv = parseVal(rsnap) || {};
  const tref = col.doc('ttm:' + program + ':' + idkey);
  await db().runTransaction(async tx => {
    const t = await tx.get(tref);
    if (!t.exists) tx.set(tref, { value: JSON.stringify({ name: String(rv.name || ''), email, idkey, code: program,
      joinedAt: Date.now(), progress: {} }), ownerEmail: email });
    else if (t.get('ownerEmail') !== email) tx.set(tref, { ownerEmail: email }, { merge: true });
  });
  await db().collection('ttmembers').doc(email).set({
    email, orgs: admin.firestore.FieldValue.arrayUnion(program),
    updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
  await rref.delete();
  return 'restored';
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
  if (body.action === 'lastopened') {
    const raw = Array.isArray(body.emails) ? body.emails : [];
    if (raw.length > MAX_LAST) return reply(400, { error: 'Up to ' + MAX_LAST + ' addresses at a time' });
    const emails = Array.from(new Set(raw.map(cleanEmail).filter(Boolean)));
    try { return reply(200, { ok: true, times: await lastOpened(emails) }); }
    catch (e) { console.error('tt-invite lastopened', e && (e.code || e.name)); return reply(502, { error: 'Could not read last opened. Try again in a moment.' }); }
  }
  const program = String(body.program || '');
  if (!PRODUCTS[PRODUCT].programs[program]) return reply(400, { error: 'Pick the 36- or 10-lesson version' });
  const mode = sendMode(), site = siteUrl(event);
  if (!site) return reply(500, { error: 'Server is not configured (site address)' });
  const col = db().collection(COLL);

  try {
    if (body.action === 'preview') {
      const org = parseVal(await col.doc('org:' + program).get());
      const code = (org && org.joinCode) || 'TWIN' + PRODUCTS[PRODUCT].programs[program].lessonCount;
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
        // A removed member is restored by the invite itself, then emailed it.
        if ((await restoreMember(col, program, email)) === 'restored') {
          const cur0 = parseVal(await col.doc(inviteId(program, email)).get());
          if (cur0 && cur0.status === 'invited' && cur0.expiresAt > Date.now()) { results.push({ email, result: 'restored' }); continue; }
          const r = await inviteOne(program, email, site, tok.uid, mode);
          results.push(Object.assign({}, r, { result: r.result === 'sent' || r.result === 'recorded-not-sent' ? 'restored-' + r.result : 'restored' }));
          continue;
        }
        const mem = await db().collection('ttmembers').doc(email).get();
        const orgs = mem.exists ? mem.get('orgs') : null;
        if (Array.isArray(orgs) && orgs.indexOf(program) >= 0) { results.push({ email, result: 'already-a-member' }); continue; }
        const cur = parseVal(await col.doc(inviteId(program, email)).get());
        if (cur && cur.status === 'invited' && cur.expiresAt > Date.now()) { results.push({ email, result: 'already-invited' }); continue; }
        results.push(await inviteOne(program, email, site, tok.uid, mode));
      }
      return reply(200, { ok: true, mode, results });
    }

    if (body.action === 'restore') {
      const raw = Array.isArray(body.emails) ? body.emails : [];
      if (!raw.length) return reply(400, { error: 'No email' });
      if (raw.length > MAX_PER_CALL) return reply(400, { error: 'Up to ' + MAX_PER_CALL + ' addresses at a time' });
      const results = [];
      for (const r of raw) {
        const email = cleanEmail(r);
        if (!email) { results.push({ email: String(r || '').trim().slice(0, 120), result: 'not-an-email' }); continue; }
        results.push({ email, result: await restoreMember(col, program, email) });
      }
      return reply(200, { ok: true, results });
    }

    const email = cleanEmail(body.email);
    if (!email) return reply(400, { error: 'No email' });
    const ref = col.doc(inviteId(program, email));
    const cur = parseVal(await ref.get());
    // Resending to a removed member restores them first, even if the old invite was used.
    const restored = body.action === 'resend' ? (await restoreMember(col, program, email)) === 'restored' : false;
    if (!cur && !restored) return reply(404, { error: 'No invite for ' + email });

    if (body.action === 'resend') {
      if (!restored && cur.status === 'joined') return reply(409, { error: email + ' has already joined' });
      const r = await inviteOne(program, email, site, tok.uid, mode);
      return reply(200, { ok: true, mode, results: [restored ? Object.assign({}, r, { result: 'restored-' + r.result }) : r] });
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
module.exports._restoreMember = restoreMember;
