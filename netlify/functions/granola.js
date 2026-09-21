/* Granola intake.
 *
 * Granola (or a Zapier/Make step watching it) posts a finished meeting note
 * here. This function does not decide anything about coaching — it only files
 * the raw note against the right client so the app can offer it to Lucas as a
 * draft he reviews and saves. Nothing reaches a member until he saves.
 *
 * Netlify → Site configuration → Environment variables:
 *   GRANOLA_SECRET   a shared secret; requests without it are refused
 *   FIREBASE_API_KEY  the same web API key the app uses
 *   FIREBASE_PROJECT  the Firestore project id
 *
 * POST /api/granola
 *   { secret, email, title, notes, date }
 * `email` is the client's email (Granola's attendee). `notes` is the plain
 * text of the note. Everything else is optional.
 */
const COLL = 'jj_playbook';

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

const PROJECT = () => process.env.FIREBASE_PROJECT || 'test-6b2ab';
const KEY = () => process.env.FIREBASE_API_KEY || 'AIzaSyAgcRPj65snd_CxN-zs8v3EXiOsDcLaxI4';
const base = () =>
  'https://firestore.googleapis.com/v1/projects/' + PROJECT() +
  '/databases/(default)/documents/' + COLL;

/* The app stores every record as a JSON string in a `value` field, so this
   function speaks exactly the same shape rather than a parallel one. */
async function getDoc(id) {
  const r = await fetch(base() + '/' + encodeURIComponent(id) + '?key=' + KEY());
  if (!r.ok) return null;
  const j = await r.json();
  const raw = j && j.fields && j.fields.value && j.fields.value.stringValue;
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}
async function setDoc(id, val) {
  const r = await fetch(
    base() + '/' + encodeURIComponent(id) + '?key=' + KEY() +
    '&updateMask.fieldPaths=value',
    { method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: { value: { stringValue: JSON.stringify(val) } } }) });
  return r.ok;
}
/* Find every member record whose email matches, so a note can be filed
   without Granola knowing anything about program codes. */
async function findByEmail(email) {
  const r = await fetch(
    'https://firestore.googleapis.com/v1/projects/' + PROJECT() +
    '/databases/(default)/documents:runQuery?key=' + KEY(),
    { method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ structuredQuery: {
        from: [{ collectionId: COLL }],
        limit: 400
      } }) });
  if (!r.ok) return [];
  const rows = await r.json();
  const out = [];
  (Array.isArray(rows) ? rows : []).forEach(x => {
    const d = x && x.document;
    if (!d || !d.name) return;
    const id = d.name.split('/').pop();
    if (id.indexOf('resp:') !== 0) return;
    let v = null;
    try { v = JSON.parse(d.fields.value.stringValue); } catch (e) { return; }
    if (!v || !v.idkey || v.idkey === '__preview__') return;
    if (String(v.email || '').trim().toLowerCase() !== email) return;
    out.push(v);
  });
  return out;
}

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'POST only' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Bad JSON' }) }; }

  const want = process.env.GRANOLA_SECRET || 'jj-granola-9f3k2xq7';
  const got = String(body.secret || event.headers['x-granola-secret'] || '');
  if (!want || got !== want) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Bad secret' }) };
  }
  if (!KEY()) {
    return { statusCode: 500, headers: CORS,
      body: JSON.stringify({ error: 'FIREBASE_API_KEY is not set on this site' }) };
  }

  const notes = String(body.notes || body.text || body.transcript ||
    body['body-plain'] || body.plain || '').trim();
  if (!notes) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'No notes' }) };

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
  if (!cand.length) {
    return { statusCode: 400, headers: CORS,
      body: JSON.stringify({ error: 'No client email found in this note' }) };
  }

  let people = [];
  for (const c of cand) {
    people = await findByEmail(c);
    if (people.length) break;
  }
  if (!people.length) {
    return { statusCode: 404, headers: CORS,
      body: JSON.stringify({ error: 'No member matched', tried: cand.slice(0, 6) }) };
  }

  /* File the note against every program that person belongs to where a 1:1
     file is already switched on. A note has to have somewhere to land, and
     the coach file is what says it does. */
  const filed = [];
  for (const p of people) {
    const cd = await getDoc('coach:' + p.code + ':' + p.idkey);
    if (!cd || cd.on !== true) continue;
    const inbox = (await getDoc('gin:' + p.code + ':' + p.idkey)) || { items: [] };
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
    const ok = await setDoc('gin:' + p.code + ':' + p.idkey, inbox);
    if (ok) filed.push({ code: p.code, name: p.name || '' });
  }

  if (!filed.length) {
    return { statusCode: 409, headers: CORS,
      body: JSON.stringify({ error: 'That person has no 1:1 file switched on yet' }) };
  }
  return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, filed }) };
};
