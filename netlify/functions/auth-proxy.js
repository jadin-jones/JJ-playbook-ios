/* Firebase's sign-in helper, served from this site's own domain.
 *
 * Google sign-in hands off through Firebase's helper pages at
 * <project>.firebaseapp.com/__/auth/*. When that is a different site from the
 * app, Safari, Firefox and Chrome with third-party storage blocked lose the
 * handoff: the person comes back from Google still signed out. Serving the
 * same pages at <this site>/__/auth/* makes the handoff first-party. This is
 * Firebase's "proxy auth requests" fix.
 *
 * GET /__/auth/<file>   (netlify.toml maps it here)
 *
 * The project comes from FIREBASE_PROJECT_ID, already set per site, so the
 * dev site proxies jj-playbook-dev and the live site its own project with one
 * shared netlify.toml. Only the helper's own files are passed through; any
 * other path is a 404.
 */
const FILES = ['handler', 'handler.js', 'iframe', 'iframe.js', 'experiments.js'];
const PASS_HEADERS = ['content-type', 'cache-control', 'content-security-policy', 'x-content-type-options'];

const text = (statusCode, body) => ({ statusCode, headers: { 'Content-Type': 'text/plain' }, body });

exports.handler = async function (event) {
  if (event.httpMethod !== 'GET' && event.httpMethod !== 'HEAD') return text(405, 'GET only');

  const project = String(process.env.FIREBASE_PROJECT_ID || '');
  if (!/^[a-z0-9-]{4,40}$/.test(project)) return text(500, 'FIREBASE_PROJECT_ID is not set on this site');

  // Netlify may hand over the original path or the function's own path.
  const m = /(?:\/__\/auth\/|\/auth-proxy\/)([^/]+)$/.exec(event.path || '');
  const file = m ? m[1] : '';
  if (FILES.indexOf(file) < 0) return text(404, 'Not found');

  let query = event.rawQuery;
  if (query == null) query = new URLSearchParams(event.queryStringParameters || {}).toString();
  const url = 'https://' + project + '.firebaseapp.com/__/auth/' + file + (query ? '?' + query : '');

  let r;
  try { r = await fetch(url, { method: event.httpMethod, redirect: 'manual' }); }
  catch (e) { console.error('auth-proxy', url, e); return text(502, 'Could not reach sign-in'); }

  const headers = {};
  PASS_HEADERS.forEach(h => { const v = r.headers.get(h); if (v) headers[h] = v; });
  const loc = r.headers.get('location');
  if (loc) headers.location = loc;
  const body = event.httpMethod === 'HEAD' ? '' : await r.text();
  return { statusCode: r.status, headers, body };
};
