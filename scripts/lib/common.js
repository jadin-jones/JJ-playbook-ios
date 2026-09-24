/* Shared by the Task 9 scripts (backfill-owner.js, build-members.js).
 *
 * Every script run the same way:
 *   node scripts/<name>.js --project <id>              dry run: reads only,
 *                                                      prints every change and
 *                                                      skip, saves the plan to
 *                                                      scripts/out/
 *   node scripts/<name>.js --project <id> --apply <plan.json>
 *                                                      real run: plans again,
 *                                                      writes only changes that
 *                                                      are in both, after you
 *                                                      type the project ID
 *   add --live for test-6b2ab; without it the script refuses the live project.
 *
 * Credentials come from the same three variables the Netlify functions use
 * (netlify/lib/firebase-admin.js): FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL,
 * FIREBASE_PRIVATE_KEY. In the Codespace they are Codespaces secrets, so no key
 * file exists. Nothing here prints the key.
 */
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { admin, db, missingEnv } = require('../../netlify/lib/firebase-admin');

const COLL = 'jj_playbook';
const LIVE_PROJECT = 'test-6b2ab';
const ADMINS = ['charlie@jadin-jones.com', 'lucas@jadin-jones.com', 'review@jadin-jones.com'];
const OUT_DIR = path.join(__dirname, '..', 'out');

// Same helpers as the app and /api/join, character for character.
const cleanCode = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
const cleanEmail = e => {
  const s = String(e || '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : '';
};

/* The app stores every record as a JSON string in `value`. A doc that exists
   but holds null (a tombstone) reads as absent, as it does in the app. */
function parseVal(snap) {
  if (!snap || !snap.exists) return null;
  const raw = snap.get('value');
  if (typeof raw !== 'string') return null;
  try { const v = JSON.parse(raw); return v && typeof v === 'object' ? v : null; } catch (e) { return null; }
}

/* Addresses left in from forms and examples. Returns why, or '' if real. */
const PLACEHOLDER_LOCALS = ['you', 'name', 'email'];
const PLACEHOLDER_DOMAINS = ['example.com', 'example.org', 'test.com'];
function placeholderReason(email) {
  const at = email.lastIndexOf('@');
  const local = email.slice(0, at), domain = email.slice(at + 1);
  if (/^your[-_]/.test(local)) return 'local part starts "' + local.slice(0, 5) + '"';
  if (PLACEHOLDER_LOCALS.indexOf(local) >= 0) return '"' + local + '@"';
  const d = PLACEHOLDER_DOMAINS.find(x => domain === x || domain.endsWith('.' + x));
  return d ? 'domain ' + d : '';
}

/* One read of every document whose id starts with prefix. */
async function listPrefix(prefix) {
  const FP = admin.firestore.FieldPath.documentId();
  const snap = await db().collection(COLL).where(FP, '>=', prefix).where(FP, '<', prefix + '').get();
  return snap.docs;
}

/* Everything the planners need, read once. Each record is
   { id, parts, value, ownerEmail, peerMode } so planning itself touches no database
   and can be checked offline. */
async function loadRecords(prefixes) {
  const out = {};
  for (const p of prefixes) {
    out[p] = (await listPrefix(p + ':')).map(snap => ({
      id: snap.id,
      parts: snap.id.split(':'),
      value: parseVal(snap),
      ownerEmail: snap.get('ownerEmail'),
      peerMode: snap.get('peerMode')
    }));
  }
  return out;
}

/* Revoked means, for program CODE, a rev:CODE:<slug(address)> tombstone that
   still holds a value, or the address listed inside any rev:CODE:* record
   (Studio's Remove writes one per address and lists them all). */
function revocations(revRecords) {
  const keys = new Set(), emails = new Set();
  for (const r of revRecords) {
    if (!r.value || r.parts.length !== 3) continue;
    const code = r.parts[1];
    keys.add(code + ':' + r.parts[2]);
    [r.value.email].concat(Array.isArray(r.value.emails) ? r.value.emails : [])
      .map(cleanEmail).filter(Boolean).forEach(e => emails.add(code + ':' + e));
  }
  return (code, email) => keys.has(code + ':' + slug(email)) || emails.has(code + ':' + email);
}

/* Why this person must not be touched in this program, or ''. Order matters
   only for which reason is shown; any one is enough to skip. */
function personSkip(email, code, isRevoked) {
  if (!email) return { reason: 'no-email', detail: 'no readable email address' };
  const ph = placeholderReason(email);
  if (ph) return { reason: 'placeholder', detail: email + ' (' + ph + ')' };
  if (ADMINS.indexOf(email) >= 0) return { reason: 'admin', detail: email + ' (admins need no record)' };
  if (code && isRevoked(code, email)) return { reason: 'revoked', detail: email + ' has a rev: record for ' + code };
  return null;
}

/* ---- Arguments, project guard, confirmation ---- */

/* flags: the script's own on/off options, e.g. ['leads']. They are kept in
   args.options and saved with the plan, so a plan is applied only with the
   options it was made with. */
function parseArgs(argv, usage, flags) {
  const args = { project: '', live: false, apply: '', options: {} };
  (flags || []).forEach(f => { args.options[f] = false; });
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--project') args.project = String(argv[++i] || '');
    else if (a === '--live') args.live = true;
    else if (a === '--apply') args.apply = String(argv[++i] || '');
    else if (a === '--help' || a === '-h') { console.log(usage); process.exit(0); }
    else if (a.indexOf('--') === 0 && Object.prototype.hasOwnProperty.call(args.options, a.slice(2))) args.options[a.slice(2)] = true;
    else fail('Unknown argument ' + a + '\n\n' + usage);
  }
  return args;
}

