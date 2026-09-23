/* Granola intake.
 *
 * Granola (or a Zapier/Make step watching it) posts a finished meeting note
 * here. This function does not decide anything about coaching — it only files
 * the raw note against the right client so the app can offer it to Lucas as a
 * draft he reviews and saves. Nothing reaches a member until he saves.
 *
 * Netlify → Site configuration → Environment variables (per site):
 *   GRANOLA_SECRET          required: the shared secret Granola sends. With it
 *                           unset every request is refused (503); there is no
 *                           built-in fallback.
 *   FIREBASE_PROJECT_ID,
 *   FIREBASE_CLIENT_EMAIL,
 *   FIREBASE_PRIVATE_KEY    the service account (see netlify/lib/firebase-admin.js)
 *   COACH_EMAIL             optional: the coach's own address, skipped when
 *                           looking for the client (default lucas@jadin-jones.com)
 *
 * POST /api/granola
 *   { secret, email, title, notes, date }   (or the X-Granola-Secret header)
 * `email` is the client's email (Granola's attendee). `notes` is the plain
 * text of the note. Everything else is optional.
 */
const crypto = require('crypto');
const { db, missingEnv } = require('../lib/firebase-admin');

const COLL = 'jj_playbook';

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Granola-Secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};
const reply = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });

// Same helper as the app, character for character.
const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);

/* Compare secrets without leaking their length or contents through timing. */
function sameSecret(got, want) {
  const a = crypto.createHash('sha256').update(String(got)).digest();
  const b = crypto.createHash('sha256').update(String(want)).digest();
  return crypto.timingSafeEqual(a, b);
}

/* The app stores every record as a JSON string in a `value` field, so this
   function speaks exactly the same shape rather than a parallel one. */
function parseVal(snap) {
  if (!snap || !snap.exists) return null;
  const raw = snap.get('value');
  if (typeof raw !== 'string') return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}
async function getVal(id) { return parseVal(await db().collection(COLL).doc(id).get()); }

/* Every current program record for this email: the programs listed in
   members/{email}.orgs, plus any resp: record whose ownerEmail is this
   address (older records, from before the members list). Revoked programs
   (a rev: record) are left out. */
async function findByEmail(email) {
  const byId = {};
  const add = (id, v) => {
    if (!v || !v.idkey || v.idkey === '__preview__' || !v.code) return;
    if (String(v.email || '').trim().toLowerCase() !== email) return;
    byId[id] = v;
  };
  const mem = await db().collection('members').doc(email).get();
  const orgs = mem.exists && Array.isArray(mem.get('orgs')) ? mem.get('orgs') : [];
  for (const code of orgs) {
    const id = 'resp:' + code + ':' + slug(email);
    add(id, await getVal(id));
  }
  const q = await db().collection(COLL).where('ownerEmail', '==', email).get();
  q.forEach(d => { if (d.id.indexOf('resp:') === 0) add(d.id, parseVal(d)); });

  const out = [];
  for (const v of Object.values(byId)) {
    const revoked = await db().collection(COLL).doc('rev:' + v.code + ':' + v.idkey).get();
    if (!revoked.exists) out.push(v);
  }
  return out;
}

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return reply(405, { error: 'POST only' });

  // No secret configured means nobody gets in, not everybody.
  const want = process.env.GRANOLA_SECRET || '';
  if (!want) return reply(503, { error: 'GRANOLA_SECRET is not set on this site, so Granola notes are refused' });
  const missing = missingEnv();
  if (missing.length) return reply(500, { error: 'Server is not configured (' + missing.join(', ') + ')' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) { return reply(400, { error: 'Bad JSON' }); }

  const h = event.headers || {};
  const got = String(body.secret || h['x-granola-secret'] || h['X-Granola-Secret'] || '');
  if (!got || !sameSecret(got, want)) return reply(401, { error: 'Bad secret' });

  const notes = String(body.notes || body.text || body.transcript ||
    body['body-plain'] || body.plain || '').trim();
  if (!notes) return reply(400, { error: 'No notes' });

  /* Candidate addresses, best guess first: an explicit field, then anything
     that looks like an address in the mail itself. Lucas's own address is
     skipped — he is on every one of these meetings. */
  const MINE = String(process.env.COACH_EMAIL || 'lucas@jadin-jones.com').toLowerCase();
  const cand = [];
  const push = v => {
    String(v || '').toLowerCase().match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/g)
      ?.forEach(x => { if (x !== MINE && cand.indexOf(x) < 0) cand.push(x); });
  };
  push(body.email); push(body.attendee); push(body.attendees); push(body.to);
  push(body.from); push(body.subject); push(body.title); push(notes);
  if (!cand.length) return reply(400, { error: 'No client email found in this note' });

  try {
    let people = [];
    for (const c of cand) {
      people = await findByEmail(c);
      if (people.length) break;
    }
    if (!people.length) return reply(404, { error: 'No member matched', tried: cand.slice(0, 6) });

    /* File the note against every program that person belongs to where a 1:1
       file is already switched on. A note has to have somewhere to land, and
       the coach file is what says it does. Only `value` is written, so an
       existing record keeps its ownerEmail; a new one has none, which leaves
       it readable by admins only — never by the member. */
    const filed = [];
    for (const p of people) {
      const cd = await getVal('coach:' + p.code + ':' + p.idkey);
      if (!cd || cd.on !== true) continue;
      const id = 'gin:' + p.code + ':' + p.idkey;
      const inbox = (await getVal(id)) || { items: [] };
      inbox.items = (inbox.items || []).filter(x => x && x.id);
      inbox.items.push({
        id: 'g' + Date.now() + Math.random().toString(36).slice(2, 6),
        ts: Date.now(),
        date: String(body.date || '').trim() ||
          new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
        title: String(body.title || body.subject || '').trim().slice(0, 160),
        notes: notes.slice(0, 20000),
        source: 'Granola'
      });
      // Only the recent tail matters; a reviewed note is removed by the app.
      inbox.items = inbox.items.slice(-25);
      inbox.updatedAt = Date.now();
      await db().collection(COLL).doc(id).set({ value: JSON.stringify(inbox) }, { merge: true });
      filed.push({ code: p.code, name: p.name || '' });
    }

    if (!filed.length) return reply(409, { error: 'That person has no 1:1 file switched on yet' });
    return reply(200, { ok: true, filed });
  } catch (e) {
    console.error('granola', e);
    return reply(500, { error: 'Could not file the note right now. Try again in a moment.' });
  }
};
