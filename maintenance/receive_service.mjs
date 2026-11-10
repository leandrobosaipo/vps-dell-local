import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import {createHash,timingSafeEqual} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {createHandler,loadConfig} from './ingress.mjs';
import {ReceiveQueue} from './receive_queue.mjs';

function authorized(header,token){
  if(typeof header!=='string'||typeof token!=='string'||token.length<32)return false;
  const hash=text=>createHash('sha256').update(text).digest();
  return timingSafeEqual(hash(header),hash('Bearer '+token));
}
function reply(res,status,value){res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(value));}
async function readId(req){
  let bytes=0;const chunks=[];
  for await(const chunk of req){bytes+=chunk.length;assert(bytes<=256);chunks.push(chunk);}
  const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));
  assert.deepEqual(Object.keys(body),['record_id']);assert.match(body.record_id,/^[0-9a-f]{64}$/);return body.record_id;
}

export function createReceiveService(config,route,queue,request=fetch){
  // The incoming JSON cannot choose an upstream, a recipient or a credential.
  const workflow=new URL(route.webhook), core=new URL(route.core);
  assert.equal(workflow.origin,'http://clock:5678');
  assert(/^\/webhook\/[a-zA-Z0-9-]{12,150}$/.test(workflow.pathname)&&!workflow.search&&!workflow.hash&&!workflow.username&&!workflow.password);
  assert.equal(core.href,'http://jp-core-transacional-dell:8791/api/n8n/inbound');
  assert(/^[a-zA-Z0-9]{8,32}$/.test(route.workflowId));
  assert(new Set([route.processToken,route.triggerToken,route.coreToken,config.token]).size===4);
  for(const token of [route.processToken,route.triggerToken,route.coreToken,config.token])assert(typeof token==='string'&&token.length>=32);
  let waking=false,recoveryCursor=0;
  async function wake(limit){
    if(waking)return 0;
    waking=true;let attempted=0;
    try{
      recoveryCursor=queue.recoverPage(recoveryCursor).next;
      for(const id of queue.ready(limit)){
        attempted++;
        // If n8n disappears before claiming, the record stays ready for the next n8n drain.
        // A claim without a final receipt stays claimed for reconciliation by that ID.
        try{
          const res=await request(workflow.href,{method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),
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
    if(req.method!=='POST'||!['/process','/drain'].includes(req.url))return reply(res,404,{ok:false});
    if(!authorized(req.headers.authorization,route.processToken))return reply(res,401,{ok:false});
    const workflowId=req.headers['x-jp-n8n-workflow-id'],execution=req.headers['x-jp-n8n-execution-id'];
    if(typeof execution!=='string'||!/^\d{1,20}$/.test(execution))return reply(res,403,{ok:false});
    if(req.url==='/drain'){
      if(!route.drainWorkflowId||workflowId!==route.drainWorkflowId)return reply(res,403,{ok:false});
      return reply(res,200,{ok:true,attempted:await wake(4)});
    }
    if(workflowId!==route.workflowId)return reply(res,403,{ok:false});
    let id;try{id=await readId(req);}catch{return reply(res,400,{ok:false});}
    let claimed;try{claimed=queue.claim(id,execution);}catch{return reply(res,409,{ok:false,reason:'held'});}
    if(claimed.state==='completed')return reply(res,200,{ok:true,duplicate:true,record_id:id,execution:claimed.execution});
    try{
      const result=await request(core.href,{method:'POST',redirect:'error',signal:AbortSignal.timeout(20000),
        headers:{'Content-Type':'application/json',Authorization:'Bearer '+route.coreToken,
          'X-JP-n8n-workflow-id':workflowId,'X-JP-n8n-execution-id':execution,'X-JP-Record-ID':id},
        body:claimed.raw});
      const data=await result.json();
      assert(result.ok&&data.ok===true&&data.record_id===id&&data.workflow===workflowId&&data.execution===execution);
      assert(['processed','retained'].includes(data.status));
      queue.finish(id,execution,true,data.status);
      return reply(res,200,{ok:true,record_id:id,execution,status:data.status});
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
  const service=createReceiveService(config,route,queue);
  http.createServer((req,res)=>service(req,res).catch(()=>reply(res,503,{ok:false}))).listen(8787,'0.0.0.0');
}
