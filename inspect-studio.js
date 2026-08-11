#!/usr/bin/env node
/* Read-only. Shows how the Studio's tabs are built, so a Chat panel can be added.
   Run from the jjplaybook2 folder:   node inspect-studio.js
*/
const fs = require('fs');
const src = fs.readFileSync('public/index.html', 'utf8');
const flat = s => s.replace(/\\n/g, ' ').replace(/\s+/g, ' ');

function one(label, needle, len) {
  const i = src.indexOf(needle);
  console.log('\n--- ' + label + (i < 0 ? ': NOT FOUND' : '') + ' ---');
  if (i >= 0) console.log(flat(src.slice(i, i + (len || 400))));
}

one('adminTab state', 'adminTab:', 120);
one('admin tab list', 'adminTabs', 500);
one('admin tab switch', "adminTab==='", 300);
one('roster load', 'loadRoster', 200);
console.log('\nflags: ' + ['admChatMsgs','startAdminChat','chatOn(','_adminOk']
  .map(n => n + '=' + (src.indexOf(n) >= 0)).join('  '));
