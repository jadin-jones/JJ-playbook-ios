/* Task 9: stamp ownerEmail on member records that lack it, and copy program
 * leads to org:CODE.
 *
 *   node scripts/backfill-owner.js --project jj-playbook-dev
 *   node scripts/backfill-owner.js --project jj-playbook-dev --apply scripts/out/<plan>.json
 *   (test-6b2ab also needs --live; --leads adds the lead copy below)
 *
 * V3 rules let a member reach their own records only when the top-level
 * ownerEmail names them. The app has stamped it on new saves since sset()
 * learned to; this fills in older records. It writes only that top-level
 * field and never changes `value`. The owner is always the member:
 *   resp:CODE:idkey         the email inside the record
 *   push:CODE:idkey         from resp:CODE:idkey (its ownerEmail, else the
 *   coach:CODE:idkey          email inside it) — the member, not the coach
 *   gin:CODE:idkey            who wrote a coach or gin record
 *   push:idkey (old,        the email of any resp:*:idkey; two different
 *     person-only)            emails is reported as ambiguous, not guessed
 *
 * Records an admin took over: until sset() stopped it, an admin saving a
 * member's record (Studio's group and lead buttons, the coach's notes) wrote
 * the admin's email as its owner, locking the member out under V3. Those
 * are re-stamped with the member's email (RESTAMP), checked the same way.
 *
 * Peer rounds: peer:CODE:TOKEN gets a top-level peerMode ('team' or 'peer',
 * from the round's own mode), which the rules use to let the whole program
 * read team rounds while individual rounds stay with their owner. A round
 * without it is owner-only, so old team rounds are hidden from members until
 * this runs (PEERMODE).
 *
 * Leads (only with --leads): for every resp:CODE:* with orgLead true, the
 * lead's email is added to the `leads` list inside org:CODE's value, the
 * admin-only place the app and /api/members trust. resp.orgLead itself is left
 * as it is. Run it only once the app that reads and keeps `leads` is live:
 * an older Studio saves the whole org record and would drop the list.
 *
 * Skipped and listed, never written: no readable email, placeholder
 * addresses, the admin addresses, anyone with a rev: record for that program,
 * programs whose org:CODE is gone, and a leads list that is not a list.
 * Records already stamped and leads already listed count as done, so a second
 * run finds nothing to do.
 */
const {
  COLL, db, ADMINS, cleanEmail, loadRecords, revocations, personSkip, parseVal,
  parseArgs, guardProject, fail, savePlan, loadPlan, printPlan, applyPlan
} = require('./lib/common');
const path = require('path');

const SCRIPT = 'backfill-owner';
// Member kinds V3 protects with ownerEmail (check against firestore.rules).
const OWNED = ['resp', 'push', 'coach', 'gin'];
const USAGE = 'Usage: node scripts/backfill-owner.js --project <id> [--live] [--leads] [--apply <plan.json>]\n' +
  'Without --apply it is a dry run: nothing is written.';

/* A missing ownerEmail is stamped; an admin's is replaced (from: that address). */
const stamp = (id, had, email) => had
  ? { key: 'owner:' + id, type: 'restamp', id, from: had, owner: email }
  : { key: 'owner:' + id, type: 'owner', id, owner: email };

