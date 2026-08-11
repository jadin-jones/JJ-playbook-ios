#!/usr/bin/env node
/* JJ Playbook — stay signed in.
   The saved session can be evicted by the phone while the remembered leader
   survives; the app was then parking people on the "Welcome back → Continue"
   screen. This signs them straight back in, so only an explicit Sign out ever
   shows the gate again.

   Run from the jjplaybook2 folder:   node fix-stay-signed-in.js
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

if (src.indexOf('/*jj-auto-resume*/') >= 0) {
  console.log('Already patched — nothing to do.');
  process.exit(0);
}

// The line that gives up and shows the gate.
const GATE = /this\.setState\(\{booting:false,view:'gate',known,joinCode:known\?known\.code:''\}\);/;
if (!GATE.test(src)) {
  console.error('Could not find the gate fallback. Nothing changed — tell Claude.');
  process.exit(1);
}

const AUTO = "/*jj-auto-resume*/if(known&&known.code&&known.idkey){ const okk=await this.loadLeader(known.code,known.idkey,known.name,known.email); if(okk) return; }";

src = src.replace(GATE, (m) => AUTO + m);

if (src.split('\n').length !== lines) {
  console.error('Line count changed — would break the pack. Nothing written.');
  process.exit(1);
}
if (src === before) {
  console.error('Nothing changed. Nothing written.');
  process.exit(1);
}

fs.writeFileSync(FILE + '.backup-signin', before);
fs.writeFileSync(FILE, src);
console.log('Patched ' + FILE);
console.log('  • reopening the app goes straight to the playbook home screen');
console.log('  • the sign-in screen only appears for new people or after Sign out');
console.log('Backup saved as ' + FILE + '.backup-signin');
console.log('Check it locally first:  open ' + FILE);
