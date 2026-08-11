#!/usr/bin/env node
/* JJ Playbook — sign-in placeholder wording.
   Replaces the sample-name placeholders on the sign-in form with instructions.
   Safe for the packed file: single-line strings only, no line breaks added.

   Run from the jjplaybook2 folder:   node fix-placeholders.js
*/
const fs = require('fs');
const path = require('path');

const FILE = path.join('public', 'index.html');
if (!fs.existsSync(FILE)) {
  console.error('Cannot find ' + FILE + '. Run this from the jjplaybook2 folder.');
  process.exit(1);
}

let src = fs.readFileSync(FILE, 'utf8');
const before = src;
const lines = before.split('\n').length;

const EDITS = [
  [/(jf\('Organization code','joinCode',')[^']*(')/, 'Enter your team code'],
  [/(jf\('First name','joinFirst',')[^']*(')/,       'Enter your first name'],
  [/(jf\('Last name','joinLast',')[^']*(')/,         'Enter your last name'],
  [/(jf\('Email','joinEmail',')[^']*(')/,            'Enter your email address']
];

let hits = 0;
for (const [re, text] of EDITS) {
  if (!re.test(src)) continue;
  src = src.replace(re, (m, a, b) => a + text + b);
  hits++;
}

if (hits === 0) {
  console.error('Could not find the sign-in fields — this build words them differently.');
  console.error('Nothing changed. Tell Claude.');
  process.exit(1);
}
if (src.split('\n').length !== lines) {
  console.error('Line count changed — would break the pack. Nothing written.');
  process.exit(1);
}
if (src === before) {
  console.error('Nothing changed.');
  process.exit(1);
}

fs.writeFileSync(FILE + '.backup-ph', before);
fs.writeFileSync(FILE, src);
console.log('Patched ' + FILE + ' — ' + hits + ' of 4 placeholders updated');
console.log('Backup saved as ' + FILE + '.backup-ph');
