import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import {createHash,timingSafeEqual} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {createHandler,loadConfig} from './ingress.mjs';
import {ReceiveQueue} from './receive_queue.mjs';
import {isIPv4} from 'node:net';

function authorized(header,token){
  if(typeof header!=='string'||typeof token!=='string'||token.length<32)return false;
  const hash=text=>createHash('sha256').update(text).digest();
  return timingSafeEqual(hash(header),hash('Bearer '+token));
}
function reply(res,status,value){res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(value));}
export function intakeOnly(service){
  return (req,res)=>{
    if(!((req.method==='POST'&&req.url==='/inbound')||(req.method==='GET'&&req.url==='/healthz')))return reply(res,404,{ok:false});
    return service(req,res);
  };
}
function directOwner(route,tokens){
  if(!route)return null;
  const url=new URL(route.url);
  assert(isIPv4(url.hostname)&&/^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(url.hostname));
  assert.equal(url.href,'http://'+url.hostname+':19735/channel-inbound');
  assert(typeof route.token==='string'&&route.token.length>=32&&!tokens.includes(route.token));
  assert(/^[a-f0-9-]{36}$/.test(route.epoch)&&Array.isArray(route.senders)&&route.senders.length>0);
  assert(route.senders.every(s=>typeof s==='string'&&/^[0-9a-f]{64}$/.test(s)));
  const senders=new Set(route.senders);
  return {url:url.href,token:route.token,epoch:route.epoch,select(raw,epoch,instance){
    if(epoch!==route.epoch)return false;
    const body=JSON.parse(raw);
    const key=body?.data?.key;
    if(body?.instance!==instance||String(body.event).toLowerCase().replaceAll('_','.')!=='messages.upsert'||
        key?.fromMe!==false||typeof key.remoteJid!=='string'||!/^\d{6,20}@(lid|s\.whatsapp\.net)$/.test(key.remoteJid))return false;
    return senders.has(createHash('sha256').update(instance).update(Buffer.from([0])).update(key.remoteJid).digest('hex'));
  }};
}
function customerOwner(route,tokens){
  if(!route)return null;
  const url=new URL(route.url);
  assert(isIPv4(url.hostname)&&/^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(url.hostname));
  assert.equal(url.href,'http://'+url.hostname+':19736/channel-inbound');
  assert(typeof route.token==='string'&&route.token.length>=32&&!tokens.includes(route.token));
  assert(/^[a-f0-9-]{36}$/.test(route.epoch));
  const claimedDirect=route.claimedDirect===true;
  if(claimedDirect){
    assert(route.fixtureRecords===undefined&&route.fixtureOnly===undefined);
  }else{
    assert(route.claimedDirect===undefined&&Array.isArray(route.fixtureRecords)&&route.fixtureRecords.length>0&&
      route.fixtureRecords.every(id=>typeof id==='string'&&/^[0-9a-f]{64}$/.test(id))&&
      new Set(route.fixtureRecords).size===route.fixtureRecords.length);
    assert(route.fixtureOnly===undefined||route.fixtureOnly===true);
  }
  const fixtures=new Set(route.fixtureRecords);
  return {url:url.href,token:route.token,epoch:route.epoch,fixtureOnly:route.fixtureOnly===true,claimedDirect,
    directInput(raw){
      if(!claimedDirect)return false;
      const body=JSON.parse(raw),items=Array.isArray(body)?body:[body];
      return items.some(item=>{
        const key=item?.data?.key;
        return String(item?.event).toLowerCase().replaceAll('_','.')==='messages.upsert'&&
          key?.fromMe!==true&&typeof key?.remoteJid==='string'&&/@(lid|s\.whatsapp\.net)$/.test(key.remoteJid);
      });
    },
    owns:(id,epoch)=>epoch===route.epoch&&fixtures.has(id),select(raw,id,epoch,instance){
    if(epoch!==route.epoch||(!claimedDirect&&!fixtures.has(id)))return false;
    const body=JSON.parse(raw),key=body?.data?.key;
    return body?.instance===instance&&String(body.event).toLowerCase().replaceAll('_','.')==='messages.upsert'&&
      key?.fromMe===false&&typeof key.id==='string'&&/^[A-Za-z0-9_-]{6,160}$/.test(key.id)&&
      typeof key.remoteJid==='string'&&/^\d{6,20}@(lid|s\.whatsapp\.net)$/.test(key.remoteJid)&&
      !key.participant&&!key.participantAlt;
  }};
}
async function readId(req){
  let bytes=0;const chunks=[];
  for await(const chunk of req){bytes+=chunk.length;assert(bytes<=256);chunks.push(chunk);}
  const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));
  assert.deepEqual(Object.keys(body),['record_id']);assert.match(body.record_id,/^[0-9a-f]{64}$/);return body.record_id;
}

