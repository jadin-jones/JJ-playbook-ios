/**
 * JJ Playbook — push notifications
 * ---------------------------------------------------------------------------
 * The app writes everything into ONE Firestore collection, `jj_playbook`,
 * as documents whose id is the storage key and whose body is `{value: "<json>"}`.
 * The keys these functions care about:
 *
 *   updates:<CODE>            JSON array of {id,title,body,createdAt}
 *   events:<CODE>             JSON array of {id,title,description,startsAt,zoomLink,group}
 *   chat:<CODE>               {messages:[{id,body,authorName,authorIdkey,createdAt}]}  (not a JSON string)
 *   resp:<CODE>:<IDKEY>       JSON object for one leader, incl. {smallGroup:'g1'|'g2'|'both'|''}
 *   push:<IDKEY>              JSON object {token,name,code,idkey,at}
 *
 * Nothing here changes the app. Deploy it and the Enable button in Settings
 * starts producing real lock-screen notifications.
 */
const {onCall, HttpsError} = require('firebase-functions/v2/https');
const {onDocumentWritten} = require('firebase-functions/v2/firestore');
const {onSchedule} = require('firebase-functions/v2/scheduler');
const {setGlobalOptions} = require('firebase-functions/v2');
const {defineSecret} = require('firebase-functions/params');
const nodemailer = require('nodemailer');
const crypto = require('crypto');
const admin = require('firebase-admin');

/* SMTP connection string, stored as a Firebase secret — never in this file.
   See PUSH-SETUP.md step 6 for how to set it. */
const SMTP_URL = defineSecret('SMTP_URL');
const ADMIN_EMAIL = 'Charlie@jadin-jones.com';
const MAIL_FROM = 'JJ Playbook <no-reply@jadin-jones.com>';

admin.initializeApp();
setGlobalOptions({region: 'us-central1', maxInstances: 10});

const COLL = 'jj_playbook';

/* ===== ADMIN AUTHORISATION ==================================================
   Admin used to be a string compiled into the page, which meant anyone who
   opened View Source was an admin. It is now a custom claim on the account,
   granted only to addresses on this list and only after the address has been
   verified by Firebase. The list is the single source of truth and lives here,
   on the server, where a browser cannot read it. */
const ADMIN_EMAILS = [
  'charlie@jadin-jones.com',
];

function isAdminEmail(email) {
  return ADMIN_EMAILS.indexOf(String(email || '').trim().toLowerCase()) >= 0;
}

/** Called by the app after sign-in. Stamps the admin claim if it is deserved
    and strips it if it is not, so revoking access is just an edit here. */
exports.claimAdmin = onCall(async (req) => {
  const auth = req.auth;
  if (!auth) throw new HttpsError('unauthenticated', 'Sign in first.');
  const email = (auth.token.email || '').toLowerCase();
  if (!auth.token.email_verified) {
    throw new HttpsError('failed-precondition', 'Verify your email address first.');
  }
  const should = isAdminEmail(email);
  const has = auth.token.admin === true;
  if (should !== has) {
    await admin.auth().setCustomUserClaims(auth.uid, should ? {admin: true} : {});
    await audit(should ? 'admin.granted' : 'admin.revoked', email, {uid: auth.uid});
  }
  return {admin: should, refresh: should !== has};
});

/* ===== ONE-TIME LOGIN CODES =================================================
   Every sign-in, leader and administrator alike, is proved by a six-digit code
   sent to the address being claimed. Nobody gets in by typing someone else's
   email any more.

   What is stored is a salted SHA-256 of the code, never the code itself, so the
   database cannot be read to log in as anyone. Codes last two minutes, are
   single-use, and are destroyed on the first correct answer.

   Guessing is bounded from both ends: five wrong answers burns the code, and a
   given address can only ask for five codes an hour. Six digits inside a
   two-minute window with five attempts is a 1-in-200,000 shot per code. */
const CODE_TTL_MS = 2 * 60 * 1000;
const CODE_MAX_TRIES = 5;
const CODE_MAX_PER_HOUR = 5;

function hashCode(code, salt) {
  return crypto.createHash('sha256').update(salt + ':' + code).digest('hex');
}

/* Rejects sequences a person would guess first (000000, 123456, 111111) rather
   than trusting six random digits to never land on one. */
function makeCode() {
  for (;;) {
    const n = crypto.randomInt(0, 1000000);
    const s = String(n).padStart(6, '0');
    if (/^(\d)\1{5}$/.test(s)) continue;
    if ('0123456789012345'.indexOf(s) >= 0) continue;
    return s;
  }
}

function codeDocId(email) {
  return 'logincode:' + crypto.createHash('sha256')
    .update(String(email || '').trim().toLowerCase()).digest('hex').slice(0, 32);
}

exports.requestLoginCode = onCall({secrets: [SMTP_URL]}, async (req) => {
  const email = String((req.data && req.data.email) || '').trim().toLowerCase();
  if (!/.+@.+\..+/.test(email)) {
    throw new HttpsError('invalid-argument', 'Enter a valid email address.');
  }

  const ref = db.collection(COLL).doc(codeDocId(email));
  const now = Date.now();
  const prev = await ref.get();
  let asked = [];
  if (prev.exists) {
    try { asked = (JSON.parse(prev.data().value).asked || []); } catch (e) { asked = []; }
  }
  asked = asked.filter((t) => now - t < 60 * 60 * 1000);
  if (asked.length >= CODE_MAX_PER_HOUR) {
    throw new HttpsError('resource-exhausted',
      'Too many codes requested. Try again in an hour.');
  }

  const code = makeCode();
  const salt = crypto.randomBytes(16).toString('hex');
  asked.push(now);

  await ref.set({value: JSON.stringify({
    email: email,
    salt: salt,
    hash: hashCode(code, salt),
    expires: now + CODE_TTL_MS,
    tries: 0,
    asked: asked,
  })});

  await mailTo(email, 'Your JJ Playbook sign-in code', [
    'Your sign-in code is ' + code,
    '',
    'It expires in two minutes and can only be used once.',
    'If you did not ask to sign in, ignore this email — nobody can get in without the code.',
  ]);

  /* The same answer whether or not an account exists, so this cannot be used to
     find out who is enrolled. */
  return {sent: true, expiresIn: Math.round(CODE_TTL_MS / 1000)};
});

