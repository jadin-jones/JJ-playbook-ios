/* The Twin Thieves lesson videos in Firebase Storage, for Studio's
 * "Link videos from Storage" (Storage rules do not let admins list folders
 * from the browser).
 *
 * POST /api/tt-videos   Authorization: Bearer <Firebase ID token of an admin>
 *   { folders:['36 Lesson Video Folder', '10 Lessons Video'] }
 *       up to 4 top-level folders, by their exact names (spaces and all);
 *       none given lists DEFAULT_FOLDERS
 * → { ok, folders:[{ folder, count }], files:[{ folder, name, path, size, contentType, url }] }
 *   { action:'thumb' }  the challenge thumbnail's own copy → { ok, url, path, created }
 *
 * The thumbnail: the first call downloads THUMB_SRC (HubSpot) once, redraws
 * it as a JPEG at most 1920 px on its long side (on navy, for PNG
 * transparency) and saves it as THUMB_PATH, beside the other lesson
 * thumbnails, with a download token so its link is the getDownloadURL()
 * form. Later calls return that copy. This is the only file it ever writes,
 * and it never replaces one that is there.
 *
 * The bucket is always this project's own (<project>.firebasestorage.app,
 * test-6b2ab.firebasestorage.app on live); a caller never chooses it. A
 * folder is allowed only when it is a top-level folder whose name is a
 * Twin Thieves one (Twin Thieves, TT…, or Lesson(s) Video), and never one
 * of the Playbook's own folders, whatever its name. Anything else refuses
 * the whole call. Listing is read-only: nothing in Storage or Firestore
 * changes (apart from the rate limit's own count). `url` is the file's
 * download link in the same form the app's own uploads get from
 * getDownloadURL(), built from the download token Storage already keeps on
 * the file; a file without one has url null and is never given one here.
 *
 * Only admins (not through Microsoft) may call it. 60 calls an hour per
 * connection.
 *
 * Env: FIREBASE_*.
 */
const crypto = require('crypto');
const { admin, auth, missingEnv } = require('../lib/firebase-admin');
const { isMicrosoft } = require('../lib/ms-verify');
const { withCors } = require('../lib/http');
const { ADMINS } = require('../lib/admins');
const { allow, clientIp, HOUR } = require('../lib/rate-limit');

const HDR = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
const reply = (statusCode, body) => ({ statusCode, headers: HDR, body: JSON.stringify(body) });

const DEFAULT_FOLDERS = ['36 Lesson Video Folder', '10 Lessons Video'];
// The same test as the app (TT_VID_FOLDER_RE).
const TT_FOLDER = /twin|thie|(^|[^a-z])tt([^a-z]|$)|lessons?[\s_-]*video/i;
// Every folder the Playbook (and the rest of the app) uploads to.
const APP_FOLDERS = ['session-videos', 'session-thumbnails', 'challenge-videos', 'welcome-videos', 'learn-more', 'knowledge'];
const VIDEO = /\.(mp4|m4v|mov|webm)$/i;
const MAX_FOLDERS = 4, MAX_FILES = 500;
const THUMB_SRC = 'https://48441925.fs1.hubspotusercontent-na1.net/hubfs/48441925/Challenge.png';
const THUMB_PATH = 'session-thumbnails/twin-thieves-challenge.jpg';
const THUMB_MAX = 1920, SRC_LIMIT = 25 * 1024 * 1024;

const bucketName = () => String(process.env.FIREBASE_PROJECT_ID || '') + '.firebasestorage.app';

/* A folder name as given, or '' when it is not an allowed Twin Thieves
   folder. Only the trailing slash is dropped; spaces stay as they are. */
function cleanFolder(f) {
  if (typeof f !== 'string') return '';
  const s = f.replace(/\/+$/, '');
  if (!s || s.length > 100 || s !== s.trim()) return '';
  if (/[\/\\\u0000-\u001f\u007f]/.test(s) || s === '.' || s === '..') return '';
  if (APP_FOLDERS.indexOf(s.toLowerCase()) >= 0) return '';
  return TT_FOLDER.test(s) ? s : '';
}

/* The link getDownloadURL() gives, from the token already on the file. */
function downloadUrl(bucket, path, md) {
  const tok = String(((md && md.metadata) || {}).firebaseStorageDownloadTokens || '').split(',')[0].trim();
  if (!tok) return null;
  return 'https://firebasestorage.googleapis.com/v0/b/' + bucket + '/o/' + encodeURIComponent(path) + '?alt=media&token=' + encodeURIComponent(tok);
}

