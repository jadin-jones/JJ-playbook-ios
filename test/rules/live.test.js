/* The cases checked before the rules went live on test-6b2ab (8 Oct 2026),
 * replacing the Sept 25 open rules. Same harness as rules.test.js:
 *
 *   node live.test.js <path to firestore.rules>   (inside the emulator; npm test runs it)
 *
 * Focus: nobody signed out reads or writes anything; a Playbook member never
 * reads a Twin Thieves name or email (sample- and __preview__ keys included);
 * a Twin Thieves member reads only their own record; tt_data and jj_lifeplan
 * are admin-only.
 */
const fs=require('fs');
const {initializeTestEnvironment,assertSucceeds,assertFails}=require('@firebase/rules-unit-testing');
const {doc,getDoc,setDoc,deleteDoc,collection,getDocs,query,where,documentId}=require('firebase/firestore');
const V=o=>({value:JSON.stringify(o)});
(async()=>{
  if(!process.argv[2]) throw new Error('usage: node live.test.js <path to firestore.rules>');
  const env=await initializeTestEnvironment({projectId:'demo-jj',firestore:{rules:fs.readFileSync(process.argv[2],'utf8'),host:'127.0.0.1',port:8089}});
  await env.withSecurityRulesDisabled(async c=>{ const d=c.firestore(); const J=id=>doc(d,'jj_playbook',id);
    const own=(o,e)=>Object.assign(V(o),{ownerEmail:e});
    await setDoc(doc(d,'members','ann@a.com'),{orgs:['T1']});
    await setDoc(doc(d,'members','dual@a.com'),{orgs:['T1']});
    for (const e of ['tia@s.org','zed@s.org','sample-sam@s.org','ms@s.org','msok@s.org','unv@s.org','dual@a.com']) await setDoc(doc(d,'ttmembers',e),{orgs:['TT36']});
    await setDoc(doc(d,'msVerified','uid-msok'),{email:'msok@s.org'});
    await setDoc(J('org:T1'),V({name:'T'}));
    await setDoc(J('org:TT36'),V({product:'tt',ttVersion:36,joinCode:'TWIN36'}));
    await setDoc(J('ttlib:master'),V({lessons:[],order36:[],order10:[]}));
    await setDoc(J('program:master'),V({modules:[]}));
    await setDoc(J('knowledge:master'),V({items:[]}));
    await setDoc(J('resp:T1:ann-a-com'),own({email:'ann@a.com'},'ann@a.com'));
    await setDoc(J('resp:T1:dual-a-com'),own({email:'dual@a.com'},'dual@a.com'));
    await setDoc(J('resp:T1:__preview__'),V({name:'Preview'}));
    await setDoc(J('resp:T1:sample-1'),V({name:'Sample'}));
    for (const [id,e] of [['tia-s-org','tia@s.org'],['zed-s-org','zed@s.org'],['sample-sam-s-org','sample-sam@s.org'],['ms-s-org','ms@s.org'],['msok-s-org','msok@s.org'],['unv-s-org','unv@s.org'],['dual-a-com','dual@a.com']])
      await setDoc(J('ttm:TT36:'+id),own({name:id,email:e,progress:{}},e));
    await setDoc(J('ttm:TT36:__preview__'),V({name:'Preview',email:'p@s.org'}));
    await setDoc(J('ttinv:TT36:abc'),Object.assign(V({email:'new@s.org',status:'invited'}),{tokenHash:'h'}));
    await setDoc(J('ttallow:TT36'),V({emails:['tia@s.org']}));
    await setDoc(J('rev:TT36:gone-s-org'),V({email:'gone@s.org'}));
    await setDoc(J('rev:TT36:sample-x-s-org'),V({email:'sample-x@s.org'}));
    await setDoc(doc(d,'tt_data','x'),{a:1}); await setDoc(doc(d,'jj_lifeplan','x'),{a:1});
  });
  const who=(uid,email,prov,ver)=>env.authenticatedContext(uid,{email,email_verified:ver!==false,firebase:{sign_in_provider:prov||'google.com'}}).firestore();
  const anon=env.unauthenticatedContext().firestore();
  const ann=who('uid-ann','ann@a.com'), tia=who('uid-tia','tia@s.org'), sam=who('uid-sam','sample-sam@s.org'),
        adm=who('uid-c','charlie@jadin-jones.com'), admMs=who('uid-cms','charlie@jadin-jones.com','microsoft.com'),
        ms=who('uid-ms','ms@s.org','microsoft.com'), msok=who('uid-msok','msok@s.org','microsoft.com'),
        unv=who('uid-unv','unv@s.org','password',false), dual=who('uid-dual','dual@a.com');
  const J=(db,id)=>doc(db,'jj_playbook',id);
  const range=(db,p)=>getDocs(query(collection(db,'jj_playbook'),where(documentId(),'>=',p),where(documentId(),'<',p+'')));
  const tests=[
   // Not signed in: everything the Sept 25 rules left open is closed.
   ['anon reads org:T1',false,()=>getDoc(J(anon,'org:T1'))],
   ['anon reads a Playbook resp',false,()=>getDoc(J(anon,'resp:T1:ann-a-com'))],
   ['anon reads a TT ttm',false,()=>getDoc(J(anon,'ttm:TT36:tia-s-org'))],
   ['anon lists jj_playbook',false,()=>getDocs(collection(anon,'jj_playbook'))],
   ['anon writes jj_playbook',false,()=>setDoc(J(anon,'org:T1'),V({x:1}),{merge:true})],
   ['anon reads tt_data',false,()=>getDoc(doc(anon,'tt_data','x'))],
   ['anon writes tt_data',false,()=>setDoc(doc(anon,'tt_data','y'),{a:1})],
   ['anon reads jj_lifeplan',false,()=>getDoc(doc(anon,'jj_lifeplan','x'))],
   ['anon writes jj_lifeplan',false,()=>setDoc(doc(anon,'jj_lifeplan','y'),{a:1})],
   ['anon reads ttmembers',false,()=>getDoc(doc(anon,'ttmembers','tia@s.org'))],
   // Playbook member vs every TT record holding a name or email.
   ['PB member reads a TT student',false,()=>getDoc(J(ann,'ttm:TT36:tia-s-org'))],
   ['PB member reads a TT student whose slug starts sample-',false,()=>getDoc(J(ann,'ttm:TT36:sample-sam-s-org'))],
   ['PB member reads ttm:TT36:__preview__',false,()=>getDoc(J(ann,'ttm:TT36:__preview__'))],
   ['PB member reads a TT invite',false,()=>getDoc(J(ann,'ttinv:TT36:abc'))],
   ['PB member reads a TT approved list',false,()=>getDoc(J(ann,'ttallow:TT36'))],
   ['PB member reads a TT tombstone',false,()=>getDoc(J(ann,'rev:TT36:gone-s-org'))],
   ['PB member reads a TT tombstone, sample- slug',false,()=>getDoc(J(ann,'rev:TT36:sample-x-s-org'))],
   ['PB member reads a TT ttmembers doc',false,()=>getDoc(doc(ann,'ttmembers','tia@s.org'))],
   ['PB member lists ttmembers',false,()=>getDocs(collection(ann,'ttmembers'))],
   ['PB member lists ttm:TT36:',false,()=>range(ann,'ttm:TT36:')],
   ['PB member reads org:TT36',false,()=>getDoc(J(ann,'org:TT36'))],
   ['PB member creates a TT record',false,()=>setDoc(J(ann,'ttm:TT36:ann-a-com'),Object.assign(V({}),{ownerEmail:'ann@a.com'}))],
   ['PB member reads jj_lifeplan',false,()=>getDoc(doc(ann,'jj_lifeplan','x'))],
   ['PB member writes tt_data',false,()=>setDoc(doc(ann,'tt_data','x'),{a:2})],
   // The tightening leaves the Playbook's own preview/sample reads alone.
   ['PB member reads resp:T1:__preview__',true,()=>getDoc(J(ann,'resp:T1:__preview__'))],
   ['PB member reads resp:T1:sample-1',true,()=>getDoc(J(ann,'resp:T1:sample-1'))],
   ['PB member reads own resp',true,()=>getDoc(J(ann,'resp:T1:ann-a-com'))],
   // TT student: own things only, nothing of the Playbook.
   ['TT student reads own ttm',true,()=>getDoc(J(tia,'ttm:TT36:tia-s-org'))],
   ['TT student (sample- slug) reads own ttm',true,()=>getDoc(J(sam,'ttm:TT36:sample-sam-s-org'))],
   ['TT student (sample- slug) saves own progress',true,()=>setDoc(J(sam,'ttm:TT36:sample-sam-s-org'),Object.assign(V({progress:{a:1}}),{ownerEmail:'sample-sam@s.org'}),{merge:true})],
   ['TT student reads a sample- classmate',false,()=>getDoc(J(tia,'ttm:TT36:sample-sam-s-org'))],
   ['TT student reads ttm:TT36:__preview__',false,()=>getDoc(J(tia,'ttm:TT36:__preview__'))],
   ['TT student reads a TT invite',false,()=>getDoc(J(tia,'ttinv:TT36:abc'))],
   ['TT student reads the approved list',false,()=>getDoc(J(tia,'ttallow:TT36'))],
   ['TT student reads a Playbook resp',false,()=>getDoc(J(tia,'resp:T1:ann-a-com'))],
   ['TT student reads resp:T1:__preview__',false,()=>getDoc(J(tia,'resp:T1:__preview__'))],
   ['TT student reads org:T1',false,()=>getDoc(J(tia,'org:T1'))],
   ['TT student reads members/ann',false,()=>getDoc(doc(tia,'members','ann@a.com'))],
   ['TT student lists jj_playbook',false,()=>getDocs(collection(tia,'jj_playbook'))],
   ['TT student creates a TT10 record (not a member)',false,()=>setDoc(J(tia,'ttm:TT10:tia-s-org'),Object.assign(V({}),{ownerEmail:'tia@s.org'}))],
   ['TT student reads tt_data',false,()=>getDoc(doc(tia,'tt_data','x'))],
   ['TT student reads the library',true,()=>getDoc(J(tia,'ttlib:master'))],
   ['TT student reads org:TT36',true,()=>getDoc(J(tia,'org:TT36'))],
   // Sign-in checks apply to TT too.
   ['TT unverified email reads own ttm',false,()=>getDoc(J(unv,'ttm:TT36:unv-s-org'))],
   ['TT Microsoft, unconfirmed, reads own ttm',false,()=>getDoc(J(ms,'ttm:TT36:ms-s-org'))],
   ['TT Microsoft, confirmed, reads own ttm',true,()=>getDoc(J(msok,'ttm:TT36:msok-s-org'))],
   // In both products.
   ['dual reads own Playbook resp',true,()=>getDoc(J(dual,'resp:T1:dual-a-com'))],
   ['dual reads own TT ttm',true,()=>getDoc(J(dual,'ttm:TT36:dual-a-com'))],
   ['dual reads a TT classmate',false,()=>getDoc(J(dual,'ttm:TT36:tia-s-org'))],
   // Admins.
   ['admin reads a TT student',true,()=>getDoc(J(adm,'ttm:TT36:tia-s-org'))],
   ['admin lists ttm:TT36: (Studio)',true,()=>range(adm,'ttm:TT36:')],
   ['admin reads a TT invite',true,()=>getDoc(J(adm,'ttinv:TT36:abc'))],
   ['admin reads jj_lifeplan',true,()=>getDoc(doc(adm,'jj_lifeplan','x'))],
   ['Microsoft admin reads a TT student',false,()=>getDoc(J(admMs,'ttm:TT36:tia-s-org'))],
  ];
  let bad=0;
  for (const [name,allow,fn] of tests){ try{ await (allow?assertSucceeds(fn()):assertFails(fn())); console.log('ok  ',name); }catch(e){ bad++; console.log('FAIL',name,'(expected '+(allow?'allowed':'refused')+')'); } }
  console.log(bad?bad+' FAILED':'ALL '+tests.length+' PASSED');
  await env.cleanup(); process.exit(bad?1:0);
})().catch(e=>{console.error(e);process.exit(2);});
