/* Microsoft sign-ins arrive with email_verified already true, but with a
 * multi-tenant app any Microsoft tenant's admin can put any address on an
 * account ("nOAuth"). So the first time a Microsoft sign-in joins a program,
 * /api/join asks for proof that they own the mailbox: a link we emailed,
 * confirmed through /api/ms-verify. Once confirmed, msVerified/{uid} holds
 * the email and it is never asked again for that account and address.
 *
 * msVerified/{uid}        { email, at }                       server-only
 * msVerifyPending/{uid}   { email, hash, exp, sentAt, sends,  server-only
 *                           windowStart, fails }
 * Neither is readable or writable by the app; only these functions (Admin
 * SDK) touch them.
 */
const { db } = require('./firebase-admin');

const isMicrosoft = tok => !!(tok && tok.firebase && tok.firebase.sign_in_provider === 'microsoft.com');

async function isConfirmed(uid, email) {
  const snap = await db().collection('msVerified').doc(uid).get();
  return snap.exists && String(snap.get('email') || '') === email;
}

module.exports = { isMicrosoft, isConfirmed };
