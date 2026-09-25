/* Checks that Twin Thieves Leadership cannot affect the Championship Playbook.
 *
 *   node test/isolation/run.js
 *
 * No network and no Firebase: the server functions run against an in-memory
 * stand-in for Firestore. Needs git (for develop's firestore.rules) and the
 * repo's own node_modules. Any failed check fails the run.
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const ROOT = path.join(__dirname, '..', '..');
let bad = 0, n = 0;
const ok = (name, cond, detail) => { n++; if (cond) console.log('PASS', name); else { bad++; console.log('FAIL', name, detail || ''); } };

// ---- 1. Rules: the Playbook's rules are unchanged; Twin Thieves only adds. ----
{
  const cur = fs.readFileSync(path.join(ROOT, 'firestore.rules'), 'utf8');
  let base = '';
  try { base = execSync('git show develop:firestore.rules', { cwd: ROOT }).toString(); } catch (e) {}
  const tail = '  }\n}\n';
  ok('rules: develop\'s firestore.rules is readable', !!base);
  ok('rules: every line of develop\'s rules is unchanged, in order, at the top',
    !!base && base.endsWith(tail) && cur.startsWith(base.slice(0, -tail.length)));
  const added = base ? cur.slice(base.length - tail.length, cur.length - tail.length) : '';
  ok('rules: the added section only matches ttmembers and jj_playbook',
    !!added && (added.match(/match \/[a-z_]+\//g) || []).every(m => m === 'match /ttmembers/' || m === 'match /jj_playbook/'));
  ok('rules: the added section never uses members/ or inOrg()', !!added && !/documents\/members\/|inOrg\(|isAnyMember\(/.test(added));
}

// ---- In-memory Firestore and Auth for the functions ----
function makeStore() {
  const docs = {}, writes = [];
  const snap = (id, d) => ({ id, exists: !!d, get: k => (d ? d[k] : undefined), data: () => d });
  const ref = (c, id) => ({ c, id, get: async () => snap(id, docs[c + '/' + id]),
    set: async (v, o) => { writes.push(c + '/' + id); docs[c + '/' + id] = Object.assign(o && o.merge ? (docs[c + '/' + id] || {}) : {}, v); } });
  const coll = c => ({ doc: id => ref(c, id),
    where: (f, op, lo) => op === '=='
      ? { limit: () => ({ get: async () => ({ docs: Object.keys(docs).filter(k => k.startsWith(c + '/') && docs[k][f] === lo)
          .map(k => snap(k.slice(c.length + 1), docs[k])) }) }) }
      : ({ where: (f2, op2, hi) => ({ get: async () => ({ docs: Object.keys(docs).filter(k => k.startsWith(c + '/'))
      .map(k => k.slice(c.length + 1)).filter(id => id >= lo && id < hi).map(id => snap(id, docs[c + '/' + id])) }) }) }) });
  const db = () => ({ collection: coll, runTransaction: async fn => fn({
    get: r => r.get(),
    set: (r, v) => { writes.push(r.c + '/' + r.id); docs[r.c + '/' + r.id] = Object.assign({}, v); },
    update: (r, v) => { writes.push(r.c + '/' + r.id); Object.assign(docs[r.c + '/' + r.id], v); } }) });
  return { docs, writes, db };
}
const SENT = [];
{
  const nm = require.resolve('nodemailer', { paths: [ROOT] });
  require.cache[nm] = { id: nm, filename: nm, loaded: true, exports: { createTransport: () => ({ sendMail: async m => { SENT.push(m); return { messageId: 'x' }; } }) } };
}
function loadFn(file, store, users) {
  const lib = path.join(ROOT, 'netlify/lib/firebase-admin.js'), ms = path.join(ROOT, 'netlify/lib/ms-verify.js');
  Object.keys(require.cache).forEach(k => { if (k.indexOf(path.join(ROOT, 'netlify')) === 0) delete require.cache[k]; });
  require.cache[lib] = { id: lib, filename: lib, loaded: true, exports: {
    admin: { firestore: { FieldPath: { documentId: () => '__id' }, Timestamp: { fromMillis: x => x },
      FieldValue: { arrayUnion: x => ({ union: x }), serverTimestamp: () => 0 } } },
    db: store.db, auth: () => ({ verifyIdToken: async t => { if (!users[t]) throw new Error('bad'); return users[t]; } }),
    missingEnv: () => [] } };
  require.cache[ms] = { id: ms, filename: ms, loaded: true, exports: { isMicrosoft: t => t.firebase.sign_in_provider === 'microsoft.com', isConfirmed: async () => false } };
  return require(path.join(ROOT, 'netlify/functions', file)).handler;
}
const V = o => ({ value: JSON.stringify(o) });
const U = (email, prov) => ({ uid: 'u-' + email, email, email_verified: true, firebase: { sign_in_provider: prov || 'google.com' } });
const call = (h, tok, body) => h({ httpMethod: 'POST', headers: { authorization: 'Bearer ' + tok, 'x-nf-client-connection-ip': '10.0.0.' + Math.floor(Math.random() * 200) }, body: JSON.stringify(body) });

(async () => {
  // ---- 2. /api/join: the Playbook join is unchanged; Twin Thieves programs are refused. ----
  {
    const st = makeStore();
    st.docs['jj_playbook/org:PLAYBOOK26'] = V({ name: 'Playbook 26', allowlist: [] });
    st.docs['jj_playbook/org:TT36'] = V({ name: 'Twin Thieves', product: 'tt', ttVersion: 36, joinCode: 'TWINTHIEVES36' });
    const join = loadFn('join.js', st, { A: U('ann@a.com') });
    const r1 = await call(join, 'A', { code: 'playbook26' });
    ok('join: a Playbook code still joins', r1.statusCode === 200 && JSON.parse(r1.body).code === 'PLAYBOOK26', r1.body);
    ok('join: it writes members/{email}', st.writes.indexOf('members/ann@a.com') >= 0, st.writes.join(','));
    const r2 = await call(join, 'A', { code: 'TT36' });
    ok('join: a Twin Thieves program id is refused as no-program', r2.statusCode === 404 && JSON.parse(r2.body).code === 'no-program', r2.body);
    const r3 = await call(join, 'A', { code: 'TWINTHIEVES36' });
    ok('join: a Twin Thieves code is not a Playbook code', r3.statusCode === 404, r3.body);
  }

  // ---- 3. /api/tt-join: joins with the code, writes only Twin Thieves records. ----
  {
    const st = makeStore();
    st.docs['jj_playbook/org:TT36'] = V({ name: 'Twin Thieves Leadership · 36 lessons', product: 'tt', ttVersion: 36, joinCode: 'TWINTHIEVES36' });
    st.docs['jj_playbook/org:TT10'] = V({ name: 'Twin Thieves Leadership · 10 lessons', product: 'tt', ttVersion: 10, joinCode: 'TWINTHIEVES10', joinDisabled: true });
    st.docs['jj_playbook/org:PLAYBOOK26'] = V({ name: 'Playbook 26' });
    st.docs['jj_playbook/rev:TT36:gone-s-org'] = V({ email: 'gone@s.org' });
    const users = { T: U('tia@s.org'), G: U('gone@s.org'), M: U('ms@s.org', 'microsoft.com'), D: U('dee@other.org') };
    const tt = loadFn('tt-join.js', st, users);
    const r1 = await call(tt, 'T', { code: 'twinthieves36', first: 'Tia', last: 'Lee' });
    const b1 = JSON.parse(r1.body);
    ok('tt-join: the code is not case-sensitive', r1.statusCode === 200 && b1.code === 'TT36' && b1.version === 36, r1.body);
    ok('tt-join: writes only ttmembers/ and ttm: (plus its own rate-limit counts)',
      st.writes.length > 0 && st.writes.every(w => w === 'ttmembers/tia@s.org' || w.indexOf('jj_playbook/ttm:TT36:') === 0 || w.indexOf('rateLimits/') === 0), st.writes.join(','));
    ok('tt-join: never writes members/, resp: or push:', !st.writes.some(w => /^members\/|:resp:|\/resp:|\/push:/.test(w)), st.writes.join(','));
    const rec = JSON.parse(st.docs['jj_playbook/ttm:TT36:tia-s-org'].value);
    ok('tt-join: the record holds only name, email, idkey, code, joinedAt and progress',
      Object.keys(rec).sort().join(',') === 'code,email,idkey,joinedAt,name,progress', Object.keys(rec).join(','));
    ok('tt-join: the record is stamped with its owner', st.docs['jj_playbook/ttm:TT36:tia-s-org'].ownerEmail === 'tia@s.org');
    const r2 = await call(tt, 'T', { code: 'TWINTHIEVES10', first: 'Tia', last: 'Lee' });
    ok('tt-join: a switched-off code is refused', r2.statusCode === 403 && JSON.parse(r2.body).code === 'disabled', r2.body);
    const r3 = await call(tt, 'T', { code: 'PLAYBOOK26', first: 'Tia', last: 'Lee' });
    ok('tt-join: a Playbook code is not a Twin Thieves code', r3.statusCode === 404 && JSON.parse(r3.body).code === 'no-code', r3.body);
    const r4 = await call(tt, 'T', { code: 'TT36', first: 'Tia', last: 'Lee' });
    ok('tt-join: the program id is not a code', r4.statusCode === 404, r4.body);
    const r5 = await call(tt, 'G', { code: 'TWINTHIEVES36', first: 'Gone', last: 'X' });
    ok('tt-join: a rev: tombstone refuses', r5.statusCode === 403 && JSON.parse(r5.body).code === 'revoked', r5.body);
    const r6 = await call(tt, 'M', { code: 'TWINTHIEVES36', first: 'M', last: 'S' });
    ok('tt-join: an unconfirmed Microsoft sign-in is asked to confirm', r6.statusCode === 403 && JSON.parse(r6.body).code === 'ms-verify', r6.body);
    st.docs['jj_playbook/org:TT36'] = V({ name: 'TT', product: 'tt', ttVersion: 36, joinCode: 'TWINTHIEVES36', joinDomain: 's.org' });
    const r7 = await call(tt, 'D', { code: 'TWINTHIEVES36', first: 'Dee', last: 'O' });
    ok('tt-join: the email-domain limit refuses other domains', r7.statusCode === 403 && JSON.parse(r7.body).code === 'domain', r7.body);
    const r8 = await call(tt, 'X', { code: 'TWINTHIEVES36', first: 'a', last: 'b' });
    ok('tt-join: no valid sign-in is refused', r8.statusCode === 401, r8.body);
    let last; for (let i = 0; i < 21; i++) last = await call(tt, 'T', { code: 'nope', first: 'a', last: 'b' });
    ok('tt-join: tries are rate-limited per account', last.statusCode === 429, last.body);
  }

  // ---- 4. Firebase Functions (reminders, notifications) never touch Twin Thieves data. ----
  {
    const fx = fs.readFileSync(path.join(ROOT, 'functions/index.js'), 'utf8');
    ok('functions: never read ttm: records or ttmembers', !/ttm:|ttmembers|ttlib/.test(fx));
    const pushPrefixes = (fx.match(/'push:'|"push:"/g) || []).length;
    ok('functions: senders find people through push: and resp: records, which Twin Thieves never writes', pushPrefixes > 0);
  }

  // ---- 5. The app: Twin Thieves code never writes Playbook records. ----
  {
    const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
    const a = html.indexOf('  /* ---- Twin Thieves Leadership ---- */'), b = html.indexOf("  /* The pyramid's blocks, labels and lock badges");
    const ttCode = a > 0 && b > a ? html.slice(a, b) : '';
    ok('app: the Twin Thieves methods are found', ttCode.length > 1000);
    ok('app: they never write resp:, push:, coach:, gin:, chat: or peer: records',
      !/sset\(\s*'(resp|push|coach|gin|chat|peer):/.test(ttCode), '');
    ok('app: they never touch members/{email} (only ttmembers)', !/collection\('members'\)/.test(ttCode));
    ok('app: Studio keeps Twin Thieves programs out of orgList (every Playbook list reads it)',
      /const orgs=all\.filter\(o=>o\.product!=='tt'\)/.test(html) && /orgList:orgs,ttOrgs/.test(html));
    ok('app: Twin Thieves turns push off (resumePush, refreshPushToken, syncReminderPrefs)',
      /async resumePush\(\)\{\n    \/\/ Twin Thieves has no notifications\.\n    if\(this\.isTT\(\)\) return;/.test(html)
      && /if\(!s\.idkey\|\|!s\.code\|\|this\.isTT\(\)\) return; try\{ if\(!reg\)/.test(html)
      && /async syncReminderPrefs\(\)\{\n    const s=this\.state; if\(!s\.idkey\|\|!s\.code\|\|this\.isTT\(\)\) return;/.test(html));
    ok('app: Twin Thieves programs are left out of push registration (myPushKeys)', /\.filter\(g=>g\.product!=='tt'\)\.forEach\(g=>\{ codes\.add/.test(html));
    ok('app: the design preview is limited to local, Codespace and the TT preview host',
      /const TT_DEMO_HOSTS=\['localhost','127\.0\.0\.1','jj-twinthieves-preview\.netlify\.app'\];/.test(html));
  }


  // ---- 6. Invites: admin-only, email and status only, links once / on time / for that address. ----
  {
    const st = makeStore();
    st.docs['jj_playbook/org:TT36'] = V({ name: 'Twin Thieves Leadership · 36 lessons', product: 'tt', ttVersion: 36, joinCode: 'TWINTHIEVES36' });
    st.docs['jj_playbook/org:TT10'] = V({ name: 'Twin Thieves Leadership · 10 lessons', product: 'tt', ttVersion: 10, joinCode: 'TWINTHIEVES10' });
    const users = { ADM: U('charlie@jadin-jones.com'), MSA: U('charlie@jadin-jones.com', 'microsoft.com'), T: U('tia@s.org'), Z: U('zed@s.org') };
    process.env.URL = 'https://jj-twinthieves-preview.netlify.app';
    const inviteCall = async (tok, body) => { const h = loadFn('tt-invite.js', st, users); const r = await call(h, tok, body); return { code: r.statusCode, body: JSON.parse(r.body) }; };
    delete process.env.INVITE_SEND_MODE; SENT.length = 0;
    let r = await inviteCall('T', { action: 'send', program: 'TT36', emails: ['tia@s.org'] });
    ok('invite: a student cannot send invites', r.code === 403, JSON.stringify(r.body));
    r = await inviteCall('MSA', { action: 'send', program: 'TT36', emails: ['tia@s.org'] });
    ok('invite: an admin address signed in through Microsoft cannot send invites', r.code === 403, JSON.stringify(r.body));
    r = await inviteCall('ADM', { action: 'send', program: 'TT36', emails: ['Tia@S.org', 'tia@s.org', 'not-an-email'] });
    ok('invite: sending off by default: recorded, nothing sent', r.code === 200 && r.body.mode === 'off' && SENT.length === 0
      && r.body.results[0].result === 'recorded-not-sent' && r.body.results[1].result === 'duplicate' && r.body.results[2].result === 'not-an-email', JSON.stringify(r.body));
    const ids = Object.keys(st.docs).filter(k => k.indexOf('jj_playbook/ttinv:') === 0);
    const inv = ids.length === 1 ? st.docs[ids[0]] : null, invVal = inv ? JSON.parse(inv.value) : {};
    ok('invite: stores only the email and invite status (and the link\'s hash)',
      !!inv && Object.keys(invVal).sort().join(',') === 'delivery,email,expiresAt,joinedAt,program,sendCount,sentAt,status'
      && Object.keys(inv).sort().join(',') === 'tokenHash,value' && invVal.email === 'tia@s.org', inv ? Object.keys(invVal).join(',') : 'none');
    ok('invite: the link expires after 7 days', Math.abs(invVal.expiresAt - invVal.sentAt - 7 * 86400000) < 5000);
    process.env.INVITE_SEND_MODE = 'test'; process.env.INVITE_TEST_RECIPIENTS = 'zed@s.org'; process.env.INVITE_SMTP_URL = 'smtps://x:y@smtp.example.com:465';
    r = await inviteCall('ADM', { action: 'send', program: 'TT10', emails: ['zed@s.org', 'someone@else.org'] });
    ok('invite: test mode sends only to test recipients', r.code === 200 && SENT.length === 1 && SENT[0].to === 'zed@s.org'
      && r.body.results[1].result === 'not-a-test-recipient' && !Object.keys(st.docs).some(k => k.indexOf('ttinv:TT10') > 0 && JSON.parse(st.docs[k].value).email === 'someone@else.org'), JSON.stringify(r.body));
    const mail = SENT[0] || {};
    ok('invite: from "Jadin | Jones Team" <charlie@jadin-jones.com>, replies to charlie@', mail.from === '"Jadin | Jones Team" <charlie@jadin-jones.com>' && mail.replyTo === 'charlie@jadin-jones.com', mail.from);
    ok('invite: the email says 10 lessons for the 10-lesson version, with the code and a Join now link',
      /series of 10 short video lessons/.test(mail.text || '') && /TWINTHIEVES10/.test(mail.text || '') && /Join now/.test(mail.html || '')
      && /https:\/\/jj-twinthieves-preview\.netlify\.app\/\?tti=[A-Za-z0-9_-]{40,}&ttc=TWINTHIEVES10/.test(mail.text || ''), (mail.text || '').slice(0, 200));
    const secret = ((mail.text || '').match(/tti=([A-Za-z0-9_-]+)/) || [])[1];
    const join = loadFn('tt-join.js', st, users);
    let j = await call(join, 'T', { invite: secret, first: 'Tia', last: 'Lee' });
    ok('invite: the link refuses a different signed-in address', j.statusCode === 403 && JSON.parse(j.body).code === 'invite-email', j.body);
    j = await call(join, 'Z', { invite: secret, first: 'Zed', last: 'Q' });
    ok('invite: the invited address joins with the link', j.statusCode === 200 && JSON.parse(j.body).code === 'TT10' && JSON.parse(j.body).invited === true, j.body);
    const z = Object.keys(st.docs).find(k => k.indexOf('ttinv:TT10') > 0);
    ok('invite: the invite is marked joined and its hash cleared', !!z && JSON.parse(st.docs[z].value).status === 'joined' && st.docs[z].tokenHash === '');
    j = await call(join, 'Z', { invite: secret, first: 'Zed', last: 'Q' });
    ok('invite: the link works only once', j.statusCode === 404 && JSON.parse(j.body).code === 'invite-invalid', j.body);
    // expiry and resend
    SENT.length = 0; process.env.INVITE_TEST_RECIPIENTS = 'zed@s.org,tia@s.org';
    await inviteCall('ADM', { action: 'resend', program: 'TT36', email: 'tia@s.org' });
    const s1 = ((SENT[0] || {}).text || '').match(/tti=([A-Za-z0-9_-]+)/)[1];
    await inviteCall('ADM', { action: 'resend', program: 'TT36', email: 'tia@s.org' });
    const s2 = ((SENT[1] || {}).text || '').match(/tti=([A-Za-z0-9_-]+)/)[1];
    j = await call(loadFn('tt-join.js', st, users), 'T', { invite: s1, first: 'Tia', last: 'Lee' });
    ok('invite: Resend makes the old link stop working', j.statusCode === 404 && JSON.parse(j.body).code === 'invite-invalid', j.body);
    const tkey = Object.keys(st.docs).find(k => k.indexOf('ttinv:TT36') > 0);
    const tv = JSON.parse(st.docs[tkey].value); tv.expiresAt = Date.now() - 1000; st.docs[tkey].value = JSON.stringify(tv);
    j = await call(loadFn('tt-join.js', st, users), 'T', { invite: s2, first: 'Tia', last: 'Lee' });
    ok('invite: an expired link is refused', j.statusCode === 410 && JSON.parse(j.body).code === 'invite-expired', j.body);
    r = await inviteCall('ADM', { action: 'cancel', program: 'TT36', email: 'tia@s.org' });
    j = await call(loadFn('tt-join.js', st, users), 'T', { invite: s2, first: 'Tia', last: 'Lee' });
    ok('invite: a cancelled invite\'s link is refused', r.code === 200 && j.statusCode === 404, j.body);
    ok('invite: never writes members/, resp: or push:', !st.writes.some(w => /^members\/|\/resp:|\/push:/.test(w)), st.writes.join(','));
    delete process.env.INVITE_SEND_MODE; delete process.env.INVITE_TEST_RECIPIENTS; delete process.env.INVITE_SMTP_URL;
  }
  console.log(bad ? bad + ' of ' + n + ' FAILED' : 'ALL ' + n + ' PASSED');
  process.exit(bad ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
