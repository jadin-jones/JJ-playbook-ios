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
  });
  const who=(uid,email,prov)=>env.authenticatedContext(uid,{email,email_verified:true,firebase:{sign_in_provider:prov||'google.com'}}).firestore();
  const ann=who('uid-ann','ann@a.com'), bob=who('uid-bob','bob@a.com'), adm=who('uid-c','charlie@jadin-jones.com'),
        admMs=who('uid-cms','charlie@jadin-jones.com','microsoft.com'), mm1=who('uid-mm1','mm@a.com','microsoft.com'), mm2=who('uid-mm2','mm@a.com','microsoft.com');
  const J=(db,id)=>doc(db,'jj_playbook',id);
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
  ];
  let bad=0;
  for(const [name,ok,fn] of tests){ try{ await (ok?assertSucceeds:assertFails)(fn()); console.log('PASS',name); }catch(e){ bad++; console.log('FAIL',name,'expected',ok?'allowed':'refused', String(e.message).slice(0,150)); } }
  console.log(bad?bad+' FAILED':'ALL '+tests.length+' PASSED');
  await env.cleanup(); process.exit(bad?1:0);
})().catch(e=>{console.error(e);process.exit(2);});
