/* The people in a program, for a member of it.
 *
 * V3 lets a member read only their own resp: record, so the app can no
 * longer list resp:CODE:* itself. This does it with the Admin SDK after
 * checking the caller belongs to the program, and returns only what the
 * app's views use: never anyone's answers.
 *
 * GET /api/members?code=CODE
 *   Authorization: Bearer <Firebase ID token>
 *
 * The caller's email comes from the verified token. They must:
 *   - have a verified email, and for a Microsoft sign-in a confirmed
 *     mailbox (msVerified, as /api/join requires);
 *   - have CODE in members/{email}.orgs, a resp:CODE:<slug(email)> record,
 *     and no rev:CODE:<slug(email)>.
 * Admins (not through Microsoft) may ask for any program.
 * Any failed check or read refuses; nothing is returned on a guess.
 *
 * Returns { ok, code, lead, members: [...] }, leaving out the caller,
 * revoked people, __preview__/sample records and records with no name. Each
 * member has: idkey, code, name, avatar, loc {lat,lng,city,region} when they
 * shared it, goals with only shared evidence, and progress as submittedAt
 * only. Program leads (their email in org:CODE's leads list) and admins also
 * get what the org dashboard counts: store, dept, email, lastSeenAt,
 * assessments {ts,total,scores}, tools history {ts,date,num,total},
 * peerRounds {token,openedAt}, and peerAgg for their newest peer round:
 * { token, n, avg } (score averages only; no comments, no one's answers).
 *
 * Env: FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY
 * (see netlify/lib/firebase-admin.js).
 */
const { admin, db, auth, missingEnv } = require('../lib/firebase-admin');
const { isMicrosoft, isConfirmed } = require('../lib/ms-verify');

const COLL = 'jj_playbook';
const ADMINS = ['charlie@jadin-jones.com', 'lucas@jadin-jones.com', 'review@jadin-jones.com'];

const HDR = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, OPTIONS'
};
const reply = (statusCode, body) => ({ statusCode, headers: HDR, body: JSON.stringify(body) });

// Same helpers as the app and /api/join, character for character.
const cleanCode = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
const lower = e => String(e || '').trim().toLowerCase();

function parseVal(snap) {
  if (!snap || !snap.exists) return null;
  const raw = snap.get('value');
  if (typeof raw !== 'string') return null;
  try { const v = JSON.parse(raw); return v && typeof v === 'object' ? v : null; } catch (e) { return null; }
}
const num = n => (typeof n === 'number' && isFinite(n) ? n : undefined);
const str = t => (typeof t === 'string' ? t : '');
const arr = a => (Array.isArray(a) ? a : []);

async function prefix(p) {
  const FP = admin.firestore.FieldPath.documentId();
  const snap = await db().collection(COLL).where(FP, '>=', p).where(FP, '<', p + '').get();
  return snap.docs;
}

/* What every member of the program may see of a colleague. */
function forMember(r, code) {
  const o = { idkey: r.idkey, code, name: str(r.name), avatar: str(r.avatar) };
  const L = r.loc;
  if (L && num(L.lat) !== undefined && num(L.lng) !== undefined)
    o.loc = { lat: L.lat, lng: L.lng, city: str(L.city), region: str(L.region) };
  o.goals = arr(r.goals).filter(g => g && typeof g === 'object').map(g => ({
    id: g.id, beliefId: g.beliefId, to: g.to, rep: str(g.rep), closed: !!g.closed,
    evidence: arr(g.evidence).filter(e => e && e.share !== false).map(e => ({ ts: num(e.ts), text: str(e.text) }))
  }));
  o.progress = {};
  const P = r.progress && typeof r.progress === 'object' ? r.progress : {};
  Object.keys(P).forEach(k => { const p = P[k]; if (p && p.submittedAt) o.progress[k] = { submittedAt: p.submittedAt }; });
  return o;
}

/* What the org dashboard adds for a program lead. */
function forLead(o, r) {
  o.store = str(r.store); o.dept = str(r.dept); o.email = lower(r.email); o.lastSeenAt = num(r.lastSeenAt) || 0;
  o.assessments = arr(r.assessments).filter(a => a && typeof a === 'object')
    .map(a => ({ ts: num(a.ts), total: num(a.total), scores: a.scores && typeof a.scores === 'object' ? a.scores : {} }));
  o.tools = {};
  const T = r.tools && typeof r.tools === 'object' ? r.tools : {};
  Object.keys(T).forEach(k => {
    o.tools[k] = { history: arr(T[k] && T[k].history).filter(h => h && typeof h === 'object')
      .map(h => ({ ts: num(h.ts), date: h.date, num: num(h.num), total: num(h.total) })) };
  });
  o.peerRounds = arr(r.peerRounds).filter(p => p && p.token).map(p => ({ token: String(p.token), openedAt: num(p.openedAt) || 0 }));
  return o;
}

