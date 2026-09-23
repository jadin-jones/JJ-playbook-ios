/* Join a program.
 *
 * Firestore rules only let someone read a program's data once their email is
 * on the guest list: members/{email}.orgs contains the program code. Members
 * cannot write that list themselves, so this function does it for them —
 * after checking the same things the app has always checked at the door.
 *
 * POST /api/join
 *   Authorization: Bearer <Firebase ID token>
 *   { code }
 *
 * The caller's email comes from the verified token, never from the body.
 * The gate mirrors the app's join():
 *   - no org:CODE              → 404, no program with that code
 *   - rev:CODE:<slug(email)>   → 403, access was ended by the program lead
 *   - a Microsoft sign-in whose mailbox has not been confirmed once through
 *     /api/ms-verify → 403 code 'ms-verify' (see netlify/lib/ms-verify.js)
 *   - allowlist non-empty and the email is not on it → 403
 *   - allowlist empty          → anyone with the code may join
 * On success CODE is added to members/{email}.orgs with arrayUnion, so
 * calling this again is harmless.
 *
 * Env: FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY
 * (see netlify/lib/firebase-admin.js).
 */
const { admin, db, auth, missingEnv } = require('../lib/firebase-admin');
const { isMicrosoft, isConfirmed } = require('../lib/ms-verify');

const COLL = 'jj_playbook';
const ADMINS = ['charlie@jadin-jones.com', 'lucas@jadin-jones.com', 'review@jadin-jones.com'];

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

// Same helpers as the app, character for character.
const cleanCode = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);

const reply = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });

/* The app stores every record as a JSON string in `value`. A doc that exists
   but holds null (a tombstone) reads as absent, as it does in the app. */
async function getVal(id) {
  const snap = await db().collection(COLL).doc(id).get();
  if (!snap.exists) return null;
  const raw = snap.get('value');
  if (typeof raw !== 'string') return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
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
  if (!email) return reply(403, { error: 'Your account has no email address' });
  if (tok.email_verified !== true) return reply(403, { error: 'Verify your email address first', code: 'unverified' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) { return reply(400, { error: 'Bad JSON' }); }

  const code = cleanCode(body.code);
  if (!code) return reply(400, { error: 'Enter your organization code' });

  // Admins read everything through the rules already; nothing to add.
  if (ADMINS.indexOf(email) >= 0) return reply(200, { ok: true, code, admin: true });

  try {
    const [org, revoked] = await Promise.all([
      getVal('org:' + code),
      getVal('rev:' + code + ':' + slug(email))
    ]);
    if (!org) return reply(404, { error: 'No program found for ' + code, code: 'no-program' });
    const orgName = org.name || code;

    if (revoked) {
      return reply(403, { error: 'Your access to ' + orgName + ' has ended. Ask your program lead to restore it.',
        code: 'revoked' });
    }

    /* Microsoft's own "verified" is not trusted (nOAuth): the first join by a
       Microsoft sign-in needs our emailed link confirmed. Checked after
       "revoked", so a revoked person still hears that, and before the
       approved list, so this answer says nothing about who is on it. */
    if (isMicrosoft(tok) && !(await isConfirmed(tok.uid, email))) {
      return reply(403, { error: 'Confirm your email address first: enter your code and join to get a link at ' + email + '.',
        code: 'ms-verify' });
    }

    /* The app reads `org.allowlist||[]`: empty means the code is the only
       gate. The Studio editor always saves an array of lowercased emails;
       anything else is a damaged record, so fail closed rather than guess. */
    const allow = org.allowlist || [];
    if (!Array.isArray(allow)) {
      return reply(403, { error: 'The approved list for ' + orgName + ' is damaged. Ask your program lead to re-save it.',
        code: 'bad-allowlist' });
    }
    if (allow.length && allow.indexOf(email) < 0) {
      return reply(403, { error: email + ' is not on the list for ' + orgName + '. Check with your program lead.',
        code: 'not-listed' });
    }

    await db().collection('members').doc(email).set({
      email,
      orgs: admin.firestore.FieldValue.arrayUnion(code),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    return reply(200, { ok: true, code, orgName });
  } catch (e) {
    console.error('join', code, email, e);
    return reply(500, { error: 'Could not join right now. Try again in a moment.' });
  }
};