function fail(msg) { console.error('\n' + msg + '\n'); process.exit(1); }

/* Refuses unless the project named on the command line is the one the
   credentials belong to, and the live project is only ever reached with
   --live. Prints the project before anything is read. */
function guardProject(args, usage) {
  if (!args.project) fail('Name the project: --project <id>\n\n' + usage);
  const missing = missingEnv();
  if (missing.length) fail('Missing credentials: ' + missing.join(', ') + '. Add them as Codespaces secrets and restart the Codespace.');
  const envProject = process.env.FIREBASE_PROJECT_ID;
  if (args.project !== envProject) fail('--project ' + args.project + ' does not match the credentials, which are for ' + envProject + '.');
  if (envProject === LIVE_PROJECT && !args.live) fail(LIVE_PROJECT + ' is the live project. Add --live to use it.');
  if (args.live && envProject !== LIVE_PROJECT) fail('--live was given, but ' + envProject + ' is not the live project.');
  console.log('\nProject:         ' + envProject + (args.live ? '   (LIVE)' : ''));
  console.log('Service account: ' + process.env.FIREBASE_CLIENT_EMAIL);
  console.log('Mode:            ' + (args.apply ? 'REAL RUN from ' + args.apply : 'dry run (nothing is written)'));
  const on = Object.keys(args.options).filter(k => args.options[k]);
  console.log('Options:         ' + (on.length ? on.map(k => '--' + k).join(' ') : 'none') + '\n');
  return envProject;
}

/* A real run goes ahead only if they type the project ID exactly. */
async function confirm(project, count) {
  if (!process.stdin.isTTY) fail('A real run needs a terminal to confirm in.');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise(res => rl.question(
    'Write ' + count + ' change' + (count === 1 ? '' : 's') + ' to ' + project + '? Type the project ID to confirm: ', res));
  rl.close();
  return answer.trim() === project;
}

/* ---- Plans ---- */

/* changes: [{ key, ... }] — key identifies a change across runs.
   skips:   [{ id, reason, detail }] */
