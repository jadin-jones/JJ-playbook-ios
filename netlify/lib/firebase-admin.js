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

function app() {
  if (admin.apps.length) return admin.app();
  const missing = missingEnv();
  if (missing.length) throw new Error('Missing env: ' + missing.join(', '));
  return admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
    }),
    projectId: process.env.FIREBASE_PROJECT_ID
  });
}

const db = () => app().firestore();
const auth = () => app().auth();

module.exports = { admin, app, db, auth, missingEnv };
