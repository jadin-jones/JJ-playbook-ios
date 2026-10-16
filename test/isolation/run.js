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

// ---- 1. Rules: main's V3 rules unchanged apart from the two changes published
// on test-6b2ab on 8 Oct 2026 and the coachmiss rule; Twin Thieves only adds a
// section at the end. ----
{
  const cur = fs.readFileSync(path.join(ROOT, 'firestore.rules'), 'utf8');
  let base = '';
  // main just before the Twin Thieves merge: V3 as it was written and tested.
  try { base = execSync('git show c3c8dd6:firestore.rules', { cwd: ROOT }).toString(); } catch (e) {}
  const tail = '  }\n}\n';
  const PUBLISHED = [
    ["      function isPreviewOrSample() { return docId.matches('.*:(__preview__|sample-[^:]*)'); }\n",
     "      // Twin Thieves keys never count as preview or sample records: tt-join\n"
     + "      // names ttm: records after the email, so sample-x@... would match.\n"
     + "      function isPreviewOrSample() {\n"
     + "        return docId.matches('.*:(__preview__|sample-[^:]*)')\n"
     + "          && !(kind() in ['ttm', 'ttinv', 'ttallow', 'ttlib'])\n"
     + "          && !(parts().size() > 1 && parts()[1] in ['TT36', 'TT10']);\n"
     + "      }\n"],
    ["    // Nothing in this app uses these two; they were open to every member.\n"
     + "    // Closed to admins until whatever uses them is known.\n",
     "    // Nothing in this app or the Twin Thieves site uses these two (checked\n"
     + "    // 8 Oct 2026: no code on any branch, no live page, no function). Under the\n"
     + "    // Sept 25 rules they were open to anyone. Admin-only until something needs\n"
     + "    // them. Twin Thieves data is not here: it is ttmembers/ and the tt keys in\n"
     + "    // jj_playbook (the section at the end).\n"],
    // Prepared 8 Oct 2026, after that publish: coachmiss:ID, create-only for members.
    ["      function revKind() { return kind() == 'rev'; }\n",
     "      function revKind() { return kind() == 'rev'; }\n"
     + "      // coachmiss:ID: one question the AI coach's library could not answer.\n"
     + "      // Any Playbook member may file one; only admins read, change or delete\n"
     + "      // them (a question can be personal). It replaces the shared\n"
     + "      // knowledge:misses list, which a member could only add to by reading\n"
     + "      // and rewriting everyone's questions.\n"
     + "      function missKind() { return kind() == 'coachmiss' && parts().size() == 2 && parts()[1].matches('[A-Za-z0-9]{16,40}'); }\n"
     + "      function missOk() {\n"
     + "        return request.resource.data.keys().hasOnly(['value'])\n"
     + "          && request.resource.data.value is string\n"
     + "          && request.resource.data.value.size() <= 800;\n"
     + "      }\n"],
    ["        || (teamKind() && inOrg(parts()[1]));\n      allow update: if isAdmin()\n",
     "        || (teamKind() && inOrg(parts()[1]))\n        || (missKind() && isAnyMember() && missOk());\n      allow update: if isAdmin()\n"]];
  const want = PUBLISHED.reduce((b, [a, z]) => (b.split(a).length === 2 ? b.replace(a, z) : ''), base);
  ok('rules: main\'s rules (c3c8dd6) are readable', !!base);
  ok('rules: main\'s rules are unchanged apart from the listed changes, in order, at the top',
    !!want && want.endsWith(tail) && cur.startsWith(want.slice(0, -tail.length)));
  const added = want ? cur.slice(want.length - tail.length, cur.length - tail.length) : '';
  ok('rules: the added section only matches ttmembers and jj_playbook',
    !!added && (added.match(/match \/[a-z_]+\//g) || []).every(m => m === 'match /ttmembers/' || m === 'match /jj_playbook/'));
  ok('rules: the added section never uses members/ or inOrg()', !!added && !/documents\/members\/|inOrg\(|isAnyMember\(/.test(added));
}

// ---- In-memory Firestore and Auth for the functions ----
function makeStore() {
  const docs = {}, writes = [];
  const snap = (id, d) => ({ id, exists: !!d, get: k => (d ? d[k] : undefined), data: () => d });
  // arrayUnion is applied as Firestore does: added to the list, once.
  const put = (key, v, o) => { const cur = o && o.merge ? (docs[key] || {}) : {}, out = Object.assign({}, cur);
    Object.keys(v).forEach(k => { const x = v[k];
      out[k] = x && x.union ? Array.from(new Set((Array.isArray(cur[k]) ? cur[k] : []).concat(x.union))) : x; });
    docs[key] = out; };
  const ref = (c, id) => ({ c, id, get: async () => snap(id, docs[c + '/' + id]),
    set: async (v, o) => { writes.push(c + '/' + id); put(c + '/' + id, v, o); },
    delete: async () => { writes.push('delete ' + c + '/' + id); delete docs[c + '/' + id]; } });
  const coll = c => ({ doc: id => ref(c, id),
    where: (f, op, lo) => op === '=='
      ? { limit: () => ({ get: async () => ({ docs: Object.keys(docs).filter(k => k.startsWith(c + '/') && docs[k][f] === lo)
          .map(k => snap(k.slice(c.length + 1), docs[k])) }) }) }
      : ({ where: (f2, op2, hi) => ({ get: async () => ({ docs: Object.keys(docs).filter(k => k.startsWith(c + '/'))
      .map(k => k.slice(c.length + 1)).filter(id => id >= lo && id < hi).map(id => snap(id, docs[c + '/' + id])) }) }) }) });
  const db = () => ({ collection: coll, runTransaction: async fn => fn({
    get: r => r.get(),
    set: (r, v, o) => { writes.push(r.c + '/' + r.id); put(r.c + '/' + r.id, v, o); },
    delete: r => { writes.push('delete ' + r.c + '/' + r.id); delete docs[r.c + '/' + r.id]; },
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
      FieldValue: { arrayUnion: (...x) => ({ union: x }), serverTimestamp: () => 0 } } },
    db: store.db, auth: () => ({ verifyIdToken: async t => { if (!users[t]) throw new Error('bad'); return users[t]; },
      // Auth accounts by email (store.accounts[email] = [UserRecord-like]); each call's size is kept.
      getUsers: async ids => { (store.authCalls = store.authCalls || []).push(ids.length);
        return { users: [].concat(...ids.map(i => (store.accounts || {})[i.email] || [])) }; } }),
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
    st.docs['jj_playbook/org:TT36'] = V({ name: 'Twin Thieves', product: 'tt', ttVersion: 36, joinCode: 'TWIN36' });
    const join = loadFn('join.js', st, { A: U('ann@a.com') });
    const r1 = await call(join, 'A', { code: 'playbook26' });
    ok('join: a Playbook code still joins', r1.statusCode === 200 && JSON.parse(r1.body).code === 'PLAYBOOK26', r1.body);
    ok('join: it writes members/{email}', st.writes.indexOf('members/ann@a.com') >= 0, st.writes.join(','));
    const r2 = await call(join, 'A', { code: 'TT36' });
    ok('join: a Twin Thieves program id is refused as no-program', r2.statusCode === 404 && JSON.parse(r2.body).code === 'no-program', r2.body);
    const r3 = await call(join, 'A', { code: 'TWIN36' });
    ok('join: a Twin Thieves code is not a Playbook code', r3.statusCode === 404, r3.body);
  }

  // ---- 3. /api/tt-join: joins with the code, writes only Twin Thieves records. ----
  {
    const st = makeStore();
    st.docs['jj_playbook/org:TT36'] = V({ name: 'Twin Thieves Leadership · 36 lessons', product: 'tt', ttVersion: 36, joinCode: 'TWIN36' });
    st.docs['jj_playbook/org:TT10'] = V({ name: 'Twin Thieves Leadership · 10 lessons', product: 'tt', ttVersion: 10, joinCode: 'TWIN10', joinDisabled: true });
    st.docs['jj_playbook/org:PLAYBOOK26'] = V({ name: 'Playbook 26' });
    st.docs['jj_playbook/rev:TT36:gone-s-org'] = V({ email: 'gone@s.org' });
    const users = { T: U('tia@s.org'), G: U('gone@s.org'), M: U('ms@s.org', 'microsoft.com'), D: U('dee@other.org') };
    const tt = loadFn('tt-join.js', st, users);
    const r1 = await call(tt, 'T', { code: 'twin36', first: 'Tia', last: 'Lee' });
    const b1 = JSON.parse(r1.body);
    ok('tt-join: the code is not case-sensitive', r1.statusCode === 200 && b1.code === 'TT36' && b1.version === 36, r1.body);
    ok('tt-join: writes only ttmembers/ and ttm: (plus its own rate-limit counts)',
      st.writes.length > 0 && st.writes.every(w => w === 'ttmembers/tia@s.org' || w.indexOf('jj_playbook/ttm:TT36:') === 0 || w.indexOf('rateLimits/') === 0), st.writes.join(','));
    ok('tt-join: never writes members/, resp: or push:', !st.writes.some(w => /^members\/|:resp:|\/resp:|\/push:/.test(w)), st.writes.join(','));
    const rec = JSON.parse(st.docs['jj_playbook/ttm:TT36:tia-s-org'].value);
    ok('tt-join: the record holds only name, email, idkey, code, joinedAt and progress',
      Object.keys(rec).sort().join(',') === 'code,email,idkey,joinedAt,name,progress', Object.keys(rec).join(','));
    ok('tt-join: the record is stamped with its owner', st.docs['jj_playbook/ttm:TT36:tia-s-org'].ownerEmail === 'tia@s.org');
    const r2 = await call(tt, 'T', { code: 'TWIN10', first: 'Tia', last: 'Lee' });
    ok('tt-join: a switched-off code is refused', r2.statusCode === 403 && JSON.parse(r2.body).code === 'disabled', r2.body);
    const r3 = await call(tt, 'T', { code: 'PLAYBOOK26', first: 'Tia', last: 'Lee' });
    ok('tt-join: a Playbook code is not a Twin Thieves code', r3.statusCode === 404 && JSON.parse(r3.body).code === 'no-code', r3.body);
    const r4 = await call(tt, 'T', { code: 'TT36', first: 'Tia', last: 'Lee' });
    ok('tt-join: the program id is not a code', r4.statusCode === 404, r4.body);
    const r5 = await call(tt, 'G', { code: 'TWIN36', first: 'Gone', last: 'X' });
    ok('tt-join: a rev: tombstone refuses', r5.statusCode === 403 && JSON.parse(r5.body).code === 'revoked', r5.body);
    const r6 = await call(tt, 'M', { code: 'TWIN36', first: 'M', last: 'S' });
    ok('tt-join: an unconfirmed Microsoft sign-in is asked to confirm', r6.statusCode === 403 && JSON.parse(r6.body).code === 'ms-verify', r6.body);
    st.docs['jj_playbook/org:TT36'] = V({ name: 'TT', product: 'tt', ttVersion: 36, joinCode: 'TWIN36', joinDomain: 's.org' });
    const r7 = await call(tt, 'D', { code: 'TWIN36', first: 'Dee', last: 'O' });
    ok('tt-join: the email-domain limit refuses other domains', r7.statusCode === 403 && JSON.parse(r7.body).code === 'domain', r7.body);
    const r8 = await call(tt, 'X', { code: 'TWIN36', first: 'a', last: 'b' });
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
    // Twin Thieves sends no notifications: every sender skips TT36/TT10 push: records.
    const loops = (fx.match(/if \(doc\.id\.indexOf\('push:'\) !== 0\) continue;\n    if \(isTTPush\(doc\)\) continue;/g) || []).length;
    const allLoops = (fx.match(/if \(doc\.id\.indexOf\('push:'\) !== 0\) continue;/g) || []).length;
    ok('functions: every scheduled sender skips Twin Thieves push: records', allLoops > 0 && loops === allLoops, loops + ' of ' + allLoops);
    ok('functions: tokensFor, the admin list and the fundamental-done push skip them too',
      (fx.match(/\.filter\(\(d\) => d\.id\.indexOf\('push:'\) === 0 && !isTTPush\(d\)\)/g) || []).length === 2
      && !/\.filter\(\(d\) => d\.id\.indexOf\('push:'\) === 0\)/.test(fx) && /if \(isTTPush\(pushDoc\)\) return;/.test(fx));
    const pv = fx.slice(fx.indexOf('function parseValue'), fx.indexOf('\n}\n', fx.indexOf('function parseValue')) + 3);
    const hp = fx.slice(fx.indexOf('const TT_PROGRAMS'), fx.indexOf('\n}\n', fx.indexOf('function isTTPush')) + 3);
    const isTTPush = new Function(pv + hp + 'return isTTPush;')();
    const D = (id, v) => ({ id, exists: true, data: () => (v ? { value: JSON.stringify(v) } : {}) });
    ok('functions: isTTPush knows a Twin Thieves record by key or stored code, and never a Playbook one',
      isTTPush(D('push:TT36:a', {})) && isTTPush(D('push:TT10:a')) && isTTPush(D('push:a', { code: 'TT36' }))
      && !isTTPush(D('push:PLAYBOOK26:a', { code: 'PLAYBOOK26' })) && !isTTPush(D('push:a', { code: 'T1' })) && !isTTPush(D('resp:TT36:a', {})));
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
    st.docs['jj_playbook/org:TT36'] = V({ name: 'Twin Thieves Leadership · 36 lessons', product: 'tt', ttVersion: 36, joinCode: 'TWIN36' });
    st.docs['jj_playbook/org:TT10'] = V({ name: 'Twin Thieves Leadership · 10 lessons', product: 'tt', ttVersion: 10, joinCode: 'TWIN10' });
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
    process.env.INVITE_SEND_MODE = 'test'; process.env.INVITE_TEST_RECIPIENTS = 'zed@s.org'; process.env.SMTP_USER = 'noreply@jadin-jones.com'; process.env.SMTP_PASS = 'x'; process.env.MAIL_FROM = 'JJ Playbook <noreply@jadin-jones.com>';
    r = await inviteCall('ADM', { action: 'send', program: 'TT10', emails: ['zed@s.org', 'someone@else.org'] });
    ok('invite: test mode sends only to test recipients', r.code === 200 && SENT.length === 1 && SENT[0].to === 'zed@s.org'
      && r.body.results[1].result === 'not-a-test-recipient' && !Object.keys(st.docs).some(k => k.indexOf('ttinv:TT10') > 0 && JSON.parse(st.docs[k].value).email === 'someone@else.org'), JSON.stringify(r.body));
    const mail = SENT[0] || {};
    ok('invite: through main\'s mailer, from "Jadin | Jones Team" <noreply@jadin-jones.com>, replies to charlie@',
      mail.from === '"Jadin | Jones Team" <noreply@jadin-jones.com>' && mail.replyTo === 'charlie@jadin-jones.com', mail.from);
    {
      // The Microsoft code email goes through the same mailer and must not change.
      const lib = path.join(ROOT, 'netlify/lib/mailer.js'); delete require.cache[lib];
      SENT.length = 0; await require(lib).sendMail({ to: 'mm@a.com', subject: 'Your code', text: '123456' });
      ok('mailer: the Microsoft code email is unchanged (MAIL_FROM, plain text, no Reply-To)',
        SENT.length === 1 && SENT[0].from === 'JJ Playbook <noreply@jadin-jones.com>' && Object.keys(SENT[0]).sort().join(',') === 'from,subject,text,to', JSON.stringify(SENT[0]));
      SENT.length = 1; SENT[0] = mail;
    }
    ok('invite: the email says 10 lessons for the 10-lesson version, with the code and a Join now link',
      /series of 10 short video lessons/.test(mail.text || '') && /TWIN10/.test(mail.text || '') && />JOIN NOW<\/a>/.test(mail.html || '')
      && /https:\/\/jj-twinthieves-preview\.netlify\.app\/\?tti=[A-Za-z0-9_-]{40,}&ttc=TWIN10/.test(mail.text || ''), (mail.text || '').slice(0, 200));
    ok('invite: the Google / Microsoft sign-in sentence follows "Sign in with <email>."',
      (mail.text || '').indexOf('Sign in with zed@s.org. Use Continue with Google if your email is a Gmail or Google Workspace account, or Continue with Microsoft if it\'s Outlook or Microsoft 365. It works once') >= 0);
    ok('invite: brand layout (site logo with JADIN | JONES alt text, navy, lime square button, footer link)',
      /<img src="https:\/\/jj-twinthieves-preview\.netlify\.app\/assets\/jj-lockup\.png"[^>]* alt="JADIN \| JONES"/.test(mail.html || '')
      && /bgcolor="#033266"/.test(mail.html || '') && /bgcolor="#D9E244" style="background:#D9E244;border-radius:0"/.test(mail.html || '')
      && /<a href="https:\/\/jadin-jones\.com" style="color:#FFFFFF/.test(mail.html || ''));
    ok('invite: "Jadin | Jones" keeps a real bar, drawn thin, never a capital I',
      /Jadin<span style="font-weight:300;color:#[0-9A-F]{6};padding:0 0\.2em">\|<\/span>Jones/.test(mail.html || '')
      && !/Jadin I Jones/i.test((mail.html || '') + (mail.text || '')) && /The Jadin \| Jones Team/.test(mail.text || ''));
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
    delete process.env.SMTP_PASS;
    r = await inviteCall('ADM', { action: 'send', program: 'TT36', emails: ['zed@s.org'] });
    ok('invite: without SMTP_USER/SMTP_PASS a send reports no-mail-setup', r.code === 200 && r.body.results[0].result === 'no-mail-setup', JSON.stringify(r.body));
    delete process.env.INVITE_SEND_MODE; delete process.env.INVITE_TEST_RECIPIENTS; delete process.env.SMTP_USER; delete process.env.SMTP_PASS; delete process.env.MAIL_FROM;
  }
  // ---- 7. Approved-email list (ttallow:TTxx): code joins only for listed emails; invites unaffected. ----
  {
    const st = makeStore();
    st.docs['jj_playbook/org:TT36'] = V({ name: 'Twin Thieves Leadership · 36 lessons', product: 'tt', ttVersion: 36, joinCode: 'TWIN36' });
    st.docs['jj_playbook/org:TT10'] = V({ name: 'Twin Thieves Leadership · 10 lessons', product: 'tt', ttVersion: 10, joinCode: 'TWIN10' });
    st.docs['jj_playbook/ttallow:TT36'] = V({ emails: ['Tia@S.org', 'amy@s.org'] });
    st.docs['jj_playbook/ttallow:TT10'] = V({ emails: [] });
    const users = { ADM: U('charlie@jadin-jones.com'), T: U('tia@s.org'), Z: U('zed@s.org'), Q: U('quin@s.org') };
    const tt = loadFn('tt-join.js', st, users);
    let r = await call(tt, 'T', { code: 'TWIN36', first: 'Tia', last: 'Lee' });
    ok('allow list: a listed email joins with the code (not case-sensitive)', r.statusCode === 200 && JSON.parse(r.body).code === 'TT36', r.body);
    r = await call(tt, 'Z', { code: 'TWIN36', first: 'Zed', last: 'Q' });
    ok('allow list: an unlisted email is refused with the agreed wording',
      r.statusCode === 403 && JSON.parse(r.body).code === 'not-listed'
      && JSON.parse(r.body).error === "Your email isn't on the list for this program. Ask the Jadin | Jones Team to add you.", r.body);
    ok('allow list: the refused join writes nothing', !st.writes.some(w => w.indexOf('zed') >= 0), st.writes.join(','));
    r = await call(tt, 'Z', { code: 'TWIN10', first: 'Zed', last: 'Q' });
    ok('allow list: an empty list lets anyone with the code join', r.statusCode === 200 && JSON.parse(r.body).code === 'TT10', r.body);
    st.docs['jj_playbook/ttallow:TT10'] = { value: '{not json' };
    r = await call(tt, 'Q', { code: 'TWIN10', first: 'Quin', last: 'R' });
    ok('allow list: a damaged list refuses the code join (fails closed)', r.statusCode === 403 && JSON.parse(r.body).code === 'list-unreadable', r.body);
    process.env.URL = 'https://jj-twinthieves-preview.netlify.app'; delete process.env.INVITE_SEND_MODE; SENT.length = 0;
    process.env.INVITE_SEND_MODE = 'test'; process.env.INVITE_TEST_RECIPIENTS = 'quin@s.org'; process.env.SMTP_USER = 'noreply@jadin-jones.com'; process.env.SMTP_PASS = 'x'; process.env.MAIL_FROM = 'JJ Playbook <noreply@jadin-jones.com>';
    await call(loadFn('tt-invite.js', st, users), 'ADM', { action: 'send', program: 'TT36', emails: ['quin@s.org'] });
    const secret = (((SENT[0] || {}).text || '').match(/tti=([A-Za-z0-9_-]+)/) || [])[1];
    r = await call(loadFn('tt-join.js', st, users), 'Q', { invite: secret, first: 'Quin', last: 'R' });
    ok('allow list: an invite still joins an address that is not on the list', !!secret && r.statusCode === 200 && JSON.parse(r.body).code === 'TT36', r.body);
    delete process.env.INVITE_SEND_MODE; delete process.env.INVITE_TEST_RECIPIENTS; delete process.env.SMTP_USER; delete process.env.SMTP_PASS; delete process.env.MAIL_FROM;
    const join = loadFn('join.js', st, { A: U('ann@a.com') });
    st.docs['jj_playbook/org:PLAYBOOK26'] = V({ name: 'Playbook 26', allowlist: [] });
    r = await call(join, 'A', { code: 'playbook26' });
    ok('allow list: the Playbook join is untouched by it', r.statusCode === 200 && JSON.parse(r.body).code === 'PLAYBOOK26', r.body);
  }

  // ---- 7b. Removed members: the code can't bring them back; an invite, the approved list or Restore access does. ----
  {
    const st = makeStore();
    st.docs['jj_playbook/org:TT36'] = V({ name: 'Twin Thieves Leadership · 36 lessons', product: 'tt', ttVersion: 36, joinCode: 'TWIN36' });
    st.docs['jj_playbook/org:TT10'] = V({ name: 'Twin Thieves Leadership · 10 lessons', product: 'tt', ttVersion: 10, joinCode: 'TWIN10' });
    st.docs['jj_playbook/ttallow:TT10'] = V({ emails: ['rem@s.org', 'old@s.org'] });
    // rem@s.org: in TT10 and TT36, and in a Playbook program, with progress in TT10.
    st.docs['members/rem@s.org'] = { orgs: ['PB1'] };
    st.docs['jj_playbook/resp:PB1:rem-s-org'] = Object.assign(V({ email: 'rem@s.org' }), { ownerEmail: 'rem@s.org' });
    st.docs['jj_playbook/ttm:TT36:rem-s-org'] = Object.assign(V({ name: 'Rem', email: 'rem@s.org', progress: { tt05: { doneAt: 5 } } }), { ownerEmail: 'rem@s.org' });
    const PROG = { tt01: { doneAt: 1 }, tt02: { doneAt: 2 } };
    st.docs['jj_playbook/ttm:TT10:rem-s-org'] = Object.assign(V({ name: 'Rem', email: 'rem@s.org', idkey: 'rem-s-org', code: 'TT10', progress: PROG }), { ownerEmail: 'rem@s.org' });
    // Studio's Remove (as the app does it): the marker, the code out of ttmembers; the record and progress stay.
    const remove = () => { st.docs['jj_playbook/rev:TT10:rem-s-org'] = V({ at: 1, email: 'rem@s.org', emails: ['rem@s.org'], name: 'Rem' });
      st.docs['ttmembers/rem@s.org'] = { email: 'rem@s.org', orgs: ['TT36'] }; };
    remove();
    const users = { ADM: U('charlie@jadin-jones.com'), R: U('rem@s.org'), T: U('tia@s.org') };
    const ttJoin = () => call(loadFn('tt-join.js', st, users), 'R', { code: 'TWIN10', first: 'Rem', last: 'R' });
    const inv = body => call(loadFn('tt-invite.js', st, users), 'ADM', Object.assign({ program: 'TT10' }, body)).then(r => ({ code: r.statusCode, body: JSON.parse(r.body) }));
    const restoredOK = () => !st.docs['jj_playbook/rev:TT10:rem-s-org']
      && JSON.stringify((st.docs['ttmembers/rem@s.org'] || {}).orgs) === JSON.stringify(['TT36', 'TT10'])
      && JSON.stringify(JSON.parse(st.docs['jj_playbook/ttm:TT10:rem-s-org'].value).progress) === JSON.stringify(PROG)
      && st.docs['jj_playbook/ttm:TT10:rem-s-org'].ownerEmail === 'rem@s.org'
      && JSON.stringify(JSON.parse(st.docs['jj_playbook/ttm:TT36:rem-s-org'].value).progress) === JSON.stringify({ tt05: { doneAt: 5 } })
      && JSON.stringify(st.docs['members/rem@s.org']) === JSON.stringify({ orgs: ['PB1'] }) && !!st.docs['jj_playbook/resp:PB1:rem-s-org'];
    let r = await ttJoin();
    ok('removed: the code alone is refused, even on the approved list', r.statusCode === 403 && JSON.parse(r.body).code === 'revoked', r.body);
    // 1. A new invite from Studio.
    process.env.INVITE_SEND_MODE = 'test'; process.env.INVITE_TEST_RECIPIENTS = 'rem@s.org';
    process.env.SMTP_USER = 'noreply@jadin-jones.com'; process.env.SMTP_PASS = 'x'; process.env.URL = 'https://dev.playbook.jadin-jones.com';
    SENT.length = 0;
    let x = await inv({ action: 'send', emails: ['rem@s.org'] });
    ok('restore by invite: sending an invite restores access and emails it', x.code === 200 && x.body.results[0].result === 'restored-sent' && SENT.length === 1, JSON.stringify(x.body));
    ok('restore by invite: progress kept; other program, members/ and resp: untouched', restoredOK());
    r = await ttJoin();
    ok('restore by invite: the code works again', r.statusCode === 200 && JSON.parse(r.body).code === 'TT10', r.body);
    ok('restore by invite: joining again keeps the progress', JSON.stringify(JSON.parse(st.docs['jj_playbook/ttm:TT10:rem-s-org'].value).progress) === JSON.stringify(PROG));
    // 2. The approved list saved with them on it (Studio calls restore for the removed people on the list).
    remove();
    x = await inv({ action: 'restore', emails: ['rem@s.org', 'old@s.org'] });
    ok('restore by approved list: restored; a listed address that was never removed is left alone',
      x.code === 200 && x.body.results[0].result === 'restored' && x.body.results[1].result === 'not-removed' && !st.docs['ttmembers/old@s.org'], JSON.stringify(x.body));
    ok('restore by approved list: progress kept; other program, members/ and resp: untouched', restoredOK());
    // 3. Restore access in Studio.
    remove();
    x = await inv({ action: 'restore', emails: ['rem@s.org'] });
    ok('restore button: restored, progress kept, nothing else touched', x.code === 200 && x.body.results[0].result === 'restored' && restoredOK(), JSON.stringify(x.body));
    x = await inv({ action: 'restore', emails: ['rem@s.org'] });
    ok('restore button: a second press does nothing', x.body.results[0].result === 'not-removed');
    // 4. Resend, even when their old invite was used.
    remove();
    const iid = require(path.join(ROOT, 'netlify/functions/tt-invite.js'))._inviteId('TT10', 'rem@s.org');
    st.docs['jj_playbook/' + iid] = V({ email: 'rem@s.org', program: 'TT10', status: 'joined', sentAt: 1, expiresAt: 2 });
    SENT.length = 0;
    x = await inv({ action: 'resend', email: 'rem@s.org' });
    ok('restore by resend: restores and sends a new link, though the old invite was used',
      x.code === 200 && x.body.results[0].result === 'restored-sent' && SENT.length === 1 && restoredOK(), JSON.stringify(x.body));
    // 5. Removed before this change: the record (and progress) was deleted; restoring gives an empty one they own.
    st.docs['jj_playbook/rev:TT10:old-s-org'] = V({ at: 1, email: 'old@s.org', emails: ['old@s.org'], name: 'Old One' });
    x = await inv({ action: 'restore', emails: ['old@s.org'] });
    const oldRec = st.docs['jj_playbook/ttm:TT10:old-s-org'];
    ok('restore after an older Remove: a fresh record they own, with their name',
      x.body.results[0].result === 'restored' && !!oldRec && oldRec.ownerEmail === 'old@s.org' && JSON.parse(oldRec.value).name === 'Old One'
      && JSON.stringify(st.docs['ttmembers/old@s.org'].orgs) === JSON.stringify(['TT10']) && !st.docs['jj_playbook/rev:TT10:old-s-org']);
    // Only admins restore.
    remove();
    const nope = await call(loadFn('tt-invite.js', st, users), 'T', { action: 'restore', program: 'TT10', emails: ['rem@s.org'] });
    ok('restore: a member cannot restore anyone', nope.statusCode === 403 && !!st.docs['jj_playbook/rev:TT10:rem-s-org'], nope.body);
    delete process.env.INVITE_SEND_MODE; delete process.env.INVITE_TEST_RECIPIENTS; delete process.env.SMTP_USER; delete process.env.SMTP_PASS;
    // The app: Remove keeps the record; saving the approved list restores; Studio marks the removed.
    const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
    const rm = html.slice(html.indexOf('  ttRemoveMember(m){'), html.indexOf('  ttStudioVM(v){'));
    ok('app: Remove keeps the progress record and stores the name on the marker', !!rm && !/sdel\('ttm:/.test(rm) && /name:String\(m\.name\|\|''\)\}/.test(rm));
    ok('app: saving the approved list restores the removed people on it',
      /\.filter\(e=>e&&emails\.indexOf\(e\)>=0\);[\s\S]{0,40}const n=back\.length\?await this\.ttRestore\(id,back,true\):0;/.test(html));
    // Last opened: Auth's own times, for current Twin Thieves members only; nothing written.
    {
      const lo = makeStore(), D = 86400000, now = Date.now(), iso = t => new Date(t).toUTCString();
      lo.docs['ttmembers/ann@s.org'] = { email: 'ann@s.org', orgs: ['TT36'] };
      lo.docs['ttmembers/bo@s.org'] = { email: 'bo@s.org', orgs: ['TT10'] };
      lo.docs['ttmembers/gone@s.org'] = { email: 'gone@s.org', orgs: [] };
      lo.docs['members/pb@s.org'] = { email: 'pb@s.org', orgs: ['PLAYBOOK26'] };
      lo.accounts = {
        'ann@s.org': [{ email: 'ann@s.org', metadata: { lastSignInTime: iso(now - 9 * D), lastRefreshTime: iso(now - 2 * D) } },
          { email: 'ann@s.org', metadata: { lastSignInTime: iso(now - 30 * D), lastRefreshTime: null } }],
        'gone@s.org': [{ email: 'gone@s.org', metadata: { lastRefreshTime: iso(now) } }],
        'pb@s.org': [{ email: 'pb@s.org', metadata: { lastRefreshTime: iso(now) } }] };
      const lusers = { ADM: U('charlie@jadin-jones.com'), MSA: U('lucas@jadin-jones.com', 'microsoft.com'), T: U('ann@s.org') };
      const last = (tok, body) => call(loadFn('tt-invite.js', lo, lusers), tok, body).then(r => ({ code: r.statusCode, body: JSON.parse(r.body) }));
      const r1 = await last('ADM', { action: 'lastopened', emails: ['Ann@s.org', 'bo@s.org', 'gone@s.org', 'pb@s.org', 'nobody@s.org', 'not an email'] });
      const t = r1.body.times || {};
      ok('last opened: an admin gets Auth\'s latest time for each current Twin Thieves member (the later of refresh and sign-in, any of their accounts)',
        r1.code === 200 && Math.abs(t['ann@s.org'] - (now - 2 * D)) < 1000 && t['bo@s.org'] === null, JSON.stringify(r1.body));
      ok('last opened: nobody outside Twin Thieves is answered (a removed member, a Playbook-only member, an unknown address)',
        Object.keys(t).sort().join() === 'ann@s.org,bo@s.org' && JSON.stringify(lo.authCalls) === '[2]', JSON.stringify(Object.keys(t)) + ' ' + JSON.stringify(lo.authCalls));
      ok('last opened: nothing is written (only the rate limit\'s own count)', lo.writes.every(w => /^rateLimits\//.test(w)), lo.writes.join());
      const refused = [await last('T', { action: 'lastopened', emails: ['ann@s.org'] }), await last('MSA', { action: 'lastopened', emails: ['ann@s.org'] }),
        await last('NOPE', { action: 'lastopened', emails: ['ann@s.org'] }), await last('ADM', { action: 'lastopened', emails: Array.from({ length: 201 }, (_, i) => 'x' + i + '@s.org') })];
      ok('last opened: a member, a Microsoft admin sign-in and a bad token are refused; over 200 addresses is refused; Auth is never asked',
        refused.map(r => r.code).join() === '403,403,401,400' && JSON.stringify(lo.authCalls) === '[2]', refused.map(r => r.code).join());
    }
    ok('app: Studio marks removed members and offers Restore access',
      /st==='removed'\?'Removed'/.test(html) && /canRestore:!!m\.removed,onRestore:\(\)=>this\.ttRestore\(/.test(html) && />Restore access<\/button>/.test(html));
  }
  // ---- 8. Hosts, sign-in wording, My groups, and no leftover debug logging. ----
  {
    const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
    const line = re => { const m = html.match(re); return m ? m[0] : ''; };
    const pick = host => {
      const src = [line(/const DEV_HOST=.*;/), line(/const FIREBASE_CONFIG=.*;/), line(/const PUSH_VAPID_KEY=.*;/),
        line(/const AUTH_OWN_HOSTS=\[[^\]]*\];/), line(/const MS_SIGNIN_HOSTS=\[[^\]]*\];/)].join('\n');
      return new Function('location', src + '\nreturn {p:FIREBASE_CONFIG.projectId,k:PUSH_VAPID_KEY.slice(0,9),own:AUTH_OWN_HOSTS.indexOf(location.hostname)>=0,ms:MS_SIGNIN_HOSTS.indexOf(location.hostname)>=0};')({ hostname: host });
    };
    const want = { 'jjplaybook.netlify.app': 'test-6b2ab', 'playbook.jadin-jones.com': 'test-6b2ab', 'twinthieves.jadin-jones.com': 'test-6b2ab',
      'jj-playbook-dev.netlify.app': 'jj-playbook-dev', 'dev.playbook.jadin-jones.com': 'jj-playbook-dev', 'jj-twinthieves-preview.netlify.app': 'jj-playbook-dev' };
    const got = Object.keys(want).map(h => [h, pick(h)]);
    ok('hosts: each host picks its project and VAPID key (twinthieves.jadin-jones.com is live)',
      got.every(([h, g]) => g.p === want[h] && g.k === (want[h] === 'test-6b2ab' ? 'BInNmntOm' : 'BC6VSCl7r')), JSON.stringify(got));
    ok('hosts: every one of our hosts signs in through its own /__/auth and offers Microsoft', got.every(([, g]) => g.own && g.ms), JSON.stringify(got));
    ok('hosts: no host list picks the product (the code entered does)', !/TT_HOSTS|ttHostHere/.test(html));
    const { SITE_HOSTS } = require(path.join(ROOT, 'netlify/lib/http.js'));
    ok('hosts: live CORS adds only twinthieves.jadin-jones.com; Dev unchanged',
      SITE_HOSTS['test-6b2ab'].join(',') === 'jjplaybook.netlify.app,playbook.jadin-jones.com,twinthieves.jadin-jones.com'
      && SITE_HOSTS['jj-playbook-dev'].join(',') === 'jj-playbook-dev.netlify.app,dev.playbook.jadin-jones.com,jj-twinthieves-preview.netlify.app', JSON.stringify(SITE_HOSTS));
    ok('sign-in: "Sign in to Jadin | Jones" on every host',
      /v\.gateSignInTitle='Sign in to Jadin \| Jones';/.test(html) && !/Sign in to your playbook/.test(html)
      && />\{\{ gateSignInTitle \}\}<\/p>/.test(html));
    ok('my groups: a Twin Thieves program skips the resp: read the rules refuse',
      /ttCodes\.has\(code\)\?Promise\.resolve\(null\):sgetStrict\('resp:'\+code\+':'\+idkey\)/.test(html));
    ok('my groups: "you are here" and Back return a Twin Thieves member to Twin Thieves',
      /g\.code===s\.code\) return this\.setState\(\{view:this\.isTT\(\)\?'tthome':'home'/.test(html)
      && /onGateBackToApp=\(\)=>this\.setState\(\{view:this\.isTT\(\)\?'tthome':'home'/.test(html));
    // Notifications: Twin Thieves-only members are never asked, and the iOS app writes no push: record under a Twin Thieves program.
    ok('push: no prompt in a Twin Thieves program unless they are also in a Playbook program',
      /pushAskDue\(\)\{\n    if\(this\.state\.role!=='leader'\|\|this\.state\.previewMode\) return false;\n    \/\/ [^\n]*\n    if\(this\.isTT\(\)&&this\.state\.ttHasPlaybook!==true\) return false;/.test(html)
      && /const hasPB=out\?out\.some\(g=>g&&g\.product!=='tt'\):null;/.test(html));
    ok('push: the iOS app saves no token record in a Twin Thieves program', /async saveNativeToken\(token\)\{\n    \/\/ [^\n]*\n    if\(this\.isTT\(\)\) return;/.test(html));
    // Lessons: transcripts hidden (kept in the data), the Thank you lesson, per-version names.
    ok('lessons: no transcript is shown to members or edited in Studio',
      !/ttTranscript|ttIsTranscript|ttEdTranscript|>Transcript</.test(html) && /transcript:''/.test(html));
    ok('lessons: the Thank you lesson has no book or "Where this fits" row, and Studio can give it a video',
      /<sc-if value="\{\{ ttNotThanks \}\}" hint-placeholder-val="\{\{ true \}\}">\n<div style="\{\{ ttFitRowStyle \}\}">/.test(html)
      && /<\/sc-raw-select>\n<\/sc-if>\n<div style="\{\{ ttK \}\}">Video URL<\/div>/.test(html));
    ok('lessons: a version\'s own name only renames; progress stays keyed by lesson id',
      /title:String\(nm\[l\.id\]\|\|''\)\.trim\(\)\|\|l\.title/.test(html) && /ttDone\(id\)\{ const p=this\.state\.ttProg\|\|\{\}; return !!\(p\[id\]&&p\[id\]\.doneAt\); \}/.test(html));
    ok('lessons: "← All lessons" at the top and the bottom of every lesson', (html.match(/aria-label="Back to all lessons"/g) || []).length === 2);
    ok('lessons menu: the sidebar list fills the height only for Twin Thieves; the drawer rule covers phones and iPad portrait',
      (html.match(/data-tt-side="1" style=/g) || []).length === 1 && /<sc-if value="\{\{ tb\.hasTTList \}\}"[^>]*>\n<div data-tt-list="1" data-tt-side="1"/.test(html)
      && /hasTTList:W&&this\.isTT\(\)&&t\.k==='lessons'/.test(html) && /@media \(max-width:899px\)\{\n\[data-tt-drawer="1"\]/.test(html));
    // Pyramid home page and lessons grouped by fundamental (Twin Thieves only).
    // d5c35ad is main before this change: the Playbook's own pieces are compared with it.
    let before = '';
    try { before = execSync('git show d5c35ad:public/index.html', { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 }).toString(); } catch (e) {}
    const method = (src, name) => { const a = src.indexOf('\n  ' + name + '('); if (a < 0) return ''; const b = src.slice(a + 1).search(/\n  (?:async )?[A-Za-z_$][\w$]*\([^)]*\)\{/); return src.slice(a, b < 0 ? undefined : a + 1 + b); };
    ok('pyramid page: the Playbook home pyramid (pyramidVM) is unchanged', !!before && !!method(html, 'pyramidVM') && method(html, 'pyramidVM') === method(before, 'pyramidVM'));
    const pbNav = src => { const m = src.match(/: \[\{k:'playbook'[\s\S]*?\.concat\(\[\{k:'me'[^\n]*\n/); return m ? m[0] : ''; };
    ok('pyramid page: the Playbook menu items are unchanged', !!before && !!pbNav(html) && pbNav(html) === pbNav(before));
    const views = []; let at = -1;
    while ((at = html.indexOf("'tthome'", at + 1)) >= 0) {
      const back = html.slice(0, at), lineStart = back.lastIndexOf('\n') + 1, line = html.slice(lineStart, html.indexOf('\n', at));
      const ms = [...back.matchAll(/\n  (?:async )?([A-Za-z_$][\w$]*)\([^)]*\)\{/g)], owner = ms.length ? ms[ms.length - 1][1] : '';
      const safe = /^(tt|loadTT|startTT)/.test(owner) || /this\.isTT\(\)\?'tthome'/.test(line) || /v\.showTTHome=V\('tthome'\)/.test(line)
        || /\(ttSideNav&&t\.k==='lessons'\)\?s\.view==='tthome'/.test(line)
        || /: this\.isTT\(\)\n$/.test(html.slice(lineStart - 30, lineStart)) && /^      \? \[\{k:'lessons'/.test(line);
      views.push({ owner, safe, line: line.trim().slice(0, 80) });
    }
    ok('pyramid page: every way into it is Twin Thieves-only (its own code, or behind isTT())', views.length >= 10 && views.every(v => v.safe), JSON.stringify(views.filter(v => !v.safe)));
    ok('pyramid page: drawn only in the Twin Thieves home view', (html.match(/data-tt-pyr="1"/g) || []).length === 1
      && /<sc-if value="\{\{ showTTHome \}\}" hint-placeholder-val="\{\{ false \}\}">\n<div data-tt-pyr="1"/.test(html));
    const rnd = method(html, 'ttRender');
    ok('pyramid page: its view model and the grouped list are built only after "if(!tt) return"',
      !!rnd && rnd.indexOf('if(!tt) return;') > 0 && rnd.indexOf('ttGroups(') > rnd.indexOf('if(!tt) return;') && rnd.indexOf('ttPyramidVM(') > rnd.indexOf('if(!tt) return;')
      && (html.match(/this\.ttGroups\(|this\.ttPyramidVM\(|this\.ttTierText\(/g) || []).length === 3);
    ok('grouped list: fundamental headings only in the Twin Thieves sidebar and phone menu',
      (html.match(/data-tt-group="\{\{ sl\.fund \}\}"/g) || []).length === 2
      && /<div data-tt-list="1" data-tt-side="1"[^\n]*\n<sc-for list="\{\{ ttSideLight \}\}"[^\n]*\n<sc-if value="\{\{ sl\.isHead \}\}"/.test(html)
      && /<div data-tt-list="1" data-tt-drawer="1"[^\n]*\n<sc-for list="\{\{ ttSide \}\}"[^\n]*\n<sc-if value="\{\{ sl\.isHead \}\}"/.test(html));
    ok('menu: "Playbook" lights on the pyramid page only in the Twin Thieves sidebar; every other menu unchanged',
      /const ttSideNav=!!W&&this\.isTT\(\);/.test(html)
      && /const active=isAdminOnly\?true:\(\(ttSideNav&&t\.k==='lessons'\)\?s\.view==='tthome':\(s\.tab===t\.k\)\);/.test(html)
      && /const active=isAdminOnly\?true:\(s\.tab===t\.k\);/.test(before));
    // The light sidebar panel: Twin Thieves members on a wide screen only; the Playbook's (and Studio's) stays as main has it.
    ok('light sidebar: only for a Twin Thieves member on a wide screen; the Playbook sidebar, label and tabs are unchanged otherwise',
      /const ttLight=sidebar&&this\.isTT\(\)&&!isAdminOnly;/.test(html)
      && /'grid-column:1;grid-row:2;border-right:1px solid #DCE6F0;padding:26px 18px 40px'/.test(before)
      && /\? \(ttLight\?'grid-column:1;grid-row:2;align-self:start;position:sticky;top:76px;margin:14px 0 14px 16px;background:#FFFFFF;border:1px solid #DFE5EE;border-radius:16px;padding:18px 12px 12px':'grid-column:1;grid-row:2;border-right:1px solid #DCE6F0;padding:26px 18px 40px'\)/.test(html)
      && /<div style="font-weight:800;font-size:9\.5px;letter-spacing:\.2em;text-transform:uppercase;color:#9DAAB8;padding:0 16px 12px">\{\{ navProductLabel \}\}<\/div>/.test(before)
      && /v\.navProductLabelStyle='font-weight:800;font-size:9\.5px;letter-spacing:\.2em;text-transform:uppercase;color:'\+\(ttLight\?'#5B6B82':'#9DAAB8'\)\+';padding:0 '\+\(ttLight\?'10px 10px':'16px 12px'\);/.test(html)
      && /hoverStyle:ttLight\?lightHover:\(W\?\(active\?\{\}:\{background:'#EAF1F8',color:'#0C1B2E'\}\):\{background:'rgba\(255,255,255,\.1\)'\}\),\n        style:ttLight\?lightStyle:W\n/.test(html)
      && /\? \(ttLight\?lightGlyph:\(active\?'#FADA01':\(t\.gc\|\|'#7E8D9C'\)\)\)/.test(html)
      && (html.match(/ttSideLight/g) || []).length === 2 && /<div data-tt-list="1" data-tt-drawer="1"[^\n]*\n<sc-for list="\{\{ ttSide \}\}"/.test(html));
    ok('lessons: "← All lessons" goes back to the pyramid page', /v\.onTTHome=\(\)=>\{ this\.setState\(\{view:'tthome',tab:'lessons',ttFocus:null\}\);/.test(html));
    const css = html.slice(html.indexOf('/* Twin Thieves lesson menu'), html.indexOf('@keyframes jjFall'));
    ok('pyramid page: the new styles reach only Twin Thieves elements', !!css && css.split('\n').filter(l => /\{/.test(l) && !/^@media/.test(l)).every(l => /^\[data-tt-(drawer|side)="1"\]/.test(l)));
    // Studio → Twin Thieves: names keep their spaces; Import lesson content.
    const tt = new Function(line(/const TT_FUND_NAMES=[\s\S]*?;\n/) + html.slice(html.indexOf('const ttNameInput='), html.indexOf('/* A thumbnail link as a CSS url()'))
      + '\nreturn {ttNameInput,ttCleanNames,ttNamesRelated,ttImportPlan,ttImportApply,ttImportRevert,ttLastOpenedText};')();
    {
      const f = tt.ttLastOpenedText, now = new Date(2026, 9, 14, 15, 0).getTime(), at = (m, d, h) => new Date(2026, m, d, h || 10).getTime();
      const got = [f(at(9, 14, 1), 0, now), f(at(9, 13, 23), 0, now), f(at(9, 11), 0, now), f(at(9, 7), 0, now), f(at(9, 6), 0, now),
        f(new Date(2025, 11, 30).getTime(), 0, now), f(null, at(9, 1), now), f(at(9, 1, 10) + 1800000, at(9, 1, 10), now), f(at(9, 2), at(9, 1), now), f(now + 60000, 0, now)];
      ok('last opened: Today, Yesterday, "3 days ago" up to a week, then the date (with the year if not this one); Never without a time or with none after the joining session',
        got.join('|') === 'Today|Yesterday|3 days ago|7 days ago|Oct 6|Dec 30, 2025|Never|Never|Oct 2|Today', got.join('|'));
    }
    {
      const lo = html.slice(html.indexOf('  async ttLoadLastOpened('), html.indexOf('  /* Remove: a rev: marker'));
      ok('last opened (app): asked only from Studio\'s member list, through /api/tt-invite; nothing saved; never the Playbook\'s lastSeenAt',
        !!lo && (html.match(/action:'lastopened'/g) || []).length === 1 && /this\.ttInviteApi\(\{action:'lastopened'/.test(lo)
        && !/sset\(|lastSeenAt|localStorage/.test(lo) && (html.match(/this\.ttLoadLastOpened\(/g) || []).length === 1
        && /this\.ttLoadLastOpened\(rows\.map\(r=>r\.email\),force\)/.test(html.slice(html.indexOf('  async ttLoadMembers(force){'), html.indexOf('  async ttLoadLastOpened('))));
      ok('last opened (app): shown only on a current member\'s row (not a removed one or an invite)',
        /hasLast:!!m\.isMember&&!m\.removed&&!m\.noRecord&&!!lastFor\(m\),last:lastFor\(m\),/.test(html)
        && (html.match(/data-tt-last="1"/g) || []).length === 1 && !/lastSeenAt/.test(html.slice(html.indexOf('const lastMap=s.ttLast'), html.indexOf('const chip='))));
    }
    {
      const want = 'Week 4: Be the Buffalo';
      let box = ''; for (const ch of want) box = tt.ttNameInput(box + ch);   // typed one key at a time
      const saved = tt.ttCleanNames({ '36': { tt12: '  ' + box + '  ', tt13: '   ', tt14: 'Lib Title' } }, { tt12: { title: 'Be the Buffalo' }, tt14: { title: 'Lib Title' } });
      ok('versions: "Week 4: Be the Buffalo" can be typed with its spaces and saves with them (ends trimmed)',
        box === want && saved['36'].tt12 === want && !('tt13' in saved['36']) && !('tt14' in saved['36']), JSON.stringify({ box, saved }));
      ok('versions: the name box no longer trims on every key; Save versions cleans the names',
        !/replace\(\/\\s\+\/g,' '\)\.trim\(\)\.slice\(0,120\)/.test(html) && /t=ttNameInput\(val\);/.test(html)
        && /v\.onTTVerSave=\(\)=>\{ this\.ttSaveLib\(Object\.assign\(\{\},lib,\{names:ttCleanNames\(lib\.names,by\)\}\)/.test(html));
      ok('lesson editor: video, thumbnail, handout and chapter boxes keep what is typed; trimmed on save',
        /v\.onTTEdVideo=e=>set\(\{videoUrl:e\.target\.value\}\);/.test(html) && /v\.onTTEdThumb=e=>set\(\{thumbUrl:e\.target\.value\}\);/.test(html)
        && /a\[i\]\.url=e\.target\.value; set\(\{handouts:a\}\);/.test(html) && /a\[i\]\.t=e\.target\.value; set\(\{chapters:a\}\);/.test(html)
        && /x\.videoUrl=String\(x\.videoUrl\|\|''\)\.trim\(\);/.test(html));
    }
    {
      // A library whose 36-lesson order is not id order, a Thank you lesson, and a per-version name.
      const ids = Array.from({ length: 36 }, (_, i) => 'tt' + String(i + 1).padStart(2, '0'));
      const lessons = ids.map((id, i) => ({ id, title: 'Lesson title ' + (i + 1), fund: i < 7 ? 'energy' : 'execute', videoUrl: 'https://v/' + id, thumbUrl: 'https://t/' + id,
        handouts: [{ label: 'PDF', url: 'https://h/' + id }], summary: 'old ' + id, discussion: ['old d'], additional: ['old a'], bookChapter: 3 }))
        .concat([{ id: 'ttthanks', closing: true, title: 'Thank you!', summary: 'thanks', discussion: [], additional: [] }]);
      lessons[0].title = 'Building Your Own House';
      const order36 = ids.slice(1).concat([ids[0]]);   // lesson 1 of the order is tt02; tt01 is last
      const lib = { lessons, order36, order10: ids.slice(0, 10), names: { '36': { tt02: 'Thermostat vs. Thermometer' } } };
      const libCopy = JSON.parse(JSON.stringify(lib));
      const data = order36.map((id, i) => ({ lesson: i + 1, fundamental: i < 6 ? 'Energy' : 'Execute', title: i === 35 ? 'Build Your Own House' : (i === 0 ? 'Thermostat vs Thermometer' : (i === 4 ? 'Something Else Entirely' : 'Lesson Title ' + (ids.indexOf(id) + 1))),
        concept: 'c', story: 's', summary: 'new summary ' + (i + 1), discussion: ['new d ' + (i + 1)], additional: ['new a ' + (i + 1), 'new b ' + (i + 1)] }));
      delete data[10].additional;   // missing in the file: kept as it is
      const plan = tt.ttImportPlan(data, lib);
      ok('import: matched by position in the 36-lesson order, not by title or id',
        !plan.err && plan.items.length === 36 && plan.items.every(it => it.id === order36[it.pos - 1]) && !plan.blockers.length && !plan.missing.length, JSON.stringify(plan.blockers));
      const flagged = plan.items.filter(it => it.flags.some(f => /^Names look different/.test(f))).map(it => it.pos);
      ok('import: unrelated names are flagged; small differences ("Building Your Own House" / "Build Your Own House") are not',
        flagged.join() === '5', JSON.stringify(flagged));
      ok('import: the per-version name is what the preview shows', plan.items[0].platform === 'Thermostat vs. Thermometer' && plan.items[35].platform === 'Building Your Own House');
      const r = tt.ttImportApply(lib, plan);
      const after = r.lib.lessons, keys = ['id', 'title', 'fund', 'videoUrl', 'thumbUrl', 'handouts', 'bookChapter', 'closing'];
      ok('import: sets only the summary and questions; names, videos, thumbnails, handouts, order and the Thank you lesson stay',
        after.every((l, i) => keys.every(k => JSON.stringify(l[k]) === JSON.stringify(libCopy.lessons[i][k])))
        && JSON.stringify(r.lib.order36) === JSON.stringify(libCopy.order36) && JSON.stringify(r.lib.order10) === JSON.stringify(libCopy.order10)
        && JSON.stringify(r.lib.names) === JSON.stringify(libCopy.names) && JSON.stringify(after[36]) === JSON.stringify(libCopy.lessons[36])
        && after[1].summary === 'new summary 1' && after[0].summary === 'new summary 36' && after[0].discussion.join() === 'new d 36'
        && JSON.stringify(lib) === JSON.stringify(libCopy));
      const l11 = after.find(l => l.id === order36[10]);
      ok('import: a field missing from the file is kept', l11.summary === 'new summary 11' && l11.additional.join() === 'old a');
      ok('import: Undo puts the previous summary and questions back exactly', JSON.stringify(tt.ttImportRevert(r.lib, r.prev)) === JSON.stringify(libCopy) && Object.keys(r.prev).length === 36);
      const dup = tt.ttImportPlan(data.concat([{ lesson: 3, title: 'x', summary: 'y' }, { lesson: 37, title: 'z', summary: 'y' }]), lib);
      ok('import: a lesson twice, or past 36, blocks the import', dup.blockers.length === 2 && /twice/.test(dup.blockers[0]) && /37/.test(dup.blockers[1]));
      ok('import: a file that is not a list of lessons is refused', !!tt.ttImportPlan({ x: 1 }, lib).err && !!tt.ttImportPlan([], lib).err);
      ok('import: admins only, a preview first, Confirm re-checks the saved library and keeps Undo before saving',
        /v\.ttImpCan=s\.role==='admin'&&!editing;/.test(html) && /if\(!f\|\|this\.state\.role!=='admin'\) return;/.test(html)
        && /const plan=ttImportPlan\(imp\.data,fresh\);[\s\S]{0,200}ids\(plan\)!==ids\(imp\.plan\)/.test(html)
        && html.indexOf("sset('ttlib:import-undo',undo)") > 0 && html.indexOf("sset('ttlib:import-undo',undo)") < html.indexOf("if(!(await sset('ttlib:master',out))) return stop("));
    }
    {
      // /api/tt-videos: lists only the named Twin Thieves folders (spaces and all), for admins only.
      const st = makeStore();
      const users = { ADM: U('charlie@jadin-jones.com'), MSA: U('charlie@jadin-jones.com', 'microsoft.com'), T: U('tia@s.org'),
        UNV: Object.assign(U('lucas@jadin-jones.com'), { email_verified: false }) };
      const tokOf = t => ({ metadata: { firebaseStorageDownloadTokens: t } });
      const A36 = '36 Lesson Video Folder/', A10 = '10 Lessons Video/';
      const objs = { 'session-videos/a.mp4': tokOf('p'), 'session-thumbnails/x.jpg': {}, 'challenge-videos/c.mp4': {}, 'knowledge/k.mp4': {},
        [A36]: {}, [A36 + 'Be the Buffalo.mp4']: tokOf('tok1,tok2'), [A36 + 'Eat_the_Frog.mp4']: {}, [A36 + 'notes.txt']: {}, [A36 + 'sub/deep.mp4']: {},
        [A10 + 'Water the Bamboo.mp4']: tokOf('w1') };
      const listed = [], buckets = [];
      const bucket = { getFiles: async q => { const pre = q.prefix || ''; listed.push(pre);
        if (q.delimiter !== '/') throw new Error('must list one level');
        const files = Object.keys(objs).filter(k => k.indexOf(pre) === 0 && (k === pre || k.indexOf('/', pre.length) < 0))
          .map(k => ({ name: k, metadata: Object.assign({ size: String(k.length * 1000), contentType: /\.mp4$/.test(k) ? 'video/mp4' : 'text/plain' }, objs[k]) }));
        return [files, null, { prefixes: [] }]; } };
      const vids = async (tok, body) => { const h = loadFn('tt-videos.js', st, users);
        require.cache[path.join(ROOT, 'netlify/lib/firebase-admin.js')].exports.admin.storage = () => ({ bucket: n => { buckets.push(n); return bucket; } });
        const r = await call(h, tok, body || {}); return { code: r.statusCode, body: JSON.parse(r.body) }; };
      const prev = process.env.FIREBASE_PROJECT_ID; process.env.FIREBASE_PROJECT_ID = 'test-6b2ab';
      const a = await vids('ADM');
      const be = (a.body.files || []).find(f => f.name === 'Be the Buffalo.mp4') || {};
      ok('tt-videos: by default an admin gets both folders, "36 Lesson Video Folder" and "10 Lessons Video", with name, path, size, type and link',
        a.code === 200 && JSON.stringify(a.body.folders) === JSON.stringify([{ folder: '36 Lesson Video Folder', count: 2 }, { folder: '10 Lessons Video', count: 1 }])
        && a.body.files.map(f => f.folder + '|' + f.name).join() === '36 Lesson Video Folder|Be the Buffalo.mp4,36 Lesson Video Folder|Eat_the_Frog.mp4,36 Lesson Video Folder|notes.txt,10 Lessons Video|Water the Bamboo.mp4'
        && be.path === A36 + 'Be the Buffalo.mp4' && be.size === (A36 + 'Be the Buffalo.mp4').length * 1000 && be.contentType === 'video/mp4', JSON.stringify(a.body));
      ok('tt-videos: spaces are kept in the folder and encoded in the link, the getDownloadURL() form from the file\'s own token; no token, no link',
        be.url === 'https://firebasestorage.googleapis.com/v0/b/test-6b2ab.firebasestorage.app/o/36%20Lesson%20Video%20Folder%2FBe%20the%20Buffalo.mp4?alt=media&token=tok1'
        && a.body.files.find(f => f.name === 'Eat_the_Frog.mp4').url === null && listed.slice(0, 2).join('|') === A36 + '|' + A10, listed.join('|'));
      const one = await vids('ADM', { folders: ['10 Lessons Video/'], bucket: 'other-bucket' });
      ok('tt-videos: the folders field is used as given (trailing slash fine); the bucket is always this project\'s own',
        one.code === 200 && one.body.files.length === 1 && buckets.every(n => n === 'test-6b2ab.firebasestorage.app'), JSON.stringify(one.body) + buckets.join());
      listed.length = 0;
      const refused = ['session-videos', 'Session-Videos', 'knowledge', 'challenge-videos', 'random-folder', '..', '/36 Lesson Video Folder',
        '36 Lesson Video Folder/sub', 'TT/../session-videos', 'gs://other/36 Lesson Video Folder', ' 36 Lesson Video Folder', ''];
      const res = [];
      for (const f of refused) res.push((await vids('ADM', { folders: ['36 Lesson Video Folder', f] })).code);
      res.push((await vids('ADM', { folders: ['TT1', 'TT2', 'TT3', 'TT4', 'TT5'] })).code, (await vids('ADM', { folders: 'TT36' })).code, (await vids('ADM', { folders: [] })).code);
      ok('tt-videos: Playbook and other folders, nested or odd paths, too many folders are refused, and nothing is listed',
        res.every(c => c === 400) && listed.length === 0, res.join() + ' | ' + listed.join('|'));
      const deny = [await vids('T'), await vids('MSA'), await vids('UNV'), await vids('NOPE')];
      ok('tt-videos: members, a Microsoft sign-in, an unverified email and a bad token are refused',
        deny.map(r => r.code).join() === '403,403,403,401', deny.map(r => r.code).join());
      ok('tt-videos: writes nothing but its rate-limit count', st.writes.every(w => /^rateLimits\//.test(w)), st.writes.join(','));
      // The thumbnail copy: one fixed file, made once from the HubSpot image, shrunk, with a download token.
      const { Jimp } = require(require.resolve('jimp', { paths: [ROOT] }));
      const srcPng = await new Jimp({ width: 3558, height: 1994, color: 0xFFAA0080 }).getBuffer('image/png');
      const fetched = [], filesTouched = [], saved = {};
      let srcOk = true;
      const realFetch = global.fetch;
      global.fetch = async (u) => { fetched.push(String(u)); return { ok: srcOk, headers: { get: () => srcOk ? 'image/png' : 'text/html' }, arrayBuffer: async () => srcPng.buffer.slice(srcPng.byteOffset, srcPng.byteOffset + srcPng.length) }; };
      bucket.file = p => { filesTouched.push(p); return {
        exists: async () => [!!saved[p]],
        getMetadata: async () => [saved[p].md],
        setMetadata: async m => { saved[p].md = Object.assign({}, saved[p].md, m); },
        save: async (buf, o) => { if (saved[p] && o.preconditionOpts && o.preconditionOpts.ifGenerationMatch === 0) throw Object.assign(new Error('x'), { code: 412 });
          saved[p] = { buf, md: Object.assign({ contentType: o.contentType }, o.metadata), opts: o }; } }; };
      const TP = 'session-thumbnails/twin-thieves-challenge.jpg';
      const t1 = await vids('ADM', { action: 'thumb' });
      const out = saved[TP] ? await Jimp.read(saved[TP].buf) : null;
      const tok1 = saved[TP] && saved[TP].md.metadata.firebaseStorageDownloadTokens;
      ok('tt-videos thumb: an admin\'s first call downloads the HubSpot image once, shrinks it to a 1920 px JPEG and saves the one Twin Thieves thumbnail file',
        t1.code === 200 && t1.body.created === true && fetched.join() === 'https://48441925.fs1.hubspotusercontent-na1.net/hubfs/48441925/Challenge.png'
        && out && out.bitmap.width === 1920 && out.bitmap.height === 1076 && saved[TP].md.contentType === 'image/jpeg' && saved[TP].buf.length < 600 * 1024
        && saved[TP].opts.preconditionOpts.ifGenerationMatch === 0 && Object.keys(saved).join() === TP, JSON.stringify(t1.body) + ' ' + fetched.join());
      ok('tt-videos thumb: its link is the getDownloadURL() form, with the token saved on the file',
        !!tok1 && t1.body.url === 'https://firebasestorage.googleapis.com/v0/b/test-6b2ab.firebasestorage.app/o/session-thumbnails%2Ftwin-thieves-challenge.jpg?alt=media&token=' + tok1);
      const t2 = await vids('ADM', { action: 'thumb' });
      ok('tt-videos thumb: later calls reuse that copy (no download, nothing written)', t2.code === 200 && t2.body.created === false && t2.body.url === t1.body.url && fetched.length === 1);
      const before = filesTouched.length;
      const td = [await vids('T', { action: 'thumb' }), await vids('MSA', { action: 'thumb' }), await vids('NOPE', { action: 'thumb' }), await vids('ADM', { action: 'other' })];
      ok('tt-videos thumb: members, a Microsoft sign-in and a bad token are refused before Storage is touched; an unknown action is refused',
        td.map(r => r.code).join() === '403,403,401,400' && filesTouched.length === before && fetched.length === 1, td.map(r => r.code).join());
      delete saved[TP]; srcOk = false;
      const t3 = await vids('ADM', { action: 'thumb' });
      ok('tt-videos thumb: if HubSpot does not give an image, nothing is saved', t3.code === 502 && /HubSpot/.test(t3.body.error) && !saved[TP]);
      ok('tt-videos thumb: only that one path is ever opened', filesTouched.every(p => p === TP), filesTouched.join());
      global.fetch = realFetch; delete bucket.file;
      process.env.FIREBASE_PROJECT_ID = prev; if (prev === undefined) delete process.env.FIREBASE_PROJECT_ID;
    }
    {
      // Link videos from Storage, on the real 36 lesson names.
      const vt = new Function(line(/const TT_FUND_NAMES=[\s\S]*?;\n/) + line(/const TT_SEED=[\s\S]*?\]\];\n/)
        + html.slice(html.indexOf('const ttNameInput='), html.indexOf('/* A thumbnail link as a CSS url()'))
        + '\nreturn {TT_SEED,ttVideoPlan,ttVideoApply,ttVideoRevert,ttStoragePath,TT_VID_FOLDER_RE};')();
      const ids = vt.TT_SEED.map((_, i) => 'tt' + String(i + 1).padStart(2, '0'));
      const idOf = t => ids[vt.TT_SEED.findIndex(x => x[1] === t)];
      const lessons = vt.TT_SEED.map(([fund, title], i) => ({ id: ids[i], fund, title, videoUrl: '', thumbUrl: '', summary: 's' + i, discussion: ['d'], additional: [], handouts: [{ label: 'PDF', url: 'h' }] }))
        .concat([{ id: 'ttthanks', fund: 'thanks', title: 'Thank you!', closing: true, videoUrl: '', summary: 'thanks' }]);
      lessons[ids.indexOf(idOf('Trust Bank'))].videoUrl = 'https://www.youtube.com/watch?v=abcdefgh';
      lessons[ids.indexOf(idOf('Eat the Frog'))].thumbUrl = 'https://own/frog.jpg';
      const lib = { lessons, order36: ids.slice(), order10: ids.slice(0, 10), names: { '36': { [idOf('Be the Buffalo')]: 'Week 4: Be the Buffalo' } } };
      const copy = JSON.parse(JSON.stringify(lib));
      const F = 'twin-thieves-videos/', MB = 1048576;
      const files = [['Be_the_Buffalo.mp4', 210, 300], ['4_Steps_to_Be_the_Buffalo.mp4', 60, 300], ['08_Water_the_Bamboo.mov', 40, 240], ['Trust_Bank.mp4', 50, 300],
        ['Eat_the_Frog.mp4', 30, 200], ['Thank_You.mp4', 10, 60], ['Random_Outtakes.mp4', 20, 100], ['notes.txt', 1, 0]]
        .map(([name, mb, dur]) => ({ path: F + name, name, size: mb * MB, dur, url: 'https://firebasestorage.googleapis.com/v0/b/test-6b2ab.firebasestorage.app/o/' + encodeURIComponent(F + name) + '?alt=media&token=t' }));
      const urls = {}; files.forEach(f => { urls[f.path] = f.url; });
      const p = vt.ttVideoPlan(files, lib, {}), row = t => p.rows.find(r => r.id === (t === 'thanks' ? 'ttthanks' : idOf(t)));
      ok('videos: matched by file name to the right lesson ("Be_the_Buffalo.mp4" → "Be the Buffalo", not "4 Steps to Be the Buffalo")',
        row('Be the Buffalo').path === F + 'Be_the_Buffalo.mp4' && row('4 Steps to Be the Buffalo').path === F + '4_Steps_to_Be_the_Buffalo.mp4'
        && row('Water the Bamboo').path === F + '08_Water_the_Bamboo.mov' && row('thanks').path === F + 'Thank_You.mp4' && p.rows.length === 37,
        JSON.stringify(p.rows.filter(r => r.path).map(r => r.name + '=' + r.path)));
      ok('videos: a lesson that has a video is skipped and its file does not go to a neighbour ("Trust Bank" / "Trust Triangle")',
        row('Trust Bank').status === 'skip' && row('Trust Triangle').status === 'none' && !row('Trust Triangle').path);
      ok('videos: lessons with no file show none; unmatched files are listed; non-videos are ignored',
        p.rows.filter(r => r.status === 'none').length === 31 && p.unmatched.map(f => f.name).join() === 'Random_Outtakes.mp4' && p.files.length === 7);
      ok('videos: over 20 MB per minute is flagged', row('Be the Buffalo').heavy && !row('4 Steps to Be the Buffalo').heavy && row('Water the Bamboo').mov);
      ok('videos: the thumbnail goes only to linked lessons, and keeps a lesson\'s own unless replace is ticked',
        p.linking === 5 && p.thumbs === 4 && row('Eat the Frog').thumb === 'keep' && vt.ttVideoPlan(files, lib, { replaceThumbs: true }).thumbs === 5);
      const r = vt.ttVideoApply(lib, p, urls, 'https://copy/thumb.jpg');
      const keys = ['id', 'title', 'fund', 'summary', 'discussion', 'additional', 'handouts', 'closing'];
      ok('videos: Confirm sets only the video and thumbnail; text, names, handouts, order and fundamentals stay',
        r.lib.lessons.every((l, i) => keys.every(k => JSON.stringify(l[k]) === JSON.stringify(copy.lessons[i][k])))
        && JSON.stringify([r.lib.order36, r.lib.order10, r.lib.names]) === JSON.stringify([copy.order36, copy.order10, copy.names])
        && r.lib.lessons.find(l => l.id === idOf('Be the Buffalo')).videoUrl === urls[F + 'Be_the_Buffalo.mp4']
        && r.lib.lessons.find(l => l.id === idOf('Be the Buffalo')).thumbUrl === 'https://copy/thumb.jpg'
        && r.lib.lessons.find(l => l.id === idOf('Eat the Frog')).thumbUrl === 'https://own/frog.jpg'
        && r.lib.lessons.find(l => l.id === idOf('Trust Bank')).videoUrl === copy.lessons[ids.indexOf(idOf('Trust Bank'))].videoUrl
        && Object.keys(r.prev).length === 5 && JSON.stringify(lib) === JSON.stringify(copy));
      const again = vt.ttVideoPlan(files.concat([{ path: F + 'Eat_the_Frog_v2.mp4', name: 'Eat_the_Frog_v2.mp4', size: MB, dur: 60, url: 'u' }]), r.lib, {});
      ok('videos: running it again links nothing already linked', again.linking === 0 && row('Be the Buffalo') && again.rows.find(x => x.id === idOf('Be the Buffalo')).status === 'same',
        JSON.stringify(again.rows.filter(x => x.status === 'link').map(x => x.name)));
      ok('videos: "Replace existing videos" links over a lesson\'s video', vt.ttVideoPlan(files, lib, { replaceVideos: true }).rows.find(x => x.id === idOf('Trust Bank')).status === 'link');
      const pk = vt.ttVideoPlan(files, lib, { picks: { [idOf('Trust Triangle')]: F + 'Random_Outtakes.mp4', [idOf('Be the Buffalo')]: '' } });
      ok('videos: a dropdown choice wins, "No video" leaves a lesson out, one file for two lessons blocks',
        pk.rows.find(x => x.id === idOf('Trust Triangle')).path === F + 'Random_Outtakes.mp4' && pk.rows.find(x => x.id === idOf('Be the Buffalo')).status === 'none'
        && pk.unmatched.map(f => f.name).join() === 'Be_the_Buffalo.mp4'
        && vt.ttVideoPlan(files, lib, { picks: { tt01: F + 'Thank_You.mp4', tt02: F + 'Thank_You.mp4' } }).blockers.length === 1);
      const nl = vt.ttVideoPlan(files.map(f => f.name === 'Be_the_Buffalo.mp4' ? Object.assign({}, f, { url: null }) : f), lib, {});
      const sk = vt.ttVideoPlan(files, lib, { skipThumbs: true, replaceThumbs: true });
      ok('videos: "Skip thumbnails" links the videos and leaves every thumbnail as it is',
        sk.linking === 5 && sk.thumbs === 0 && vt.ttVideoApply(lib, sk, urls, '').lib.lessons.every((l, i) => (l.thumbUrl || '') === (copy.lessons[i].thumbUrl || '')));
      ok('videos: a file with no download link is shown but never linked',
        nl.rows.find(x => x.id === idOf('Be the Buffalo')).status === 'nourl' && nl.linking === 4
        && !vt.ttVideoApply(lib, nl, urls, 't').prev[idOf('Be the Buffalo')]);
      {
        const G1 = '36 Lesson Video Folder', G2 = '10 Lessons Video';
        const mk = (fo, name) => ({ folder: fo, path: fo + '/' + name, name, size: 30 * MB, dur: 300,
          url: 'https://firebasestorage.googleapis.com/v0/b/test-6b2ab.firebasestorage.app/o/' + encodeURIComponent(fo + '/' + name) + '?alt=media&token=t' });
        const two = [mk(G1, 'Be_the_Buffalo.mp4'), mk(G2, 'Be the Buffalo.mp4'), mk(G1, 'Eat_the_Frog.mp4'), mk(G2, 'Water the Bamboo.mp4')];
        const tp = vt.ttVideoPlan(two, lib, {}), tr = id => tp.rows.find(x => x.id === idOf(id));
        ok('videos: across both folders, each lesson gets its one file; a lesson found in both is "choose", not guessed',
          tr('Be the Buffalo').status === 'choose' && !tr('Be the Buffalo').path && tr('Be the Buffalo').alts.map(f => f.folder).join() === G1 + ',' + G2
          && tr('Eat the Frog').status === 'link' && tr('Water the Bamboo').status === 'link' && tp.linking === 2 && tp.choosing === 1 && !tp.unmatched.length,
          JSON.stringify(tp.rows.filter(x => x.status !== 'none').map(x => x.name + ':' + x.status)));
        const tk = vt.ttVideoPlan(two, lib, { picks: { [idOf('Be the Buffalo')]: G2 + '/Be the Buffalo.mp4' } });
        ok('videos: picking one of the two links it; the other file is then listed as matching nothing',
          tk.rows.find(x => x.id === idOf('Be the Buffalo')).status === 'link' && tk.rows.find(x => x.id === idOf('Be the Buffalo')).path === G2 + '/Be the Buffalo.mp4'
          && tk.unmatched.map(f => f.path).join() === G1 + '/Be_the_Buffalo.mp4' && tk.linking === 3);
        const tl = vt.ttVideoApply(lib, tk, Object.fromEntries(two.map(f => [f.path, f.url])), 't');
        const again2 = vt.ttVideoPlan(two, tl.lib, {});
        ok('videos: after linking one of the two, running again leaves that lesson as it is', again2.rows.find(x => x.id === idOf('Be the Buffalo')).status === 'same' && again2.linking === 0);
        ok('videos: both Storage folder names are Twin Thieves folders; the Playbook\'s are not',
          vt.TT_VID_FOLDER_RE.test(G1) && vt.TT_VID_FOLDER_RE.test(G2) && !['session-videos', 'session-thumbnails', 'challenge-videos', 'welcome-videos', 'learn-more', 'knowledge'].some(f => vt.TT_VID_FOLDER_RE.test(f)));
      }
      const edited = JSON.parse(JSON.stringify(r.lib)); edited.lessons.find(l => l.id === idOf('Be the Buffalo')).videoUrl = 'https://edited/later.mp4';
      ok('videos: Undo puts the previous videos and thumbnails back exactly, and keeps a video changed since',
        JSON.stringify(vt.ttVideoRevert(r.lib, r.prev)) === JSON.stringify(copy)
        && vt.ttVideoRevert(edited, r.prev).lessons.find(l => l.id === idOf('Be the Buffalo')).videoUrl === 'https://edited/later.mp4' && vt.ttStoragePath(urls[F + 'Thank_You.mp4']) === F + 'Thank_You.mp4');
      const scan = html.slice(html.indexOf('  /* POST /api/tt-videos (admins)'), html.indexOf('  ttOrgRec(id){'));
      ok('videos: admins only; listing and the thumbnail copy are /api/tt-videos\' (the browser writes nothing to Storage); writes only ttlib:master and its Undo (Undo first)',
        /v\.ttVidCan=s\.role==='admin'&&!editing;/.test(html) && /const s=this\.state; if\(s\.role!=='admin'\) return;/.test(scan)
        && /authFetch\('\/api\/tt-videos'/.test(scan) && /this\.ttVidApi\(\{folders\}\)/.test(scan) && /this\.ttVidApi\(\{action:'thumb'\}\)/.test(scan)
        && !/listAll|\.list\(|fbStorage|uploadMedia|ttImageCopy/.test(scan) && !/ttImageCopy/.test(html)
        && (scan.match(/sset\('([^']+)'/g) || []).every(x => /ttlib:(master|video-undo)/.test(x))
        && !/\.(delete|put|putString|updateMetadata)\(/.test(scan)
        && scan.indexOf("sset('ttlib:video-undo',undo)") < scan.indexOf("if(!(await sset('ttlib:master',out))) return stop(")
        && !vt.TT_VID_FOLDER_RE.test('session-videos') && !vt.TT_VID_FOLDER_RE.test('session-thumbnails') && !vt.TT_VID_FOLDER_RE.test('challenge-videos')
        && vt.TT_VID_FOLDER_RE.test('twin-thieves-videos') && vt.TT_VID_FOLDER_RE.test('TT36'));
    }
    const j1 = fs.readFileSync(path.join(ROOT, 'netlify/functions/join.js'), 'utf8'), j2 = fs.readFileSync(path.join(ROOT, 'netlify/functions/tt-join.js'), 'utf8');
    ok('logging: the temporary sign-in error logs are gone', !/verify', e && e\.code, e && e\.message/.test(j1 + j2));
  }

  // ---- /api/tt-video: a short-lived link to a lesson video, for Twin Thieves members only. ----
  {
    const st = makeStore(), signed = [], buckets = [];
    const B = 'test-6b2ab.firebasestorage.app';
    const fb = (bk, p) => 'https://firebasestorage.googleapis.com/v0/b/' + bk + '/o/' + encodeURIComponent(p) + '?alt=media&token=tok';
    st.docs['jj_playbook/ttlib:master'] = V({ order36: ['tt01', 'tt02', 'tt03', 'tt05'], order10: ['tt02'], lessons: [
      { id: 'tt01', videoUrl: fb(B, '36 Lesson Video Folder/Be the Buffalo.mp4') },
      { id: 'tt02', videoUrl: fb(B, '10 Lessons Video/Water the Bamboo.mp4') },
      { id: 'tt03', videoUrl: 'https://youtu.be/abcdefghijk' },
      { id: 'tt05', videoUrl: fb('someone-else.appspot.com', 'x/y.mp4') },
      { id: 'tt09', videoUrl: fb(B, '../x.mp4') },
      { id: 'ttthanks', closing: true, videoUrl: fb(B, '36 Lesson Video Folder/Thank you.mp4') }] });
    st.docs['ttmembers/m36@s.org'] = { email: 'm36@s.org', orgs: ['TT36'] };
    st.docs['ttmembers/m10@s.org'] = { email: 'm10@s.org', orgs: ['TT10'] };
    st.docs['ttmembers/gone@s.org'] = { email: 'gone@s.org', orgs: [] };
    st.docs['members/pb@s.org'] = { email: 'pb@s.org', orgs: ['PLAYBOOK26'] };
    const users = { M36: U('m36@s.org'), M10: U('m10@s.org'), G: U('gone@s.org'), PB: U('pb@s.org'), ADM: U('charlie@jadin-jones.com'),
      MS: U('m36@s.org', 'microsoft.com'), UV: Object.assign(U('m36@s.org'), { email_verified: false }) };
    const prev = process.env.FIREBASE_PROJECT_ID; process.env.FIREBASE_PROJECT_ID = 'test-6b2ab';
    const tv = async (tok, body) => { const h = loadFn('tt-video.js', st, users);
      require.cache[path.join(ROOT, 'netlify/lib/firebase-admin.js')].exports.admin.storage = () => ({ bucket: n => { buckets.push(n);
        return { file: p => ({ getSignedUrl: async o => { signed.push({ p, o }); return ['https://storage.googleapis.com/' + n + '/' + encodeURIComponent(p) + '?X-Goog-Expires=14400&X-Goog-Signature=s']; } }) }; } });
      const r = await call(h, tok, body); return { code: r.statusCode, body: JSON.parse(r.body) }; };
    const t0 = Date.now(), a = await tv('M36', { lesson: 'tt01' });
    ok('tt-video: a TT36 member gets a 4-hour signed link to their lesson\'s own file (v4, read only), in this project\'s bucket',
      a.code === 200 && /^https:\/\/storage\.googleapis\.com\//.test(a.body.url) && signed.length === 1 && signed[0].p === '36 Lesson Video Folder/Be the Buffalo.mp4'
      && signed[0].o.version === 'v4' && signed[0].o.action === 'read' && Math.abs(signed[0].o.expires - (t0 + 4 * 3600000)) < 5000
      && a.body.expiresAt === signed[0].o.expires && buckets.every(b => b === B), JSON.stringify(a.body) + JSON.stringify(signed));
    const b10 = [await tv('M10', { lesson: 'tt02' }), await tv('M10', { lesson: 'tt01' }), await tv('M10', { lesson: 'ttthanks' })];
    ok('tt-video: a TT10 member gets only their version\'s lessons (and the closing Thank you!)', b10.map(r => r.code).join() === '200,403,200', b10.map(r => r.code).join());
    const n0 = signed.length;
    const no = [await tv('G', { lesson: 'tt01' }), await tv('PB', { lesson: 'tt01' }), await tv('MS', { lesson: 'tt01' }), await tv('UV', { lesson: 'tt01' }), await tv('NOPE', { lesson: 'tt01' })];
    ok('tt-video: a removed member, a Playbook-only member, an unconfirmed Microsoft sign-in, an unverified email and a bad token get nothing',
      no.map(r => r.code).join() === '403,403,403,403,401' && signed.length === n0, no.map(r => r.code).join());
    const other = [await tv('M36', { lesson: 'tt03' }), await tv('M36', { lesson: 'tt05' }), await tv('ADM', { lesson: 'tt09' })];
    ok('tt-video: a YouTube link, another bucket\'s file or a path with ".." is never signed (url null: the app plays its own link)',
      other.every(r => r.code === 200 && r.body.url === null) && signed.length === n0, JSON.stringify(other.map(r => r.body)));
    const adm = await tv('ADM', { lesson: 'tt02' }), bad = [await tv('M36', { lesson: '../etc' }), await tv('M36', { lesson: 'tt77' }), await tv('M36', { path: 'session-videos/x.mp4' })];
    ok('tt-video: an admin may ask for any lesson (Preview as a member); a caller never names a file; an unknown lesson is refused',
      adm.code === 200 && !!adm.body.url && bad.map(r => r.code).join() === '400,404,400' && signed.length === n0 + 1, bad.map(r => r.code).join());
    ok('tt-video: nothing is written (only the rate limit\'s own count); the download tokens are never touched',
      st.writes.every(w => /^rateLimits\//.test(w)) && !/setMetadata|makePublic|delete\(|save\(/.test(fs.readFileSync(path.join(ROOT, 'netlify/functions/tt-video.js'), 'utf8')), st.writes.join());
    process.env.FIREBASE_PROJECT_ID = prev; if (prev === undefined) delete process.env.FIREBASE_PROJECT_ID;
    // The real SDK signs a v4 link with the service account's own key, with no call out (a made-up key here).
    {
      const crypto = require('crypto'), { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
      const fa = require(path.join(ROOT, 'node_modules/firebase-admin'));
      const app = fa.initializeApp({ credential: fa.credential.cert({ projectId: 'p-test', clientEmail: 'sa@p-test.iam.gserviceaccount.com', privateKey }) }, 'sign-test-' + Date.now());
      let u = ''; try { [u] = await app.storage().bucket('p-test.firebasestorage.app').file('36 Lesson Video Folder/Be the Buffalo.mp4').getSignedUrl({ version: 'v4', action: 'read', expires: Date.now() + 4 * 3600000 }); } catch (e) { u = 'ERR ' + e.message; }
      await app.delete().catch(() => {});
      ok('tt-video: the Admin SDK signs it locally, read-only, for 4 hours (X-Goog-Expires=14400)',
        /^https:\/\/storage\.googleapis\.com\/p-test\.firebasestorage\.app\/36%20Lesson%20Video%20Folder\/Be%20the%20Buffalo\.mp4\?X-Goog-Algorithm=GOOG4-RSA-SHA256&/.test(u) && /X-Goog-Expires=14400&/.test(u), u.slice(0, 160));
    }
    // The app: the Twin Thieves player and its links.
    const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
    let main = ''; try { main = execSync('git show origin/main:public/index.html', { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 }).toString(); } catch (e) {}
    const ttv = (html.match(/<video data-ttp="1"[^>]*>/g) || []);
    ok('player: the lesson video has no browser controls (no ⋮ menu, no Download), nodownload, no remote playback; right-click is blocked',
      ttv.length === 1 && !/ controls=/.test(ttv[0]) && /controlslist="nodownload noplaybackrate noremoteplayback"/.test(ttv[0]) && /disableremoteplayback=/.test(ttv[0])
      && !/disable-picture-in-picture|disablepictureinpicture/i.test(ttv[0]) && /document\.addEventListener\('contextmenu',e=>\{ if\(boxOf\(e\.target\)\) e\.preventDefault\(\); \},true\);/.test(html));
    ok('player: its own bar has play, seek, time, mute, speed (1x, 1.25x, 1.5x, 2x), Picture in Picture and full screen',
      /const TTP_SPEEDS=\[1,1\.25,1\.5,2\];/.test(html) && ['play', 'mute', 'speed', 'pip', 'full'].every(a => (html.match(new RegExp('data-ttp-act="' + a + '"', 'g')) || []).length >= 1)
      && /data-ttp-seek="1"/.test(html) && /data-ttp-time="1"/.test(html));
    // Every video on the platform (the Playbook's too) has the same player: our bar, no browser controls.
    const vids = html.match(/<video\s[^>]*>/g) || [];
    const boxes = (html.match(/<div data-ttp-box="1"[^>]*>/g) || []).length, bars = (html.match(/<div data-ttp-bar="1" role="group" aria-label="Video controls">/g) || []).length;
    ok('player: every video on the platform (Twin Thieves lessons; the Playbook\'s session, more, challenge and welcome videos) has the same bar and no browser controls, Download or "Save video as"',
      vids.length === 5 && vids.every(v => /data-ttp="1"/.test(v) && !/ controls=|disable-picture-in-picture|disablepictureinpicture/i.test(v) && /controlslist="nodownload noplaybackrate noremoteplayback"/.test(v))
      && boxes === 5 && bars === 5 && ['Session video player', 'Challenge video player', 'Welcome video player', 'Lesson video player'].every(l => html.indexOf('aria-label="' + l + '"') > 0),
      vids.length + ' videos, ' + boxes + ' boxes, ' + bars + ' bars');
    ok('player: the Playbook\'s own player code is as it was (the refs still set the source, start on the tap, and catch errors; the welcome video keeps its own first-play button)',
      ['{{ item.videoRef }}', '{{ mv.ref }}', '{{ item.chvRef }}', '{{ welcomeRef }}'].every(r => vids.some(v => v.indexOf('ref="' + r + '"') > 0))
      && /el\.onerror=\(\)=>this\.setState\(\{vidErr:/.test(html) && /el\.src=media;/.test(html) && /chvRef:el=>\{ if\(!el\|\|el\.dataset\.jjWired\) return; el\.dataset\.jjWired='1';/.test(html)
      && /v\.welcomeRef=el=>\{ this\._welcomeVid=el;/.test(html) && /<button sc-camel-on-click="\{\{ onWelcomePlay \}\}" aria-label="Play"/.test(html)
      && (html.match(/<audio\b[^>]*controls=/g) || []).length === 2);
    const lk = html.slice(html.indexOf('  ttVideoLinkFor(l){'), html.indexOf('  ttToggleDone(id){'));
    ok('links (app): a Storage file plays from /api/tt-video; the preview, a failed or broken signed link and any other link use the library\'s own link; nothing saved',
      !!lk && /authFetch\('\/api\/tt-video'/.test(lk) && /if\(!own\|\|this\.state\.ttDemo\|\|this\._ttSignedBroken\) return \{src:l\.videoUrl\};/.test(lk)
      && /return \{src:k\.url\|\|l\.videoUrl\}/.test(lk) && !/sset\(|localStorage/.test(lk) && (html.match(/\/api\/tt-video'/g) || []).length === 1);
  }

  console.log(bad ? bad + ' of ' + n + ' FAILED' : 'ALL ' + n + ' PASSED');
  process.exit(bad ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
