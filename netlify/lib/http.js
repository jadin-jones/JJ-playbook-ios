/* JSON replies with CORS for our own sites only.
 *
 * The app calls /api/* from its own origin, which needs no CORS at all; this
 * only decides what another site's browser may do. Each Netlify site answers
 * only its own addresses (by FIREBASE_PROJECT_ID), so the live API never
 * serves a Dev page or the other way round; any other origin gets no CORS
 * headers, so its browser refuses the response. Errors never carry a stack
 * or an exception's message.
 */
const SITE_HOSTS = {
  'test-6b2ab': ['jjplaybook.netlify.app', 'playbook.jadin-jones.com'],
  'jj-playbook-dev': ['jj-playbook-dev.netlify.app', 'dev.playbook.jadin-jones.com', 'jj-twinthieves-preview.netlify.app']
};
/* This site's own https origins; none if the project is not one of ours. */
function siteOrigins() {
  return (SITE_HOSTS[String(process.env.FIREBASE_PROJECT_ID || '')] || []).map(h => 'https://' + h);
}
/* The caller's Origin header when it is one of this site's own, else ''. */
function ownOrigin(event) {
  const h = (event && event.headers) || {};
  const origin = String(h.origin || h.Origin || '');
  return siteOrigins().indexOf(origin) >= 0 ? origin : '';
}

function http(event, methods, allowHeaders) {
  const origin = ownOrigin(event);
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Vary': 'Origin' };
  if (origin) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Allow-Methods'] = methods;
    headers['Access-Control-Allow-Headers'] = allowHeaders || 'Content-Type, Authorization';
  }
  return {
    headers,
    reply: (statusCode, body) => ({ statusCode, headers, body: JSON.stringify(body) }),
    preflight: () => ({ statusCode: 204, headers, body: '' })
  };
}

/* exports.handler = withCors(methods, allowHeaders, async event => ...)
   answers preflight, puts our CORS headers on every response (dropping any
   the handler set), and turns anything thrown into a plain 500. */
function withCors(methods, allowHeaders, fn) {
  return async function (event, context) {
    const { headers, preflight } = http(event, methods, allowHeaders);
    if (event.httpMethod === 'OPTIONS') return preflight();
    let res;
    try { res = await fn(event, context); }
    catch (e) {
      console.error('handler', e && (e.code || e.name));
      res = { statusCode: 500, body: JSON.stringify({ error: 'Something went wrong. Try again in a moment.' }) };
    }
    const out = Object.assign({}, (res && res.headers) || {});
    Object.keys(out).forEach(k => { if (/^access-control-/i.test(k) || /^vary$/i.test(k)) delete out[k]; });
    return Object.assign({}, res, { headers: Object.assign(out, headers) });
  };
}

module.exports = { http, withCors, ownOrigin, siteOrigins, SITE_HOSTS };