exports.verifyLoginCode = onCall(async (req) => {
  const email = String((req.data && req.data.email) || '').trim().toLowerCase();
  const code = String((req.data && req.data.code) || '').replace(/\D/g, '');
  if (!/.+@.+\..+/.test(email) || code.length !== 6) {
    throw new HttpsError('invalid-argument', 'Enter the six-digit code.');
  }

  const ref = db.collection(COLL).doc(codeDocId(email));
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Ask for a new code.');

  let rec;
  try { rec = JSON.parse(snap.data().value); } catch (e) { rec = null; }
  if (!rec) throw new HttpsError('not-found', 'Ask for a new code.');

  if (Date.now() > rec.expires) {
    await ref.delete();
    throw new HttpsError('deadline-exceeded', 'That code has expired. Ask for a new one.');
  }
  if ((rec.tries || 0) >= CODE_MAX_TRIES) {
    await ref.delete();
    throw new HttpsError('resource-exhausted', 'Too many wrong tries. Ask for a new code.');
  }

  /* Constant-time compare so the response time cannot be used to learn the
     code a digit at a time. */
  const got = Buffer.from(hashCode(code, rec.salt));
  const want = Buffer.from(rec.hash);
  const ok = got.length === want.length && crypto.timingSafeEqual(got, want);

  if (!ok) {
    rec.tries = (rec.tries || 0) + 1;
    await ref.set({value: JSON.stringify(rec)});
    throw new HttpsError('permission-denied',
      'That code is not right. ' + (CODE_MAX_TRIES - rec.tries) + ' tries left.');
  }

  await ref.delete();          // single use

  /* The address is now proven, so the account is created or found and marked
     verified. Admin rights are decided here, never by the client. */
  let user;
  try {
    user = await admin.auth().getUserByEmail(email);
  } catch (e) {
    user = await admin.auth().createUser({email: email, emailVerified: true});
  }
  if (!user.emailVerified) {
    await admin.auth().updateUser(user.uid, {emailVerified: true});
  }

  const shouldAdmin = isAdminEmail(email);
  if (shouldAdmin !== (user.customClaims && user.customClaims.admin === true)) {
    await admin.auth().setCustomUserClaims(user.uid, shouldAdmin ? {admin: true} : {});
  }

  await audit('login.verified', email, {uid: user.uid, admin: shouldAdmin});

  const token = await admin.auth().createCustomToken(user.uid,
    shouldAdmin ? {admin: true} : {});
  return {token: token, admin: shouldAdmin};
});

/* ===== AUDIT TRAIL ==========================================================
   Every privileged action leaves a record. Written server-side so it cannot be
   edited or suppressed from the browser, and kept for a year alongside
   everything else. */
async function audit(action, actor, detail) {
  try {
    await db.collection('jj_audit').add({
      action: action,
      actor: String(actor || 'unknown'),
      detail: detail || {},
      at: Date.now(),
      atISO: new Date().toISOString(),
    });
  } catch (e) {
    console.error('audit failed', action, e);
  }
}

/** The app calls this for anything privileged instead of checking a password
    locally. Nothing is trusted from the client except the payload itself. */
exports.adminAction = onCall(async (req) => {
  const auth = req.auth;
  if (!auth || auth.token.admin !== true) {
    await audit('admin.denied', (auth && auth.token.email) || 'anonymous',
      {action: (req.data || {}).action});
    throw new HttpsError('permission-denied', 'Admin access required.');
  }
  const {action, key, value} = req.data || {};
  if (!action || !key) throw new HttpsError('invalid-argument', 'Missing action or key.');

  const ref = db.collection(COLL).doc(String(key));
  if (action === 'set') {
    await ref.set({value: JSON.stringify(value)});
  } else if (action === 'delete') {
    await ref.delete();
  } else {
    throw new HttpsError('invalid-argument', 'Unknown action.');
  }
  await audit('content.' + action, auth.token.email, {key: String(key)});
  return {ok: true};
});

/* ===== RETENTION ============================================================
   Personal data is kept for one year past a cohort's last activity, then
   deleted. Runs nightly. Anything the purge removes is recorded in the audit
   trail, which is itself trimmed to the same horizon. */
const RETAIN_MS = 365 * 24 * 60 * 60 * 1000;

exports.purgeExpired = onSchedule('every day 03:00', async () => {
  const cutoff = Date.now() - RETAIN_MS;
  const snap = await db.collection(COLL).get();
  let gone = 0;
  let batch = db.batch();
  let n = 0;

  for (const d of snap.docs) {
    // Only personal records expire. Course content and org settings stay.
    if (d.id.indexOf('resp:') !== 0 && d.id.indexOf('pr:') !== 0 &&
        d.id.indexOf('peer:') !== 0 && d.id.indexOf('push:') !== 0) continue;
    const v = parseValue(d);
    const last = v && (v.lastOpenAt || v.updatedAt || v.at || v.createdAt || v.joinedAt);
    if (!last || last > cutoff) continue;
    batch.delete(d.ref);
    gone++; n++;
    if (n >= 400) { await batch.commit(); batch = db.batch(); n = 0; }
  }
  if (n) await batch.commit();

  const old = await db.collection('jj_audit').where('at', '<', cutoff).limit(400).get();
  if (!old.empty) {
    const ab = db.batch();
    old.docs.forEach((d) => ab.delete(d.ref));
    await ab.commit();
  }

  if (gone) await audit('retention.purge', 'system', {removed: gone});
  console.log('purgeExpired removed=' + gone);
});

/* ===== SUBJECT ACCESS =======================================================
   A person can take everything we hold on them, and can ask for it to be
   erased. Both are requirements under GDPR and CCPA and both are questions a
   security review will ask out loud. */