/* Score averages of a peer round's responses, the part the dashboard uses. */
function aggregate(doc) {
  const rs = arr(doc && doc.responses);
  const sums = {}, counts = {};
  rs.forEach(x => {
    const sc = x && x.scores && typeof x.scores === 'object' ? x.scores : {};
    Object.keys(sc).forEach(k => { if (typeof sc[k] === 'number' && isFinite(sc[k])) { sums[k] = (sums[k] || 0) + sc[k]; counts[k] = (counts[k] || 0) + 1; } });
  });
  const avg = {};
  Object.keys(sums).forEach(k => { avg[k] = sums[k] / counts[k]; });
  return { n: rs.length, avg };
}

async function peerDoc(code, token) {
  const col = db().collection(COLL);
  const d = parseVal(await col.doc('peer:' + code + ':' + token).get());
  return d || parseVal(await col.doc('peer:' + token).get());
}

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: HDR, body: '' };
  if (event.httpMethod !== 'GET') return reply(405, { error: 'GET only' });

  const missing = missingEnv();
  if (missing.length) return reply(500, { error: 'Server is not configured (' + missing.join(', ') + ')' });

  const h = event.headers || {};
  const m = /^Bearer\s+(.+)$/i.exec(h.authorization || h.Authorization || '');
  if (!m) return reply(401, { error: 'Sign in first' });
  let tok;
  try { tok = await auth().verifyIdToken(m[1], true); }
  catch (e) { return reply(401, { error: 'Your sign-in has expired. Sign in again.' }); }

  const email = lower(tok.email);
  if (!email) return reply(403, { error: 'Your account has no email address' });
  if (tok.email_verified !== true) return reply(403, { error: 'Verify your email address first', code: 'unverified' });

  const code = cleanCode((event.queryStringParameters || {}).code);
  if (!code) return reply(400, { error: 'No program code' });

  try {
    const ms = isMicrosoft(tok);
    if (ms && !(await isConfirmed(tok.uid, email)))
      return reply(403, { error: 'Confirm your email address first', code: 'ms-verify' });
    const isAdmin = ADMINS.indexOf(email) >= 0 && !ms;
    const idkey = slug(email);
    const col = db().collection(COLL);

    const [orgSnap, memberSnap, ownSnap, ownRev] = await Promise.all([
      col.doc('org:' + code).get(),
      db().collection('members').doc(email).get(),
      col.doc('resp:' + code + ':' + idkey).get(),
      col.doc('rev:' + code + ':' + idkey).get()
    ]);
    const org = parseVal(orgSnap);
    if (!org) return reply(404, { error: 'No program found for ' + code, code: 'no-program' });
    if (!isAdmin) {
      const orgs = memberSnap.exists ? memberSnap.get('orgs') : null;
      if (!Array.isArray(orgs) || orgs.indexOf(code) < 0) return reply(403, { error: 'You are not in this program', code: 'not-member' });
      if (!parseVal(ownSnap)) return reply(403, { error: 'You are not in this program', code: 'not-member' });
      if (parseVal(ownRev)) return reply(403, { error: 'Your access to this program has ended', code: 'revoked' });
    }
    const leads = Array.isArray(org.leads) ? org.leads.map(lower) : [];
    const lead = isAdmin || leads.indexOf(email) >= 0;

    // Revoked in this program: a tombstone for their idkey, or their address
    // listed in any tombstone.
    const revKeys = new Set(), revEmails = new Set();
    (await prefix('rev:' + code + ':')).forEach(d => {
      const v = parseVal(d); if (!v) return;
      revKeys.add(d.id.split(':')[2]);
      [v.email].concat(arr(v.emails)).map(lower).filter(Boolean).forEach(e => revEmails.add(e));
    });

    const out = [];
    for (const d of await prefix('resp:' + code + ':')) {
      const parts = d.id.split(':');
      if (parts.length !== 3) continue;
      const r = parseVal(d);
      const k = parts[2];
      if (!r || !r.name || k === idkey || k === '__preview__' || /^sample-/.test(k)) continue;
      if (revKeys.has(k) || (r.email && revEmails.has(lower(r.email)))) continue;
      r.idkey = k;
      const o = forMember(r, code);
      if (lead) forLead(o, r);
      out.push(o);
    }
    // Leads: each member's newest peer round, read side by side.
    if (lead) await Promise.all(out.map(async o => {
      const newest = o.peerRounds.slice().sort((a, b) => b.openedAt - a.openedAt)[0];
      o.peerAgg = null;
      if (!newest) return;
      const pd = await peerDoc(code, newest.token);
      if (pd) o.peerAgg = Object.assign({ token: newest.token }, aggregate(pd));
    }));
    out.sort((a, b) => a.name.localeCompare(b.name));
    return reply(200, { ok: true, code, lead, members: out });
  } catch (e) {
    console.error('members', code, email, e);
    return reply(500, { error: 'Could not load the program right now. Try again in a moment.' });
  }
};
