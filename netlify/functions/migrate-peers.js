/* One-off: move peer and team rounds from peer:TOKEN to peer:CODE:TOKEN.
 *
 * V3 rules check the program in the second part of a key, and old rounds have
 * the token there, so only admins can reach them. This moves each one to its
 * new key, adding the top-level peerToken (how /api/peer finds a round from a
 * link) and ownerEmail (the leader who opened it).
 *
 * POST /api/admin/migrate-peers
 *   Authorization: Bearer <Firebase ID token of an admin>
 *   { run: false }                  dry run (the default): reports, changes nothing
 *   { run: true, tokens: [...] }    moves only these tokens, the ones the dry
 *                                   run listed as ready
 *
 * Each round is checked, not guessed. It is skipped and reported when:
 *   - its record is unreadable, or names no program code   (no-code)
 *   - that program no longer exists                        (no-program)
 *   - no owner email can be found from the leader's record (no-owner)
 *   - peer:CODE:TOKEN already exists                       (target-exists)
 *   - another round already carries that peerToken         (token-in-use)
 * On a run, every check is made again. A round that is ready now but was not
 * in the dry run's list is reported (not-in-dry-run), not moved; a listed
 * token no longer at an old key is reported too (gone).
 * A ready round is copied and the old copy deleted in one transaction, which
 * re-reads the old copy so an answer arriving mid-run is not lost. Running it
 * again is harmless: moved rounds are no longer at an old key.
 *
 * Remove this function, its redirect and the Studio card once live has been
 * migrated.
 */
const { admin, db, auth, missingEnv } = require('../lib/firebase-admin');

const COLL = 'jj_playbook';
const ADMINS = ['charlie@jadin-jones.com', 'lucas@jadin-jones.com', 'review@jadin-jones.com'];
const MAX_ROUNDS = 400;   // one call's worth; run again for more

const JSON_HDR = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
const reply = (statusCode, body) => ({ statusCode, headers: JSON_HDR, body: JSON.stringify(body) });

// Same helper as the app and /api/join.
const cleanCode = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);

