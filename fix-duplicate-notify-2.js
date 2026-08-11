#!/usr/bin/env node
/* JJ Playbook — duplicate notifications, done narrowly.
   Rewinds the blunt patch, then removes ONLY the app's duplicate alerts for the
   three things the server already announces: sessions, updates, chat messages.
   Everything the server does not send keeps working exactly as before —
   peer responses, the 5 S's and daily tool nudges, Start Up / Shut Down
   routines, new content releases, deep-work blocks.
   Also re-applies the sign-in placeholder wording.

   Run from the jjplaybook2 folder:   node fix-duplicate-notify-2.js
*/
const fs = require('fs');
const path = require('path');

const FILE = path.join('public', 'index.html');
const DUPE_BAK = FILE + '.backup-dupe';

if (!fs.existsSync(FILE)) {
  console.error('Cannot find ' + FILE + '. Run this from the jjplaybook2 folder.');
  process.exit(1);
}

/* ---- 0. rewind the blunt patch ----------------------------------------- */
if (fs.existsSync(DUPE_BAK)) {
  fs.copyFileSync(DUPE_BAK, FILE);
  console.log('Rewound the blunt patch from ' + DUPE_BAK);
} else if (fs.readFileSync(FILE, 'utf8').indexOf('/*jj-no-dupe*/') >= 0) {
  console.error('The blunt patch is in but its backup is gone. Tell Claude.');
  process.exit(1);
}

let src = fs.readFileSync(FILE, 'utf8');
const before = src;
const lines = before.split('\n').length;

if (src.indexOf('feedToast') >= 0) {
  console.log('Already patched — nothing to do.');
  process.exit(0);
}

/* ---- 1. a toast-only helper, defined next to localNotify --------------- */
const at = src.search(/(async\s+)?localNotify\s*\(/);
if (at < 0) {
  console.error('Could not find localNotify(). Nothing changed.');
  process.exit(1);
}
const HELPER = 'feedToast(title){ this.toast(title); } ';
src = src.slice(0, at) + HELPER + src.slice(at);

/* ---- 2. point the two feed watchers at it ------------------------------ */
const SITES = [
  [/fresh\.forEach\(x=>this\.localNotify\(/, 'fresh.forEach(x=>this.feedToast('],
  [/fresh\.forEach\(m=>this\.localNotify\(/, 'fresh.forEach(m=>this.feedToast(']
];
let hits = 0;
for (const [re, to] of SITES) {
  if (!re.test(src)) continue;
  src = src.replace(re, to);
  hits++;
}
if (hits === 0) {
  console.error('Could not find the feed watchers. Nothing written.');
  process.exit(1);
}

/* ---- 3. sign-in placeholder wording ----------------------------------- */
const PH = [
  [/(jf\('Organization code','joinCode',')[^']*(')/, 'Enter your team code'],
  [/(jf\('First name','joinFirst',')[^']*(')/,       'Enter your first name'],
  [/(jf\('Last name','joinLast',')[^']*(')/,         'Enter your last name'],
  [/(jf\('Email','joinEmail',')[^']*(')/,            'Enter your email address']
];
let phHits = 0;
for (const [re, text] of PH) {
  if (!re.test(src)) continue;
  src = src.replace(re, (m, a, b) => a + text + b);
  phHits++;
}

/* ---- 4. safety checks -------------------------------------------------- */
if (src.split('\n').length !== lines) {
  console.error('Line count changed — would break the pack. Nothing written.');
  process.exit(1);
}
if (src === before) {
  console.error('Nothing changed. Nothing written.');
  process.exit(1);
}

fs.writeFileSync(FILE + '.backup-narrow', before);
fs.writeFileSync(FILE, src);
console.log('Patched ' + FILE);
console.log('  • ' + hits + ' of 2 feed watchers now show an in-app banner only');
console.log('  • server sends the one lock-screen alert, with the group name');
console.log('  • tool, activity, peer and routine nudges untouched');
console.log('  • ' + phHits + ' of 4 sign-in placeholders reworded');
console.log('Backup saved as ' + FILE + '.backup-narrow');
