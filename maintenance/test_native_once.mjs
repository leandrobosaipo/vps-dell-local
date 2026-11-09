import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {snapshotNativeClient,startNativeReload,inspectNativeReload} from './evolution-native-once.mjs';

function fixture(t,behavior='success'){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'jp-native-once-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 let calls=0,ends=0;const qr={count:2,base64:'fictional-historical-qr'},creds={registered:false,me:{id:'fictional-account'},signedIdentityKey:{public:Buffer.from('fictional-identity-key')}};
 const client={ws:{isOpen:false,isClosed:true,isClosing:false,isConnecting:false,socket:{readyState:3}}};
 const target={instance:{name:'fictional',id:'fictional-id',integration:'WHATSAPP-BAILEYS',authState:{state:{creds}}},connectionStatus:{state:'open'},endSession:false,client,qrCode:qr,localSettings:{},async createClient(){},async reloadConnection(){calls++;if(behavior==='rejected')throw Error('fictional-secret-error');if(behavior==='pending')return new Promise(()=>{});this.client={ws:{isOpen:true,isClosed:false,isClosing:false,isConnecting:false,socket:{readyState:1},close(){this.isOpen=false;this.isClosed=true}},end(){ends++}};return{secret:'fictional-native-secret-return'}}};
 const controller={waMonitor:{waInstances:{fictional:target}}},before=snapshotNativeClient.call(target),expected={...before,closed_wrapper_evidence:null};
 return{target,controller,expected,client,qr,claim:path.join(dir,'jp-reloadConnection-20261109-once.json'),calls:()=>calls,ends:()=>ends};
}

test('actual native core claims once and discards the returned socket/secret',async t=>{
 const f=fixture(t),record=startNativeReload(f.controller,f.target,f.expected,f.claim);await new Promise(resolve=>setImmediate(resolve));
 const proof=inspectNativeReload(f.controller,f.target,record,f.expected,f.client);
 assert.equal(f.calls(),1);assert.equal(record.status,'resolved');assert.equal(proof.safety_stop,false);assert.equal(proof.new_client_observed,true);
 assert.equal(JSON.stringify(proof).includes('fictional-native-secret-return'),false);assert.equal(JSON.stringify(proof).includes('fictional-historical-qr'),false);
 assert.equal(fs.statSync(f.claim).mode&0o777,0o600);assert.throws(()=>startNativeReload(f.controller,f.target,f.expected,f.claim));assert.equal(f.calls(),1);
});

test('wrong registry, live socket, auth mismatch or call reply block before claiming',t=>{
 const f=fixture(t);assert.throws(()=>startNativeReload(f.controller,{...f.target},f.expected,f.claim));
 f.target.client.ws.isOpen=true;assert.throws(()=>startNativeReload(f.controller,f.target,f.expected,f.claim));f.target.client.ws.isOpen=false;
 assert.throws(()=>startNativeReload(f.controller,f.target,{...f.expected,auth:{...f.expected.auth,me_hash:'0'.repeat(64)}},f.claim));
 f.target.localSettings.msgCall='fictional';assert.throws(()=>startNativeReload(f.controller,f.target,f.expected,f.claim));assert.equal(f.calls(),0);assert.equal(fs.existsSync(f.claim),false);
});

test('rejection and unresolved outcome retain their claim and cannot repeat',async t=>{
 for(const state of ['rejected','pending']){const f=fixture(t,state),record=startNativeReload(f.controller,f.target,f.expected,f.claim);await new Promise(resolve=>setImmediate(resolve));assert.equal(record.status,state);assert.throws(()=>startNativeReload(f.controller,f.target,f.expected,f.claim));assert.equal(f.calls(),1);assert.equal(JSON.stringify(record).includes('fictional-secret-error'),false)}
});

test('new pairing or auth drift stops only the new client, without a second reload',async t=>{
 for(const reason of ['qr','auth']){const f=fixture(t),record=startNativeReload(f.controller,f.target,f.expected,f.claim);await new Promise(resolve=>setImmediate(resolve));
  if(reason==='qr')f.qr.count=3;else delete f.target.instance.authState.state.creds.me;
  const proof=inspectNativeReload(f.controller,f.target,record,f.expected,f.client);assert.equal(proof.safety_stop,true);assert.equal(proof.new_client_closed,true);assert.equal(f.target.endSession,true);assert.equal(f.calls(),1);assert.equal(f.ends(),1);
  inspectNativeReload(f.controller,f.target,record,f.expected,f.client);assert.equal(f.ends(),1);assert.equal(f.calls(),1);
 }
});