/* The challenge image as a JPEG Buffer: at most THUMB_MAX px, on navy. */
async function shrinkImage(buf) {
  const { Jimp } = require('jimp');
  const img = await Jimp.read(buf);
  const w = img.bitmap.width, h = img.bitmap.height, sc = Math.min(1, THUMB_MAX / Math.max(w, h));
  if (sc < 1) img.resize({ w: Math.max(1, Math.round(w * sc)), h: Math.max(1, Math.round(h * sc)) });
  const bg = new Jimp({ width: img.bitmap.width, height: img.bitmap.height, color: 0x0C2647FF });
  bg.composite(img, 0, 0);
  return bg.getBuffer('image/jpeg', { quality: 85 });
}

/* The thumbnail copy's link, making the copy first if it is not there. */
async function thumbCopy(name, bucket) {
  const file = bucket.file(THUMB_PATH);
  const have = async () => { const [md] = await file.getMetadata(); return downloadUrl(name, THUMB_PATH, md); };
  const [exists] = await file.exists();
  if (exists) {
    const url = await have();
    if (url) return { url, created: false };
    // Our own copy without a token (never expected): give it one so it can be shown.
    await file.setMetadata({ metadata: { firebaseStorageDownloadTokens: crypto.randomUUID() } });
    return { url: await have(), created: false };
  }
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 6000);
  let src;
  try {
    const r = await fetch(THUMB_SRC, { signal: ctl.signal });
    const type = String(r.headers.get('content-type') || '');
    if (!r.ok || !/^image\/(png|jpeg)/i.test(type)) throw Object.assign(new Error('source'), { code: 'thumb-source' });
    src = Buffer.from(await r.arrayBuffer());
    if (src.length > SRC_LIMIT) throw Object.assign(new Error('source'), { code: 'thumb-source' });
  } finally { clearTimeout(timer); }
  const jpg = await shrinkImage(src);
  try {
    await file.save(jpg, { resumable: false, contentType: 'image/jpeg', preconditionOpts: { ifGenerationMatch: 0 },
      metadata: { cacheControl: 'public,max-age=31536000', metadata: { firebaseStorageDownloadTokens: crypto.randomUUID() } } });
  } catch (e) {
    // Made by another call in the meantime: use that one.
    if (e && (e.code === 412 || e.code === '412')) return { url: await have(), created: false };
    throw e;
  }
  return { url: await have(), created: true };
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
  if (body.action === 'thumb') {
    const name = bucketName();
    try {
      const t = await thumbCopy(name, admin.storage().bucket(name));
      if (!t.url) return reply(502, { error: 'The thumbnail was saved but has no link. Try again.' });
      return reply(200, { ok: true, url: t.url, path: THUMB_PATH, created: t.created });
    } catch (e) {
      console.error('tt-videos thumb', e && (e.code || e.name));
      return reply(502, { error: e && e.code === 'thumb-source' ? 'Could not download the challenge image from HubSpot.'
        : 'Could not save the thumbnail in Storage. Try again in a moment.' });
    }
  }
  if (body.action != null) return reply(400, { error: 'Unknown action' });
  const asked = body.folders == null ? DEFAULT_FOLDERS : body.folders;
  if (!Array.isArray(asked) || !asked.length) return reply(400, { error: 'Give at least one Storage folder.' });
  if (asked.length > MAX_FOLDERS) return reply(400, { error: 'Up to ' + MAX_FOLDERS + ' Storage folders at a time.' });
  const folders = [];
  for (const f of asked) {
    const c = cleanFolder(f);
    if (!c) return reply(400, { error: 'Not a Twin Thieves videos folder: "' + String(f).slice(0, 100) + '". Only top-level folders named like Twin Thieves or Lesson Video can be listed.' });
    if (folders.indexOf(c) < 0) folders.push(c);
  }

  const name = bucketName();
  const bucket = admin.storage().bucket(name);
  const out = [], files = [];
  try {
    for (const folder of folders) {
      const prefix = folder + '/';
      const [list] = await bucket.getFiles({ prefix, delimiter: '/', autoPaginate: false, maxResults: MAX_FILES });
      const here = (list || []).filter(f => f.name !== prefix && f.name.indexOf('/', prefix.length) < 0);
      out.push({ folder, count: here.filter(f => VIDEO.test(f.name)).length });
      here.forEach(f => {
        const md = f.metadata || {};
        files.push({ folder, name: f.name.slice(prefix.length), path: f.name, size: Number(md.size) || 0,
          contentType: String(md.contentType || ''), url: downloadUrl(name, f.name, md) });
      });
    }
  } catch (e) { console.error('tt-videos list', e && (e.code || e.name)); return reply(502, { error: 'Could not list Storage. Try again in a moment.' }); }
  return reply(200, { ok: true, folders: out, files });
});
