/* One firebase-admin app per function instance, built from three split env
 * vars so the service-account JSON never has to fit in a single Netlify
 * variable (the full JSON blows past the 4KB AWS limit).
 *
 * Netlify → Site configuration → Environment variables (per site — dev and
 * live point at different Firebase projects):
 *   FIREBASE_PROJECT_ID     e.g. jj-playbook-dev
 *   FIREBASE_CLIENT_EMAIL   the service account's client_email
 *   FIREBASE_PRIVATE_KEY    the service account's private_key; paste it with
 *                           literal \n sequences or real newlines, both work
 *
 * Lives outside netlify/functions so Netlify does not deploy it as its own
 * endpoint; the functions require it and the bundler pulls it in.
 */
const admin = require('firebase-admin');

function missingEnv() {
  return ['FIREBASE_PROJECT_ID', 'FIREBASE_CLIENT_EMAIL', 'FIREBASE_PRIVATE_KEY']
    .filter(k => !process.env[k]);
}

/* A value pasted into the dashboard can pick up spaces, a trailing newline or
   the quotes around it in the JSON file. Any of those breaks the credential
   (or, in the project ID, every token's audience check), so they're dropped. */
function envValue(k) {
  const s = String(process.env[k] || '').trim();
  return /^(["']).*\1$/s.test(s) ? s.slice(1, -1).trim() : s;
}

function app() {
  if (admin.apps.length) return admin.app();
  const missing = missingEnv();
  if (missing.length) throw new Error('Missing env: ' + missing.join(', '));
  const projectId = envValue('FIREBASE_PROJECT_ID');
  return admin.initializeApp({
    credential: admin.credential.cert({
      projectId,
      clientEmail: envValue('FIREBASE_CLIENT_EMAIL'),
      privateKey: envValue('FIREBASE_PRIVATE_KEY').replace(/\\n/g, '\n')
    }),
    projectId
  });
}

const db = () => app().firestore();
const auth = () => app().auth();

/* Why verifyIdToken failed, as { status, error, code }. Only a token that is
   itself bad is the member's to fix by signing in again; anything else (a
   broken key, a project ID that doesn't match the app's, a missing
   permission) is this site's settings, and says so instead of blaming the
   sign-in. The reason is logged for the Netlify function log; it never holds
   the key. */
const TOKEN_CODES = ['auth/id-token-expired', 'auth/id-token-revoked', 'auth/user-disabled', 'auth/user-not-found'];
function tokenFailure(e) {
  const code = String((e && (e.code || (e.errorInfo && e.errorInfo.code))) || '');
  const msg = String((e && e.message) || '');
  console.error('verifyIdToken failed:', code || 'no code', msg.slice(0, 300));
  const server = !(TOKEN_CODES.indexOf(code) >= 0 || (code === 'auth/argument-error' && !/"aud"|"iss"/.test(msg)));
  return server
    ? { status: 500, code: 'server-auth', error: 'The server could not check your sign-in (' + (code || 'unknown') + '). This is a site setting, not your account: tell the Playbook team.' }
    : { status: 401, code: 'expired', error: 'Your sign-in has expired. Sign in again.' };
}

module.exports = { admin, app, db, auth, missingEnv, tokenFailure };