function dispatchRequest(path,input){
  const body=JSON.stringify(input);
  return new Promise((resolve,reject)=>{
    const request=http.request({socketPath:'/dispatch/dispatch.sock',path,method:'POST',
      signal:AbortSignal.timeout(path==='/resume-record'?60000:10000),headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}},res=>{
      let text='';
      res.setEncoding('utf8');
      res.on('error',reject);
      res.on('data',chunk=>{text+=chunk;if(text.length>1024)res.destroy(Error('receipt_response_limit'));});
      res.on('end',()=>{
        try{
          assert.equal(res.statusCode,200);
          resolve(JSON.parse(text));
        }catch(error){reject(error);}
      });
    });
    request.on('error',reject);request.end(body);
  });
}

async function observeDispatchRecord(id){
  const row=await dispatchRequest('/receipt-event',{record:id});
  for(const key of ['matched','waiting','confirmed'])assert(Number.isSafeInteger(row[key])&&row[key]>=0&&row[key]<=256);
  assert.equal(row.waiting+row.confirmed,row.matched);
  return row;
}

function outgoingReceipt(raw, instance){
  let body=JSON.parse(raw);
  if(Array.isArray(body)){
    if(body.length!==1)return false;
    [body]=body;
  }
  const event=String(body?.event).toLowerCase().replaceAll('_','.');
  if(body?.instance!==instance||!['messages.upsert','messages.update'].includes(event))return false;
  const rows=Array.isArray(body.data)?body.data:[body.data];
  return rows.some(row=>(row?.fromMe??row?.key?.fromMe)===true);
}

