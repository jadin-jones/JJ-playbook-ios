/* Task 9: build members/{email}.orgs from existing resp: records.
 *
 *   node scripts/build-members.js --project jj-playbook-dev
 *   node scripts/build-members.js --project jj-playbook-dev --apply scripts/out/<plan>.json
 *   (test-6b2ab also needs --live)
 *
 * V3 rules let a member read a program only when its code is in their
 * members/{email}.orgs. /api/join adds it when someone joins; people who
 * joined before that have no entry, and V3 would lock them out. This adds
 * CODE for every resp:CODE:idkey, with the same checks /api/join makes, and
 * the same write: email, orgs (arrayUnion, so codes are only ever added) and
 * updatedAt. Run backfill-owner.js first.
 *
 * Skipped and listed, never written:
 *   no-program     org:CODE is gone
 *   unreadable     the resp: record is empty or unreadable
 *   no-email       no readable email address
 *   owner-mismatch its ownerEmail and the email inside it disagree
 *   placeholder    a placeholder address (your-…, you@, @example.com, …)
 *   admin          an admin address (admins read through the rules)
 *   revoked        a rev: record for that program
 *   idkey-mismatch the key is not resp:CODE:<slug(email)>, so the app's
 *                  own lookup would not find it; handle by hand
 *   bad-allowlist  the program's approved list is not a list
 *   not-listed     the program has an approved list and the email is not
 *                  on it; add them in Studio's Who can join if they belong
 *   bad-members    their members document has an orgs that is not a list
 * Codes already listed count as done, so a second run finds nothing to do.
 */
const {
  admin, db, slug, cleanEmail, loadRecords, revocations, personSkip,
  parseArgs, guardProject, fail, savePlan, loadPlan, printPlan, applyPlan
} = require('./lib/common');
const path = require('path');

const SCRIPT = 'build-members';
const USAGE = 'Usage: node scripts/build-members.js --project <id> [--live] [--apply <plan.json>]\n' +
  'Without --apply it is a dry run: nothing is written.';

/* members/{email} → { orgs } for everyone, read once. */
async function loadMembers() {
  const snap = await db().collection('members').get();
  return snap.docs.map(d => ({ email: d.id, orgs: d.get('orgs') }));
}

/* The whole plan from records already read; touches no database. */
function plan(recs, members, isRevoked) {
  const changes = [], skips = [];
  let already = 0;
  const skip = (id, reason, detail) => skips.push({ id, reason, detail });

  const orgs = new Map();
  (recs.org || []).forEach(r => { if (r.parts.length === 2 && r.value) orgs.set(r.parts[1], r.value); });
  const listed = new Map();
  (members || []).forEach(m => listed.set(m.email, m.orgs));
  const seen = new Set();

  for (const r of (recs.resp || [])) {
    if (r.parts.length !== 3) { skip(r.id, 'odd-key', 'expected resp:CODE:idkey'); continue; }
    const code = r.parts[1], idkey = r.parts[2];
    if (idkey === '__preview__' || /^sample-/.test(idkey)) continue;
    const org = orgs.get(code);
    if (!org) { skip(r.id, 'no-program', 'no org:' + code); continue; }
    if (!r.value) { skip(r.id, 'unreadable', 'record is empty or unreadable'); continue; }
    const inside = cleanEmail(r.value.email), top = cleanEmail(r.ownerEmail);
    if (top && inside && top !== inside) { skip(r.id, 'owner-mismatch', 'ownerEmail ' + top + ' but the record says ' + inside); continue; }
    const email = top || inside;
    const s = personSkip(email, code, isRevoked);
    if (s) { skip(r.id, s.reason, s.detail); continue; }
    if (idkey !== slug(email)) { skip(r.id, 'idkey-mismatch', email + ' would be resp:' + code + ':' + slug(email)); continue; }
    const allow = org.allowlist || [];
    if (!Array.isArray(allow)) { skip(r.id, 'bad-allowlist', 'the approved list for ' + (org.name || code) + ' is not a list'); continue; }
    if (allow.length && allow.indexOf(email) < 0) {
      skip(r.id, 'not-listed', email + ' is not on the approved list for ' + (org.name || code) + ' (' + code + ')');
      continue;
    }
    const have = listed.get(email);
    if (have !== undefined && !Array.isArray(have)) { skip(r.id, 'bad-members', 'members/' + email + ' has an orgs that is not a list'); continue; }
    if ((have || []).indexOf(code) >= 0) { already++; continue; }
    const key = 'member:' + email + ':' + code;
    if (seen.has(key)) continue;
    seen.add(key);
    changes.push({ key, type: 'member', email, code });
  }
  return { changes, skips, already };
}

const describe = c => 'ADD    members/' + c.email + '  orgs += ' + c.code;

/* One change, in a transaction that re-reads the members document first.
   Returns true, or why it was not written. */
function write(c) {
  const ref = db().collection('members').doc(c.email);
  return db().runTransaction(async tx => {
    const snap = await tx.get(ref);
    const orgs = snap.exists ? snap.get('orgs') : [];
    if (orgs !== undefined && !Array.isArray(orgs)) return 'orgs is not a list';
    if ((orgs || []).indexOf(c.code) >= 0) return 'already listed';
    tx.set(ref, {
      email: c.email,
      orgs: admin.firestore.FieldValue.arrayUnion(c.code),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    return true;
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2), USAGE, []);
  const project = guardProject(args, USAGE);
  const saved = args.apply ? loadPlan(args.apply, SCRIPT, project, args.options) : null;
  const recs = await loadRecords(['resp', 'org', 'rev']);
  const fresh = plan(recs, await loadMembers(), revocations(recs.rev));
  if (!saved) {
    printPlan(fresh, describe, { member: 'Add a program code to members/{email}.orgs' });
    const file = savePlan(SCRIPT, project, args.options, fresh);
    console.log('\nNothing was written. Plan saved to ' + path.relative(process.cwd(), file));
    console.log('To write exactly these changes: node scripts/build-members.js --project ' + project +
      (args.live ? ' --live' : '') + ' --apply ' + path.relative(process.cwd(), file));
    return;
  }
  await applyPlan(saved, fresh, project, describe, write);
}

if (require.main === module) main().catch(e => fail(e.stack || e.message));
module.exports = { plan };
