#!/usr/bin/env node
/* JJ Playbook — notification fix, part 2.
   Adds the sign-in hook the first script couldn't find: once we know who is
   signed in, write this device's push token for them.

   Run from the jjplaybook2 folder:   node fix-notifications-2.js
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

if (src.indexOf('refreshPushToken') < 0) {
  console.error('Run fix-notifications.js first.');
  process.exit(1);
}
if (src.indexOf('/*jj-signin-hook*/') >= 0) {
  console.log('Already hooked — nothing to do.');
  process.exit(0);
}

const ADD = '/*jj-signin-hook*/this.resumePush().catch(()=>{});';

// Try the likely call sites in order of preference. We only patch the FIRST
// match, and never the method definitions themselves.
const CANDIDATES = [
  /this\.claimPushForThisDevice\(\)\s*\.catch\([^)]*\)\s*;/,
  /this\.claimPushForThisDevice\(\)\s*;/,
  /this\.syncReminderPrefs\(\)\s*\.catch\([^)]*\)\s*;/,
  /this\.syncReminderPrefs\(\)\s*;/,
  /this\.scheduleFiveS\(\)\s*;/
];

let done = null;
for (const re of CANDIDATES) {
  const m = src.match(re);
  if (!m) continue;
  src = src.replace(re, m[0] + ADD);
  done = m[0];
  break;
}

if (!done || src === before) {
  console.error('Could not find a sign-in call site. Nothing changed — tell Claude.');
  process.exit(1);
}

fs.writeFileSync(FILE + '.backup2', before);
fs.writeFileSync(FILE, src);
console.log('Patched ' + FILE);
console.log('  • token now written right after sign-in, hooked onto: ' + done.trim());
console.log('Backup saved as ' + FILE + '.backup2');
