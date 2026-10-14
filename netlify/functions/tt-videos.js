/* The Twin Thieves lesson videos in Firebase Storage, for Studio's
 * "Link videos from Storage" (Storage rules do not let admins list folders
 * from the browser).
 *
 * POST /api/tt-videos   Authorization: Bearer <Firebase ID token of an admin>
 *   { }                 find the Twin Thieves videos folder and list it
 *   { folder:'x/' }     list that folder; it must be one this finds
 *   { prefer:'x/' }     list that folder if it is one this finds, else the default
 * → { ok, folder, folders:[...], files:[{ name, path, size, contentType, url }] }
 *
 * Only a top-level folder named like Twin Thieves (or TT…), or a videos
 * folder inside one, is ever listed; any other folder is refused. Listing is
 * read-only: nothing in Storage or Firestore changes (apart from the rate
 * limit's own count). `url` is the file's download link in the same form the
 * app's own uploads get from getDownloadURL(), built from the download token
 * Storage already keeps on the file; a file without one has url null and is
 * never given one here.
 *
 * Only admins (not through Microsoft) may call it. 60 calls an hour per
 * connection.
 *
 * Env: FIREBASE_*, and FIREBASE_STORAGE_BUCKET when the bucket is not
 * <project>.firebasestorage.app.
 */
const { admin, auth, missingEnv } = require('../lib/firebase-admin');
const { isMicrosoft } = require('../lib/ms-verify');
const { withCors } = require('../lib/http');
const { ADMINS } = require('../lib/admins');
const { allow, clientIp, HOUR } = require('../lib/rate-limit');

const HDR = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
const reply = (statusCode, body) => ({ statusCode, headers: HDR, body: JSON.stringify(body) });

// The same tests as the app (TT_VID_FOLDER_RE, TT_VID_EXT_RE).
const TT_FOLDER = /twin|thie|(^|[^a-z])tt([^a-z]|$)/i;
const SUB_FOLDER = /video|vid|mp4/i;
const VIDEO = /\.(mp4|m4v|mov|webm)$/i;
const MAX_FILES = 500;

const bucketName = () => String(process.env.FIREBASE_STORAGE_BUCKET || '').trim()
  || String(process.env.FIREBASE_PROJECT_ID || '') + '.firebasestorage.app';

/* One level of a folder: its files and its subfolders (prefixes). */
async function level(bucket, prefix) {
  const [files, , res] = await bucket.getFiles({ prefix, delimiter: '/', autoPaginate: false, maxResults: 1000 });
  return { files: (files || []).filter(f => f.name !== prefix), prefixes: (res && res.prefixes) || [] };
}

/* The Twin Thieves folders that hold videos: a top-level folder named like
   Twin Thieves, and the videos folders directly inside one. */
async function ttFolders(bucket) {
  const out = [];
  for (const top of (await level(bucket, '')).prefixes) {
    if (!TT_FOLDER.test(top.replace(/\/$/, ''))) continue;
    const t = await level(bucket, top);
    if (t.files.some(f => VIDEO.test(f.name))) out.push({ folder: top, n: t.files.filter(f => VIDEO.test(f.name)).length });
    for (const sub of t.prefixes) {
      if (!SUB_FOLDER.test(sub.slice(top.length).replace(/\/$/, ''))) continue;
      const s = await level(bucket, sub);
      const n = s.files.filter(f => VIDEO.test(f.name)).length;
      if (n) out.push({ folder: sub, n });
    }
  }
  return out;
}

/* The link getDownloadURL() gives, from the token already on the file. */
function downloadUrl(bucket, path, md) {
  const tok = String(((md && md.metadata) || {}).firebaseStorageDownloadTokens || '').split(',')[0].trim();
  if (!tok) return null;
  return 'https://firebasestorage.googleapis.com/v0/b/' + bucket + '/o/' + encodeURIComponent(path) + '?alt=media&token=' + encodeURIComponent(tok);
}

exports.handler = withCors('POST, OPTIONS', 'Content-Type, Authorization', async function (event) {
  if (event.httpMethod !== 'POST') return reply(405, { error: 'POST only' });
  const missing = missingEnv();
  if (missing.length) return reply(500, { error: 'Server is not configured (' + missing.join(', ') + ')' });
  if ((event.body || '').length > 2000) return reply(413, { error: 'Too long' });
  if (!(await allow('tt-videos-ip', clientIp(event), 60, HOUR))) return reply(429, { error: 'Too many requests. Try again later.', code: 'wait' });

  const h = event.headers || {};
  const m = /^Bearer\s+(.+)$/i.exec(h.authorization || h.Authorization || '');
  if (!m) return reply(401, { error: 'Sign in first' });
  let tok;
  try { tok = await auth().verifyIdToken(m[1], true); }
  catch (e) { return reply(401, { error: 'Your sign-in has expired. Sign in again.' }); }
  const me = String(tok.email || '').trim().toLowerCase();
  if (tok.email_verified !== true || ADMINS.indexOf(me) < 0 || isMicrosoft(tok)) return reply(403, { error: 'Admins only' });

  let body;
  try { body = JSON.parse(event.body || '{}') || {}; } catch (e) { return reply(400, { error: 'Bad JSON' }); }
  const want = body.folder == null ? '' : String(body.folder);
  const prefer = body.prefer == null ? '' : String(body.prefer);

  const name = bucketName();
  const bucket = admin.storage().bucket(name);
  let found;
  try { found = await ttFolders(bucket); }
  catch (e) { console.error('tt-videos list', e && (e.code || e.name)); return reply(502, { error: 'Could not list Storage. Try again in a moment.' }); }
  const folders = found.map(f => f.folder);
  if (want && folders.indexOf(want) < 0) return reply(400, { error: 'That is not a Twin Thieves videos folder.' });
  if (!found.length) return reply(200, { ok: true, folder: null, folders: [], files: [] });
  const folder = want || (folders.indexOf(prefer) >= 0 ? prefer : found.slice().sort((a, b) => b.n - a.n)[0].folder);

  let files;
  try {
    const lv = await level(bucket, folder);
    files = lv.files.slice(0, MAX_FILES).map(f => {
      const md = f.metadata || {};
      return { name: f.name.slice(folder.length), path: f.name, size: Number(md.size) || 0,
        contentType: String(md.contentType || ''), url: downloadUrl(name, f.name, md) };
    });
  } catch (e) { console.error('tt-videos files', e && (e.code || e.name)); return reply(502, { error: 'Could not read that folder. Try again in a moment.' }); }
  return reply(200, { ok: true, folder, folders, files });
});
