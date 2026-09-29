/* The coaching endpoint.
 *
 * The app cannot call Anthropic directly: doing so would ship your API key to
 * every member's phone. This function is the middle step — it runs on
 * Netlify's servers, holds the key as an environment variable, and passes the
 * conversation through.
 *
 * POST /api/coach   Authorization: Bearer <Firebase ID token>
 *   { system, messages, max_tokens }
 *
 * Only a signed-in member of a program (members/{email}.orgs lists one) or
 * an admin may use it, so the key is not open to the internet. The same
 * checks as /api/join: a verified email, and for a Microsoft sign-in a
 * confirmed mailbox. The model is fixed here, not chosen by the caller, and
 * each account gets COACH_PER_HOUR replies an hour.
 *
 * Env: ANTHROPIC_API_KEY, and FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL,
 * FIREBASE_PRIVATE_KEY for the sign-in check (see netlify/lib/firebase-admin.js).
 */
const { db, auth, missingEnv } = require('../lib/firebase-admin');
const { isMicrosoft, isConfirmed } = require('../lib/ms-verify');
const { withCors } = require('../lib/http');
const { ADMINS } = require('../lib/admins');
const { allow, HOUR } = require('../lib/rate-limit');

const MODEL = 'claude-sonnet-4-5';
const MAX_SYSTEM = 60000;   // a runaway knowledge base should cost you nothing
const MAX_TOKENS = 700;
const MAX_BODY = 200000;
const COACH_PER_HOUR = 60;

const HDR = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
const reply = (statusCode, body) => ({ statusCode, headers: HDR, body: JSON.stringify(body) });

exports.handler = withCors('POST, OPTIONS', 'Content-Type, Authorization', async function (event) {
  if (event.httpMethod !== 'POST') return reply(405, { error: 'POST only' });

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return reply(500, { error: 'The coach is not set up on this site' });
  const missing = missingEnv();
  if (missing.length) return reply(500, { error: 'Server is not configured (' + missing.join(', ') + ')' });

  // Who is asking: a member of some program, or an admin.
  const h = event.headers || {};
  const m = /^Bearer\s+(.+)$/i.exec(h.authorization || h.Authorization || '');
  if (!m) return reply(401, { error: 'Sign in first' });
  let tok;
  try { tok = await auth().verifyIdToken(m[1], true); }
  catch (e) { return reply(401, { error: 'Your sign-in has expired. Sign in again.' }); }
  const email = String(tok.email || '').trim().toLowerCase();
  if (!email || tok.email_verified !== true) return reply(403, { error: 'Verify your email address first', code: 'unverified' });
  try {
    const ms = isMicrosoft(tok);
    if (ms && !(await isConfirmed(tok.uid, email))) return reply(403, { error: 'Confirm your email address first', code: 'ms-verify' });
    if (!(ADMINS.indexOf(email) >= 0 && !ms)) {
      const mem = await db().collection('members').doc(email).get();
      const orgs = mem.exists ? mem.get('orgs') : null;
      if (!Array.isArray(orgs) || !orgs.length) return reply(403, { error: 'Join a program to use the coach', code: 'not-member' });
    }
  } catch (e) {
    console.error('coach sign-in check', e && e.code);
    return reply(500, { error: 'Could not reach the coach right now. Try again in a moment.' });
  }
  if (!(await allow('coach', tok.uid, COACH_PER_HOUR, HOUR)))
    return reply(429, { error: 'That is a lot of questions for one hour. Try again a little later.', code: 'wait' });

  if ((event.body || '').length > MAX_BODY) return reply(413, { error: 'Too long' });
  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) { return reply(400, { error: 'Bad JSON' }); }

  const system = String(body.system || '').slice(0, MAX_SYSTEM);
  /* Only the two roles the API accepts, only strings, and never an empty turn —
     a malformed history is the most common cause of a 400 from upstream. */
  const messages = (Array.isArray(body.messages) ? body.messages : [])
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && String(m.content || '').trim())
    .map(m => ({ role: m.role, content: String(m.content).slice(0, 8000) }))
    .slice(-20);

  if (!messages.length) return reply(400, { error: 'No message' });
  // The API requires the exchange to start with the member, not the coach.
  while (messages.length && messages[0].role !== 'user') messages.shift();
  if (!messages.length) return reply(400, { error: 'No user message' });

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: Math.min(Number(body.max_tokens) || MAX_TOKENS, 1200),
        system: system || undefined,
        messages: messages
      })
    });

    const data = await res.json();
    if (!res.ok) {
      console.error('anthropic error', res.status, data && data.error && data.error.type);
      return reply(502, { error: 'The coach could not answer just now. Try again in a moment.' });
    }

    const text = (Array.isArray(data.content) ? data.content : [])
      .filter(b => b && b.type === 'text').map(b => b.text).join('').trim();

    return reply(200, { text: text });
  } catch (e) {
    console.error('coach handler', e && e.name);
    return reply(502, { error: 'Could not reach the model' });
  }
});