function parseVal(snap) {
  if (!snap || !snap.exists) return null;
  const raw = snap.get('value');
  if (typeof raw !== 'string') return null;
  try { const v = JSON.parse(raw); return v && typeof v === 'object' ? v : null; } catch (e) { return null; }
}
const cleanEmail = e => {
  const s = String(e || '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : '';
};

/* What would happen to one old round. Returns { ready, ... } or a skip. */
async function plan(snap) {
  const col = db().collection(COLL);
  const token = snap.id.split(':')[1];
  const doc = parseVal(snap);
  const base = { from: snap.id, token };
  if (!doc) return Object.assign(base, { skip: 'no-code', detail: 'record is empty or unreadable' });
  const code = cleanCode(doc.code);
  if (!code) return Object.assign(base, { skip: 'no-code', detail: 'round names no program' });
  Object.assign(base, { to: 'peer:' + code + ':' + token, code, mode: doc.mode === 'team' ? 'team' : 'peer',
    responses: Array.isArray(doc.responses) ? doc.responses.length : 0, closed: !!doc.closed });

  const orgSnap = await col.doc('org:' + code).get();
  const org = parseVal(orgSnap);
  if (!org) return Object.assign(base, { skip: 'no-program', detail: 'no org:' + code });
  base.orgName = org.name || code;

  // The owner is the leader who opened it: their own record says who they are.
  let owner = cleanEmail(doc.ownerEmail);
  if (!owner && doc.idkey) {
    const respSnap = await col.doc('resp:' + code + ':' + doc.idkey).get();
    const resp = parseVal(respSnap);
    owner = cleanEmail(respSnap.exists && respSnap.get('ownerEmail')) || cleanEmail(resp && resp.email);
  }
  if (!owner) return Object.assign(base, { skip: 'no-owner', detail: doc.idkey ? 'no email on resp:' + code + ':' + doc.idkey : 'round names no leader' });
  base.owner = owner;

  if ((await col.doc(base.to).get()).exists) return Object.assign(base, { skip: 'target-exists', detail: base.to + ' already exists' });
  const clash = await col.where('peerToken', '==', token).limit(1).get();
  if (!clash.empty) return Object.assign(base, { skip: 'token-in-use', detail: clash.docs[0].id + ' carries this token' });

  return Object.assign(base, { ready: true });
}

async function move(p) {
  const col = db().collection(COLL);
  const from = col.doc(p.from), to = col.doc(p.to);
  return db().runTransaction(async tx => {
    const [f, t] = await Promise.all([tx.get(from), tx.get(to)]);
    const doc = parseVal(f);
    if (!doc) return 'gone';
    if (t.exists) return 'target-exists';
    doc.ownerEmail = p.owner;   // inside too, so the app's saves keep it
    tx.set(to, {
      value: JSON.stringify(doc),
      peerToken: p.token,
      ownerEmail: p.owner,
      migratedFrom: p.from,
      migratedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    tx.delete(from);
    return 'moved';
  });
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') return reply(405, { error: 'POST only' });
  const missing = missingEnv();
  if (missing.length) return reply(500, { error: 'Server is not configured (' + missing.join(', ') + ')' });

  const h = event.headers || {};
  const m = /^Bearer\s+(.+)$/i.exec(h.authorization || h.Authorization || '');
  if (!m) return reply(401, { error: 'Sign in first' });
  let tok;
  try { tok = await auth().verifyIdToken(m[1], true); }
  catch (e) { return reply(401, { error: 'Your sign-in has expired. Sign in again.' }); }
  const email = String(tok.email || '').trim().toLowerCase();
  if (tok.email_verified !== true || ADMINS.indexOf(email) < 0) return reply(403, { error: 'Admins only' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch (e) { return reply(400, { error: 'Bad JSON' }); }
  const run = body.run === true;
  // A run moves only what the dry run showed; without that list, nothing.
  let listed = null;
  if (run) {
    const t = body.tokens;
    if (!Array.isArray(t) || !t.length || t.length > MAX_ROUNDS
      || !t.every(x => typeof x === 'string' && /^[A-Z0-9]{4,16}$/.test(x))) {
      return reply(400, { error: 'Run the dry run first: a run needs its list of ready rounds' });
    }
    listed = new Set(t);
  }

  try {
    const FP = admin.firestore.FieldPath.documentId();
    // Every id from "peer:" up to "peer;" (the next character after ':').
    const snap = await db().collection(COLL).where(FP, '>=', 'peer:').where(FP, '<', 'peer;').get();
    const old = snap.docs.filter(d => d.id.split(':').length === 2);
    const batch = old.slice(0, MAX_ROUNDS);

    const plans = [];
    for (const d of batch) plans.push(await plan(d));
    if (listed) {
      plans.forEach(p => { if (p.ready && !listed.has(p.token)) {
        p.ready = false; p.skip = 'not-in-dry-run'; p.detail = 'not in dry run — run again';
      } });
      const seen = new Set(plans.map(p => p.token));
      listed.forEach(t => { if (!seen.has(t)) plans.push({ from: 'peer:' + t, token: t,
        skip: 'gone', detail: 'listed in the dry run, but no longer at an old key' }); });
    }
    const ready = plans.filter(p => p.ready);
    const skipped = plans.filter(p => !p.ready);

    const results = [];
    if (run) {
      for (const p of ready) {
        let outcome;
        try { outcome = await move(p); }
        catch (e) { console.error('migrate-peers', p.from, e); outcome = 'error'; }
        results.push({ from: p.from, to: p.to, outcome });
      }
    }
    console.log('migrate-peers', run ? 'RUN' : 'dry run', 'by', email, 'old', old.length,
      'ready', ready.length, 'skipped', skipped.length,
      run ? 'moved ' + results.filter(r => r.outcome === 'moved').length : '');

    return reply(200, {
      ok: true, run, by: email,
      oldTotal: old.length, checked: batch.length, more: old.length > batch.length,
      alreadyNew: snap.docs.length - old.length,
      ready: ready.map(p => ({ token: p.token, from: p.from, to: p.to, orgName: p.orgName, mode: p.mode,
        owner: p.owner, responses: p.responses, closed: p.closed })),
      skipped: skipped.map(p => ({ from: p.from, to: p.to || '', reason: p.skip, detail: p.detail })),
      results
    });
  } catch (e) {
    console.error('migrate-peers', e);
    return reply(500, { error: 'Migration check failed: ' + (e && e.message || 'unknown error') });
  }
};
