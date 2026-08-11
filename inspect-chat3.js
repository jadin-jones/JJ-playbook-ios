#!/usr/bin/env node
/* Read-only. Prints just the chat bubble builder, small enough to read.
   Run from the jjplaybook2 folder:   node inspect-chat3.js
*/
const fs = require('fs');
const src = fs.readFileSync('public/index.html', 'utf8');
const i = src.indexOf('chatBubbles=');
if (i < 0) { console.log('chatBubbles= NOT FOUND'); process.exit(0); }
console.log(src.slice(i, i + 620).replace(/\\n/g, ' ').replace(/\s+/g, ' '));
