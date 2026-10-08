/* Copy the Twin Thieves set-up (lesson library and the two programs) from one
 * project to another. Step 7 of docs/TWIN-THIEVES-MERGE.md, used only if
 * scripts/tt-inventory.js shows them missing on live.
 *
 * Only these three records are ever read or written; anything else in an
 * export file stops the script:
 *   ttlib:master   the lesson library (order36 / order10)
 *   org:TT36       the 36-lesson program and its code TWIN36
 *   org:TT10       the 10-lesson program and its code TWIN10
 * Members, progress, invites, approved lists and removals (ttm, ttmembers,
 * ttinv, ttallow, rev) are never copied, and nothing of the Playbook is
 * touched.
 *
 * 1. Export, with the SOURCE project's credentials (reads only):
 *      node scripts/copy-tt.js --export --project jj-playbook-dev
 *    saves scripts/out/copy-tt-export-<project>-<time>.json
 * 2. Dry run, with the TARGET project's credentials (reads only):
 *      node scripts/copy-tt.js --project test-6b2ab --live --from <export.json>
 *    lists each record as new (would be created), identical (nothing to do)
 *    or different (left alone), and saves the plan to scripts/out/.
 * 3. Real run: the same command plus --apply <plan.json>. It plans again,
 *    writes only what both plans agree on, after you type the project ID.
 *
 * A record that already exists and differs is never replaced unless you add
 * --overwrite (to the dry run and the real run alike). Then the real run
 * first saves every record it is about to replace to
 * scripts/out/copy-tt-backup-<project>-<time>.json, and writes a record only
 * if it is still exactly what the dry run saw.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  db, COLL, parseArgs, guardProject, fail, savePlan, loadPlan, printPlan, applyPlan
} = require('./lib/common');

const SCRIPT = 'copy-tt';
const IDS = ['ttlib:master', 'org:TT36', 'org:TT10'];
const CODES = { 'org:TT36': ['TWIN36', 36], 'org:TT10': ['TWIN10', 10] };
const OUT_DIR = path.join(__dirname, 'out');
const USAGE = [
  'Usage:',
  '  node scripts/copy-tt.js --export --project <source> [--live]',
  '  node scripts/copy-tt.js --project <target> [--live] --from <export.json> [--overwrite]',
  '  node scripts/copy-tt.js --project <target> [--live] --from <export.json> [--overwrite] --apply <plan.json>'
].join('\n');
const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');

/* Why a record's value is not fit to copy, or ''. */
function badValue(id, raw) {
  let v; try { v = JSON.parse(raw); } catch (e) { return 'value is not JSON'; }
  if (!v || typeof v !== 'object') return 'value is not an object';
  if (id === 'ttlib:master') {
    const o36 = Array.isArray(v.order36) ? v.order36 : [], o10 = Array.isArray(v.order10) ? v.order10 : [];
    const ids = new Set((Array.isArray(v.lessons) ? v.lessons : []).map(l => l && l.id));
    if (o36.length !== 36) return 'order36 has ' + o36.length + ' lessons, not 36';
    if (o10.length !== 10) return 'order10 has ' + o10.length + ' lessons, not 10';
    if (!o10.every(x => o36.indexOf(x) >= 0)) return 'order10 is not inside order36';
    if (!o36.every(x => ids.has(x))) return 'order36 names a lesson the library does not have';
    return '';
  }
  const [code, version] = CODES[id];
  if (v.product !== 'tt') return 'product is not tt';
  if (Number(v.ttVersion) !== version) return 'ttVersion is not ' + version;
  if (String(v.joinCode || '').toUpperCase() !== code) return 'joinCode is not ' + code;
  return '';
}

async function exportFrom(project) {
  const docs = {};
  for (const id of IDS) {
    const snap = await db().collection(COLL).doc(id).get();
    if (!snap.exists) { console.log('  ' + id + ': not in ' + project + ', left out'); continue; }
    const raw = snap.get('value');
    if (typeof raw !== 'string') { console.log('  ' + id + ': no value, left out'); continue; }
    const bad = badValue(id, raw);
    if (bad) { console.log('  ' + id + ': ' + bad + ', left out'); continue; }
    docs[id] = raw;
    console.log('  ' + id + ': exported (' + raw.length + ' characters)');
  }
  if (!Object.keys(docs).length) fail('Nothing to export.');
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, 'copy-tt-export-' + project + '-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json');
  fs.writeFileSync(file, JSON.stringify({ script: SCRIPT + '-export', project, at: new Date().toISOString(), docs }, null, 2));
  console.log('\nSaved ' + path.relative(process.cwd(), file) + '\nNext, with the target project\'s credentials: --project <target> --from ' + path.relative(process.cwd(), file));
}

