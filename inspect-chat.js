#!/usr/bin/env node
/* JJ Playbook — read-only inspection. Changes nothing.
   Prints the parts of the deployed build that draw chat messages, so the delete
   control can be added in the right place.

   Run from the jjplaybook2 folder:   node inspect-chat.js
*/
const fs = require('fs');
const path = require('path');

const FILE = path.join('public', 'index.html');
const src = fs.readFileSync(FILE, 'utf8');

function show(label, needle, before, after) {
  const i = src.indexOf(needle);
  if (i < 0) { console.log('\n--- ' + label + ': NOT FOUND (' + needle + ')'); return; }
  console.log('\n--- ' + label + ' ---');
  console.log(src.slice(Math.max(0, i - (before || 0)), i + (after || 300)));
}

console.log('file size: ' + src.length + ' chars, ' + src.split('\n').length + ' lines');

// Studio-side chat list
show('admChatMsgs (state/render)', 'admChatMsgs', 60, 400);
// Leader-side chat rows
show('chatRows', 'chatRows', 60, 500);
// The message bubble markup
show('bubbleStyle', 'bubbleStyle', 200, 400);
// Send path, to see the message shape
show('sendChat', 'sendChat', 40, 300);
// Whether an admin flag already exists we can hang a delete off
['_adminOk', 'canModerate', 'guardHard', 'admChatOrg'].forEach(n => {
  console.log('\n' + n + ': ' + (src.indexOf(n) >= 0 ? 'present' : 'absent'));
});
