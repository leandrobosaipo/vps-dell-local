// The captured API listens on loopback. Only health checks are reachable on the Docker network.
import http from 'node:http';
import fs from 'node:fs';
import crypto from 'node:crypto';
import {pathToFileURL} from 'node:url';

export function healthProxy({port,workflowId,receiptFile}){
  return http.createServer(async(req,res)=>{
    const send=(status,body)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(body));};
    if(req.method!=='GET'||!['/healthz','/healthz/flow'].includes(req.url))return send(404,{error:'unavailable'});
    try{
      const upstream=await fetch('http://127.0.0.1:'+port+req.url,{redirect:'error',signal:AbortSignal.timeout(4000)});
      const status=await upstream.json();
      if(req.url==='/healthz' && upstream.ok && status.ok===true && status.service==='jp-api'){
        const execution=req.headers['x-jp-n8n-execution-id'];
        if(req.headers['x-jp-n8n-workflow-id']===workflowId && typeof execution==='string' && /^[1-9][0-9]{0,18}$/.test(execution)){
          const tmp=receiptFile+'.new';
          fs.writeFileSync(tmp,JSON.stringify({workflowId,execution,observedAt:new Date().toISOString()}),{mode:0o600});
          fs.renameSync(tmp,receiptFile);
        }
        return send(200,{ok:true,service:'jp-api',mode:'read_only'});
      }
      if(req.url==='/healthz/flow')return send(upstream.status,{ok:status.ok===true,mode:status.mode});
      return send(503,{ok:false});
    }catch{return send(503,{ok:false});}
  });
}

if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href){
  const key=fs.readFileSync('/secrets/key');
  if(key.length!==32)throw Error('invalid_key');
  Object.assign(process.env,{JP_STATE_ENCRYPTION_KEY:key.toString('hex'),JP_LOCAL_API_HOST:'127.0.0.1',
    JP_LOCAL_API_PORT:'18791',JP_LOCAL_API_READ_TOKEN:crypto.randomUUID(),JP_LOCAL_API_OPERATE_TOKEN:crypto.randomUUID(),
    JP_EVOLUTION_INSTANCE:fs.readFileSync('/secrets/instance','utf8').trim(),JP_LOCAL_API_STATE:'/lab/local-state.json'});
  key.fill(0);
  await import('file:///lab/scripts/jp-evolution-local-api.mjs');
  healthProxy({port:18791,workflowId:fs.readFileSync('/secrets/monitor','utf8').trim(),
    receiptFile:'/tmp/last-health.json'}).listen(8791,'0.0.0.0');
}
