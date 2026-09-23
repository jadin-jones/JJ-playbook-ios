/* The peer-review and team-assessment form, for the people a leader sends the
 * link to.
 *
 * Respondents are not members of the program and do not sign in, so the V3
 * rules rightly keep them out of Firestore. This function is their only door:
 * the token in the link is the key, and they see and write only what the form
 * needs, never the other answers in the round.
 *
 * GET  /api/peer?t=TOKEN
 *   → { ok, orgName, mode, closed }
 * POST /api/peer   { t, scores, keep, change }
 *   → { ok }   adds one anonymous response
 *
 * Rounds are stored as peer:CODE:TOKEN and carry a top-level peerToken, so
 * the link needs no program code (the code is the join key and stays out of
 * links). A round not migrated yet is still found at its old key, peer:TOKEN.
 *
 * Env: FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY
 * (see netlify/lib/firebase-admin.js).
 */
const { db, missingEnv } = require('../lib/firebase-admin');

const COLL = 'jj_playbook';
// Same as the app's ASSESS keys and ASSESS_SCALE (there is no 7).
const KEYS = ['energy', 'execute', 'ero', 'principle', 'comm', 'cast', 'trust', 'champions', 'tough', 'starfish'];
const SCALE = [1, 2, 3, 4, 5, 6, 8, 9, 10];
const MAX_TEXT = 600;          // the form's own limit
const MAX_RESPONSES = 500;     // a leaked link cannot grow a round without end
const MAX_BODY = 10000;

const JSON_HDR = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
const reply = (statusCode, body) => ({ statusCode, headers: JSON_HDR, body: JSON.stringify(body) });

const cleanToken = s => String(s || '').trim().toUpperCase();
const validToken = t => /^[A-Z0-9]{4,16}$/.test(t);

/* The app stores every record as a JSON string in `value`; null or bad JSON
   reads as absent, as it does in the app. */
function parseVal(snap) {
  if (!snap.exists) return null;
  const raw = snap.get('value');
  if (typeof raw !== 'string') return null;
  try { const v = JSON.parse(raw); return v && typeof v === 'object' ? v : null; } catch (e) { return null; }
}

/* The round's document, or null. Two rounds claiming one token would be a
   damaged record: refuse rather than pick one. */
async function findRound(token) {
  const col = db().collection(COLL);
  const snap = await col.where('peerToken', '==', token).limit(3).get();
  const hits = snap.docs.filter(d => {
    const p = d.id.split(':');
    return p.length === 3 && p[0] === 'peer' && p[2] === token;
  });
  if (hits.length > 1) throw Object.assign(new Error('Two rounds share token ' + token), { ambiguous: true });
  if (hits.length === 1) return hits[0].ref;
  const legacy = col.doc('peer:' + token);
  return (await legacy.get()).exists ? legacy : null;
}

function cleanScores(s) {
  if (!s || typeof s !== 'object' || Array.isArray(s)) return null;
  if (Object.keys(s).length !== KEYS.length) return null;
  const out = {};
  for (const k of KEYS) {
    const n = Number(s[k]);
    if (SCALE.indexOf(n) < 0) return null;
    out[k] = n;
  }
  return out;
}
const cleanText = s => String(s == null ? '' : s).slice(0, MAX_TEXT);

exports.handler = async function (event) {
  const method = event.httpMethod;
  if (method !== 'GET' && method !== 'POST') return reply(405, { error: 'GET or POST only' });

  const missing = missingEnv();
  if (missing.length) return reply(500, { error: 'Server is not configured (' + missing.join(', ') + ')' });

  let body = {};
  if (method === 'POST') {
    if ((event.body || '').length > MAX_BODY) return reply(413, { error: 'Too long' });
    try { body = JSON.parse(event.body || '{}'); }
    catch (e) { return reply(400, { error: 'Bad JSON' }); }
  }
  const token = cleanToken(method === 'GET' ? (event.queryStringParameters || {}).t : body.t);
  if (!validToken(token)) return reply(404, { error: 'This link is not valid', code: 'missing' });

  try {
    const ref = await findRound(token);
    if (!ref) return reply(404, { error: 'This link is not valid', code: 'missing' });

    if (method === 'GET') {
      const doc = parseVal(await ref.get());
      if (!doc) return reply(404, { error: 'This link is not valid', code: 'missing' });
      return reply(200, { ok: true, orgName: String(doc.orgName || ''),
        mode: doc.mode === 'team' ? 'team' : 'peer', closed: !!doc.closed });
    }

    const scores = cleanScores(body.scores);
    if (!scores) return reply(400, { error: 'Score all ' + KEYS.length + ' lines', code: 'scores' });
    const entry = { ts: Date.now(), scores, keep: cleanText(body.keep), change: cleanText(body.change) };

    // A transaction, so two people sending at once both land.
    const out = await db().runTransaction(async tx => {
      const doc = parseVal(await tx.get(ref));
      if (!doc) return { status: 404, body: { error: 'This link is not valid', code: 'missing' } };
      if (doc.closed) return { status: 409, body: { error: 'This round is closed', code: 'closed' } };
      const responses = Array.isArray(doc.responses) ? doc.responses : [];
      if (responses.length >= MAX_RESPONSES) return { status: 409, body: { error: 'This round is full', code: 'full' } };
      doc.responses = responses.concat([entry]);
      tx.update(ref, { value: JSON.stringify(doc) });
      return { status: 200, body: { ok: true } };
    });
    return reply(out.status, out.body);
  } catch (e) {
    console.error('peer', method, token, e);
    if (e && e.ambiguous) return reply(409, { error: 'This link points at a damaged round. Ask the person who sent it.', code: 'ambiguous' });
    return reply(500, { error: 'Could not reach the form right now. Try again in a moment.' });
  }
};
