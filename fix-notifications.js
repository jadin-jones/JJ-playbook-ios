#!/usr/bin/env node
/* JJ Playbook — notification fix.
   Patches public/index.html so the app refreshes its push token on every launch
   instead of only on the one tap of "Turn on notifications".

   Run from the jjplaybook2 folder:   node fix-notifications.js
   A backup is written next to the file before anything changes.
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

if (src.indexOf('refreshPushToken') >= 0) {
  console.log('Already patched — nothing to do.');
  process.exit(0);
}

/* ---- 1. replace the whole resumePush method ---------------------------- */
const start = src.search(/async\s+resumePush\s*\(\s*\)\s*\{/);
if (start < 0) {
  console.error('Could not find resumePush() in ' + FILE + '. Nothing changed.');
  process.exit(1);
}
// walk to the matching closing brace
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

const REPLACEMENT = `async resumePush(){
    if(!this.pushSupported()) return;
    if(Notification.permission!=='granted') return;
    this.setState({pushOn:true});
    if(navigator.clearAppBadge) navigator.clearAppBadge().catch(()=>{});
    try{
      let reg=await navigator.serviceWorker.getRegistration();
      if(!reg) reg=await navigator.serviceWorker.register('firebase-messaging-sw.js');
      if(!reg) return;
      await this.loadScript('https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js');
      if(!firebase.apps.length) firebase.initializeApp(FIREBASE_CONFIG);
      this.attachForegroundPush(reg);
      await this.refreshPushToken(reg);
      this.bindPushRefresh();
    }catch(e){ console.error('resumePush',e); }
  }
  async refreshPushToken(reg){
    if(!PUSH_VAPID_KEY) return;
    const s=this.state; if(!s.idkey) return;
    try{
      if(!reg) reg=await navigator.serviceWorker.getRegistration();
      if(!reg) return;
      const token=await firebase.messaging()
        .getToken({vapidKey:PUSH_VAPID_KEY,serviceWorkerRegistration:reg});
      if(!token) return;
      const key='push:'+s.idkey;
      let rec=null; try{ rec=await sget(key); }catch(e){}
      rec=rec||{};
      const changed=rec.token!==token||rec.active===false
        ||String(rec.code||'')!==String(s.code||'');
      rec.token=token; rec.active=true;
      rec.name=s.name||rec.name||''; rec.code=s.code||rec.code||'';
      rec.idkey=s.idkey;
      rec.tz=(Intl.DateTimeFormat().resolvedOptions()||{}).timeZone||rec.tz||'America/Chicago';
      if(rec.remindHour==null) rec.remindHour=18;
      if(rec.remind5s==null) rec.remind5s=this.fiveSOn();
      rec.at=Date.now();
      delete rec.mutedAt; delete rec.mutedFor;
      await sset(key,rec);
      if(changed) await this.claimPushForThisDevice();
    }catch(e){ console.error('refreshPushToken',e); }
  }
  bindPushRefresh(){
    if(this._pushRefreshBound) return;
    this._pushRefreshBound=true;
    document.addEventListener('visibilitychange',()=>{
      if(document.visibilityState!=='visible') return;
      if(typeof Notification==='undefined'||Notification.permission!=='granted') return;
      if(!this.state.idkey) return;
      const now=Date.now();
      if(this._lastPushRefresh&&now-this._lastPushRefresh<6*60*60*1000) return;
      this._lastPushRefresh=now;
      this.refreshPushToken().catch(()=>{});
    });
  }`;

src = src.slice(0, start) + REPLACEMENT + src.slice(end);

/* ---- 2. run it again once we know who signed in ------------------------ */
const CLAIM = 'this.claimPushForThisDevice().catch(()=>{});';
let hooked = false;
if (src.indexOf(CLAIM) >= 0) {
  src = src.replace(CLAIM, CLAIM + '\n      this.resumePush().catch(()=>{});');
  hooked = true;
}

if (src === before) {
  console.error('Nothing changed — bailing out rather than writing a bad file.');
  process.exit(1);
}

fs.writeFileSync(FILE + '.backup', before);
fs.writeFileSync(FILE, src);

console.log('Patched ' + FILE);
console.log('  • resumePush now registers the worker and refreshes the token');
console.log('  • token also refreshes when the app returns to the foreground');
console.log(hooked
  ? '  • token is written again right after sign-in'
  : '  ! could not find the sign-in hook — tell Claude, the main fix is still in');
console.log('Backup saved as ' + FILE + '.backup');
