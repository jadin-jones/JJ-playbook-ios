/* One-off: move peer and team rounds from peer:TOKEN to peer:CODE:TOKEN.
 *
 * V3 rules check the program in the second part of a key, and old rounds have
 * the token there, so only admins can reach them. This moves each one to its
 * new key, adding the top-level peerToken (how /api/peer finds a round from a
 * link) and ownerEmail (the leader who opened it).
 *
 * POST /api/admin/migrate-peers
 *   Authorization: Bearer <Firebase ID token of an admin>
 *   { run: false, after }           dry run (the default), one page: checks up
 *                                   to 50 old rounds after the id `after` and
 *                                   changes nothing. Returns `next` and `done`;
 *                                   the Studio card pages until done.
 *   { run: true, tokens: [...] }    moves only these tokens (1-50 a call), the
 *                                   ones the dry run listed as ready. A run
 *                                   scans nothing else.
 *
 * Each round is checked, not guessed. It is skipped and reported when:
 *   - its record is unreadable, or names no program code   (no-code)
 *   - that program no longer exists                        (no-program)
 *   - no owner email can be found from the leader's record (no-owner)
 *   - peer:CODE:TOKEN already exists                       (target-exists)
 *   - another round already carries that peerToken         (token-in-use)
 * On a run, every check is made again for each listed token; a listed token
 * no longer at an old key is reported (gone). The card then dry-runs once more
 * and reports anything still ready as not in the dry run: run again.
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
const PAGE = 50;     // old rounds checked or moved per call, well inside the time limit
const SCAN = 500;    // ids read per page while looking for old (two-part) keys
const AT_ONCE = 8;   // rounds checked or moved in parallel

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

// fn over items, at most n at a time, results in order.
async function mapLimit(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
  }));
  return out;
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
  const validToken = x => typeof x === 'string' && /^[A-Z0-9]{4,16}$/.test(x);
  const col = db().collection(COLL);

  try {
    if (run) {
      // A run moves only what the dry run showed; without that list, nothing.
      const t = body.tokens;
      if (!Array.isArray(t) || !t.length || t.length > PAGE || !t.every(validToken)) {
        return reply(400, { error: 'Run the dry run first: a run needs its list of ready rounds (up to ' + PAGE + ' a call)' });
      }
      const tokens = Array.from(new Set(t));
      const plans = await mapLimit(tokens, AT_ONCE, async tk => {
        const snap = await col.doc('peer:' + tk).get();
        if (!snap.exists) return { from: 'peer:' + tk, token: tk, skip: 'gone', detail: 'listed in the dry run, but no longer at an old key' };
        return plan(snap);
      });
      const ready = plans.filter(p => p.ready);
      const results = await mapLimit(ready, AT_ONCE, async p => {
        let outcome;
        try { outcome = await move(p); }
        catch (e) { console.error('migrate-peers', p.from, e); outcome = 'error'; }
        return { from: p.from, to: p.to, outcome };
      });
      const skipped = plans.filter(p => !p.ready);
      console.log('migrate-peers RUN by', email, 'listed', tokens.length,
        'moved', results.filter(r => r.outcome === 'moved').length, 'skipped', skipped.length);
      return reply(200, { ok: true, run: true, by: email, results,
        skipped: skipped.map(p => ({ from: p.from, to: p.to || '', reason: p.skip, detail: p.detail })) });
    }

    // Dry run, one page. Ids from after `after` (or "peer:") up to "peer;",
    // the next character after ':'. New three-part keys are counted, not checked.
    const after = typeof body.after === 'string' && body.after.indexOf('peer:') === 0 ? body.after : 'peer:';
    const FP = admin.firestore.FieldPath.documentId();
    const snap = await col.where(FP, '>', after).where(FP, '<', 'peer;').orderBy(FP).limit(SCAN).get();
    const old = [];
    let next = after, alreadyNew = 0, full = false;
    for (const d of snap.docs) {
      if (old.length >= PAGE) { full = true; break; }
      next = d.id;
      if (d.id.split(':').length === 2) old.push(d); else alreadyNew++;
    }
    const done = !full && snap.docs.length < SCAN;
    const plans = await mapLimit(old, AT_ONCE, plan);
    const ready = plans.filter(p => p.ready);
    const skipped = plans.filter(p => !p.ready);
    console.log('migrate-peers dry run page by', email, 'after', after, 'old', old.length,
      'ready', ready.length, 'skipped', skipped.length, done ? 'done' : 'next ' + next);

    return reply(200, {
      ok: true, run: false, by: email, next, done,
      oldTotal: old.length, alreadyNew,
      ready: ready.map(p => ({ token: p.token, from: p.from, to: p.to, orgName: p.orgName, mode: p.mode,
        owner: p.owner, responses: p.responses, closed: p.closed })),
      skipped: skipped.map(p => ({ from: p.from, to: p.to || '', reason: p.skip, detail: p.detail }))
    });
  } catch (e) {
    console.error('migrate-peers', e);
    return reply(500, { error: 'Migration check failed: ' + (e && e.message || 'unknown error') });
  }
};
