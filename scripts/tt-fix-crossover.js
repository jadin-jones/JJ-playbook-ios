/* Undo a Playbook join of a Twin Thieves program, for one person.
 *
 *   node scripts/tt-fix-crossover.js --project test-6b2ab --live --email <address>
 *   node scripts/tt-fix-crossover.js --project test-6b2ab --live --email <address> --apply <plan.json>
 *
 * Before the merge, main's /api/join did not refuse Twin Thieves programs, so
 * typing TT36 or TT10 on the Playbook site joined it as a Playbook program:
 * TT36/TT10 went into members/{email}.orgs and Playbook records such as
 * resp:TT10:<idkey> were made. scripts/tt-inventory.js lists them. Twin
 * Thieves itself never uses either (its members are in ttmembers/ and ttm:).
 *
 * For the one --email given, and nothing else, the plan:
 *   members  takes TT36 and TT10 out of members/{email}.orgs (its other
 *            codes stay; the document stays, even if orgs ends up empty)
 *   delete   deletes resp:, coach:, gin: and push: records keyed
 *            <kind>:TT36:<idkey> or <kind>:TT10:<idkey>
 * ttmembers/, ttm: and every Playbook program's records are never touched.
 *
 * A dry run reads only and saves the plan. --apply plans again, writes only
 * what both plans agree on, after you type the project ID. It first saves
 * everything it will change or delete to
 * scripts/out/tt-fix-crossover-backup-<project>-<time>.json, and changes a
 * record only if it is still exactly what the dry run saw.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  admin, db, COLL, slug, cleanEmail, parseArgs, guardProject, fail, savePlan, loadPlan, printPlan, applyPlan
} = require('./lib/common');

const SCRIPT = 'tt-fix-crossover';
const TT = ['TT36', 'TT10'];
const KINDS = ['resp', 'coach', 'gin', 'push'];
const OUT_DIR = path.join(__dirname, 'out');
const USAGE = 'Usage: node scripts/tt-fix-crossover.js --project <id> [--live] --email <address> [--apply <plan.json>]';
const sha = o => crypto.createHash('sha256').update(JSON.stringify(o)).digest('hex');

async function plan(email) {
  const changes = [], skips = [];
  const idkey = slug(email);
  const mref = db().collection('members').doc(email);
  const m = await mref.get();
  const orgs = m.exists ? m.get('orgs') : null;
  if (!m.exists) skips.push({ id: 'members/' + email, reason: 'no-members', detail: 'no members document' });
  else if (!Array.isArray(orgs)) skips.push({ id: 'members/' + email, reason: 'bad-members', detail: 'orgs is not a list; fix by hand' });
  else {
    const remove = orgs.filter(c => TT.indexOf(c) >= 0);
    if (remove.length) changes.push({ key: 'members/' + email, type: 'members', email, remove, was: sha(orgs),
      keep: orgs.filter(c => TT.indexOf(c) < 0) });
  }
  for (const kind of KINDS) for (const code of TT) {
    const id = kind + ':' + code + ':' + idkey;
    const s = await db().collection(COLL).doc(id).get();
    if (s.exists) changes.push({ key: id, type: 'delete', id, was: sha(s.data()) });
  }
  return { email, changes, skips, already: 0 };
}

const describe = c => c.type === 'members'
  ? c.key + ': remove ' + c.remove.join(', ') + ' (keeps ' + (c.keep.length ? c.keep.join(', ') : 'nothing') + ')'
  : c.id + ': delete';

async function main() {
  const argv = process.argv.slice(2);
  let email = '';
  const i = argv.indexOf('--email');
  if (i >= 0) { email = cleanEmail(argv[i + 1]); argv.splice(i, 2); }
  const args = parseArgs(argv, USAGE, []);
  if (!email) fail('Name the one person: --email <address>\n\n' + USAGE);
  const project = guardProject(args, USAGE);
  console.log('Person:          ' + email + '\n');
  const options = { email };
  const saved = args.apply ? loadPlan(args.apply, SCRIPT, project, options) : null;
  const fresh = await plan(email);
  if (!saved) {
    printPlan(fresh, describe, { members: 'Take Twin Thieves codes out of members/', delete: 'Delete Playbook records under TT36/TT10' });
    const file = savePlan(SCRIPT, project, options, fresh);
    console.log('\nDry run only: nothing was written. Plan saved to ' + path.relative(process.cwd(), file));
    if (fresh.changes.length) console.log('To write it: add --apply ' + path.relative(process.cwd(), file));
    return;
  }
  // Back up everything the run may change or delete, before anything is written.
  const backup = {};
  for (const c of saved.changes) {
    const ref = c.type === 'members' ? db().collection('members').doc(c.email) : db().collection(COLL).doc(c.id);
    const s = await ref.get(); backup[c.key] = s.exists ? s.data() : null;
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const bf = path.join(OUT_DIR, SCRIPT + '-backup-' + project + '-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json');
  fs.writeFileSync(bf, JSON.stringify({ project, email, at: new Date().toISOString(), docs: backup }, null, 2));
  console.log('Backed up ' + Object.keys(backup).length + ' record(s) to ' + path.relative(process.cwd(), bf) + '\n');
  await applyPlan(saved, fresh, project, describe, c => db().runTransaction(async tx => {
    if (c.type === 'members') {
      const ref = db().collection('members').doc(c.email);
      const s = await tx.get(ref);
      if (!s.exists || sha(s.get('orgs')) !== c.was) return 'changed since the dry run';
      tx.update(ref, { orgs: admin.firestore.FieldValue.arrayRemove(...c.remove), updatedAt: admin.firestore.FieldValue.serverTimestamp() });
      return true;
    }
    const ref = db().collection(COLL).doc(c.id);
    const s = await tx.get(ref);
    if (!s.exists || sha(s.data()) !== c.was) return 'changed since the dry run';
    tx.delete(ref);
    return true;
  }));
}

main().then(() => process.exit(0)).catch(e => { console.error('\nStopped: ' + (e && (e.code || e.message))); process.exit(1); });
