#!/usr/bin/env node
/* JJ Playbook — stop the duplicate notification.
   The server already sends a properly-labelled alert for every session, update
   and chat message ("Quarterly Full Group", etc). The app was also raising its
   own for the same item ("New session: Test"), so people got two. This makes the
   app's copy stop at the in-app toast and leave the lock screen to the server.

   Run from the jjplaybook2 folder:   node fix-duplicate-notify.js
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

if (src.indexOf('/*jj-no-dupe*/') >= 0) {
  console.log('Already patched — nothing to do.');
  process.exit(0);
}

// Find the local notification method.
const at = src.search(/(async\s+)?localNotify\s*\(/);
if (at < 0) {
  console.error('Could not find localNotify() in ' + FILE + '. Nothing changed.');
  process.exit(1);
}

// Insert the bail-out right after its toast, so the in-app banner still shows.
const TOAST = /this\.toast\(title\)\s*;/;
const tail = src.slice(at);
if (!TOAST.test(tail)) {
  console.error('Could not find the toast inside localNotify(). Nothing changed.');
  process.exit(1);
}
const GUARD = "/*jj-no-dupe*/if(typeof Notification!=='undefined'&&Notification.permission==='granted') return;";
const patchedTail = tail.replace(TOAST, (m) => m + GUARD);
src = src.slice(0, at) + patchedTail;

if (src.split('\n').length !== lines) {
  console.error('Line count changed — would break the pack. Nothing written.');
  process.exit(1);
}
if (src === before) {
  console.error('Nothing changed.');
  process.exit(1);
}

fs.writeFileSync(FILE + '.backup-dupe', before);
fs.writeFileSync(FILE, src);
console.log('Patched ' + FILE);
console.log('  • the app no longer raises its own lock-screen alert');
console.log('  • the in-app banner still appears while the app is open');
console.log('  • the server alert (with the group name) is the only one people get');
console.log('Backup saved as ' + FILE + '.backup-dupe');
