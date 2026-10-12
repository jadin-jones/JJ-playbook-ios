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
    const j1 = fs.readFileSync(path.join(ROOT, 'netlify/functions/join.js'), 'utf8'), j2 = fs.readFileSync(path.join(ROOT, 'netlify/functions/tt-join.js'), 'utf8');
    ok('logging: the temporary sign-in error logs are gone', !/verify', e && e\.code, e && e\.message/.test(j1 + j2));
  }

  console.log(bad ? bad + ' of ' + n + ' FAILED' : 'ALL ' + n + ' PASSED');
  process.exit(bad ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
