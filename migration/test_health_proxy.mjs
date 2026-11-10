import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import {healthProxy} from './read_only_core.mjs';

test('only health requests pass and the scoped execution leaves a receipt',async(t)=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'health-fixture-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  async function listen(server){
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    t.after(()=>{server.closeAllConnections();server.close()});
    return server.address().port;
  }
  const upstream=await listen(http.createServer((req,res)=>res.end(JSON.stringify({ok:true,service:'jp-api'}))));
  const receipt=path.join(dir,'receipt');
  const port=await listen(healthProxy({port:upstream,workflowId:'fixture',receiptFile:receipt}));
  const url='http://127.0.0.1:'+port;
  assert.equal((await fetch(url+'/api/status')).status,404);
  assert.equal((await fetch(url+'/healthz',{method:'POST'})).status,404);
  assert.equal((await fetch(url+'/healthz')).status,200);
  await assert.rejects(fs.readFile(receipt),{code:'ENOENT'});
  assert.equal((await fetch(url+'/healthz',{headers:{'x-jp-n8n-execution-id':'42','x-jp-n8n-workflow-id':'fixture'}})).status,200);
  assert.equal(JSON.parse(await fs.readFile(receipt)).execution,'42');
});
