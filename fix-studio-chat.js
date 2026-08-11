#!/usr/bin/env node
/* JJ Playbook — move message deletion into the Studio, admin only.
   1. turns OFF the delete that currently shows on the member side
   2. adds a CHAT tab to the Studio: pick an organization, see every message,
      delete any of them (with a confirm) — deletes for everyone

   Run from the jjplaybook2 folder:   node fix-studio-chat.js
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

if (src.indexOf('admChatListX') >= 0) { console.log('Already patched.'); process.exit(0); }
if (src.indexOf('deleteChatMsgX') < 0) {
  console.error('Run fix-chat-delete-2.js first (it adds the delete method). Nothing changed.');
  process.exit(1);
}

const step = [];

/* ---- 1. member-side delete off ---------------------------------------- */
const MEMBER = "canDelete:(!!this._adminOk||/charlie/i.test(s.name||''))";
if (src.indexOf(MEMBER) < 0) {
  console.error('Could not find the member-side delete flag. Nothing changed.');
  process.exit(1);
}
src = src.replace(MEMBER, 'canDelete:false');
step.push('member-side delete turned off');

/* ---- 2. loader + delete for the Studio -------------------------------- */
const SEND = 'async sendChat(){';
const METHODS = "async loadAdminChatX(code){ if(!code) return; this.setState({admChatCodeX:code,admChatListX:[]}); try{ const key='chat:'+code, db=fb(); let list=[]; if(db){ const snap=await db.collection(COLL).doc(key).get(); const data=snap.exists?(snap.data()||{}):{}; list=Array.isArray(data.messages)?data.messages:[]; } else { list=(await sget(key))||[]; } list=list.slice().sort((a,b)=>(b.createdAt||0)-(a.createdAt||0)); this.setState({admChatListX:list}); }catch(e){ console.error('loadAdminChatX',e); this.toast('Could not load that chat',true); } } async deleteAdminChatMsgX(code,id){ await this.deleteChatMsgX(code,id); await this.loadAdminChatX(code); } ";
if (src.indexOf(SEND) < 0) {
  console.error('Could not find sendChat(). Nothing changed.');
  process.exit(1);
}
src = src.replace(SEND, METHODS + SEND);
step.push('Studio chat loader added');

/* ---- 3. the tab itself ------------------------------------------------- */
const TABSW = "isOrgs:s.adminTab==='orgs',";
if (src.indexOf(TABSW) < 0) {
  console.error('Could not find the Studio tab switch. Nothing changed.');
  process.exit(1);
}
const VALS = "isChat:s.adminTab==='chat', chatPicked:(s.admChatCodeX||''), chatNone:!s.admChatCodeX, chatEmpty:!!s.admChatCodeX&&!((s.admChatListX||[]).length), chatOrgs:(s.orgList||[]).map(o=>({label:o.name||o.code, style:'background:'+(s.admChatCodeX===o.code?'#0C2647':'#EAF1F8')+';color:'+(s.admChatCodeX===o.code?'#FFFFFF':'#0C1B2E')+';border:1px solid #C6D4E2;border-radius:8px;padding:9px 13px;font-family:inherit;font-weight:800;font-size:11px;letter-spacing:.06em;text-transform:uppercase;cursor:pointer;min-height:38px', onTap:()=>this.loadAdminChatX(o.code)})), chatRows:((s.admChatListX||[])).map(m=>({who:(m.authorName||'Teammate')+(m.studio?' \\u00b7 Studio':''), body:m.body||'', when:new Date(m.createdAt||0).toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}), onDelete:()=>{ if(window.confirm('Delete this message for everyone?')) this.deleteAdminChatMsgX(s.admChatCodeX,m.id); }})), ";
src = src.replace(TABSW, VALS + TABSW);
step.push('Studio chat data wired');

/* ---- 4. add CHAT to the tab row --------------------------------------- */
// adminTabs is an assignment ending in a semicolon; append one more entry to it.
const m = src.match(/adminTabs=/);
if (!m) {
  console.error('Could not find adminTabs. Nothing changed.');
  process.exit(1);
}
const at = src.indexOf('adminTabs=') + 'adminTabs='.length;
const semi = src.indexOf(';', at);
if (semi < 0 || semi - at > 4000) {
  console.error('Could not read the end of adminTabs. Nothing changed.');
  process.exit(1);
}
const TABADD = ".concat([{label:'Chat', onTap:()=>this.setState({adminTab:'chat'}), style:'background:'+(this.state.adminTab==='chat'?'#0C2647':'transparent')+';color:'+(this.state.adminTab==='chat'?'#FFFFFF':'#7E8D9C')+';border:none;border-radius:9px;padding:10px 14px;font-family:inherit;font-weight:800;font-size:11.5px;letter-spacing:.07em;text-transform:uppercase;cursor:pointer;min-height:40px'}])";
src = src.slice(0, semi) + TABADD + src.slice(semi);
step.push('CHAT tab added to the Studio');