function readExport(file, target) {
  let x;
  try { x = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { fail('Could not read export ' + file + ': ' + e.message); }
  if (x.script !== SCRIPT + '-export' || !x.docs || typeof x.docs !== 'object') fail('That is not a copy-tt export.');
  if (x.project === target) fail('That export is from ' + target + ' itself.');
  const extra = Object.keys(x.docs).filter(id => IDS.indexOf(id) < 0);
  if (extra.length) fail('The export holds records this script never copies: ' + extra.join(', '));
  return x;
}

/* What would change. Reads only. */
async function plan(x, overwrite) {
  const changes = [], skips = [];
  let already = 0;
  for (const id of IDS) {
    const raw = x.docs[id];
    if (raw === undefined) { skips.push({ id, reason: 'not-exported', detail: 'not in the export' }); continue; }
    const bad = badValue(id, raw);
    if (bad) { skips.push({ id, reason: 'bad-export', detail: bad }); continue; }
    const snap = await db().collection(COLL).doc(id).get();
    const cur = snap.exists ? snap.data() : null;
    if (!cur) { changes.push({ key: id, type: 'create', id, hash: sha(raw) }); continue; }
    if (cur.value === raw && Object.keys(cur).join() === 'value') { already++; continue; }
    if (!overwrite) { skips.push({ id, reason: 'differs', detail: 'exists and differs; left alone (add --overwrite to replace it, after a backup)' }); continue; }
    changes.push({ key: id, type: 'overwrite', id, hash: sha(raw), was: sha(JSON.stringify(cur)) });
  }
  return { from: x.project, exportAt: x.at, changes, skips, already };
}

const describe = c => c.id + (c.type === 'overwrite' ? '  (replaces the record there now)' : '');

async function main() {
  const argv = process.argv.slice(2);
  let from = '';
  const i = argv.indexOf('--from');
  if (i >= 0) { from = String(argv[i + 1] || ''); argv.splice(i, 2); }
  const args = parseArgs(argv, USAGE, ['export', 'overwrite']);
  const project = guardProject(args, USAGE);

  if (args.options.export) {
    if (from || args.apply || args.options.overwrite) fail('--export only reads; it takes no --from, --apply or --overwrite.');
    return exportFrom(project);
  }
  if (!from) fail('Name the export: --from scripts/out/copy-tt-export-<project>-<time>.json\n\n' + USAGE);
  const x = readExport(from, project);
  const options = { overwrite: args.options.overwrite, from: x.project, exportAt: x.at };
  console.log('Export:          ' + x.project + ' at ' + x.at + '\n');
  const saved = args.apply ? loadPlan(args.apply, SCRIPT, project, options) : null;
  const fresh = await plan(x, args.options.overwrite);
  if (!saved) {
    printPlan(fresh, describe, { create: 'Create (not there yet)', overwrite: 'Replace (exists and differs)' });
    const file = savePlan(SCRIPT, project, options, fresh);
    console.log('\nDry run only: nothing was written. Plan saved to ' + path.relative(process.cwd(), file));
    if (fresh.changes.length) console.log('To write it: add --apply ' + path.relative(process.cwd(), file));
    return;
  }
  // Back up every record a real run may replace, before anything is written.
  const over = saved.changes.filter(c => c.type === 'overwrite');
  if (over.length) {
    const backup = {};
    for (const c of over) { const s = await db().collection(COLL).doc(c.id).get(); backup[c.id] = s.exists ? s.data() : null; }
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const bf = path.join(OUT_DIR, 'copy-tt-backup-' + project + '-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json');
    fs.writeFileSync(bf, JSON.stringify({ project, at: new Date().toISOString(), docs: backup }, null, 2));
    console.log('Backed up ' + over.length + ' record(s) to ' + path.relative(process.cwd(), bf) + '\n');
  }
  await applyPlan(saved, fresh, project, describe, c => db().runTransaction(async tx => {
    const ref = db().collection(COLL).doc(c.id);
    const s = await tx.get(ref);
    if (c.type === 'create' && s.exists) return 'exists now';
    if (c.type === 'overwrite' && (!s.exists || sha(JSON.stringify(s.data())) !== c.was)) return 'changed since the dry run';
    const raw = x.docs[c.id];
    if (sha(raw) !== c.hash) return 'the export changed since the dry run';
    tx.set(ref, { value: raw });
    return true;
  }));
}

main().then(() => process.exit(0)).catch(e => { console.error('\nStopped: ' + (e && (e.code || e.message))); process.exit(1); });
