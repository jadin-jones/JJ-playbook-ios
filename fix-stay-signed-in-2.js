#!/usr/bin/env node
/* JJ Playbook — stay signed in, take 2.
   The first version tried once. At launch the database connection often is not
   up yet, so that one attempt failed and the app fell back to the gate — which
   is why Continue worked (by then the connection was ready). This retries for a
   few seconds before ever showing the sign-in screen.

   Run from the jjplaybook2 folder:   node fix-stay-signed-in-2.js
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

const OLD = "/*jj-auto-resume*/if(known&&known.code&&known.idkey){ const okk=await this.loadLeader(known.code,known.idkey,known.name,known.email); if(okk) return; }";
const NEW = "/*jj-auto-resume2*/if(known&&known.code&&known.idkey){ for(let ai=0;ai<10;ai++){ let okk=false; try{ okk=await this.loadLeader(known.code,known.idkey,known.name,known.email); }catch(e){} if(okk) return; await new Promise(r=>setTimeout(r,600)); } }";

if (src.indexOf('/*jj-auto-resume2*/') >= 0) {
  console.log('Already patched — nothing to do.');
  process.exit(0);
}
if (src.indexOf(OLD) < 0) {
  console.error('Could not find the first auto-resume patch. Nothing changed — tell Claude.');
  process.exit(1);
}

src = src.split(OLD).join(NEW);

if (src.split('\n').length !== lines) {
  console.error('Line count changed — would break the pack. Nothing written.');
  process.exit(1);
}
if (src === before) {
  console.error('Nothing changed. Nothing written.');
  process.exit(1);
}

fs.writeFileSync(FILE + '.backup-signin2', before);
fs.writeFileSync(FILE, src);
console.log('Patched ' + FILE);
console.log('  • keeps retrying for ~6 seconds before showing the sign-in screen');
console.log('  • a recognised person lands straight on the playbook home screen');
console.log('Backup saved as ' + FILE + '.backup-signin2');
