/* A small rate limit that needs nothing but Firestore.
 *
 * allow(bucket, key, max, windowMs) is true while `key` (an IP address, a
 * uid, a round token) has made fewer than `max` calls in `bucket` within the
 * current window. Counts live in rateLimits/{hash of bucket and key}, which
 * firestore.rules closes to every client; `expireAt` lets a Firestore TTL
 * policy clear old ones. Fails closed: if the count cannot be read or
 * written, the call counts as over the limit.
 */
const crypto = require('crypto');
const { admin, db } = require('./firebase-admin');

/* The caller's address as Netlify saw it. */
function clientIp(event) {
  const h = (event && event.headers) || {};
  const ip = h['x-nf-client-connection-ip'] || String(h['x-forwarded-for'] || '').split(',')[0] || '';
  return String(ip).trim() || 'unknown';
}

async function allow(bucket, key, max, windowMs) {
  const id = crypto.createHash('sha256').update(bucket + '|' + key).digest('hex').slice(0, 40);
  const ref = db().collection('rateLimits').doc(id);
  const now = Date.now();
  try {
    return await db().runTransaction(async tx => {
      const snap = await tx.get(ref);
      const d = snap.exists ? snap.data() : {};
      if (!d.start || now - d.start >= windowMs) {
        tx.set(ref, { bucket, start: now, count: 1, expireAt: admin.firestore.Timestamp.fromMillis(now + windowMs) });
        return true;
      }
      if ((d.count || 0) >= max) return false;
      tx.update(ref, { count: (d.count || 0) + 1 });
      return true;
    });
  } catch (e) {
    console.error('rate-limit', bucket, e && e.code);
    return false;
  }
}

const HOUR = 60 * 60 * 1000;
module.exports = { allow, clientIp, HOUR };
