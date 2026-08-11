#!/usr/bin/env node
/* JJ Playbook — notification fix, corrected.
   public/index.html is a PACKED file: the app lives inside a JSON string, so a
   patch must not introduce real line breaks. This script restores the original
   from the backup and re-applies the fix as single-line code.

   Run from the jjplaybook2 folder:   node fix-notifications-3.js
*/
const fs = require('fs');
const path = require('path');

const FILE = path.join('public', 'index.html');
const B1 = FILE + '.backup';
const B2 = FILE + '.backup2';

if (!fs.existsSync(FILE)) {
  console.error('Cannot find ' + FILE + '. Run this from the jjplaybook2 folder.');
  process.exit(1);
}

/* ---- 0. get back to the original ---------------------------------------- */
if (fs.existsSync(B1)) {
  fs.copyFileSync(B1, FILE);
  console.log('Restored the original from ' + B1);
} else {
  console.error('No backup found at ' + B1 + '.');
  console.error('Do not run this. Tell Claude — we will rebuild the file instead.');
  process.exit(1);
}
if (fs.existsSync(B2)) fs.unlinkSync(B2);

let src = fs.readFileSync(FILE, 'utf8');
const before = src;

if (src.indexOf('refreshPushToken') >= 0) {
  console.error('Backup already contained the patch. Stopping — tell Claude.');
  process.exit(1);
}

/* ---- 1. replace resumePush, all on one line ---------------------------- */
const start = src.search(/async\s+resumePush\s*\(\s*\)\s*\{/);
if (start < 0) {
  console.error('Could not find resumePush(). Nothing changed.');
  process.exit(1);
}
let i = src.indexOf('{', start), depth = 0, end = -1;
for (; i < src.length; i++) {
  const c = src[i];
  if (c === '{') depth++;
  else if (c === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
}
if (end < 0) {
  console.error('Could not read the end of resumePush(). Nothing changed.');
  process.exit(1);
}

// One line. No comments, no newlines, no double quotes — safe inside the pack.
const REPLACEMENT =
  "async resumePush(){ if(!this.pushSupported()) return; " +
  "if(Notification.permission!=='granted') return; this.setState({pushOn:true}); " +
  "if(navigator.clearAppBadge) navigator.clearAppBadge().catch(()=>{}); " +
  "try{ let reg=await navigator.serviceWorker.getRegistration(); " +
  "if(!reg) reg=await navigator.serviceWorker.register('firebase-messaging-sw.js'); " +
  "if(!reg) return; " +
  "await this.loadScript('https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js'); " +
  "if(!firebase.apps.length) firebase.initializeApp(FIREBASE_CONFIG); " +
  "this.attachForegroundPush(reg); await this.refreshPushToken(reg); this.bindPushRefresh(); " +
  "}catch(e){ console.error('resumePush',e); } } " +
  "async refreshPushToken(reg){ if(!PUSH_VAPID_KEY) return; const s=this.state; if(!s.idkey) return; " +
  "try{ if(!reg) reg=await navigator.serviceWorker.getRegistration(); if(!reg) return; " +
  "const token=await firebase.messaging().getToken({vapidKey:PUSH_VAPID_KEY,serviceWorkerRegistration:reg}); " +
  "if(!token) return; const key='push:'+s.idkey; let rec=null; try{ rec=await sget(key); }catch(e){} " +
  "rec=rec||{}; const changed=rec.token!==token||rec.active===false||String(rec.code||'')!==String(s.code||''); " +
  "rec.token=token; rec.active=true; rec.name=s.name||rec.name||''; rec.code=s.code||rec.code||''; " +
  "rec.idkey=s.idkey; rec.tz=(Intl.DateTimeFormat().resolvedOptions()||{}).timeZone||rec.tz||'America/Chicago'; " +
  "if(rec.remindHour==null) rec.remindHour=18; if(rec.remind5s==null) rec.remind5s=this.fiveSOn(); " +
  "rec.at=Date.now(); delete rec.mutedAt; delete rec.mutedFor; await sset(key,rec); " +
  "if(changed) await this.claimPushForThisDevice(); }catch(e){ console.error('refreshPushToken',e); } } " +
  "bindPushRefresh(){ if(this._pushRefreshBound) return; this._pushRefreshBound=true; " +
  "document.addEventListener('visibilitychange',()=>{ if(document.visibilityState!=='visible') return; " +
  "if(typeof Notification==='undefined'||Notification.permission!=='granted') return; " +
  "if(!this.state.idkey) return; const now=Date.now(); " +
  "if(this._lastPushRefresh&&now-this._lastPushRefresh<6*60*60*1000) return; " +
  "this._lastPushRefresh=now; this.refreshPushToken().catch(()=>{}); }); }";

src = src.slice(0, start) + REPLACEMENT + src.slice(end);

/* ---- 2. the sign-in hook, also one line -------------------------------- */
const CANDIDATES = [
  /this\.claimPushForThisDevice\(\)\s*\.catch\([^)]*\)\s*;/,
  /this\.claimPushForThisDevice\(\)\s*;/,
  /this\.syncReminderPrefs\(\)\s*\.catch\([^)]*\)\s*;/,
  /this\.scheduleFiveS\(\)\s*;/
];
let hooked = null;
for (const re of CANDIDATES) {
  const m = src.match(re);
  if (!m) continue;
  src = src.replace(re, m[0] + 'this.resumePush().catch(()=>{});');
  hooked = m[0].trim();
  break;
}

/* ---- 3. sanity check: did we keep the pack valid? ---------------------- */
if (/[\n\r]/.test(REPLACEMENT)) {
  console.error('Internal error: replacement contains a line break. Nothing written.');
  process.exit(1);
}
if (src === before) {
  console.error('Nothing changed. Nothing written.');
  process.exit(1);
}
if (src.split('\n').length !== before.split('\n').length) {
  console.error('Line count changed — the pack would break. Nothing written.');
  process.exit(1);
}

fs.writeFileSync(FILE, src);
console.log('Patched ' + FILE + ' (packing preserved)');
console.log('  • resumePush registers the worker and refreshes the token');
console.log('  • token refreshes again when the app returns to the foreground');
console.log(hooked ? '  • hooked after: ' + hooked : '  ! no sign-in hook found — tell Claude');
console.log('Original still at ' + B1);
