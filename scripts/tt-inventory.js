/* Twin Thieves inventory: read-only. Step 0 of docs/TWIN-THIEVES-MERGE.md.
 *
 *   node scripts/tt-inventory.js --project jj-playbook-dev
 *   node scripts/tt-inventory.js --project test-6b2ab --live
 *
 * Reads only; there is no --apply. Prints counts and the ids of records that
 * need attention, never a name or an email address (members may be
 * students). Nothing is saved to scripts/out/.
 *
 * What it checks:
 *   library   ttlib:master exists; order36 has 36 lessons and order10 has 10,
 *             all inside order36; every ordered id has a lesson; lessons
 *             outside order36 and lessons with no video are counted
 *   programs  org:TT36 / org:TT10: product 'tt', ttVersion, joinCode
 *             TWIN36 / TWIN10, on or off, domain limit
 *   records   ttm: per program, ttmembers, ttallow (list size), ttinv (by
 *             status), rev:TT36 / rev:TT10
 *   rules     what the live rules need for a member to keep working, for
 *             every ttm:TTxx:idkey: a top-level ownerEmail that is the email
 *             inside, in lower case, with slug(ownerEmail) == idkey, and
 *             ttmembers/{ownerEmail}.orgs listing TTxx
 *   isolation no members/{email}.orgs lists TT36 or TT10, and no resp:TT36: /
 *             resp:TT10: records exist (Twin Thieves never uses either)
 */
const {
  admin, db, COLL, slug, parseVal, parseArgs, guardProject, fail
} = require('./lib/common');

const USAGE = 'Usage: node scripts/tt-inventory.js --project <id> [--live]';
const PROGRAMS = { TT36: { version: 36, code: 'TWIN36' }, TT10: { version: 10, code: 'TWIN10' } };

async function range(prefix) {
  const FP = admin.firestore.FieldPath.documentId();
  const snap = await db().collection(COLL).where(FP, '>=', prefix).where(FP, '<', prefix + '').get();
  return snap.docs;
}
const tally = list => list.reduce((a, k) => { a[k] = (a[k] || 0) + 1; return a; }, {});