/* The whole plan from records already read; touches no database. */
function plan(recs, isRevoked, options) {
  options = options || {};
  const changes = [], skips = [];
  let already = 0;
  const skip = (id, s) => skips.push({ id, reason: s.reason, detail: s.detail });

  const orgs = new Map();
  (recs.org || []).forEach(r => { if (r.parts.length === 2 && r.value) orgs.set(r.parts[1], r.value); });

  // Who each member record belongs to, by program and idkey, and by idkey
  // alone. An admin's address as ownerEmail is the takeover above, so the
  // email inside the record wins over it.
  const isAdmin = e => ADMINS.indexOf(e) >= 0;
  const owner = new Map(), byIdkey = new Map();
  (recs.resp || []).forEach(r => {
    if (r.parts.length !== 3) return;
    const top = cleanEmail(r.ownerEmail), inside = cleanEmail(r.value && r.value.email);
    const email = (top && !isAdmin(top)) ? top : (inside || top);
    if (!email) return;
    owner.set(r.parts[1] + ':' + r.parts[2], email);
    if (!byIdkey.has(r.parts[2])) byIdkey.set(r.parts[2], { emails: new Set(), codes: new Set() });
    byIdkey.get(r.parts[2]).emails.add(email);
    byIdkey.get(r.parts[2]).codes.add(r.parts[1]);
  });

  // 1. ownerEmail
  for (const kind of OWNED) {
    for (const r of (recs[kind] || [])) {
      const had = cleanEmail(r.ownerEmail);
      if (had && !isAdmin(had)) { already++; continue; }
      if (r.ownerEmail && !had) { skip(r.id, { reason: 'bad-owner', detail: 'ownerEmail is set but is not an email address' }); continue; }

      if (kind === 'push' && r.parts.length === 2) {
        const who = byIdkey.get(r.parts[1]);
        if (!who) { skip(r.id, { reason: 'no-resp', detail: 'no resp:*:' + r.parts[1] + ' to take the owner from' }); continue; }
        if (who.emails.size > 1) { skip(r.id, { reason: 'ambiguous', detail: 'resp records name ' + Array.from(who.emails).join(', ') }); continue; }
        const email = Array.from(who.emails)[0];
        if (had && had === email) { already++; continue; }
        const s = personSkip(email, null, isRevoked);
        if (s) { skip(r.id, s); continue; }
        const rev = Array.from(who.codes).find(c => isRevoked(c, email));
        if (rev) { skip(r.id, { reason: 'revoked', detail: email + ' has a rev: record for ' + rev }); continue; }
        changes.push(stamp(r.id, had, email));
        continue;
      }

      if (r.parts.length !== 3) { skip(r.id, { reason: 'odd-key', detail: 'expected ' + kind + ':CODE:idkey' }); continue; }
      const code = r.parts[1], idkey = r.parts[2];
      if (!orgs.has(code)) { skip(r.id, { reason: 'no-program', detail: 'no org:' + code }); continue; }
      let email;
      if (kind === 'resp') {
        if (!r.value) { skip(r.id, { reason: 'unreadable', detail: 'record is empty or unreadable' }); continue; }
        email = cleanEmail(r.value.email);
      } else {
        email = owner.get(code + ':' + idkey);
        if (!email) { skip(r.id, { reason: 'no-resp', detail: 'no resp:' + code + ':' + idkey + ' with an email to take the owner from' }); continue; }
      }
      if (had && had === email) { already++; continue; }   // an admin's own record
      const s = personSkip(email, code, isRevoked);
      if (s) { skip(r.id, s); continue; }
      changes.push(stamp(r.id, had, email));
    }
  }

  // 2. peerMode on peer rounds
  for (const r of (recs.peer || [])) {
    if (r.parts.length !== 3) continue;   // old peer:TOKEN rounds are the migration's
    if (!r.value) { skip(r.id, { reason: 'unreadable', detail: 'round is empty or unreadable' }); continue; }
    const mode = r.value.mode === 'team' ? 'team' : 'peer';
    if (r.peerMode === mode) { already++; continue; }
    changes.push({ key: 'peermode:' + r.id, type: 'peermode', id: r.id, mode, from: r.peerMode || '' });
  }

  // 3. leads
  const seen = new Set();
  for (const r of (options.leads ? (recs.resp || []) : [])) {
    if (r.parts.length !== 3 || !r.value || r.value.orgLead !== true) continue;
    const code = r.parts[1], id = 'org:' + code;
    const org = orgs.get(code);
    if (!org) { skip(r.id, { reason: 'no-program', detail: 'lead of a program with no org:' + code }); continue; }
    const email = owner.get(code + ':' + r.parts[2]) || '';
    const s = personSkip(email, code, isRevoked);
    if (s) { skip(r.id, Object.assign({}, s, { detail: 'lead: ' + s.detail })); continue; }
    if (org.leads !== undefined && !Array.isArray(org.leads)) { skip(id, { reason: 'bad-leads', detail: 'leads is not a list; fix it in Studio first' }); continue; }
    if ((org.leads || []).indexOf(email) >= 0) { already++; continue; }
    const key = 'lead:' + code + ':' + email;
    if (seen.has(key)) continue;
    seen.add(key);
    changes.push({ key, type: 'lead', id, code, email });
  }

  return { changes, skips, already };
}

const describe = c => c.type === 'owner' ? 'STAMP    ' + c.id + '  ownerEmail = ' + c.owner
  : c.type === 'restamp' ? 'RESTAMP  ' + c.id + '  ownerEmail ' + c.from + ' -> ' + c.owner
  : c.type === 'peermode' ? 'PEERMODE ' + c.id + '  peerMode = ' + c.mode + (c.from ? ' (was ' + c.from + ')' : '')
  : 'LEAD     ' + c.id + '  add ' + c.email + ' to leads';

/* One change, in a transaction that re-reads the record first. Returns true,
   or why it was not written. */
function write(c) {
  const ref = db().collection(COLL).doc(c.id);
  return db().runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (!snap.exists) return 'record is gone';
    if (c.type === 'owner' || c.type === 'restamp') {
      const now = snap.get('ownerEmail') || '';
      if (c.type === 'owner' && now) return 'already has ownerEmail ' + now;
      if (c.type === 'restamp' && now !== c.from) return 'ownerEmail is now ' + (now || 'missing') + ', not ' + c.from;
      tx.update(ref, { ownerEmail: c.owner });
      return true;
    }
    const v = parseVal(snap);
    if (c.type === 'peermode') {
      if (!v) return 'round is empty or unreadable';
      if ((v.mode === 'team' ? 'team' : 'peer') !== c.mode) return 'the round\'s mode has changed';
      if ((snap.get('peerMode') || '') !== c.from) return 'peerMode is now ' + (snap.get('peerMode') || 'missing');
      tx.update(ref, { peerMode: c.mode });
      return true;
    }
    if (!v) return 'program record is empty or unreadable';
    const leads = v.leads === undefined ? [] : v.leads;
    if (!Array.isArray(leads)) return 'leads is not a list';
    if (leads.indexOf(c.email) >= 0) return 'already a lead';
    v.leads = leads.concat([c.email]);
    tx.update(ref, { value: JSON.stringify(v) });
    return true;
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2), USAGE, ['leads']);
  const project = guardProject(args, USAGE);
  const saved = args.apply ? loadPlan(args.apply, SCRIPT, project, args.options) : null;
  const recs = await loadRecords(OWNED.concat(['org', 'rev', 'peer']));
  const fresh = plan(recs, revocations(recs.rev), args.options);
  if (!saved) {
    printPlan(fresh, describe);
    const file = savePlan(SCRIPT, project, args.options, fresh);
    console.log('\nNothing was written. Plan saved to ' + path.relative(process.cwd(), file));
    console.log('To write exactly these changes: node scripts/backfill-owner.js --project ' + project +
      (args.live ? ' --live' : '') + (args.options.leads ? ' --leads' : '') + ' --apply ' + path.relative(process.cwd(), file));
    return;
  }
  await applyPlan(saved, fresh, project, describe, write);
}

if (require.main === module) main().catch(e => fail(e.stack || e.message));
module.exports = { plan };
