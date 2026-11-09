import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {nativeCommand} from './evolution-native-runner.mjs';

const linux=process.platform==='linux';
async function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'jp-native-runner-')),file=path.join(dir,'fixture.cjs');
 const mod=new URL('./evolution-native-once.mjs',import.meta.url).href;
 const code=`(async()=>{const http=require('http'),{snapshotNativeClient}=await import(${JSON.stringify(mod)});let calls=0;
 const closed=()=>({ws:{isOpen:false,isClosed:true,isClosing:false,isConnecting:false,socket:{readyState:3}}});
 const target={instance:{name:'fictional',id:'fictional-id',integration:'WHATSAPP-BAILEYS',authState:{state:{creds:{me:{id:'fictional-account'},signedIdentityKey:{public:Buffer.from('fictional-key')}}}}},client:closed(),connectionStatus:{state:'open'},endSession:false,localSettings:{},qrCode:{count:0},async createClient(){},async reloadConnection(){calls++;this.client={ws:{isOpen:true,isClosed:false,isClosing:false,isConnecting:false,socket:{readyState:1}}};return {auth:'fictional-private-native-result'}}};
 const Ke={waMonitor:{waInstances:{fictional:target}},restartInstance(){throw Error('must_not_call_restart')}};
 function wrap(fn){return function newFn(...args){return fn.apply(this,args)}}
 function route(){return Ke.restartInstance()}
 const app=(req,res)=>res.end('fictional');app._router={stack:[{route:{path:'/restart/:instanceName',methods:{post:true},stack:[{handle:wrap(route)}]}}]};
 const server=http.createServer(app);server.listen(0,'127.0.0.1',()=>console.log(JSON.stringify({port:server.address().port,proof:snapshotNativeClient.call(target)})));
 process.on('message',message=>{if(message==='reset')target.client=closed();process.send({calls})});})();`;
 fs.writeFileSync(file,code);
 const child=spawn(process.execPath,[file],{cwd:dir,stdio:['ignore','pipe','pipe','ipc']});
 t.after(async()=>{child.kill('SIGKILL');await new Promise(resolve=>{if(child.exitCode!==null||child.signalCode)resolve();else child.once('exit',resolve)});fs.rmSync(dir,{recursive:true,force:true})});
 const first=await new Promise((resolve,reject)=>{let output='';child.stdout.on('data',chunk=>{output+=chunk;if(output.includes('\n'))resolve(JSON.parse(output.split('\n')[0]))});child.once('exit',()=>reject(Error('fixture_early_exit')))});
 const expected={...first.proof,source_main_sha256:crypto.createHash('sha256').update(code).digest('hex')};
 return{child,dir,file,expected,runtime:{argument:file,cwd:dir,source:file,port:first.port},claim:path.join(dir,'jp-reloadConnection-20261109-once.json')};
}
async function run(options){
 const child=spawn(process.execPath,['-e',nativeCommand(options)],{stdio:['ignore','pipe','pipe']});let raw='';child.stdout.on('data',chunk=>{raw+=chunk});
 const exit=await new Promise(resolve=>child.once('exit',resolve));assert.equal(exit,0);return JSON.parse(raw);
}
async function stats(child,command='stats'){const promise=new Promise(resolve=>child.once('message',resolve));child.send(command);return promise}

test('bounded inspector selector finds only the wrapped native controller without a call',{skip:!linux},async t=>{
 const f=await fixture(t),result=await run({mode:'inspect',expected:f.expected,runtime:f.runtime});
 assert.equal(result.explicit_calls,0,JSON.stringify(result));assert.equal(result.gates.can_attempt_once,true);assert.equal((await stats(f.child)).calls,0);assert.equal(fs.existsSync(f.claim),false);
});

test('same runner claims once and suppresses a secret native return; claimed retry cannot call',{skip:!linux},async t=>{
 const f=await fixture(t),options={mode:'apply',external_fence_verified:true,expected:f.expected,runtime:f.runtime,claim_file:f.claim,observe_ms:2000};
 const first=await run(options);assert.equal(first.explicit_calls,1,JSON.stringify(first));assert.equal(first.status,'resolved');assert.equal(first.safety_stop,false);assert.equal((await stats(f.child)).calls,1);assert.equal(JSON.stringify(first).includes('fictional-private-native-result'),false);
 await stats(f.child,'reset');const second=await run(options);assert.equal(second.error,'native_projection_failed');assert.equal((await stats(f.child)).calls,1);assert.equal(fs.statSync(f.claim).mode&0o777,0o600);
});