exports.exportMyData = onCall(async (req) => {
  const auth = req.auth;
  if (!auth) throw new HttpsError('unauthenticated', 'Sign in first.');
  const key = slugEmail(auth.token.email);
  const snap = await db.collection(COLL).get();
  const out = {};
  snap.docs.forEach((d) => {
    if (d.id.indexOf(':' + key) < 0 && d.id.indexOf('push:' + key) !== 0) return;
    out[d.id] = parseValue(d);
  });
  await audit('data.export', auth.token.email, {documents: Object.keys(out).length});
  return {exportedAt: new Date().toISOString(), data: out};
});

exports.deleteMyData = onCall(async (req) => {
  const auth = req.auth;
  if (!auth) throw new HttpsError('unauthenticated', 'Sign in first.');
  const key = slugEmail(auth.token.email);
  const snap = await db.collection(COLL).get();
  const batch = db.batch();
  let gone = 0;
  snap.docs.forEach((d) => {
    if (d.id.indexOf(':' + key) < 0 && d.id.indexOf('push:' + key) !== 0) return;
    batch.delete(d.ref);
    gone++;
  });
  if (gone) await batch.commit();
  await audit('data.erasure', auth.token.email, {removed: gone});
  try { await admin.auth().deleteUser(auth.uid); } catch (e) { console.error(e); }
  return {removed: gone};
});

