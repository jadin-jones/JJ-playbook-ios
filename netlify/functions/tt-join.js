/* Join Twin Thieves Leadership with its code.
 *
 * POST /api/tt-join   Authorization: Bearer <Firebase ID token>
 *   { code, first, last }
 *
 * Twin Thieves has two programs, TT36 (all 36 lessons) and TT10 (10 of
 * them). Each org:TTxx record holds its join code (joinCode), whether it is
 * switched off (joinDisabled) and an optional email-domain limit
 * (joinDomain). Codes are compared without regard to case. There is no
 * approved-email list: anyone with a working code joins.
 *
 * The caller must have a verified email, and a Microsoft sign-in a confirmed
 * mailbox (as /api/join). Calls are rate-limited per account and per
 * address. On success:
 *   - the program id is added to ttmembers/{email}.orgs (arrayUnion), which
 *     is what the Twin Thieves rules check. It is deliberately NOT
 *     members/{email}: that list opens the Playbook's rules, so a Twin
 *     Thieves-only member has no members document and no Playbook access;
 *   - ttm:TTxx:<slug(email)> is created if missing, holding only the name,
 *     email and progress (members may be students; nothing else is kept);
 *   - it answers { ok, code: 'TT36'|'TT10', version: 36|10, name }.
 * Or { invite, first, last }: the secret from an emailed invite link
 * (/api/tt-invite). It is accepted once, before it expires, and only when
 * the signed-in address is the invited one; it then joins the invite's
 * program (even if the code is switched off or domain-limited, since an
 * admin asked for this person) and marks the invite joined. Failures answer
 * invite-invalid, invite-used, invite-cancelled, invite-expired or
 * invite-email; the join code in the email still works.
 * A code join also marks any open invite for that address and program
 * joined.
 * A rev: tombstone for that program refuses the join. A code that matches
 * no Twin Thieves program answers 404 code 'no-code', so the app can say
 * "No program found" as it does for Playbook codes.
 *
 * Env: FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY.
 */
const { admin, db, auth, missingEnv } = require('../lib/firebase-admin');
const { isMicrosoft, isConfirmed } = require('../lib/ms-verify');
const { withCors } = require('../lib/http');
const { allow, clientIp, HOUR } = require('../lib/rate-limit');

const COLL = 'jj_playbook';
const PROGRAMS = ['TT36', 'TT10'];
const HDR = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
const reply = (statusCode, body) => ({ statusCode, headers: HDR, body: JSON.stringify(body) });

// Same helpers as the app and /api/join, character for character.
const cleanCode = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 20);
const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
const cleanName = s => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 60);
const crypto = require('crypto');
const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const inviteId = (program, email) => 'ttinv:' + program + ':' + sha(email).slice(0, 32);
function parseVal(snap) {
  if (!snap || !snap.exists) return null;
  const raw = snap.get('value');
  if (typeof raw !== 'string') return null;
  try { const v = JSON.parse(raw); return v && typeof v === 'object' ? v : null; } catch (e) { return null; }
}

/* Membership (ttmembers, which the Twin Thieves rules check) and the record
   (ttm:, name, email and progress only), created if missing. */
async function joinProgram(col, id, email, idkey, name) {
  await db().collection('ttmembers').doc(email).set({
    email,
    orgs: admin.firestore.FieldValue.arrayUnion(id),
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });
  const ref = col.doc('ttm:' + id + ':' + idkey);
  await db().runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (snap.exists) return;
    tx.set(ref, { value: JSON.stringify({ name, email, idkey, code: id, joinedAt: Date.now(), progress: {} }), ownerEmail: email });
  });
}

