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
