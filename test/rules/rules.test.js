/* Checks firestore.rules in the local Firestore emulator.
 *
 *   npm --prefix test/rules install && npm --prefix test/rules test
 *
 * Runs against project demo-jj, which the emulator keeps entirely local: no
 * real Firebase project is read or written. Needs Java (the emulator).
 * Each case says whether a signed-in person may do one thing; any case that
 * comes out the other way fails the run.
 */
const fs=require('fs');
const {initializeTestEnvironment,assertSucceeds,assertFails}=require('@firebase/rules-unit-testing');
const {doc,getDoc,setDoc,deleteDoc,collection,getDocs,query,where,documentId}=require('firebase/firestore');
const V=o=>({value:JSON.stringify(o)});
(async()=>{
  if(!process.argv[2]) throw new Error('usage: node rules.test.js <path to firestore.rules>');
  const env=await initializeTestEnvironment({projectId:'demo-jj',firestore:{rules:fs.readFileSync(process.argv[2],'utf8'),host:'127.0.0.1',port:8089}});
  await env.withSecurityRulesDisabled(async c=>{ const d=c.firestore(); const J=id=>doc(d,'jj_playbook',id);
    await setDoc(doc(d,'members','ann@a.com'),{orgs:['T1']}); await setDoc(doc(d,'members','bob@a.com'),{orgs:['T1']});
    await setDoc(doc(d,'members','mm@a.com'),{orgs:['T1']});
    await setDoc(doc(d,'msVerified','uid-mm2'),{email:'mm@a.com'});
    await setDoc(J('org:T1'),V({name:'T',leads:['ann@a.com']}));
    await setDoc(J('resp:T1:ann-a-com'),Object.assign(V({email:'ann@a.com'}),{ownerEmail:'ann@a.com'}));
    await setDoc(J('resp:T1:bob-a-com'),Object.assign(V({email:'bob@a.com'}),{ownerEmail:'bob@a.com'}));
    await setDoc(J('push:T1:ann-a-com'),Object.assign(V({token:'t'}),{ownerEmail:'ann@a.com'}));
    await setDoc(J('rev:T1:bob-a-com'),V({email:'bob@a.com'}));
    await setDoc(J('peer:T1:P1'),Object.assign(V({mode:'peer'}),{ownerEmail:'ann@a.com',peerToken:'P1',peerMode:'peer'}));
    await setDoc(J('peer:T1:TM'),Object.assign(V({mode:'team'}),{ownerEmail:'ann@a.com',peerToken:'TM',peerMode:'team'}));
    await setDoc(J('peer:T1:OLD'),Object.assign(V({mode:'team'}),{ownerEmail:'ann@a.com',peerToken:'OLD'}));
    await setDoc(J('chat:T1'),{messages:[]});
    await setDoc(doc(d,'tt_data','x'),{a:1});
    await setDoc(J('knowledge:master'),V({items:[]}));
    await setDoc(J('knowledge:misses'),V({items:[{q:'a member question'}]}));
    await setDoc(J('demo:ann-a-com:1'),V({token:'t'}));
    await setDoc(doc(d,'rateLimits','x'),{count:1});
    // Twin Thieves: tia and zed are students in TT36 only; ann is a Playbook member only.
    await setDoc(doc(d,'ttmembers','tia@s.org'),{orgs:['TT36']}); await setDoc(doc(d,'ttmembers','zed@s.org'),{orgs:['TT36']});
    await setDoc(J('ttlib:master'),V({lessons:[]}));
    await setDoc(J('program:master'),V({modules:[]}));
    await setDoc(J('ttinv:TT36:abc'),Object.assign(V({email:'tia@s.org',program:'TT36',status:'invited'}),{tokenHash:'h'}));
    await setDoc(J('org:TT36'),V({product:'tt',ttVersion:36,joinCode:'TWINTHIEVES36'}));
    await setDoc(J('org:TT10'),V({product:'tt',ttVersion:10,joinCode:'TWINTHIEVES10'}));
    await setDoc(J('ttm:TT36:tia-s-org'),Object.assign(V({name:'Tia',progress:{}}),{ownerEmail:'tia@s.org'}));
    await setDoc(J('ttm:TT36:zed-s-org'),Object.assign(V({name:'Zed',progress:{}}),{ownerEmail:'zed@s.org'}));
    await setDoc(J('rev:TT36:gone-s-org'),V({email:'gone@s.org'}));
    await setDoc(doc(d,'ttmembers','gone@s.org'),{orgs:['TT36']});
    await setDoc(J('ttallow:TT36'),V({emails:['tia@s.org','amy@s.org']}));
    // dual@a.com is in the Playbook's T1 and Twin Thieves' TT36.
    await setDoc(doc(d,'members','dual@a.com'),{orgs:['T1']}); await setDoc(doc(d,'ttmembers','dual@a.com'),{orgs:['TT36']});
    await setDoc(J('ttm:TT36:dual-a-com'),Object.assign(V({name:'Dual',progress:{}}),{ownerEmail:'dual@a.com'}));
  });
  const who=(uid,email,prov)=>env.authenticatedContext(uid,{email,email_verified:true,firebase:{sign_in_provider:prov||'google.com'}}).firestore();
  const ann=who('uid-ann','ann@a.com'), bob=who('uid-bob','bob@a.com'), adm=who('uid-c','charlie@jadin-jones.com'),
        admMs=who('uid-cms','charlie@jadin-jones.com','microsoft.com'), mm1=who('uid-mm1','mm@a.com','microsoft.com'), mm2=who('uid-mm2','mm@a.com','microsoft.com');
  const J=(db,id)=>doc(db,'jj_playbook',id);
  const tia=who('uid-tia','tia@s.org'), gone=who('uid-gone','gone@s.org');
  const dual=who('uid-dual','dual@a.com');
  const TT=[
   ['TT: student reads the lesson library',true,()=>getDoc(J(tia,'ttlib:master'))],
   ['TT: Playbook member reads the lesson library',false,()=>getDoc(J(ann,'ttlib:master'))],
   ['TT: student reads own program',true,()=>getDoc(J(tia,'org:TT36'))],
   ['TT: student reads the other version',false,()=>getDoc(J(tia,'org:TT10'))],
   ['TT: student reads own progress',true,()=>getDoc(J(tia,'ttm:TT36:tia-s-org'))],
   ['TT: student reads another student',false,()=>getDoc(J(tia,'ttm:TT36:zed-s-org'))],
   ['TT: student lists the program\'s progress',false,()=>getDocs(query(collection(tia,'jj_playbook'),where(documentId(),'>=','ttm:TT36:'),where(documentId(),'<','ttm:TT36:\uf8ff')))],
   ['TT: student saves own progress',true,()=>setDoc(J(tia,'ttm:TT36:tia-s-org'),Object.assign(V({name:'Tia',progress:{tt01:{doneAt:1}}}),{ownerEmail:'tia@s.org'}),{merge:true})],
   ['TT: student changes own ownerEmail',false,()=>setDoc(J(tia,'ttm:TT36:tia-s-org'),{ownerEmail:'zed@s.org'},{merge:true})],
   ['TT: student writes another student',false,()=>setDoc(J(tia,'ttm:TT36:zed-s-org'),Object.assign(V({}),{ownerEmail:'tia@s.org'}),{merge:true})],
   ['TT: student deletes own progress',false,()=>deleteDoc(J(tia,'ttm:TT36:tia-s-org'))],
   ['TT: student edits the lesson library',false,()=>setDoc(J(tia,'ttlib:master'),V({lessons:[]}),{merge:true})],
   ['TT: admin edits the lesson library',true,()=>setDoc(J(adm,'ttlib:master'),V({lessons:[]}),{merge:true})],
   ['TT: admin reads a student\'s progress',true,()=>getDoc(J(adm,'ttm:TT36:zed-s-org'))],
   ['TT: student reads own ttmembers',true,()=>getDoc(doc(tia,'ttmembers','tia@s.org'))],
   ['TT: student adds a program to own ttmembers',false,()=>setDoc(doc(tia,'ttmembers','tia@s.org'),{orgs:['TT36','TT10']})],
   ['TT: student reads own missing tombstone',true,()=>getDoc(J(tia,'rev:TT36:tia-s-org'))],
   ['TT: revoked student reads own tombstone',false,()=>getDoc(J(gone,'rev:TT36:gone-s-org'))],
   ['TT: Playbook member reads a student\'s progress',false,()=>getDoc(J(ann,'ttm:TT36:tia-s-org'))],
   ['TT isolation: student creates chat:TT36',false,()=>setDoc(J(tia,'chat:TT36'),{messages:[{t:1}]})],
   ['TT isolation: student creates push:TT36',false,()=>setDoc(J(tia,'push:TT36:tia-s-org'),Object.assign(V({token:'t'}),{ownerEmail:'tia@s.org'}))],
   ['TT isolation: student creates a peer round in TT36',false,()=>setDoc(J(tia,'peer:TT36:ZZZ'),Object.assign(V({}),{ownerEmail:'tia@s.org',peerToken:'ZZZ',peerMode:'team'}))],
   ['TT isolation: student reads Playbook program content',false,()=>getDoc(J(tia,'program:master'))],
   ['TT isolation: student reads a Playbook org',false,()=>getDoc(J(tia,'org:T1'))],
   ['TT isolation: student reads a Playbook member',false,()=>getDoc(J(tia,'resp:T1:ann-a-com'))],
   ['TT isolation: student reads knowledge:master',false,()=>getDoc(J(tia,'knowledge:master'))],
   ['TT invites: student reads an invite (even their own)',false,()=>getDoc(J(tia,'ttinv:TT36:abc'))],
   ['TT invites: Playbook member reads an invite',false,()=>getDoc(J(ann,'ttinv:TT36:abc'))],
   ['TT invites: student writes an invite',false,()=>setDoc(J(tia,'ttinv:TT36:abc'),V({status:'joined'}),{merge:true})],
   ['TT invites: admin reads an invite',true,()=>getDoc(J(adm,'ttinv:TT36:abc'))],
   ['TT approved list: student reads it (even listed)',false,()=>getDoc(J(tia,'ttallow:TT36'))],
   ['TT approved list: Playbook member reads it',false,()=>getDoc(J(ann,'ttallow:TT36'))],
   ['TT approved list: student writes it',false,()=>setDoc(J(tia,'ttallow:TT36'),V({emails:[]}))],
   ['TT approved list: admin reads it',true,()=>getDoc(J(adm,'ttallow:TT36'))],
   ['TT approved list: admin writes it',true,()=>setDoc(J(adm,'ttallow:TT10'),V({emails:['a@b.org']}))],
   ['TT approved list: Microsoft admin writes it',false,()=>setDoc(J(admMs,'ttallow:TT10'),V({emails:[]}))],
   ['TT both products: reads own ttm: record',true,()=>getDoc(J(dual,'ttm:TT36:dual-a-com'))],
   ['TT both products: reads own missing TT36 tombstone',true,()=>getDoc(J(dual,'rev:TT36:dual-a-com'))],
   ['TT both products: reads org:TT36',true,()=>getDoc(J(dual,'org:TT36'))],
   ['TT both products: a resp:TT36 read is refused (why My groups reads ttm: instead)',false,()=>getDoc(J(dual,'resp:TT36:dual-a-com'))],
  ];
  const tests=[
   ['member reads own resp',true,()=>getDoc(J(ann,'resp:T1:ann-a-com'))],
   ['member reads colleague resp',false,()=>getDoc(J(ann,'resp:T1:bob-a-com'))],
   ['member lists resp:T1:',false,()=>getDocs(query(collection(ann,'jj_playbook'),where(documentId(),'>=','resp:T1:'),where(documentId(),'<','resp:T1:')))],
   ['member updates own push',true,()=>setDoc(J(ann,'push:T1:ann-a-com'),Object.assign(V({token:'u'}),{ownerEmail:'ann@a.com'}),{merge:true})],
   ['member changes push ownerEmail',false,()=>setDoc(J(ann,'push:T1:ann-a-com'),{ownerEmail:'bob@a.com'},{merge:true})],
   ['member creates push in other program',false,()=>setDoc(J(ann,'push:T2:ann-a-com'),Object.assign(V({}),{ownerEmail:'ann@a.com'}))],
   ['member reads missing push:T1',true,()=>getDoc(J(ann,'push:T1:nobody'))],
   ['member reads legacy push:idkey',false,()=>getDoc(J(ann,'push:ann-a-com'))],
   ['member reads own missing rev',true,()=>getDoc(J(ann,'rev:T1:ann-a-com'))],
   ['member reads existing rev',false,()=>getDoc(J(bob,'rev:T1:bob-a-com'))],
   ['member writes rev',false,()=>setDoc(J(ann,'rev:T1:x'),V({}))],
   ['owner reads individual round',true,()=>getDoc(J(ann,'peer:T1:P1'))],
   ['colleague reads individual round',false,()=>getDoc(J(bob,'peer:T1:P1'))],
   ['colleague reads team round',true,()=>getDoc(J(bob,'peer:T1:TM'))],
   ['colleague reads team round without peerMode',false,()=>getDoc(J(bob,'peer:T1:OLD'))],
   ['colleague updates team round',false,()=>setDoc(J(bob,'peer:T1:TM'),Object.assign(V({}),{ownerEmail:'bob@a.com',peerToken:'TM',peerMode:'team'}),{merge:true})],
   ['owner closes round (full save)',true,()=>setDoc(J(ann,'peer:T1:P1'),Object.assign(V({mode:'peer',closed:true}),{ownerEmail:'ann@a.com',peerToken:'P1',peerMode:'peer'}),{merge:true})],
   ['owner flips round to team',false,()=>setDoc(J(ann,'peer:T1:P1'),{peerMode:'team'},{merge:true})],
   ['owner creates round',true,()=>setDoc(J(ann,'peer:T1:NEW'),Object.assign(V({}),{ownerEmail:'ann@a.com',peerToken:'NEW',peerMode:'peer'}))],
   ['create with wrong peerToken',false,()=>setDoc(J(ann,'peer:T1:NEW2'),Object.assign(V({}),{ownerEmail:'ann@a.com',peerToken:'X',peerMode:'peer'}))],
   ['owner stamps peerMode on old round (app save)',true,()=>setDoc(J(ann,'peer:T1:OLD'),Object.assign(V({mode:'team'}),{ownerEmail:'ann@a.com',peerToken:'OLD',peerMode:'team'}),{merge:true})],
   ['owner deletes round',true,()=>deleteDoc(J(ann,'peer:T1:NEW'))],
   ['colleague deletes round',false,()=>deleteDoc(J(bob,'peer:T1:P1'))],
   ['member reads org (with leads)',true,()=>getDoc(J(ann,'org:T1'))],
   ['member writes org',false,()=>setDoc(J(ann,'org:T1'),V({name:'x'}),{merge:true})],
   ['admin writes org leads',true,()=>setDoc(J(adm,'org:T1'),V({name:'T',leads:['bob@a.com']}),{merge:true})],
   ['Microsoft admin writes org',false,()=>setDoc(J(admMs,'org:T1'),V({}),{merge:true})],
   ['admin reads colleague resp',true,()=>getDoc(J(adm,'resp:T1:bob-a-com'))],
   ['member writes chat',true,()=>setDoc(J(ann,'chat:T1'),{messages:[{t:1}]},{merge:true})],
   ['Microsoft member, unconfirmed, reads own members doc',false,()=>getDoc(doc(mm1,'members','mm@a.com'))],
   ['Microsoft member, unconfirmed, reads org',false,()=>getDoc(J(mm1,'org:T1'))],
   ['Microsoft member, confirmed, reads org',true,()=>getDoc(J(mm2,'org:T1'))],
   ['member reads own members doc',true,()=>getDoc(doc(ann,'members','ann@a.com'))],
   ['admin reads msVerified',false,()=>getDoc(doc(adm,'msVerified','uid-mm2'))],
   ['member reads tt_data',false,()=>getDoc(doc(ann,'tt_data','x'))],
   ['admin reads tt_data',true,()=>getDoc(doc(adm,'tt_data','x'))],
   ['member reads knowledge:master',true,()=>getDoc(J(ann,'knowledge:master'))],
   ['member reads knowledge:misses',false,()=>getDoc(J(ann,'knowledge:misses'))],
   ['admin reads knowledge:misses',true,()=>getDoc(J(adm,'knowledge:misses'))],
   ['member reads demo:',false,()=>getDoc(J(ann,'demo:ann-a-com:1'))],
   ['member writes knowledge:misses',false,()=>setDoc(J(ann,'knowledge:misses'),V({items:[]}),{merge:true})],
   ['member creates demo:',false,()=>setDoc(J(ann,'demo:ann-a-com:2'),V({token:'t'}))],
   ['member reads rateLimits',false,()=>getDoc(doc(ann,'rateLimits','x'))],
   ['admin writes rateLimits',false,()=>setDoc(doc(adm,'rateLimits','y'),{count:0})],
   ['member writes members doc',false,()=>setDoc(doc(ann,'members','ann@a.com'),{orgs:['T1','T2']})],
   ['member reads another members doc',false,()=>getDoc(doc(ann,'members','bob@a.com'))],
  ];
  let bad=0;
  const ALL=tests.concat(TT);
  for(const [name,ok,fn] of ALL){ try{ await (ok?assertSucceeds:assertFails)(fn()); console.log('PASS',name); }catch(e){ bad++; console.log('FAIL',name,'expected',ok?'allowed':'refused', String(e.message).slice(0,150)); } }
  console.log(bad?bad+' FAILED':'ALL '+ALL.length+' PASSED ('+tests.length+' Playbook + '+TT.length+' Twin Thieves)');
  await env.cleanup(); process.exit(bad?1:0);
})().catch(e=>{console.error(e);process.exit(2);});
