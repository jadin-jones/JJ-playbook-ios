/* A short-lived link to one Twin Thieves lesson video, for a signed-in member.
 *
 * POST /api/tt-video   Authorization: Bearer <Firebase ID token>
 *   { lesson:'tt04' }
 * → { ok, url, expiresAt }   a signed Storage link that stops working after
 *                            LINK_HOURS (Range requests, so seeking and long
 *                            videos play as before)
 *   { ok, url:null }         the lesson's video is not a file in this
 *                            project's own Storage (YouTube, Vimeo, Drive, or
 *                            another bucket): the app plays its link as it is
 *
 * Who: a verified email (a Microsoft sign-in with its mailbox confirmed, as
 * /api/tt-join) whose ttmembers/{email}.orgs holds TT36 or TT10, for a lesson
 * in that version's order (or the closing Thank you!). Admins (not through
 * Microsoft) may ask for any lesson, for Studio's "Preview as a member".
 *
 * Which file: only the one the lesson library (ttlib:master, admin-written)
 * links to, in this project's own bucket; a caller never names a path. The
 * link is signed with the service account's own key (nothing is called to
 * sign it), and nothing is written apart from the rate limit's own count.
 * The file's existing download token is not touched, so the library's own
 * links keep working (see docs/TWIN-THIEVES.md).
 *
 * 300 calls an hour per account. Env: FIREBASE_*.
 */
const { admin, db, auth, missingEnv } = require('../lib/firebase-admin');
const { isMicrosoft, isConfirmed } = require('../lib/ms-verify');
const { withCors } = require('../lib/http');
const { ADMINS } = require('../lib/admins');
const { allow, HOUR } = require('../lib/rate-limit');

const HDR = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
const reply = (statusCode, body) => ({ statusCode, headers: HDR, body: JSON.stringify(body) });
const LINK_HOURS = 4;
const THANKS_ID = 'ttthanks';
const ORDER = { TT36: 'order36', TT10: 'order10' };

const bucketName = () => String(process.env.FIREBASE_PROJECT_ID || '') + '.firebasestorage.app';
function parseVal(snap) {
  if (!snap || !snap.exists) return null;
  const raw = snap.get('value');
  if (typeof raw !== 'string') return null;
  try { const v = JSON.parse(raw); return v && typeof v === 'object' ? v : null; } catch (e) { return null; }
}
/* The Storage path a Firebase download link points at, when it is in this
   bucket; '' for any other link. */
function ownPath(u, bucket) {
  const m = String(u || '').match(/^https:\/\/firebasestorage\.(?:googleapis\.com|app)\/v0\/b\/([^/]+)\/o\/([^?#]+)/i);
  if (!m || m[1] !== bucket) return '';
  try { const p = decodeURIComponent(m[2]); return p && p.indexOf('..') < 0 ? p : ''; } catch (e) { return ''; }
}

exports.handler = withCors('POST, OPTIONS', 'Content-Type, Authorization', async function (event) {
  if (event.httpMethod !== 'POST') return reply(405, { error: 'POST only' });
  const missing = missingEnv();
  if (missing.length) return reply(500, { error: 'Server is not configured (' + missing.join(', ') + ')' });
  if ((event.body || '').length > 500) return reply(413, { error: 'Too long' });

  const h = event.headers || {};
  const m = /^Bearer\s+(.+)$/i.exec(h.authorization || h.Authorization || '');
  if (!m) return reply(401, { error: 'Sign in first' });
  let tok;
  try { tok = await auth().verifyIdToken(m[1], true); }
  catch (e) { return reply(401, { error: 'Your sign-in has expired. Sign in again.' }); }
  const email = String(tok.email || '').trim().toLowerCase();
  if (tok.email_verified !== true || !email) return reply(403, { error: 'Twin Thieves members only' });
  if (!(await allow('tt-video-uid', tok.uid, 300, HOUR))) return reply(429, { error: 'Too many requests. Try again later.', code: 'wait' });

  let body;
  try { body = JSON.parse(event.body || '{}') || {}; } catch (e) { return reply(400, { error: 'Bad JSON' }); }
  const lesson = String(body.lesson || '');
  if (!/^[a-z0-9_-]{1,40}$/i.test(lesson)) return reply(400, { error: 'Which lesson?' });

  try {
    const isAdmin = ADMINS.indexOf(email) >= 0 && !isMicrosoft(tok);
    let programs = [];
    if (!isAdmin) {
      if (isMicrosoft(tok) && !(await isConfirmed(tok.uid, email))) return reply(403, { error: 'Twin Thieves members only' });
      const mem = await db().collection('ttmembers').doc(email).get();
      const orgs = mem.exists ? mem.get('orgs') : null;
      programs = (Array.isArray(orgs) ? orgs : []).filter(c => ORDER[c]);
      if (!programs.length) return reply(403, { error: 'Twin Thieves members only' });
    }
    const lib = parseVal(await db().collection('jj_playbook').doc('ttlib:master').get());
    const l = lib && Array.isArray(lib.lessons) ? lib.lessons.find(x => x && x.id === lesson) : null;
    if (!l) return reply(404, { error: 'No such lesson' });
    const inVersion = lesson === THANKS_ID || isAdmin || programs.some(c => Array.isArray(lib[ORDER[c]]) && lib[ORDER[c]].indexOf(lesson) >= 0);
    if (!inVersion) return reply(403, { error: 'Not a lesson in your program' });

    const bucket = bucketName(), path = ownPath(l.videoUrl, bucket);
    if (!path) return reply(200, { ok: true, url: null });
    const expiresAt = Date.now() + LINK_HOURS * HOUR;
    const [url] = await admin.storage().bucket(bucket).file(path).getSignedUrl({ version: 'v4', action: 'read', expires: expiresAt });
    return reply(200, { ok: true, url, expiresAt });
  } catch (e) {
    console.error('tt-video', e && (e.code || e.name));
    return reply(502, { error: 'Could not get the video right now. Try again in a moment.' });
  }
});
