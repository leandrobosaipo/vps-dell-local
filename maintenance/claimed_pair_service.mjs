// A mutually authenticated reader for one preconfigured native instance and epoch.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import https from 'node:https';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {proveRecordedSender} from './native_identity_proof.mjs';

export function servePair(cfg, tls, hmget) {
  assert(/^[a-f0-9]{64}$/.test(cfg.instanceIdHash)&&/^[a-f0-9-]{36}$/.test(cfg.epoch));
  assert(cfg.allowed===undefined||Array.isArray(cfg.allowed)&&cfg.allowed.every(id=>/^[a-f0-9]{64}$/.test(id)));
  assert(/^[a-f0-9]{64}$/.test(cfg.clientFingerprint));
  let active=0;
  const service=https.createServer({...tls,minVersion:'TLSv1.3',requestCert:true,rejectUnauthorized:true}, async(req,res)=>{
    const finish=(status,obj)=>res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'}).end(JSON.stringify(obj));
    const identity=req.socket.getPeerCertificate().raw;
    if(!req.socket.authorized||!identity||createHash('sha256').update(identity).digest('hex')!==cfg.clientFingerprint)
      return finish(403,{held:true});
    if(req.method!=='POST'||req.url!=='/v1/claimed-pair')return finish(404,{held:true});
    const id=req.headers['x-record-id'],epoch=req.headers['x-owner-epoch'],size=Number(req.headers['content-length']);
    if(!/^[0-9a-f]{64}$/.test(id)||epoch!==cfg.epoch||cfg.allowed&&!cfg.allowed.includes(id)||
        !Number.isSafeInteger(size)||size<1||size>1_000_000||req.headers['transfer-encoding'])return finish(403,{held:true});
    if(active>=4)return finish(503,{held:true});
    active++;
    try{
      const chunks=[];let count=0;
      for await(const part of req){count+=part.length;assert(count<=size);chunks.push(part);}
      assert.equal(count,size);
      const raw=Buffer.concat(chunks),scope={id,epoch,instance:cfg.instance,instanceIdHash:cfg.instanceIdHash};
      const proof=await proveRecordedSender({id,raw,meta:{source:'evolution',instance:cfg.instance}},scope,hmget);
      return finish(200,proof);
    }catch{return finish(409,{held:true});}
    finally{active--;}
  });
  service.requestTimeout=6000;service.headersTimeout=5000;service.maxConnections=12;
  return service;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const dir='/run/jp-pair/',cfg=JSON.parse(fs.readFileSync(dir+'settings.json'));
  const redis=createRequire(process.cwd()+'/package.json')('redis').createClient({
    url:cfg.redisUrl,disableOfflineQueue:true,socket:{connectTimeout:2000,reconnectStrategy:false}});
  redis.on('error',()=>{});
  await redis.connect();
  const tls=Object.fromEntries([['ca','client.crt'],['cert','server.crt'],['key','server.key']].map(([k,n])=>[k,fs.readFileSync(dir+n)]));
  const server=servePair(cfg,tls,async(instanceId,fields)=>{
    assert.equal(createHash('sha256').update(instanceId).digest('hex'),cfg.instanceIdHash);
    assert(fields.length>=1&&fields.length<=2&&fields.every(f=>/^lid-mapping-[0-9]{6,20}(_reverse)?$/.test(f)));
    return redis.sendCommand(['HMGET',cfg.prefix+':instance:'+instanceId,...fields]);
  });
  server.listen(8790,'0.0.0.0');
}