export function createReceiveService(config,route,queue,request=fetch,observe=observeDispatchRecord,parseBusiness=null){
  // The incoming JSON cannot choose an upstream, a recipient or a credential.
  const workflow=new URL(route.webhook), core=new URL(route.core);
  assert.equal(workflow.origin,'http://clock:5678');
  assert(/^\/webhook\/[a-zA-Z0-9-]{12,150}$/.test(workflow.pathname)&&!workflow.search&&!workflow.hash&&!workflow.username&&!workflow.password);
  assert.equal(core.href,'http://jp-core-transacional-dell:8791/api/n8n/inbound');
  assert(/^[a-zA-Z0-9]{8,32}$/.test(route.workflowId));
  assert(new Set([route.processToken,route.triggerToken,route.coreToken,config.token]).size===4);
  for(const token of [route.processToken,route.triggerToken,route.coreToken,config.token])assert(typeof token==='string'&&token.length>=32);
  const chat=directOwner(route.direct,[route.processToken,route.triggerToken,route.coreToken,config.token]);
  const customer=customerOwner(route.customer,[route.processToken,route.triggerToken,route.coreToken,config.token,chat?.token]);
  assert(!(customer?.fixtureOnly||customer?.claimedDirect)||!chat);
  if(route.nativeBusinessControls){
    assert(customer?.claimedDirect&&typeof parseBusiness==='function');
    const business=route.businessCore;
    assert(business?.url==='http://jp-core-operacional:8791/api/n8n/inbound' && typeof business.token==='string' && business.token.length>=32 &&
      ![config.token,route.processToken,route.triggerToken,route.coreToken,customer.token].includes(business.token) &&
      /^[A-Za-z0-9_-]{6,80}$/.test(business.node));
  }
  const observer=route.receiptObserver;
  if(observer){
    assert(/^[a-f0-9-]{36}$/.test(observer.epoch)&&typeof observer.fixtureOnly==='boolean');
    if(observer.fixtureOnly)assert(!customer&&!chat);
    else assert(!customer?.fixtureOnly);
    if(observer.fixtureOnly){
      assert(Array.isArray(observer.records)&&observer.records.length>0&&observer.records.every(id=>/^[a-f0-9]{64}$/.test(id)));
    }else assert(observer.records===undefined);
  }
  let waking=false,recoveryCursor=0;
  async function wake(limit){
    if(waking)return 0;
    waking=true;let attempted=0;
    try{
      recoveryCursor=queue.recoverPage(recoveryCursor).next;
      const ready=queue.ready(limit);
      if(observer?.resume===true)ready.unshift(...queue.readyContinuations(limit));
      for(const id of ready.slice(0,limit)){
        attempted++;
        // If n8n disappears before claiming, the record stays ready for the next n8n drain.
        // A claim without a final receipt stays claimed for reconciliation by that ID.
        try{
          const res=await request(workflow.href,{method:'POST',redirect:'error',signal:AbortSignal.timeout(chat||customer?140000:15000),
            headers:{'Content-Type':'application/json',Authorization:'Bearer '+route.triggerToken},body:JSON.stringify({record_id:id})});
          await res.body?.cancel();
          if(!res.ok)break;
        }catch{break;}
      }
    }finally{waking=false;}
    return attempted;
  }
  const ingress=createHandler(config,{
    reserve:id=>queue.reserve(id),
    committed:result=>{queue.committed(result);void wake(4).catch(()=>{});},
    health:()=>queue.health(),
  });
  return async(req,res)=>{
    if(req.url==='/inbound'||req.url==='/healthz')return ingress(req,res);
    if(req.method!=='POST'||!['/process','/drain','/resume'].includes(req.url))return reply(res,404,{ok:false});
    if(!authorized(req.headers.authorization,route.processToken))return reply(res,401,{ok:false});
    const workflowId=req.headers['x-jp-n8n-workflow-id'],execution=req.headers['x-jp-n8n-execution-id'];
    if(typeof execution!=='string'||!/^\d{1,20}$/.test(execution))return reply(res,403,{ok:false});
    if(req.url==='/drain'){
      if(!route.drainWorkflowId||workflowId!==route.drainWorkflowId)return reply(res,403,{ok:false});
      return reply(res,200,{ok:true,attempted:await wake(4)});
    }
    if(workflowId!==route.workflowId)return reply(res,403,{ok:false});
    let id;try{id=await readId(req);}catch{return reply(res,400,{ok:false});}
    if(req.url==='/resume'){
      if(observer?.resume!==true)return reply(res,403,{ok:false});
      const received=queue.status(id);
      if(received?.state!=='completed'||received.epoch!==observer.epoch||
          queue.owner().epoch!==observer.epoch)return reply(res,409,{ok:false});
      let outcome='no_continuation';
      if(received.outcome===JSON.stringify('confirmed_receipt')){
        outcome=queue.startContinuation(id,received.epoch,execution);
        if(outcome==='claimed'){
          try{
            const result=await dispatchRequest('/resume-record',{record:id,workflow:workflowId,execution,epoch:received.epoch});
            assert(['no_continuation','human','accepted','delivery_unknown'].includes(result.status));
            outcome=result.status;
          }catch{outcome='held';}
          queue.finishContinuation(id,execution,outcome);
        }
      }
      return reply(res,200,{ok:true,record_id:id,workflow:workflowId,execution,status:'retained',outcome});
    }
    let claimed;try{claimed=queue.claim(id,execution);}catch{return reply(res,409,{ok:false,reason:'held'});}
    if(claimed.state==='completed')return reply(res,200,{ok:true,duplicate:true,record_id:id,execution:claimed.execution,
      resume_pending:observer?.resume===true&&queue.status(id).outcome===JSON.stringify('confirmed_receipt')});
    try{
      let confirmed=false;
      if(observer){
        const permitted=observer.epoch===claimed.epoch&&(!observer.fixtureOnly||observer.records.includes(id));
        const outgoing=outgoingReceipt(claimed.raw,config.instance);
        if(outgoing&&!permitted&&!observer.fixtureOnly)throw Error('receipt_epoch_closed');
        if(permitted&&outgoing){
          const result=await observe(id);
          confirmed=observer.resume===true&&result.confirmed>0;
          if(customer?.claimedDirect && result.public_reply_receipt===true && result.matched===1){
            queue.finish(id,execution,true,confirmed?'confirmed_receipt':'processed');
            return reply(res,200,{ok:true,record_id:id,execution,status:'processed',resume_pending:confirmed});
          }
        }
        if(observer.fixtureOnly){
          queue.finish(id,execution,true,confirmed?'confirmed_receipt':'retained');
          return reply(res,200,{ok:true,record_id:id,execution,status:'retained',resume_pending:confirmed});
        }
      }
      if(customer?.fixtureOnly&&!customer.owns(id,claimed.epoch)){
        queue.finish(id,execution,true,'retained');
        return reply(res,200,{ok:true,record_id:id,execution,status:'retained'});
      }
      if((customer?.owns(id,claimed.epoch)||customer?.directInput(claimed.raw))&&
         !customer.select(claimed.raw,id,claimed.epoch,config.instance)){
        queue.finish(id,execution,true,'retained');
        return reply(res,200,{ok:true,record_id:id,execution,status:'retained'});
      }
      let owner=chat?.select(claimed.raw,claimed.epoch,config.instance)?chat:
        customer?.select(claimed.raw,id,claimed.epoch,config.instance)?customer:null;
      if(owner===customer && customer && route.nativeBusinessControls){
        const inbound=parseBusiness(JSON.parse(claimed.raw),config.instance);
        if(inbound && (inbound.quoted_message_id || ['confirmed','opt_out'].includes(inbound.intent))){
          const check=await request(new URL('/business-preflight',customer.url).href,{method:'POST',redirect:'error',
            signal:AbortSignal.timeout(125000),headers:{'Content-Type':'application/json',Authorization:'Bearer '+customer.token,
              'X-JP-Owner-Epoch':claimed.epoch,'X-JP-Control-Intent':['confirmed','opt_out'].includes(inbound.intent)?inbound.intent:'quoted',
              'X-JP-n8n-workflow-id':workflowId,'X-JP-n8n-execution-id':execution,'X-JP-Record-ID':id},body:claimed.raw});
          const proof=await check.json();
          assert(check.ok && proof.ok===true && proof.record_id===id && proof.execution===execution && proof.workflow===workflowId);
          if(proof.status==='retained'){
            queue.finish(id,execution,true,'retained');
            return reply(res,200,{ok:true,record_id:id,execution,status:'retained',resume_pending:false});
          }
          assert(proof.status==='business_ready' && proof.recipient===inbound.phone+'@s.whatsapp.net' &&
            proof.record_epoch===claimed.epoch && queue.owner().epoch===claimed.epoch && queue.status(id).state==='claimed');
          // Exactly one business consumer, with the unchanged provider envelope. Its
          // existing visit, opt-out and permission checks own any resulting effect.
          owner=route.businessCore;
        }
      }
      // Group events and unmatched provider receipts belong to the scheduler's ledger too.
      if(!owner && route.nativeBusinessControls){
        assert(queue.owner().epoch===claimed.epoch && queue.status(id).state==='claimed');
        owner=route.businessCore;
      }
      const result=await request(owner?.url||core.href,{method:'POST',redirect:'error',signal:AbortSignal.timeout(owner?125000:20000),
        headers:{'Content-Type':'application/json',Authorization:'Bearer '+(owner?.token||route.coreToken),
          ...(owner?{'X-JP-Owner-Epoch':claimed.epoch}:{}),
          ...(owner===route.businessCore && owner?{'X-JP-Node-ID':owner.node}:{}),
          'X-JP-n8n-workflow-id':workflowId,'X-JP-n8n-execution-id':execution,'X-JP-Record-ID':id},
        body:claimed.raw});
      const data=await result.json();
      assert(result.ok&&data.ok===true&&data.record_id===id&&data.workflow===workflowId&&data.execution===execution);
      assert(['processed','retained'].includes(data.status));
      queue.finish(id,execution,true,confirmed?'confirmed_receipt':data.status);
      return reply(res,200,{ok:true,record_id:id,execution,status:data.status,resume_pending:confirmed});
    }catch{
      // Covers rejection, loss of the HTTP response and an unexpected result shape.
      // Never manufacture a second Central call for an ambiguous business outcome.
      if(queue.status(id)?.state==='claimed')queue.finish(id,execution,false,'core_outcome_unconfirmed');
      return reply(res,503,{ok:false,record_id:id,reason:'requires_reconciliation'});
    }
  };
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  process.umask(0o077);
  const config=loadConfig({dir:'/data/records',keyFile:'/access/key',tokenFile:'/access/token',instanceFile:'/access/instance',
    source:'evolution',minFreeBytes:512*1024*1024});
  const route=JSON.parse(fs.readFileSync('/access/route.json'));
  const queue=new ReceiveQueue('/data/index',config.dir,config.key,config.instance);
  let parseBusiness=null;
  if(route.nativeBusinessControls){
    const contract=await import('/contract/jp-followup-core.mjs');
    parseBusiness=(event,instance)=>{
      const native=contract.parseEvolutionInbound(event,instance);
      if(native)return native;
      const content=contract.extractEvolutionContent(event.data?.message);
      return {intent:content.original_intent||contract.responseIntent(content.text),quoted_message_id:content.quoted_message_id,phone:null};
    };
  }
  const service=createReceiveService(config,route,queue,fetch,observeDispatchRecord,parseBusiness);
  const handler=(req,res)=>service(req,res).catch(()=>reply(res,503,{ok:false}));
  http.createServer(handler).listen(8787,'0.0.0.0');
  if(route.publicIntake===true)http.createServer(intakeOnly(handler)).listen(8790,'0.0.0.0');
}
