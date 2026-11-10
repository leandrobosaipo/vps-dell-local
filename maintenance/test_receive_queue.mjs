import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {recordId,persistRaw} from './ingress.mjs';
import {ReceiveQueue} from './receive_queue.mjs';
import {createReceiveService,intakeOnly} from './receive_service.mjs';

function setup(t){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'jp-queue-')));
  const index=path.join(root,'index'),records=path.join(root,'records');
  for(const p of [index,records])fs.mkdirSync(p,{mode:0o700});
  const config={source:'evolution',dir:records,key:randomBytes(32),instance:'fixture',token:randomBytes(32).toString('hex')};
  const queue=new ReceiveQueue(index,records,config.key,config.instance);
  const raw=n=>Buffer.from(JSON.stringify({instance:'fixture',event:'messages.upsert',data:{id:n}}));
  const id=b=>recordId(config.instance,b);
  const append=b=>{queue.reserve(id(b));queue.committed(persistRaw(config,b,null));};
  t.after(()=>{queue.close();fs.rmSync(root,{recursive:true});});
  return {queue,config,raw,id,append};
}
test('the external listener serves only the two intake operations',async t=>{
  const calls=[];const service=http.createServer(intakeOnly((req,res)=>{calls.push(req.url);res.end('ok');}));
  await new Promise(r=>service.listen(0,'127.0.0.1',r));t.after(()=>{service.closeAllConnections();service.close();});
  const base='http://127.0.0.1:'+service.address().port;
  for(const [method,path] of [['POST','/process'],['POST','/drain'],['GET','/inbound'],['POST','/inbound?path=drain'],['GET','/healthz'],['POST','/inbound']]){
    const r=await fetch(base+path,{method});assert.equal(r.status,['/inbound','/healthz'].includes(path)&&!(method==='GET'&&path==='/inbound')?200:404);
  }
  assert.deepEqual(calls,['/healthz','/inbound']);
});
test('continuation survives a missed n8n step, retains uncertain calls and cannot cross epochs',t=>{
  const {queue:q,config:c,raw,id,append}=setup(t);
  const first=raw(51),second=raw(52),epoch=randomUUID();
  q.changeOwner('',epoch);
  for(const b of [first,second]){
    append(b);q.claim(id(b),'51');q.finish(id(b),'51',true,'confirmed_receipt');
  }
  assert.deepEqual(q.readyContinuations(2),[id(first),id(second)]);
  assert.equal(q.startContinuation(id(first),epoch,'52'),'claimed');
  assert.throws(()=>q.startContinuation(id(first),epoch,'53'));
  q.finishContinuation(id(first),'52','delivery_unknown');
  assert.equal(q.startContinuation(id(first),epoch,'54'),'delivery_unknown');
  assert.deepEqual(q.readyContinuations(2),[id(second)]);
  q.changeOwner(epoch,'');q.changeOwner('',randomUUID());
  assert.deepEqual(q.readyContinuations(2),[]);
  assert.throws(()=>q.startContinuation(id(second),epoch,'55'));
});
test('the first observation owns eligibility across retries, cut and return',t=>{
  const {queue:q,config:c,raw,id,append}=setup(t);
  const [a,b,d,e]=[1,2,3,4].map(raw);
  persistRaw(c,a,null);append(b);const epoch=randomUUID();q.changeOwner('',epoch,id(d));
  append(a);append(b);append(d);append(d);append(e);
  assert.deepEqual(q.ready(10),[id(d)]);assert.equal(q.health().lastSequence,4);
  assert.deepEqual(q.claim(id(d),'18').raw,d);assert.throws(()=>q.claim(id(d),'19'));
  q.finish(id(d),'18',true,'retained');assert.equal(q.claim(id(d),'19').execution,'18');
  assert.throws(()=>q.changeOwner('',randomUUID()));q.changeOwner(epoch,'');
  assert.throws(()=>q.changeOwner('',epoch));assert.deepEqual(q.ready(),[]);
  assert.throws(()=>q.claim(id(a),'20'));assert.throws(()=>q.claim(id(e),'21'));
});
test('recover a reservation after durable write, retain on close and preserve unknown results',t=>{
  const {queue:q,config:c,raw,id,append}=setup(t);const epoch=randomUUID();q.changeOwner('',epoch);
  const b=raw(1),orphan=raw(2),pending=raw(3);
  q.reserve(id(b));persistRaw(c,b,null);assert.equal(q.recover(id(b)).state,'ready');
  q.claim(id(b),'90');q.finish(id(b),'90',false,'unconfirmed');assert.throws(()=>q.claim(id(b),'91'));
  q.reserve(id(orphan));assert.throws(()=>q.recover(id(orphan)));append(pending);
  q.changeOwner(epoch,'');append(orphan);assert.equal(q.status(id(orphan)).state,'retained');
  assert.equal(q.status(id(pending)).state,'retained');assert.equal(q.status(id(b)).state,'uncertain');
});
test('only a direct identity assigned to the current epoch goes to the chat consumer',async t=>{
  const {queue:q,config:c,id,append}=setup(t);const epoch=randomUUID(),jid='10000001@lid';
  const token=()=>randomBytes(32).toString('hex');
  const route={workflowId:'abcdefgh',webhook:'http://clock:5678/webhook/authorized-trigger',core:'http://jp-core-transacional-dell:8791/api/n8n/inbound',coreToken:token(),processToken:token(),triggerToken:token(),
    direct:{url:'http://172.18.0.1:19735/channel-inbound',token:token(),epoch,senders:[createHash('sha256').update('fixture\0'+jid).digest('hex')]}};
  assert.throws(()=>createReceiveService(c,{...route,direct:{...route.direct,url:'https://example.invalid'}},q));
  let expected;
  const calls=[];
  async function consume(url,opt){
    calls.push(url);assert.equal(opt.headers.Authorization,'Bearer '+(expected?route.direct.token:route.coreToken));
    assert.equal(opt.headers['X-JP-Owner-Epoch'],expected?epoch:undefined);
    return Response.json({ok:true,status:'retained',workflow:route.workflowId,execution:'70',record_id:id(opt.body)});
  }
  const service=http.createServer(createReceiveService(c,route,q,consume));
  await new Promise(r=>service.listen(0,'127.0.0.1',r));t.after(()=>{service.closeAllConnections();service.close();});
  q.changeOwner('',epoch);
  for(const [sender,own,ok] of [[jid,false,true],['10000002@lid',false,false],[jid,true,false],['10000001@g.us',false,false]]){
    expected=ok;const raw=Buffer.from(JSON.stringify({instance:'fixture',event:'messages.upsert',data:{key:{remoteJid:sender,fromMe:own}}}));append(raw);
    const res=await fetch('http://127.0.0.1:'+service.address().port+'/process',{method:'POST',headers:{Authorization:'Bearer '+route.processToken,'X-JP-n8n-workflow-id':route.workflowId,'X-JP-n8n-execution-id':'70'},body:JSON.stringify({record_id:id(raw)})});
    assert.equal(res.status,200);assert.equal(calls.at(-1),ok?route.direct.url:route.core);
  }
  assert.equal(calls.length,4);
});
test('current owner routes unseen direct inputs, retains stale or ambiguous direct claims',async t=>{
  const {queue:q,config:c,id,append}=setup(t),epoch=randomUUID(),token=()=>randomBytes(32).toString('hex');
  const route={workflowId:'abcdefgh',webhook:'http://clock:5678/webhook/authorized-trigger',
    core:'http://jp-core-transacional-dell:8791/api/n8n/inbound',coreToken:token(),processToken:token(),triggerToken:token(),
    customer:{url:'http://172.18.0.1:19736/channel-inbound',token:token(),epoch,claimedDirect:true}};
  assert.throws(()=>createReceiveService(c,{...route,customer:{...route.customer,fixtureOnly:true}},q));
  const calls=[];
  const service=http.createServer(createReceiveService(c,route,q,async (url,opt)=>{
    calls.push(url);
    return Response.json({ok:true,status:'retained',record_id:id(opt.body),workflow:'abcdefgh',execution:'71'});
  }));
  await new Promise(r=>service.listen(0,'127.0.0.1',r));t.after(()=>{service.closeAllConnections();service.close();});
  const body=(remoteJid,fromMe=false)=>({instance:'fixture',event:'messages.upsert',data:{key:{id:'FIXTURE001',remoteJid,fromMe}}});
  async function process(item){
    const b=Buffer.from(JSON.stringify(item));append(b);
    const response=await fetch('http://127.0.0.1:'+service.address().port+'/process',{method:'POST',headers:{
      Authorization:'Bearer '+route.processToken,'X-JP-n8n-workflow-id':route.workflowId,'X-JP-n8n-execution-id':'71'},
      body:JSON.stringify({record_id:id(b)})});
    assert.equal(response.status,200);
  }
  q.changeOwner('',epoch);
  await process(body('100000006@lid'));await process(body('5511960000001@s.whatsapp.net'));
  await process(body('100000002@g.us'));await process([body('100000005@lid')]);
  await process(body('100000005@lid',null));
  q.changeOwner(epoch,'');q.changeOwner('',randomUUID());
  await process(body('100000003@lid'));
  assert.deepEqual(calls,[route.customer.url,route.customer.url,route.core]);
});
test('public reply receipts are owned by the sender ledger and legacy receipts still reach the core',async t=>{
  const {queue:q,config:c,id,append}=setup(t),epoch=randomUUID(),token=()=>randomBytes(32).toString('hex');
  const route={workflowId:'abcdefgh',webhook:'http://clock:5678/webhook/authorized-trigger',
    core:'http://jp-core-transacional-dell:8791/api/n8n/inbound',coreToken:token(),processToken:token(),triggerToken:token(),
    customer:{url:'http://172.18.0.1:19736/channel-inbound',token:token(),epoch,claimedDirect:true},
    receiptObserver:{epoch,fixtureOnly:false,resume:true}};
  let owns=true, calls=0;
  const downstream=async(url,opt)=>{assert.equal(url,route.core);calls++;
    return Response.json({ok:true,record_id:id(opt.body),workflow:route.workflowId,execution:'91',status:'retained'});};
  const observer=async()=>({matched:1,confirmed:1,waiting:0,public_reply_receipt:owns});
  const service=http.createServer(createReceiveService(c,route,q,downstream,observer));
  await new Promise(r=>service.listen(0,'127.0.0.1',r));
  t.after(()=>{service.closeAllConnections();service.close();});q.changeOwner('',epoch);
  for(const publicPart of [true,false]){
    owns=publicPart;
    const b=Buffer.from(JSON.stringify({instance:'fixture',event:'messages.update',data:{keyId:'R'+owns,fromMe:true}}));
    append(b);
    const reply=await fetch('http://127.0.0.1:'+service.address().port+'/process',{method:'POST',headers:{
      Authorization:'Bearer '+route.processToken,'X-JP-n8n-workflow-id':route.workflowId,'X-JP-n8n-execution-id':'91'},
      body:JSON.stringify({record_id:id(b)})});
    assert.equal(reply.status,200);assert.equal((await reply.json()).resume_pending,true);
    assert.equal(calls,owns?0:1);
  }
});
test('one authenticated claim routes only enumerated customer fixture records',async t=>{
  const {queue:q,config:c,id,append}=setup(t),epoch=randomUUID();
  const raw=Buffer.from(JSON.stringify({instance:'fixture',event:'messages.upsert',data:{
    key:{id:'FIXTURE001',remoteJid:'100000001@lid',fromMe:false},message:{conversation:'Tabela fictícia'}}}));
  const other=Buffer.from(JSON.stringify({instance:'fixture',event:'messages.upsert',data:{
    key:{id:'FIXTURE002',remoteJid:'100000002@lid',fromMe:false},message:{conversation:'Tabela fictícia'}}}));
  const token=()=>randomBytes(32).toString('hex');
  const route={workflowId:'abcdefgh',webhook:'http://clock:5678/webhook/authorized-trigger',
    core:'http://jp-core-transacional-dell:8791/api/n8n/inbound',coreToken:token(),processToken:token(),triggerToken:token(),
    customer:{url:'http://172.18.0.1:19736/channel-inbound',token:token(),epoch,fixtureRecords:[id(raw)],fixtureOnly:true}};
  assert.throws(()=>createReceiveService(c,{...route,customer:{...route.customer,url:'https://external.invalid'}},q));
  const calls=[];
  async function consume(url,opt){
    calls.push({url,headers:opt.headers,body:opt.body});
    return Response.json({ok:true,status:'retained',record_id:id(opt.body),workflow:'abcdefgh',execution:'70'});
  }
  const service=http.createServer(createReceiveService(c,route,q,consume));
  await new Promise(r=>service.listen(0,'127.0.0.1',r));t.after(()=>{service.closeAllConnections();service.close();});
  q.changeOwner('',epoch);append(raw);append(other);
  const base='http://127.0.0.1:'+service.address().port;
  for(const b of [raw,other]){
    const res=await fetch(base+'/process',{method:'POST',headers:{Authorization:'Bearer '+route.processToken,
      'X-JP-n8n-workflow-id':'abcdefgh','X-JP-n8n-execution-id':'70'},body:JSON.stringify({record_id:id(b)})});
    assert.equal(res.status,200);
  }
  assert.equal(calls[0].url,route.customer.url);
  assert.equal(calls[0].headers.Authorization,'Bearer '+route.customer.token);
  assert.equal(calls[0].headers['X-JP-Owner-Epoch'],epoch);
  assert.equal(calls[0].headers['X-JP-Record-ID'],id(raw));
  assert.deepEqual(calls[0].body,raw);
  assert.equal(calls.length,1);
  assert.equal(q.status(id(raw)).state,'completed');
  assert.equal(q.status(id(other)).state,'completed');
});

