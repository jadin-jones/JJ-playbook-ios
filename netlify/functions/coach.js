/* The coaching endpoint.
 *
 * The app cannot call Anthropic directly: doing so would ship your API key to
 * every member's phone. This function is the middle step — it runs on
 * Netlify's servers, holds the key as an environment variable, and passes the
 * conversation through.
 *
 * Set ANTHROPIC_API_KEY in Netlify → Site configuration → Environment
 * variables. Nothing else is required; the redirect in netlify.toml maps
 * /api/coach to this file.
 */
const MODEL = 'claude-sonnet-4-5';
const MAX_SYSTEM = 60000;   // a runaway knowledge base should cost you nothing
const MAX_TOKENS = 700;

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'POST only' }) };
  }

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    return { statusCode: 500, headers: CORS,
      body: JSON.stringify({ error: 'ANTHROPIC_API_KEY is not set on this site' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Bad JSON' }) }; }

  const system = String(body.system || '').slice(0, MAX_SYSTEM);
  /* Only the two roles the API accepts, only strings, and never an empty turn —
     a malformed history is the most common cause of a 400 from upstream. */
  const messages = (Array.isArray(body.messages) ? body.messages : [])
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && String(m.content || '').trim())
    .map(m => ({ role: m.role, content: String(m.content).slice(0, 8000) }))
    .slice(-20);

  if (!messages.length) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'No message' }) };
  }
  // The API requires the exchange to start with the member, not the coach.
  while (messages.length && messages[0].role !== 'user') messages.shift();
  if (!messages.length) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'No user message' }) };
  }

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: body.model || MODEL,
        max_tokens: Math.min(Number(body.max_tokens) || MAX_TOKENS, 1200),
        system: system || undefined,
        messages: messages
      })
    });

    const data = await res.json();
    if (!res.ok) {
      console.error('anthropic error', res.status, data && data.error);
      return { statusCode: 502, headers: CORS,
        body: JSON.stringify({ error: (data && data.error && data.error.message) || 'Upstream error' }) };
    }

    const text = (Array.isArray(data.content) ? data.content : [])
      .filter(b => b && b.type === 'text').map(b => b.text).join('').trim();

    return { statusCode: 200, headers: CORS, body: JSON.stringify({ text: text }) };
  } catch (e) {
    console.error('coach handler', e);
    return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: 'Could not reach the model' }) };
  }
};