async function main() {
  const args = parseArgs(process.argv.slice(2), USAGE, []);
  if (args.apply) fail('This script only reads; there is nothing to apply.');
  guardProject(args, USAGE);
  const problems = [];
  const problem = (id, why) => problems.push(id + '  ' + why);

  // ---- library ----
  const lib = parseVal(await db().collection(COLL).doc('ttlib:master').get());
  console.log('Library (ttlib:master)');
  if (!lib) { console.log('  missing or unreadable'); problem('ttlib:master', 'missing or unreadable'); }
  else {
    const lessons = Array.isArray(lib.lessons) ? lib.lessons : [];
    const o36 = Array.isArray(lib.order36) ? lib.order36 : [], o10 = Array.isArray(lib.order10) ? lib.order10 : [];
    const ids = new Set(lessons.map(l => l && l.id));
    const outside = lessons.filter(l => l && o36.indexOf(l.id) < 0).map(l => l.id);
    console.log('  lessons: ' + lessons.length + ', order36: ' + o36.length + ', order10: ' + o10.length
      + ', no video: ' + lessons.filter(l => !(l && String(l.videoUrl || '').trim())).length);
    console.log('  outside order36: ' + (outside.length ? outside.join(', ') : 'none')
      + '; last saved: ' + (lib.updatedAt ? new Date(lib.updatedAt).toISOString() : 'unknown'));
    if (o36.length !== 36) problem('ttlib:master', 'order36 has ' + o36.length + ' lessons, not 36');
    if (o10.length !== 10) problem('ttlib:master', 'order10 has ' + o10.length + ' lessons, not 10');
    if (!o10.every(id => o36.indexOf(id) >= 0)) problem('ttlib:master', 'order10 has lessons that are not in order36');
    const missing = o36.concat(o10).filter(id => !ids.has(id));
    if (missing.length) problem('ttlib:master', 'ordered ids with no lesson: ' + Array.from(new Set(missing)).join(', '));
  }

  // ---- programs ----
  console.log('\nPrograms');
  for (const id of Object.keys(PROGRAMS)) {
    const o = parseVal(await db().collection(COLL).doc('org:' + id).get());
    if (!o) { console.log('  org:' + id + ': missing'); problem('org:' + id, 'missing'); continue; }
    console.log('  org:' + id + ': product ' + o.product + ', ttVersion ' + o.ttVersion + ', joinCode ' + o.joinCode
      + ', ' + (o.joinDisabled ? 'code OFF' : 'code on') + (o.joinDomain ? ', domain ' + o.joinDomain : ''));
    if (o.product !== 'tt') problem('org:' + id, 'product is not tt');
    if (Number(o.ttVersion) !== PROGRAMS[id].version) problem('org:' + id, 'ttVersion is not ' + PROGRAMS[id].version);
    if (String(o.joinCode || '').toUpperCase() !== PROGRAMS[id].code) problem('org:' + id, 'joinCode is not ' + PROGRAMS[id].code);
  }

  // ---- records ----
  const ttm = await range('ttm:');
  const tm = await db().collection('ttmembers').get();
  const orgsOf = {};
  tm.docs.forEach(d => { const o = d.get('orgs'); orgsOf[d.id] = Array.isArray(o) ? o : null; });
  console.log('\nRecords');
  console.log('  ttm: ' + ttm.length + ' ' + JSON.stringify(tally(ttm.map(d => d.id.split(':')[1]))));
  console.log('  ttmembers: ' + tm.size + ' ' + JSON.stringify(tally(tm.docs.map(d => (orgsOf[d.id] || ['(orgs not a list)']).slice().sort().join('+')))));
  let withProgress = 0;
  for (const id of Object.keys(PROGRAMS)) {
    const allow = parseVal(await db().collection(COLL).doc('ttallow:' + id).get());
    const inv = await range('ttinv:' + id + ':');
    const rev = await range('rev:' + id + ':');
    console.log('  ' + id + ': approved list ' + (allow ? (Array.isArray(allow.emails) ? allow.emails.length + ' emails' : 'DAMAGED') : 'none')
      + ', invites ' + JSON.stringify(tally(inv.map(d => (parseVal(d) || {}).status || 'unreadable'))) + ', removed ' + rev.length);
  }

  // ---- what the live rules need ----
  for (const d of ttm) {
    const p = d.id.split(':'), code = p[1], idkey = p[2], v = parseVal(d);
    if (p.length !== 3 || !PROGRAMS[code]) { problem(d.id, 'not ttm:TT36:idkey or ttm:TT10:idkey'); continue; }
    if (!v) { problem(d.id, 'value unreadable'); continue; }
    if (v.progress && Object.keys(v.progress).length) withProgress++;
    const owner = d.get('ownerEmail');
    if (typeof owner !== 'string' || !owner) { problem(d.id, 'no top-level ownerEmail: the member cannot read or save it'); continue; }
    if (owner !== owner.toLowerCase()) problem(d.id, 'ownerEmail is not lower case: the member cannot read or save it');
    if (String(v.email || '').trim().toLowerCase() !== owner.toLowerCase()) problem(d.id, 'ownerEmail and the email inside disagree');
    if (slug(owner) !== idkey) problem(d.id, 'the key is not ttm:' + code + ':slug(ownerEmail)');
    const orgs = orgsOf[owner.toLowerCase()];
    if (!orgs) problem(d.id, 'no ttmembers document for its owner: the member cannot read it');
    else if (orgs.indexOf(code) < 0) problem(d.id, 'its owner\'s ttmembers does not list ' + code);
  }
  console.log('  ttm with progress: ' + withProgress);
  Object.keys(orgsOf).forEach(e => {
    if (!orgsOf[e]) return problem('ttmembers/' + slug(e), 'orgs is not a list');
    orgsOf[e].forEach(c => { if (!PROGRAMS[c]) problem('ttmembers/' + slug(e), 'lists ' + c + ', not a Twin Thieves program'); });
  });

  // ---- isolation ----
  const mem = await db().collection('members').get();
  mem.docs.forEach(d => { const o = d.get('orgs');
    if (Array.isArray(o) && o.some(c => PROGRAMS[c])) problem('members/' + slug(d.id), 'a Playbook members document lists a Twin Thieves program'); });
  for (const id of Object.keys(PROGRAMS)) (await range('resp:' + id + ':')).forEach(d => problem(d.id, 'a Playbook resp: record for a Twin Thieves program'));

  console.log('\n' + (problems.length ? 'Needs attention (' + problems.length + '):\n  ' + problems.join('\n  ') : 'Needs attention: nothing') + '\n');
}

main().then(() => process.exit(0)).catch(e => { console.error('\nStopped: ' + (e && (e.code || e.message))); process.exit(1); });
