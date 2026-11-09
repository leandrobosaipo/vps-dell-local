import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';

test('large compressed snapshot retains all IDs, unknowns and scalar maps in a bounded child', {timeout:45000},()=>{
 const script=String.raw`
 import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
 import assert from 'node:assert/strict';import {gzipSync,gunzipSync} from 'node:zlib';
 import {restore,digest,reconcile} from './migration/snapshot.mjs';
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'migration-large-fixture-'));
 fs.chmodSync(dir,0o700);
 try{
  const source={version:3,credits:{remaining:7},identity:{instance:'fixture'},authorization:{human:true},
    messages:Array.from({length:75000},(_,i)=>({message_id:'fixture-'+(i%10000),status:'delivery_unknown',body:'texto fictício '.repeat(8)}))};
  const raw=Buffer.from(JSON.stringify({fixture:true,payload:gzipSync(JSON.stringify(source)).toString('base64')}));
  const sourceFile=path.join(dir,'source.json'),targetFile=path.join(dir,'restored.json'),consumerFile=path.join(dir,'consumer.mjs');
  fs.writeFileSync(sourceFile,raw,{mode:0o600});
  fs.writeFileSync(consumerFile,"var stateReadCache = null;function load(){const serialized=decodeStateEnvelope(JSON.parse(fs.readFileSync(file)),encryptionKey);stateReadCache={serialized};return JSON.parse(serialized)}function reply(res,value){}",{mode:0o600});
  const codec={isEncryptedEnvelope:x=>x.fixture===true,decodeStateEnvelope:x=>gunzipSync(Buffer.from(x.payload,'base64')).toString('utf8')};
  const result=restore({sourceFile,targetFile,consumerFile,codec,key:Buffer.alloc(32),expectedHash:digest(raw)});
  assert.equal(result.proof.arrayRecordsVerified,75000);assert.equal(result.state.messages[0].status,'delivery_unknown');
  assert.equal(result.state.credits.remaining,7);assert.equal(result.state.identity.instance,'fixture');
  assert.throws(()=>reconcile(result.state,{...result.state,credits:{remaining:0}}),/snapshot_semantic_mismatch/);
  console.log('large_snapshot_verified');
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
 `;
 const child=spawnSync(process.execPath,['--max-old-space-size=256','--input-type=module','-e',script],{cwd:new URL('..',import.meta.url),encoding:'utf8',timeout:40000,maxBuffer:262144});
 assert.equal(child.status,0,`bounded snapshot child failed: signal=${child.signal}; ${child.stderr.slice(-2000)}`);
 assert.match(child.stdout,/large_snapshot_verified/);
});