exports.handler = withCors('POST, OPTIONS', 'Content-Type, Authorization', async function (event) {
  if (event.httpMethod !== 'POST') return reply(405, { error: 'POST only' });
  const missing = missingEnv();
  if (missing.length) return reply(500, { error: 'Server is not configured (' + missing.join(', ') + ')' });
  if ((event.body || '').length > 2000) return reply(413, { error: 'Too long' });

  if (!(await allow('tt-join-ip', clientIp(event), 60, HOUR)))
    return reply(429, { error: 'Too many tries from here. Wait a while and try again.', code: 'wait' });

  const h = event.headers || {};
  const m = /^Bearer\s+(.+)$/i.exec(h.authorization || h.Authorization || '');
  if (!m) return reply(401, { error: 'Sign in first' });
  let tok;
  try { tok = await auth().verifyIdToken(m[1], true); }
  catch (e) { return reply(401, { error: 'Your sign-in has expired. Sign in again.' }); }
  const email = String(tok.email || '').trim().toLowerCase();
  if (!email) return reply(403, { error: 'Your account has no email address' });
  if (tok.email_verified !== true) return reply(403, { error: 'Verify your email address first', code: 'unverified' });
  if (!(await allow('tt-join-uid', tok.uid, 20, HOUR)))
    return reply(429, { error: 'Too many tries. Wait a while and try again.', code: 'wait' });

  let body;
  try { body = JSON.parse(event.body || '{}') || {}; } catch (e) { return reply(400, { error: 'Bad JSON' }); }
  const typed = cleanCode(body.code);
  const invite = String(body.invite || '').trim();
  if (!typed && !invite) return reply(400, { error: 'Enter your code' });
  const first = cleanName(body.first), last = cleanName(body.last);
  if (!first || !last) return reply(400, { error: 'Enter your first and last name' });

  try {
    if (isMicrosoft(tok) && !(await isConfirmed(tok.uid, email)))
      return reply(403, { error: 'Confirm your email address first: we sent a link to ' + email + '.', code: 'ms-verify' });

    const col = db().collection(COLL);
    const idkey = slug(email), name = first + ' ' + last;

    // An emailed invite: once, unexpired, for the invited address only.
    if (invite) {
      const bad = (code, error) => reply(code === 'invite-email' ? 403 : (code === 'invite-invalid' ? 404 : 410), { error, code });
      if (!/^[A-Za-z0-9_-]{20,80}$/.test(invite)) return bad('invite-invalid', "This invite link isn't valid. Use the join code from the email instead.");
      const q = await col.where('tokenHash', '==', sha(invite)).limit(2).get();
      const hits = q.docs.filter(d => d.id.indexOf('ttinv:') === 0);
      if (hits.length !== 1) return bad('invite-invalid', "This invite link isn't valid any more. Use the join code from the email instead.");
      const iref = col.doc(hits[0].id);
      const claimed = await db().runTransaction(async tx => {
        const snap = await tx.get(iref);
        const inv = parseVal(snap);
        if (!inv || snap.get('tokenHash') !== sha(invite)) return { code: 'invite-invalid', error: "This invite link isn't valid any more. Use the join code from the email instead." };
        if (inv.status === 'joined') return { code: 'invite-used', error: 'This invite has already been used. Sign in to open Twin Thieves Leadership.' };
        if (inv.status === 'cancelled') return { code: 'invite-cancelled', error: 'This invite was cancelled. Ask the Jadin | Jones Team for a new one.' };
        if (!(inv.expiresAt > Date.now())) return { code: 'invite-expired', error: 'This invite has expired. Use the join code from the email, or ask for a new invite.' };
        if (String(inv.email || '').toLowerCase() !== email) return { code: 'invite-email', error: 'This invite is for ' + inv.email + '. Sign in with that address, or use the join code from the email.' };
        if (PROGRAMS.indexOf(inv.program) < 0) return { code: 'invite-invalid', error: "This invite link isn't valid." };
        if (parseVal(await tx.get(col.doc('rev:' + inv.program + ':' + idkey)))) return { code: 'revoked', error: 'Your access to Twin Thieves Leadership has ended.' };
        tx.set(iref, { value: JSON.stringify(Object.assign({}, inv, { status: 'joined', joinedAt: Date.now() })), tokenHash: '' });
        return { program: inv.program };
      });
      if (!claimed.program) return claimed.code === 'revoked' ? reply(403, { error: claimed.error, code: 'revoked' }) : bad(claimed.code, claimed.error);
      const org = parseVal(await col.doc('org:' + claimed.program).get());
      if (!org || org.product !== 'tt') return reply(404, { error: 'No program found', code: 'no-code' });
      await joinProgram(col, claimed.program, email, idkey, name);
      return reply(200, { ok: true, code: claimed.program, version: Number(org.ttVersion) === 10 ? 10 : 36, name, invited: true });
    }

    const orgs = await Promise.all(PROGRAMS.map(id => col.doc('org:' + id).get()));
    const hit = orgs.map((snap, i) => ({ id: PROGRAMS[i], org: parseVal(snap) }))
      .find(x => x.org && x.org.product === 'tt' && typeof x.org.joinCode === 'string' && x.org.joinCode
        && cleanCode(x.org.joinCode) === typed);
    if (!hit) return reply(404, { error: 'No program found for ' + typed, code: 'no-code' });
    const { id, org } = hit;
    const label = org.name || 'Twin Thieves Leadership';
    if (org.joinDisabled === true) return reply(403, { error: 'That code is switched off. Ask whoever gave it to you for the current one.', code: 'disabled' });
    const domain = String(org.joinDomain || '').trim().toLowerCase().replace(/^@/, '');
    if (domain && !email.endsWith('@' + domain))
      return reply(403, { error: label + ' is only for @' + domain + ' addresses. Sign in with that email.', code: 'domain' });

    if (parseVal(await col.doc('rev:' + id + ':' + idkey).get()))
      return reply(403, { error: 'Your access to ' + label + ' has ended.', code: 'revoked' });

    await joinProgram(col, id, email, idkey, name);
    // An open invite for this address and version counts as used.
    try {
      const iref = col.doc(inviteId(id, email)), inv = parseVal(await iref.get());
      if (inv && inv.status === 'invited') await iref.set({ value: JSON.stringify(Object.assign({}, inv, { status: 'joined', joinedAt: Date.now() })), tokenHash: '' });
    } catch (e) { console.error('tt-join invite mark', e && e.code); }
    return reply(200, { ok: true, code: id, version: Number(org.ttVersion) === 10 ? 10 : 36, name });
  } catch (e) {
    console.error('tt-join', e && (e.code || e.name));
    return reply(500, { error: 'Could not join right now. Try again in a moment.' });
  }
});
