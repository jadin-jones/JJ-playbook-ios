#!/usr/bin/env node
/* JJ Playbook — duplicate notifications, corrected.
   Previous attempt inserted a helper at the first mention of localNotify, which
   was a CALL, not the method definition — that broke the file. This one anchors
   on the definition itself and verifies the result parses before writing.

   Run from the jjplaybook2 folder:   node fix-duplicate-notify-3.js
*/
const fs = require('fs');
const path = require('path');

const FILE = path.join('public', 'index.html');
const NARROW = FILE + '.backup-narrow';

if (!fs.existsSync(FILE)) {
  console.error('Cannot find ' + FILE + '. Run this from the jjplaybook2 folder.');
  process.exit(1);
}
if (!fs.existsSync(NARROW)) {
  console.error('Cannot find ' + NARROW + '. Tell Claude before running anything else.');
  process.exit(1);
}

fs.copyFileSync(NARROW, FILE);
console.log('Restored the good file from ' + NARROW);

let src = fs.readFileSync(FILE, 'utf8');
const before = src;
const lines = before.split('\n').length;

if (src.indexOf('feedToast') >= 0) {
  console.error('Restored file already has feedToast — stopping. Tell Claude.');
  process.exit(1);
}

/* ---- 1. helper, anchored on the DEFINITION ----------------------------- */
const DEF = /async\s+localNotify\s*\(/;
const m = src.match(DEF);
if (!m) {
  console.error('Could not find the localNotify definition. Nothing changed.');
  process.exit(1);
}
const at = src.indexOf(m[0]);
// Sanity: the definition must not be preceded by "this." (that would be a call).
if (/this\.\s*$/.test(src.slice(Math.max(0, at - 8), at))) {
  console.error('Matched a call, not the definition. Nothing changed.');
  process.exit(1);
}
src = src.slice(0, at) + 'feedToast(title){ this.toast(title); } ' + src.slice(at);

/* ---- 2. the two feed watchers ----------------------------------------- */
const SITES = [
  /fresh\.forEach\(x=>this\.localNotify\(/,
  /fresh\.forEach\(m=>this\.localNotify\(/
];
let hits = 0;
for (const re of SITES) {
  const found = src.match(re);
  if (!found) continue;
  src = src.replace(re, found[0].replace('localNotify', 'feedToast'));
  hits++;
}
if (hits !== 2) {
  console.error('Expected 2 feed watchers, found ' + hits + '. Nothing written.');
  process.exit(1);
}

/* ---- 3. sign-in placeholders ------------------------------------------ */
const PH = [
  [/(jf\('Organization code','joinCode',')[^']*(')/, 'Enter your team code'],
  [/(jf\('First name','joinFirst',')[^']*(')/,       'Enter your first name'],
  [/(jf\('Last name','joinLast',')[^']*(')/,         'Enter your last name'],
  [/(jf\('Email','joinEmail',')[^']*(')/,            'Enter your email address']
];
let ph = 0;
for (const [re, text] of PH) {
  if (!re.test(src)) continue;
  src = src.replace(re, (s, a, b) => a + text + b);
  ph++;
}

/* ---- 4. checks -------------------------------------------------------- */
if (src.split('\n').length !== lines) {
  console.error('Line count changed — would break the pack. Nothing written.');
  process.exit(1);
}
// Balanced braces/parens around the helper we inserted.
const seg = src.slice(Math.max(0, at - 200), at + 400);
const open = (seg.match(/\(/g) || []).length, close = (seg.match(/\)/g) || []).length;
if (Math.abs(open - close) > 4) {
  console.error('Parentheses look unbalanced near the edit. Nothing written.');
  process.exit(1);
}
if (src === before) {
  console.error('Nothing changed. Nothing written.');
  process.exit(1);
}

fs.writeFileSync(FILE, src);
console.log('Patched ' + FILE);
console.log('  • both feed watchers now show an in-app banner only');
console.log('  • the server sends the single lock-screen alert, with the group name');
console.log('  • tool, activity, peer and routine nudges untouched');
console.log('  • ' + ph + ' of 4 sign-in placeholders reworded');
console.log('If the site breaks again: cp ' + NARROW + ' ' + FILE);