function savePlan(script, project, options, plan) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(OUT_DIR, script + '-' + project + '-' + stamp + '.json');
  fs.writeFileSync(file, JSON.stringify(Object.assign({ script, project, options, at: new Date().toISOString() }, plan), null, 2));
  return file;
}

function loadPlan(file, script, project, options) {
  let p;
  try { p = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { fail('Could not read plan ' + file + ': ' + e.message); }
  if (p.script !== script) fail('That plan is from ' + p.script + ', not ' + script + '.');
  if (p.project !== project) fail('That plan is for ' + p.project + ', not ' + project + '.');
  if (JSON.stringify(p.options || {}) !== JSON.stringify(options || {}))
    fail('That plan was made with options ' + JSON.stringify(p.options || {}) + '; run --apply with the same ones.');
  if (!Array.isArray(p.changes)) fail('That plan has no list of changes.');
  return p;
}

/* titles: { type: heading } lists each type of change in its own section,
   in that order. */
function printPlan(plan, describe, titles) {
  if (!plan.changes.length) console.log('Changes: none');
  const types = Object.keys(titles || {});
  plan.changes.forEach(c => { if (types.indexOf(c.type) < 0) types.push(c.type); });
  types.forEach(t => {
    const list = plan.changes.filter(c => c.type === t);
    if (!list.length) return;
    console.log(((titles || {})[t] || t) + ' (' + list.length + '):');
    list.forEach(c => console.log('  ' + describe(c)));
    console.log('');
  });
  const byReason = {};
  plan.skips.forEach(s => (byReason[s.reason] = byReason[s.reason] || []).push(s));
  const reasons = Object.keys(byReason).sort();
  console.log('\nSkipped (' + plan.skips.length + '):' + (reasons.length ? '' : ' none'));
  reasons.forEach(r => {
    console.log('  ' + r + ' (' + byReason[r].length + ')');
    byReason[r].forEach(s => console.log('    ' + s.id + '  ' + s.detail));
  });
  if (plan.already) console.log('\nAlready done: ' + plan.already);
}

/* The real run: plans again now, and writes only changes that are in the
   saved plan too, each through write(change) (a transaction that re-checks
   it). Anything else is reported, never written. */
async function applyPlan(saved, fresh, project, describe, write) {
  const now = new Map(fresh.changes.map(c => [c.key, c]));
  const todo = saved.changes.filter(c => now.has(c.key) && JSON.stringify(now.get(c.key)) === JSON.stringify(c));
  const dropped = saved.changes.filter(c => todo.indexOf(c) < 0);
  const extra = fresh.changes.filter(c => !saved.changes.some(s => s.key === c.key));
  if (dropped.length) {
    console.log('In the plan but no longer ready, not written (' + dropped.length + '):');
    dropped.forEach(c => console.log('  ' + describe(c)));
  }
  if (extra.length) console.log('Ready now but not in the plan, not written (' + extra.length + '): dry-run again to include them.');
  if (!todo.length) { console.log('\nNothing to write.'); return; }
  if (!(await confirm(project, todo.length))) fail('Not confirmed. Nothing was written.');
  let done = 0; const failed = [];
  for (const c of todo) {
    try {
      const r = await write(c);
      if (r === true) done++;
      else failed.push(describe(c) + '  (' + r + ')');
    } catch (e) { failed.push(describe(c) + '  (' + e.message + ')'); }
  }
  console.log('\nWritten: ' + done + ' of ' + todo.length);
  if (failed.length) { console.log('Not written (' + failed.length + '):'); failed.forEach(f => console.log('  ' + f)); }
}

module.exports = {
  admin, db, COLL, LIVE_PROJECT, ADMINS,
  cleanCode, slug, cleanEmail, parseVal, placeholderReason,
  loadRecords, revocations, personSkip,
  parseArgs, guardProject, fail, savePlan, loadPlan, printPlan, applyPlan
};
