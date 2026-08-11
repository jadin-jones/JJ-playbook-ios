#!/usr/bin/env node
/* JJ Playbook — read-only inspection, part 2. Changes nothing.
   Prints where chat bubbles are built, so a delete control can be wired in.

   Run from the jjplaybook2 folder:   node inspect-chat2.js
*/
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join('public', 'index.html'), 'utf8');

function show(label, needle, before, after) {
  let from = 0, n = 0;
  while (n < 3) {
    const i = src.indexOf(needle, from);
    if (i < 0) break;
    console.log('\n--- ' + label + ' #' + (++n) + ' ---');
    console.log(src.slice(Math.max(0, i - (before || 0)), i + (after || 500)));
    from = i + 1;
  }
  if (!n) console.log('\n--- ' + label + ': NOT FOUND');
}

show('chatBubbles built', 'v.chatBubbles', 0, 900);
show('deleteChat-ish', 'chatMsgs', 0, 200);
console.log('\nadmin flags: ' +
  ['_adminOk', 'enterStudio', 'guardHard', 'role:\'admin\''].map(n =>
    n + '=' + (src.indexOf(n) >= 0)).join('  '));