/* ---- 5. the panel markup ---------------------------------------------- */
const ORGS_IF = src.indexOf('<sc-if value=\\"{{ admin.isOrgs }}\\"');
if (ORGS_IF < 0) {
  console.error('Could not find the Studio panels. Nothing changed.');
  process.exit(1);
}
const S = '<\\/';
const PANEL =
  '<sc-if value=\\"{{ admin.isChat }}\\" hint-placeholder-val=\\"{{ false }}\\">' +
  '<div style=\\"background:#fff;border:1px solid #DCE6F0;border-radius:14px;padding:16px\\">' +
  '<div style=\\"font-weight:800;font-size:10.5px;letter-spacing:.12em;text-transform:uppercase;color:#7E8D9C;margin-bottom:10px\\">Team chat · moderation' + S + 'div>' +
  '<div style=\\"display:flex;flex-wrap:wrap;gap:8px;margin-bottom:14px\\">' +
  '<sc-for list=\\"{{ admin.chatOrgs }}\\" as=\\"co\\" hint-placeholder-count=\\"2\\">' +
  '<button sc-camel-on-click=\\"{{ co.onTap }}\\" style=\\"{{ co.style }}\\">{{ co.label }}' + S + 'button>' +
  S + 'sc-for>' + S + 'div>' +
  '<sc-if value=\\"{{ admin.chatNone }}\\" hint-placeholder-val=\\"{{ true }}\\">' +
  '<p style=\\"font-size:13px;color:#7E8D9C;margin:0\\">Pick an organization to see its messages.' + S + 'p>' + S + 'sc-if>' +
  '<sc-if value=\\"{{ admin.chatEmpty }}\\" hint-placeholder-val=\\"{{ false }}\\">' +
  '<p style=\\"font-size:13px;color:#7E8D9C;margin:0\\">No messages in this chat yet.' + S + 'p>' + S + 'sc-if>' +
  '<sc-for list=\\"{{ admin.chatRows }}\\" as=\\"cr\\" hint-placeholder-count=\\"0\\">' +
  '<div style=\\"border-top:1px solid #DCE6F0;padding:11px 0;display:flex;align-items:flex-start;justify-content:space-between;gap:12px\\">' +
  '<div style=\\"min-width:0\\">' +
  '<span style=\\"display:block;font-weight:800;font-size:10.5px;letter-spacing:.07em;text-transform:uppercase;color:#7E8D9C\\">{{ cr.who }}' + S + 'span>' +
  '<span style=\\"display:block;font-size:14px;line-height:1.45;color:#0C1B2E;margin-top:3px\\">{{ cr.body }}' + S + 'span>' +
  '<span style=\\"display:block;font-size:11.5px;color:#9DAAB8;margin-top:3px\\">{{ cr.when }}' + S + 'span>' + S + 'div>' +
  '<button sc-camel-on-click=\\"{{ cr.onDelete }}\\" style=\\"flex:none;background:#fff;border:1px solid #E4C4C4;color:#B4302A;border-radius:8px;padding:8px 11px;font-family:inherit;font-weight:800;font-size:10px;letter-spacing:.08em;text-transform:uppercase;cursor:pointer;min-height:36px\\">Delete' + S + 'button>' +
  S + 'div>' + S + 'sc-for>' + S + 'div>' + S + 'sc-if>';
src = src.slice(0, ORGS_IF) + PANEL + src.slice(ORGS_IF);
step.push('Studio chat panel added');

/* ---- checks ----------------------------------------------------------- */
for (const [n, t] of [['methods', METHODS], ['vals', VALS], ['tab', TABADD], ['panel', PANEL]]) {
  if (/[\n\r]/.test(t)) { console.error('Internal error: ' + n + ' has a line break.'); process.exit(1); }
}
if (src.split('\n').length !== lines) {
  console.error('Line count changed — would break the pack. Nothing written.');
  process.exit(1);
}
if (src === before) { console.error('Nothing changed.'); process.exit(1); }

fs.writeFileSync(FILE + '.backup-studiochat', before);
fs.writeFileSync(FILE, src);
console.log('Patched ' + FILE);
step.forEach(s => console.log('  • ' + s));
console.log('Backup: ' + FILE + '.backup-studiochat');
console.log('Check locally first:  open public/index.html');
