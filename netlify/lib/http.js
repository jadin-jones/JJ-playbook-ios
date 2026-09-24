/* JSON replies with CORS for our own sites only.
 *
 * The app calls /api/* from its own origin, which needs no CORS at all; this
 * only decides what another site's browser may do. The two sites below get
 * the CORS headers; any other origin gets none, so its browser refuses the
 * response. Errors never carry a stack or an exception's message.
 */
const ORIGINS = ['https://jjplaybook.netlify.app', 'https://jj-playbook-dev.netlify.app'];

function http(event, methods, allowHeaders) {
  const h = (event && event.headers) || {};
  const origin = h.origin || h.Origin || '';
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Vary': 'Origin' };
  if (ORIGINS.indexOf(origin) >= 0) {
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

module.exports = { http, withCors, ORIGINS };