test('claimed outgoing events notify the receipt socket by journal ID once',async t=>{
  const {queue:q,config:c,id,append}=setup(t),epoch=randomUUID();
  const event=(native,fromMe)=>Buffer.from(JSON.stringify({instance:c.instance,event:'messages.update',data:{
    keyId:native,fromMe,status:'DELIVERY_ACK'}}));
  const allowed=event('fixture-allowed',true), foreign=event('fixture-foreign',true), inbound=event('fixture-inbound',false);
  const token=()=>randomBytes(32).toString('hex');
  const route={workflowId:'abcdefgh',webhook:'http://clock:5678/webhook/authorized-trigger',
    core:'http://jp-core-transacional-dell:8791/api/n8n/inbound',coreToken:token(),processToken:token(),triggerToken:token(),
    receiptObserver:{epoch,fixtureOnly:true,records:[id(allowed),id(inbound)]}};
  const seen=[];
  const service=http.createServer(createReceiveService(c,route,q,()=>assert.fail('fixture reached a business route'),async record=>seen.push(record)));
  await new Promise(r=>service.listen(0,'127.0.0.1',r));t.after(()=>{service.closeAllConnections();service.close();});
  q.changeOwner('',epoch);
  for(const body of [allowed,foreign,inbound])append(body);
  for(const body of [allowed,allowed,foreign,inbound]){
    const response=await fetch('http://127.0.0.1:'+service.address().port+'/process',{method:'POST',
      headers:{Authorization:'Bearer '+route.processToken,'X-JP-n8n-workflow-id':route.workflowId,'X-JP-n8n-execution-id':'75'},
      body:JSON.stringify({record_id:id(body)})});
    assert.equal(response.status,200);
  }
  assert.deepEqual(seen,[id(allowed)]);
});
test('webhook forwards references only; authentic n8n claim sends the exact bytes once',async t=>{
  const {queue:q,config:c,raw,id}=setup(t);const bytes=raw(27),rid=id(bytes);
  const route={workflowId:'abcdefgh',webhook:'http://clock:5678/webhook/authorized-trigger',
    core:'http://jp-core-transacional-dell:8791/api/n8n/inbound',...Object.fromEntries(['processToken','coreToken','triggerToken'].map(k=>[k,randomBytes(32).toString('hex')]))};
  let base,trigger=0,core=0,actual='7',corrupt=false;
  async function processId(key,token=route.processToken,workflow=route.workflowId){
    return fetch(base+'/process',{method:'POST',headers:{Authorization:'Bearer '+token,
      'x-jp-n8n-workflow-id':workflow,'x-jp-n8n-execution-id':actual},body:JSON.stringify({record_id:key})});
  }
  async function downstream(url,options){
    if(url===route.webhook){
      trigger++;const body=JSON.parse(options.body);assert.deepEqual(Object.keys(body),['record_id']);
      assert.equal(options.headers.Authorization,'Bearer '+route.triggerToken);
      return new Response(null,{status:200});
    }
    assert.equal(url,route.core);core++;
    assert.equal(options.headers.Authorization,'Bearer '+route.coreToken);
    const key=options.headers['X-JP-Record-ID'];assert.equal(id(options.body),key);
    return Response.json({ok:true,record_id:corrupt?'wrong':key,workflow:route.workflowId,execution:actual,status:'retained'});
  }
  const service=http.createServer(createReceiveService(c,route,q,downstream));
  await new Promise(r=>service.listen(0,'127.0.0.1',r));base='http://127.0.0.1:'+service.address().port;
  t.after(()=>{service.closeAllConnections();service.close();});q.changeOwner('',randomUUID());
  const send=body=>fetch(base+'/inbound',{method:'POST',headers:{Authorization:'Bearer '+c.token},body});
  assert.equal((await send(bytes)).status,202);assert(trigger>0);
  assert.equal((await processId(rid,'incorrect')).status,401);
  assert.equal((await processId(rid,route.processToken,'other')).status,403);
  assert.equal((await processId(rid)).status,200);actual='8';assert((await (await processId(rid)).json()).duplicate);
  assert((await (await send(bytes)).json()).duplicate);assert.equal(core,1);
  corrupt=true;const newer=raw(28);await send(newer);assert.equal((await processId(id(newer))).status,503);
  assert.equal(q.status(id(newer)).state,'uncertain');assert.equal((await processId(id(newer))).status,409);
  assert.equal(core,2);
});
