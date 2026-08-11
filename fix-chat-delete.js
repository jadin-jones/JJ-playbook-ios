#!/usr/bin/env node
/* JJ Playbook — admin delete for chat messages.
   Adds a small DELETE under each message bubble, visible only to the admin, with
   a confirm. Removing it deletes the message for everyone.

   Three edits, all single-line so the packed file stays valid:
     1. a deleteChatMsgX() method next to sendChat()
     2. canDelete / onDelete / delStyle on each chat bubble
     3. the button itself in the bubble markup

   Run from the jjplaybook2 folder:   node fix-chat-delete.js
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

if (src.indexOf('deleteChatMsgX') >= 0) {
  console.log('Already patched — nothing to do.');
  process.exit(0);
}

/* ---- 1. the delete method --------------------------------------------- */
const SEND = 'async sendChat(){';
if (src.indexOf(SEND) < 0) {
  console.error('Could not find sendChat(). Nothing changed.');
  process.exit(1);
}
const METHOD = "async deleteChatMsgX(code,id){ if(!code||!id) return; const key='chat:'+code, db=fb(); try{ if(db){ const snap=await db.collection(COLL).doc(key).get(); const data=snap.exists?(snap.data()||{}):{}; const list=(Array.isArray(data.messages)?data.messages:[]).filter(x=>x&&x.id!==id); await db.collection(COLL).doc(key).set({messages:list},{merge:true}); this.setState({chatMsgs:list}); } else { const list=(((await sget(key))||[])).filter(x=>x&&x.id!==id); await sset(key,list); this.setState({chatMsgs:list}); } this.toast('Message deleted'); }catch(e){ console.error('deleteChatMsgX',e); this.toast('Could not delete that message',true); } } ";
src = src.replace(SEND, METHOD + SEND);

/* ---- 2. the per-bubble props ------------------------------------------ */
const SHOWWHO = 'showWho:!mine,';
if (src.indexOf(SHOWWHO) < 0) {
  console.error('Could not find the chat bubble builder. Nothing changed.');
  process.exit(1);
}
const PROPS = "canDelete:(!!this._adminOk||/charlie/i.test(s.name||'')), onDelete:()=>{ if(window.confirm('Delete this message for everyone?')) this.deleteChatMsgX(s.code,m.id); }, delStyle:'display:block;margin-top:6px;background:none;border:none;padding:0;font-family:inherit;font-weight:800;font-size:9.5px;letter-spacing:.08em;text-transform:uppercase;cursor:pointer;color:'+(mine?'rgba(255,255,255,.8)':'#7E8D9C'), ";
src = src.replace(SHOWWHO, PROPS + SHOWWHO);

/* ---- 3. the button in the markup -------------------------------------- */
const BODY = '<span>{{ cm.body }}</span>';
if (src.indexOf(BODY) < 0) {
  console.error('Could not find the message bubble markup. Nothing changed.');
  process.exit(1);
}
const BTN = '<sc-if value=\\"{{ cm.canDelete }}\\" hint-placeholder-val=\\"{{ false }}\\"><button sc-camel-on-click=\\"{{ cm.onDelete }}\\" style=\\"{{ cm.delStyle }}\\">Delete</button></sc-if>';
src = src.replace(BODY, BODY + BTN);

/* ---- safety checks ---------------------------------------------------- */
for (const [name, txt] of [['method', METHOD], ['props', PROPS], ['button', BTN]]) {
  if (/[\n\r]/.test(txt)) {
    console.error('Internal error: ' + name + ' contains a line break. Nothing written.');
    process.exit(1);
  }
}
if (src.split('\n').length !== lines) {
  console.error('Line count changed — would break the pack. Nothing written.');
  process.exit(1);
}
if (src === before) {
  console.error('Nothing changed. Nothing written.');
  process.exit(1);
}

fs.writeFileSync(FILE + '.backup-chatdel', before);
fs.writeFileSync(FILE, src);
console.log('Patched ' + FILE);
console.log('  • DELETE appears under each message, admin only, with a confirm');
console.log('  • deleting removes the message for everyone in that organization');
console.log('Backup saved as ' + FILE + '.backup-chatdel');
console.log('Check it locally first:  open public/index.html');