function slugEmail(email) {
  return String(email || '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}


/* Who gets the "someone joined" alert. A device is treated as a coach's if the
   name it registered with matches, if its idkey is listed, or if that person's
   `resp:` record is flagged orgLead in the roster. Lowercase everything. */
const ADMIN_NAMES = ['charlie'];
const ADMIN_IDKEYS = [];   // optional: paste an idkey from a push: doc for an exact match
const db = admin.firestore();
const messaging = admin.messaging();

const GROUP_LABEL = {
  all: 'Leadership Training',
  g1: 'Small Group #1',
  g2: 'Small Group #2',
};

/* ---------- storage helpers (mirror the app's sget/sset shape) ---------- */

function parseValue(snap) {
  if (!snap || !snap.exists) return null;
  const d = snap.data() || {};
  if (typeof d.value !== 'string') return null;
  try { return JSON.parse(d.value); } catch (e) { return null; }
}

function listFrom(snap) {
  const v = parseValue(snap);
  return Array.isArray(v) ? v : [];
}

/** Everything added to `after` that wasn't in `before`, matched on `id`. */
function newItems(beforeSnap, afterSnap) {
  const before = listFrom(beforeSnap);
  const after = listFrom(afterSnap);
  const seen = new Set(before.map((x) => x && x.id));
  return after.filter((x) => x && x.id && !seen.has(x.id));
}

/* ---------- audience ---------- */

/**
 * Every push token registered against an org code, optionally narrowed to a
 * session group. Tokens are stored per person (`push:<idkey>`) and carry the
 * code they signed up with; the group lives on their `resp:` doc.
 */
/* One read of the whole collection, filtered in code. The Admin SDK rejects
   inequality queries on documentId(), and this collection is small enough that
   a full read costs nothing. */
async function tokensFor(code, group, exclude) {
  const snap = await db.collection(COLL).get();

  // Who belongs to this org, and which monthly group they are in.
  const groupOf = {};
  snap.docs.forEach((d) => {
    if (d.id.indexOf('resp:' + code + ':') !== 0) return;
    const r = parseValue(d);
    if (r && r.idkey) groupOf[r.idkey] = r.smallGroup || '';
  });

  const all = snap.docs
    .filter((d) => d.id.indexOf('push:') === 0)
    .map((d) => parseValue(d))
    .filter((p) => p && p.token);

  /* A device counts as "on this code" if the token says so OR if the person it
     belongs to has a record under this code. Coaches often enable notifications
     from the admin side, where the token gets saved with no code at all. */
  let regs = all.filter((p) =>
    p.code === code || Object.prototype.hasOwnProperty.call(groupOf, p.idkey));

  const g = group || 'all';
  if (g !== 'all') {
    regs = regs.filter((p) => {
      const mine = groupOf[p.idkey];
      if (mine === undefined) return true;   // coach / not on the roster: still tell them
      return mine === 'both' || mine === g;
    });
  }

  /* Never notify the person who caused the notification. Match on idkey first,
     and fall back to the name — a device that enabled notifications from the
     admin side stores a different idkey than the one on their chat messages. */
  if (exclude) {
    const exName = (exclude.name || '').trim().toLowerCase();
    regs = regs.filter((p) => {
      if (exclude.idkey && p.idkey === exclude.idkey) return false;
      if (exName && (p.name || '').trim().toLowerCase() === exName) return false;
      return true;
    });
  }

  console.log('audience code=' + code + ' group=' + g + ' registered=' + all.length +
    ' roster=' + Object.keys(groupOf).length + ' matched=' + regs.length);

  // De-dupe: one person can have several devices, but not the same token twice.
  return Array.from(new Set(regs.map((p) => p.token)));
}

/** Push tokens belonging to the coaches — used for the join alert. */
async function adminTokens() {
  const snap = await db.collection(COLL).get();

  const leadIdkeys = new Set();
  snap.docs.forEach((d) => {
    if (d.id.indexOf('resp:') !== 0) return;
    const r = parseValue(d);
    if (r && r.idkey && r.orgLead) leadIdkeys.add(r.idkey);
  });

  const tokens = snap.docs
    .filter((d) => d.id.indexOf('push:') === 0)
    .map((d) => parseValue(d))
    .filter((p) => {
    if (!p || !p.token) return false;
    const name = (p.name || '').toLowerCase();
    return ADMIN_IDKEYS.indexOf(p.idkey) >= 0 ||
      leadIdkeys.has(p.idkey) ||
      ADMIN_NAMES.some((n) => name.indexOf(n) >= 0);
  }).map((p) => p.token);

  return Array.from(new Set(tokens));
}

/** Plain-text email to the coach. Silently skips if SMTP isn't configured. */
/** Send to a named recipient. `email()` below always writes to the office. */
async function mailTo(to, subject, lines) {
  let url = '';
  try { url = SMTP_URL.value(); } catch (e) { url = ''; }
  if (!url) {
    /* Without SMTP nobody could ever sign in, so this has to be loud. */
    console.error('CANNOT SEND LOGIN CODE — SMTP_URL is not set');
    throw new HttpsError('failed-precondition',
      'Email is not configured yet. Contact your program lead.');
  }
  await nodemailer.createTransport(url).sendMail({
    from: MAIL_FROM,
    to: to,
    subject: subject,
    text: lines.join('\n'),
  });
}

async function email(subject, lines) {
  let url = '';
  try { url = SMTP_URL.value(); } catch (e) { url = ''; }
  if (!url) { console.log('email skipped — SMTP_URL not set'); return; }
  try {
    await nodemailer.createTransport(url).sendMail({
      from: MAIL_FROM,
      to: ADMIN_EMAIL,
      subject,
      text: lines.join('\n'),
    });
    console.log('emailed', subject);
  } catch (e) {
    console.error('email failed', e);
  }
}

/* ---------- send ---------- */

/* Where the app lives. `fcmOptions.link` must be an absolute https URL — FCM
   rejects a relative path with invalid-argument, and the whole send fails. */
const SITE_URL = 'https://jjplaybook.netlify.app';
const absolute = (u) => {
  const p = String(u || '/');
  if (/^https?:\/\//i.test(p)) return p;
  return SITE_URL.replace(/\/+$/, '') + (p.charAt(0) === '/' ? p : '/' + p);
};

async function push(tokens, {title, body, url, go}) {
  if (!tokens.length) { console.log('PUSH SKIPPED - no devices - ' + title); return 0; }
  const link = absolute(url);
  let sent = 0;
  const dead = [];

  for (let i = 0; i < tokens.length; i += 500) {
    const batch = tokens.slice(i, i + 500);
    /* Web push only — no apns/android blocks. A web registration token rejects
       platform configs meant for native apps. */
    const res = await messaging.sendEachForMulticast({
      tokens: batch,
      notification: {title, body},
      data: {url: link, go: go || ''},
      webpush: {
        notification: {
          title,
          body,
          icon: '/assets/icon-192.png',
          badge: '/assets/icon-192.png',
          tag: 'jj-playbook',
        },
        fcmOptions: {link},
        data: {url: link, go: go || ''},
      },
    });
    res.responses.forEach((r, n) => {
      if (r.success) { sent++; return; }
      const code = (r.error && r.error.code) || 'unknown';
      console.log('SEND FAILED ' + code + ' :: ' + ((r.error && r.error.message) || ''));
      /* Only retire a token FCM has actually disowned. invalid-argument means
         the PAYLOAD was wrong — pruning on it deletes healthy devices and makes
         a code bug look like everyone unsubscribing. */
      if (code === 'messaging/registration-token-not-registered' ||
          code === 'messaging/invalid-registration-token') dead.push(batch[n]);
    });
  }

  if (dead.length) await pruneTokens(dead);
  console.log('PUSH SENT ' + sent + ' of ' + tokens.length + ' pruned=' + dead.length);
  return sent;
}

/** Drop `push:` docs whose token FCM has retired, so the list stays clean. */
async function pruneTokens(tokens) {
  const kill = new Set(tokens);
  const snap = await db.collection(COLL).get();
  const batch = db.batch();
  snap.docs.forEach((d) => {
    if (d.id.indexOf('push:') !== 0) return;
    const p = parseValue(d);
    if (p && kill.has(p.token)) batch.delete(d.ref);
  });
  await batch.commit();
}

function whenText(ts) {
  const d = new Date(ts);
  return d.toLocaleString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZone: 'America/Chicago',
  });
}

/* ---------- triggers ---------- */

/** A coach posts a follow-up in Studio → everyone on that code. */
exports.onUpdatePosted = onDocumentWritten(COLL + '/{docId}', async (event) => {
  const id = event.params.docId;
  if (!id.startsWith('updates:')) return;
  const code = id.slice('updates:'.length);
  const fresh = newItems(event.data.before, event.data.after);
  if (!fresh.length) return;

  const tokens = await tokensFor(code, 'all');
  for (const u of fresh) {
    await push(tokens, {
      title: u.title || 'New from your coach',
      body: (u.body || '').slice(0, 160),
      url: '/?go=updates', go: 'updates',
    });
  }
});

/** A coach schedules a session → only the group it is for. */
exports.onSessionScheduled = onDocumentWritten(COLL + '/{docId}', async (event) => {
  const id = event.params.docId;
  if (!id.startsWith('events:')) return;
  const code = id.slice('events:'.length);
  const fresh = newItems(event.data.before, event.data.after);
  if (!fresh.length) return;

  for (const e of fresh) {
    const g = e.group || 'all';
    const tokens = await tokensFor(code, g);
    await push(tokens, {
      title: GROUP_LABEL[g] || 'Session scheduled',
      body: (e.title || 'New session') + ' — ' + whenText(e.startsAt),
      url: '/?go=events', go: 'events',
    });
  }
});

/** New chat message → everyone on the code except the author. */
exports.onChatMessage = onDocumentWritten(COLL + '/{docId}', async (event) => {
  const id = event.params.docId;
  if (!id.startsWith('chat:')) return;
  const code = id.slice('chat:'.length);

  const before = ((event.data.before.data() || {}).messages) || [];
  const after = ((event.data.after.data() || {}).messages) || [];
  const seen = new Set(before.map((m) => m && m.id));
  const fresh = after.filter((m) => m && m.id && !seen.has(m.id));
  if (!fresh.length) return;

  // One notification for the batch, not one per message.
  const last = fresh[fresh.length - 1];
  const authors = Array.from(new Set(fresh.map((m) => m.authorName).filter(Boolean)));

  const tokens = await tokensFor(code, 'all',
    {idkey: last.authorIdkey, name: last.authorName});

  await push(tokens, {
    title: authors.length > 1 ? 'Group chat' : ((last.authorName || 'Teammate') + ' — group chat'),
    body: fresh.length > 1
      ? fresh.length + ' new messages'
      : (last.body || 'Sent a photo').slice(0, 160),
    url: '/?go=chat', go: 'chat',
  });
});

/** Someone signs up with an access code → tell the coaches. */
exports.onLeaderJoined = onDocumentWritten(
  {document: COLL + '/{docId}', secrets: [SMTP_URL]},
  async (event) => {
    const id = event.params.docId;
    if (!id.startsWith('resp:')) return;
    if (event.data.before.exists) return;           // only a brand-new record

    const parts = id.split(':');                    // resp:<CODE>:<IDKEY>
    const code = parts[1] || '';
    const r = parseValue(event.data.after);
    if (!r || !r.name || r.idkey === '__preview__') return;

    const orgSnap = await db.collection(COLL).doc('org:' + code).get();
    const org = parseValue(orgSnap) || {};
    const orgName = org.name || code;

    await push(await adminTokens(), {
      title: 'New leader joined',
      body: r.name + ' just signed up for ' + orgName +
        (r.email ? ' (' + r.email + ')' : ''),
      url: '/?go=members', go: 'members',
    });

    await email(r.name + ' joined ' + orgName, [
      r.name + ' just signed up for the Championship Teams Playbook.',
      '',
      'Name:         ' + r.name,
      'Email:        ' + (r.email || '—'),
      'Organization: ' + orgName,
      'Access code:  ' + code,
      'Joined:       ' + whenText(r.joinedAt || Date.now()),
      '',
      'They are in the roster now — assign their small group in Studio.',
    ]);
  });

/* ---------- daily activity reminders ---------- */

/**
 * The app writes a `schedule` array onto each `push:<idkey>` doc — one entry
 * per daily activity, each with its own local time and an on/off flag. Nothing
 * read it until now, so those reminders only fired while the app was open.
 *
 * This runs every five minutes, converts "now" into each person's own timezone,
 * and sends anything whose time has just passed. A `remindmark:` doc per
 * person/activity/day/time stops it repeating — move the reminder to a new time
 * and it fires again at that time, even if the old one already went out today.
 */
function localNow(tz) {
  const parts = {};
  new Intl.DateTimeFormat('en-CA', {
    timeZone: tz || 'America/Chicago',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date()).forEach((p) => { parts[p.type] = p.value; });
  const hour = Number(parts.hour) % 24;          // some ICU builds say "24"
  return {
    date: parts.year + '-' + parts.month + '-' + parts.day,
    minutes: hour * 60 + Number(parts.minute),
  };
}

function hhmmToMinutes(v) {
  const p = String(v || '').split(':');
  const h = Number(p[0]);
  const m = Number(p[1]);
  if (!isFinite(h) || !isFinite(m)) return null;
  return h * 60 + m;
}

/* Which tool each schedule entry is really about. `fiveS` is deliberately
   absent — it spans several pinned actions, so it always sends. */
/* Start Up and Shut Down share one tool but are two separate promises: opening
   the day well says nothing about closing it. Each entry carries which half it
   was, so each reminder checks only its own. */
const REMIND_TOOL = {
  su: {tool: 'routine', which: 'su'},
  sd: {tool: 'routine', which: 'sd'},
  deep: {tool: 'deepwork'},
};

/** Did they already log this tool today, in their own timezone? */
function localDayOf(ts, tz) {
  const parts = {};
  new Intl.DateTimeFormat('en-CA', {
    timeZone: tz || 'America/Chicago',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(ts)).forEach((p) => { parts[p.type] = p.value; });
  return parts.year + '-' + parts.month + '-' + parts.day;
}
function loggedToday(resp, toolId, tz, todayDate, which) {
  const hist = (resp && resp.tools && resp.tools[toolId] &&
    resp.tools[toolId].history) || [];
  return hist.some((h) => {
    if (!h) return false;
    if (which && h.which !== which) return false;
    const ts = h.ts || Date.parse(h.date);
    return ts ? localDayOf(ts, tz) === todayDate : false;
  });
}

exports.dailyReminders = onSchedule('every 5 minutes', async () => {
  const snap = await db.collection(COLL).get();

  const resps = {};
  snap.docs.forEach((d) => {
    if (d.id.indexOf('resp:') !== 0) return;
    const r = parseValue(d);
    if (r && r.idkey) resps[r.idkey] = r;
  });

  let fired = 0;
  for (const doc of snap.docs) {
    if (doc.id.indexOf('push:') !== 0) continue;
    const rec = parseValue(doc);
    if (!rec || !rec.token || !Array.isArray(rec.schedule)) continue;

    const tz = rec.tz || 'America/Chicago';
    const now = localNow(tz);
    const resp = resps[rec.idkey];

    for (const item of rec.schedule) {
      if (!item || !item.on) continue;
      const due = hhmmToMinutes(item.time);
      if (due === null) continue;

      /* Fire once the minute has passed, within a ten-minute grace window so a
         late run still delivers. No wrap across midnight — a 23:58 reminder
         missed by a slow run waits for tomorrow rather than arriving at 00:03
         stamped with the wrong day. */
      const since = now.minutes - due;
      if (since < 0 || since >= 10) continue;

      /* A coach does not ask you to do a thing you have already done. The
         routines go quiet once they are logged; the 5 S's always asks, because
         it covers several pinned actions and "done" is ambiguous. */
      const rt = REMIND_TOOL[item.key];
      if (rt && resp &&
          loggedToday(resp, rt.tool, tz, now.date, rt.which)) continue;

      /* The mark carries the time it was sent for, so moving a reminder to a
         new time on the same day is treated as a new reminder and delivers
         again. Re-saving the same time still sends only once. */
      const markRef = db.collection(COLL)
        .doc('remindmark:' + rec.idkey + ':' + item.key + ':' + now.date +
             ':' + String(item.time).replace(/[^0-9]/g, ''));
      const mark = await markRef.get();
      if (mark.exists) continue;
      await markRef.set({value: JSON.stringify({sentAt: Date.now()})});

      const sent = await push([rec.token], {
        title: item.title || 'JJ Playbook',
        body: item.body || '',
        url: '/?go=' + encodeURIComponent(item.go || ''), go: item.go || '',
      });
      if (sent) fired++;
    }
  }
  /* The app reads this whole collection on every load, so spent markers cannot
     be allowed to pile up. Anything older than two days goes. */
  const cutoff = Date.now() - 2 * 24 * 60 * 60 * 1000;
  const stale = snap.docs.filter((d) => {
    if (d.id.indexOf('logincode:') === 0) {
      const v = parseValue(d);
      /* An hour past expiry, so the rate-limit history still means something
         for a while after the code itself dies. */
      return !!(v && v.expires && v.expires < Date.now() - 60 * 60 * 1000);
    }
    /* Only the day-keyed markers are safe to sweep. `awaymark:`, `unlockmark:`,
       `dwinvitemark:` and `milemark:` are the memory that stops a milestone
       being celebrated twice, so they stay. They are one small doc per person
       per occasion. */
    const marker = ['remindmark:', 'pushmark:', 'weekmark:', 'streakmark:']
      .some((p) => d.id.indexOf(p) === 0);
    if (!marker) return false;
    const v = parseValue(d);
    return v && v.sentAt && v.sentAt < cutoff;
  });
  if (stale.length) {
    const batch = db.batch();
    stale.slice(0, 400).forEach((d) => batch.delete(d.ref));
    await batch.commit();
    console.log('pruned ' + Math.min(stale.length, 400) + ' spent markers');
  }

  console.log('dailyReminders fired=' + fired);
});


/* ---------- the coach's cadence ----------
   Three sweeps that are not daily. Each runs hourly and only acts inside one
   hour of the person's own local day, so nothing lands at 3am, and each writes
   a marker so an hourly run can never send twice. */

const DAY_MS = 24 * 60 * 60 * 1000;

/** The local weekday, 0=Sunday, in someone's own timezone. */
function localDow(tz) {
  const s = new Intl.DateTimeFormat('en-US', {
    timeZone: tz || 'America/Chicago', weekday: 'short',
  }).format(new Date());
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(s);
}

/** Send once per person per marker id. Returns true if this call owns the send. */
async function claimMark(id) {
  const ref = db.collection(COLL).doc(id);
  const got = await ref.get();
  if (got.exists) return false;
  await ref.set({value: JSON.stringify({sentAt: Date.now()})});
  return true;
}

/**
 * Friday, 4pm local. Not a demand — a read-back of the week they just had.
 * This is the one that makes the app feel like someone is paying attention.
 */
exports.weeklyReview = onSchedule('every 60 minutes', async () => {
  const snap = await db.collection(COLL).get();
  let fired = 0;

  for (const doc of snap.docs) {
    if (doc.id.indexOf('push:') !== 0) continue;
    const rec = parseValue(doc);
    if (!rec || !rec.token) continue;
    const away = rec.away || {};
    if (away.weekly === false) continue;

    const tz = rec.tz || 'America/Chicago';
    const now = localNow(tz);
    if (localDow(tz) !== 5) continue;
    if (now.minutes < 16 * 60 || now.minutes >= 17 * 60) continue;

    if (!await claimMark('weekmark:' + rec.idkey + ':' + now.date)) continue;

    const streak = Number(rec.streak) || 0;
    const body = streak >= 2
      ? streak + ' days running. Take two minutes, score today, and carry it into the weekend.'
      : 'Score today and next week starts from something instead of nothing.';
    const sent = await push([rec.token], {
      title: 'The week you had',
      body: body,
      url: '/?go=' + encodeURIComponent('fund:energy'), go: 'fund:energy',
    });
    if (sent) fired++;
  }
  console.log('weeklyReview fired=' + fired);
});

/**
 * 8pm local, and only when there is something to lose: a streak of three or
 * more with nothing logged today. One save attempt, never a second.
 */
exports.streakSave = onSchedule('every 60 minutes', async () => {
  const snap = await db.collection(COLL).get();
  let fired = 0;

  for (const doc of snap.docs) {
    if (doc.id.indexOf('push:') !== 0) continue;
    const rec = parseValue(doc);
    if (!rec || !rec.token) continue;
    if ((rec.away || {}).streak === false) continue;
    if ((Number(rec.streak) || 0) < 3) continue;

    const tz = rec.tz || 'America/Chicago';
    const now = localNow(tz);
    if (now.minutes < 20 * 60 || now.minutes >= 21 * 60) continue;

    /* Opening the app is how anything gets logged, so a launch today means the
       day is already handled. Cheap, and it never nags someone who showed up. */
    if (rec.lastOpenAt && localDayOf(rec.lastOpenAt, tz) === now.date) continue;

    if (!await claimMark('streakmark:' + rec.idkey + ':' + now.date)) continue;

    const sent = await push([rec.token], {
      title: (Number(rec.streak) || 0) + ' days on the line',
      body: 'Two minutes keeps it alive. Score your 5 S’s before the day closes.',
      url: '/?go=' + encodeURIComponent('fund:energy'), go: 'fund:energy',
    });
    if (sent) fired++;
  }
  console.log('streakSave fired=' + fired);
});

/**
 * A new fundamental opens each month from the organization's start date. This
 * catches the day it turns and says so, at 9am local — the "what's next" that
 * keeps a twelve-month program from feeling like the same week on repeat.
 */
exports.monthlyUnlock = onSchedule('every 60 minutes', async () => {
  const snap = await db.collection(COLL).get();

  const orgs = {};
  snap.docs.forEach((d) => {
    if (d.id.indexOf('org:') !== 0) return;
    const o = parseValue(d);
    if (o && o.code) orgs[o.code] = o;
  });

  let fired = 0;
  for (const doc of snap.docs) {
    if (doc.id.indexOf('push:') !== 0) continue;
    const rec = parseValue(doc);
    if (!rec || !rec.token || !rec.code) continue;
    if ((rec.away || {}).unlock === false) continue;

    const org = orgs[rec.code];
    if (!org || !org.startDate) continue;

    const tz = rec.tz || 'America/Chicago';
    const now = localNow(tz);
    if (now.minutes < 9 * 60 || now.minutes >= 10 * 60) continue;

    /* The app unlocks on thirty-day steps from the start date, so the program
       month turns whenever that count goes up. Only the first twelve matter. */
    const elapsed = Date.now() - org.startDate;
    if (elapsed < 30 * DAY_MS) continue;
    const monthNo = Math.floor(elapsed / (30 * DAY_MS));
    if (monthNo < 1 || monthNo > 11) continue;
    /* Fire only on the day the step is crossed, not every day after. */
    if (elapsed - monthNo * 30 * DAY_MS >= DAY_MS) continue;

    if (!await claimMark('unlockmark:' + rec.idkey + ':' + monthNo)) continue;

    const sent = await push([rec.token], {
      title: 'Month ' + (monthNo + 1) + ' is open',
      body: 'A new fundamental just unlocked in your playbook. Take a look at what is next.',
      url: '/', go: '',
    });
    if (sent) fired++;
  }
  console.log('monthlyUnlock fired=' + fired);
});


/**
 * Deep Work is the one practice nobody adopts because a settings toggle told
 * them to. So it is not a daily reminder — it is an invitation, sent once a
 * month at 9am local, to people far enough along to be ready for it and who
 * have never run a block. It stops the moment they run one, and it stops
 * anyway after the third ask. Nobody gets talked into this four times.
 */
exports.deepWorkInvite = onSchedule('every 60 minutes', async () => {
  const snap = await db.collection(COLL).get();

  const orgs = {};
  const resps = {};
  snap.docs.forEach((d) => {
    if (d.id.indexOf('org:') === 0) {
      const o = parseValue(d); if (o && o.code) orgs[o.code] = o; return;
    }
    if (d.id.indexOf('resp:') === 0) {
      const r = parseValue(d); if (r && r.idkey) resps[r.idkey] = r;
    }
  });

  let fired = 0;
  for (const doc of snap.docs) {
    if (doc.id.indexOf('push:') !== 0) continue;
    const rec = parseValue(doc);
    if (!rec || !rec.token || !rec.code) continue;

    const tz = rec.tz || 'America/Chicago';
    const now = localNow(tz);
    if (now.minutes < 9 * 60 || now.minutes >= 10 * 60) continue;

    /* Month two at the earliest. Asking someone to defend ninety minutes in
       their first fortnight is how the whole idea gets dismissed. */
    const org = orgs[rec.code];
    if (!org || !org.startDate) continue;
    const monthNo = Math.floor((Date.now() - org.startDate) / (30 * DAY_MS));
    if (monthNo < 1 || monthNo > 11) continue;

    /* Already doing it? Then there is nothing to invite them to. */
    const resp = resps[rec.idkey];
    const dw = (resp && resp.tools && resp.tools.deepwork &&
      resp.tools.deepwork.history) || [];
    if (dw.length) continue;

    /* Three asks, spread a month apart, then it lets go. */
    const asks = monthNo - 1;
    if (asks > 2) continue;
    if (!await claimMark('dwinvitemark:' + rec.idkey + ':' + monthNo)) continue;

    const sent = await push([rec.token], {
      title: 'Start your Deep Work session today',
      body: 'Ninety minutes, one thing, nothing else. The block is in your toolkit whenever you are ready to defend it.',
      url: '/?go=' + encodeURIComponent('tool:deepwork'), go: 'tool:deepwork',
    });
    if (sent) fired++;
  }
  console.log('deepWorkInvite fired=' + fired);
});


/* ---------- saying well done ----------
   Everything above asks something. These two only ever report good news, and
   they are the reason the app reads as a coach rather than a timer. */

/**
 * A fundamental just went from unfinished to finished. Fires off the leader's
 * own record, so it lands within seconds of the last question being submitted.
 */
exports.onFundamentalDone = onDocumentWritten(COLL + '/{docId}', async (event) => {
  const id = event.params.docId;
  if (!id.startsWith('resp:')) return;

  const before = event.data.before.exists ? parseValue(event.data.before) : null;
  const after = event.data.after.exists ? parseValue(event.data.after) : null;
  if (!after || !after.idkey) return;

  const pb = (before && before.progress) || {};
  const pa = after.progress || {};
  const done = (p, itemId) => !!(p[itemId] && p[itemId].submittedAt);
  /* Cheapest possible early exit: nothing was submitted, nothing to celebrate. */
  if (Object.keys(pa).length === Object.keys(pb).length) return;

  const progDoc = await db.collection(COLL).doc('program:master').get();
  if (!progDoc.exists) return;
  let program = null;
  try { program = JSON.parse((progDoc.data() || {}).value || 'null'); } catch (e) { return; }
  const mods = (program && program.modules) || [];
  if (!mods.length) return;

  const finished = [];
  mods.forEach((m) => {
    const items = (m.items || []).filter((it) => it.enabled !== false);
    if (!items.length) return;
    const wasDone = items.every((it) => done(pb, it.id));
    const nowDone = items.every((it) => done(pa, it.id));
    if (!wasDone && nowDone) finished.push(m);
  });
  if (!finished.length) return;

  /* Push records are keyed 'push:<code>:<idkey>' so one person can be enrolled
     in two programs. Fall back to the legacy 'push:<idkey>' for records written
     before that change. */
  let pushDoc = await db.collection(COLL)
    .doc('push:' + (after.code || '') + ':' + after.idkey).get();
  if (!pushDoc.exists) {
    pushDoc = await db.collection(COLL).doc('push:' + after.idkey).get();
  }
  if (!pushDoc.exists) return;
  const rec = parseValue(pushDoc);
  if (!rec || !rec.token) return;

  const litCount = mods.filter((m) => {
    const items = (m.items || []).filter((it) => it.enabled !== false);
    return items.length && items.every((it) => done(pa, it.id));
  }).length;

  const m = finished[0];
  const body = litCount >= mods.length
    ? 'That is the whole pyramid. Every fundamental, start to finish.'
    : m.name + ' is done \u2014 learned, led and reflected on. ' + litCount +
      ' of ' + mods.length + ' lit.';
  await push([rec.token], {
    title: 'Fundamental complete',
    body: body,
    url: '/', go: '',
  });
});

/**
 * Streak milestones and a real move on the assessment. Swept hourly, delivered
 * inside the 9am hour so praise arrives at the start of a day rather than the
 * end of one. Each milestone is claimed once and never repeats.
 */
const STREAK_MILES = [7, 30, 60, 100, 200, 365];

exports.celebrations = onSchedule('every 60 minutes', async () => {
  const snap = await db.collection(COLL).get();

  const resps = {};
  snap.docs.forEach((d) => {
    if (d.id.indexOf('resp:') !== 0) return;
    const r = parseValue(d);
    if (r && r.idkey) resps[r.idkey] = r;
  });

  let fired = 0;
  for (const doc of snap.docs) {
    if (doc.id.indexOf('push:') !== 0) continue;
    const rec = parseValue(doc);
    if (!rec || !rec.token) continue;

    const tz = rec.tz || 'America/Chicago';
    const now = localNow(tz);
    if (now.minutes < 9 * 60 || now.minutes >= 10 * 60) continue;

    /* Streak milestones. The app writes its own best streak onto the push doc
       every launch, so no history has to be replayed here. */
    const streak = Number(rec.streak) || 0;
    const hit = STREAK_MILES.filter((n) => streak >= n).pop();
    if (hit && await claimMark('milemark:' + rec.idkey + ':streak' + hit)) {
      const sent = await push([rec.token], {
        title: hit + ' days in a row',
        body: hit >= 100
          ? 'A hundred days is not motivation any more. That is who you are now.'
          : 'Most people quit in the first month. You did not. Keep it going.',
        url: '/', go: '',
      });
      if (sent) { fired++; continue; }
    }

    /* A real move against their own baseline — not noise, five points or more. */
    const resp = resps[rec.idkey];
    const takes = ((resp && resp.assessments) || []).slice()
      .sort((a, b) => (a.ts || 0) - (b.ts || 0));
    if (takes.length >= 2) {
      const first = takes[0], last = takes[takes.length - 1];
      const gain = (Number(last.total) || 0) - (Number(first.total) || 0);
      if (gain >= 5 && await claimMark('milemark:' + rec.idkey + ':score' + last.total)) {
        const sent = await push([rec.token], {
          title: 'Up ' + gain + ' points',
          body: 'Your assessment moved from ' + first.total + ' to ' + last.total +
            ' since you started. That is evidence, not a feeling.',
          url: '/', go: '',
        });
        if (sent) fired++;
      }
    }
  }
  console.log('celebrations fired=' + fired);
});

/* ---------- coming back ---------- */

/**
 * Three days quiet, then a week, then once a week after that. The app stamps
 * `lastOpenAt` on every launch, so opening the app is what resets the ladder —
 * nothing to clear, nothing to unsubscribe from.
 *
 * Runs hourly and only sends inside the 9am hour in the person's own timezone,
 * so a nudge about yesterday never arrives at 3am. The marker carries the
 * absence it belongs to, so the next absence starts the ladder over.
 */
const AWAY_COPY = {
  3: {title: 'Three days off the board',
    body: 'Your 5 S’s are two minutes. Score today and the average starts telling the truth again.'},
  7: {title: 'A week without a score',
    body: 'Nothing to catch up on — just today. Score your 5 S’s and you are back in it.'},
  weekly: {title: 'Still here when you are',
    body: 'One honest 5 S’s score today is worth more than a perfect week later.'},
};

exports.awayNudges = onSchedule('every 60 minutes', async () => {
  const snap = await db.collection(COLL).get();
  let fired = 0;

  for (const doc of snap.docs) {
    if (doc.id.indexOf('push:') !== 0) continue;
    const rec = parseValue(doc);
    if (!rec || !rec.token || !rec.lastOpenAt) continue;

    const tz = rec.tz || 'America/Chicago';
    const now = localNow(tz);
    if (now.minutes < 9 * 60 || now.minutes >= 10 * 60) continue;

    const days = Math.floor((Date.now() - rec.lastOpenAt) / (24 * 60 * 60 * 1000));
    if (days < 3) continue;

    /* 3 covers days 3–6, 7 covers 7–13, then every seventh day. */
    const step = days < 7 ? 3 : 7 * Math.floor(days / 7);
    const away = rec.away || {};
    if (step === 3 && away.d3 === false) continue;
    if (step === 7 && away.d7 === false) continue;
    if (step > 7 && away.weekly === false) continue;

    const markRef = db.collection(COLL)
      .doc('awaymark:' + rec.idkey + ':' + rec.lastOpenAt + ':' + step);
    const mark = await markRef.get();
    if (mark.exists) continue;
    await markRef.set({value: JSON.stringify({sentAt: Date.now()})});

    const copy = AWAY_COPY[step] || AWAY_COPY.weekly;
    const sent = await push([rec.token], {
      title: copy.title, body: copy.body,
      url: '/?go=' + encodeURIComponent('fund:energy'), go: 'fund:energy',
    });
    if (sent) fired++;
  }

  console.log('awayNudges fired=' + fired);
});

/**
 * Hourly reminder sweep. Anything starting in the next 60–120 minutes gets one
 * "starts soon" push; a marker doc keeps it from firing twice.
 */
exports.sessionReminders = onSchedule('every 60 minutes', async () => {
  const now = Date.now();
  const from = now + 60 * 60 * 1000;
  const to = now + 120 * 60 * 1000;

  const snap = await db.collection(COLL).get();

  for (const doc of snap.docs) {
    if (doc.id.indexOf('events:') !== 0) continue;
    const code = doc.id.slice('events:'.length);
    const events = listFrom(doc);
    for (const e of events) {
      if (!e || !e.startsAt || e.startsAt < from || e.startsAt > to) continue;
      const markRef = db.collection(COLL).doc('pushmark:' + code + ':' + e.id);
      const mark = await markRef.get();
      if (mark.exists) continue;

      const g = e.group || 'all';
      const tokens = await tokensFor(code, g);
      await push(tokens, {
        title: (e.title || 'Session') + ' starts soon',
        body: (GROUP_LABEL[g] || '') + ' · ' + whenText(e.startsAt) +
          (e.zoomLink ? ' · Tap to join' : ''),
        url: '/?go=events', go: 'events',
      });
      await markRef.set({value: JSON.stringify({sentAt: now})});
    }
  }
});
