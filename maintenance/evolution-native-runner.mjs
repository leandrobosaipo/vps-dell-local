import {validateNativeTarget} from './evolution-native-guard.mjs';
import {snapshotNativeClient,startNativeReload,inspectNativeReload} from './evolution-native-once.mjs';

// Administrative child only. No listener, HTTP sender, pairing or instance API.
export async function operateNativeClient(options) {
 const fs=require('node:fs'),net=require('node:net'),crypto=require('node:crypto');
 const runtime=options.runtime||{argument:'dist/main',cwd:'/evolution',source:'/evolution/dist/main.js',port:8080};
 const expected=options.expected,mode=options.mode||'inspect';
 if(!['inspect','apply'].includes(mode)||!expected||crypto.createHash('sha256').update(fs.readFileSync(runtime.source)).digest('hex')!==expected.source_main_sha256)throw Error('native_source_guard');
 if(mode==='apply'&&options.external_fence_verified!==true)throw Error('external_fence_not_verified');
 const pids=fs.readdirSync('/proc').filter(n=>/^\d+$/.test(n)&&n!==String(process.pid)).filter(n=>{try{const a=fs.readFileSync('/proc/'+n+'/cmdline','utf8').split('\0');return a[0]?.endsWith('node')&&a.includes(runtime.argument)&&fs.readlinkSync('/proc/'+n+'/cwd')===runtime.cwd}catch{return false}});
 if(pids.length!==1)throw Error('native_process_identity_ambiguous');
 await new Promise((resolve,reject)=>{const s=net.connect({host:'127.0.0.1',port:9229}),timer=setTimeout(()=>{s.destroy();reject(Error('inspector_port_uncertain'))},800);s.once('connect',()=>{clearTimeout(timer);s.destroy();reject(Error('existing_inspector_preserved'))});s.once('error',e=>{clearTimeout(timer);e.code==='ECONNREFUSED'?resolve():reject(Error('inspector_port_uncertain'))})});
 process.kill(Number(pids[0]),'SIGUSR1');let ws,id=0;const pending=new Map();
 try{
  let target;for(let n=0;n<30;n++){try{const rows=await(await fetch('http://127.0.0.1:9229/json/list',{signal:AbortSignal.timeout(700)})).json();if(rows.length!==1)throw Error('inspector_target_ambiguous');target=rows[0];break}catch(error){if(error.message==='inspector_target_ambiguous')throw error;await new Promise(r=>setTimeout(r,100))}}
  if(!target)throw Error('inspector_unavailable');const url=new URL(target.webSocketDebuggerUrl);if(url.protocol!=='ws:'||url.hostname!=='127.0.0.1'||url.port!=='9229')throw Error('inspector_target_guard');
  ws=new WebSocket(url);ws.addEventListener('message',event=>{const row=JSON.parse(event.data),p=pending.get(row.id);if(p){pending.delete(row.id);row.error?p.reject(Error('inspector_command_failed')):p.resolve(row.result)}});
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('inspector_socket_timeout')),1500);ws.addEventListener('open',()=>{clearTimeout(timer);resolve()},{once:true});ws.addEventListener('error',()=>{clearTimeout(timer);reject(Error('inspector_socket_failed'))},{once:true})});
  const send=(method,params)=>new Promise((resolve,reject)=>{const n=++id,t=setTimeout(()=>{pending.delete(n);reject(Error('inspector_command_timeout'))},5000);pending.set(n,{resolve:r=>{clearTimeout(t);resolve(r)},reject:e=>{clearTimeout(t);reject(e)}});ws.send(JSON.stringify({id:n,method,params}))});
  const call=async(objectId,functionDeclaration,args=[],byValue=false)=>{const row=await send('Runtime.callFunctionOn',{objectId,functionDeclaration,arguments:args,returnByValue:byValue});if(row.exceptionDetails)throw Error('native_projection_failed');return row.result};
  const app=await send('Runtime.evaluate',{expression:`(()=>{const a=process._getActiveHandles().filter(h=>h.constructor?.name==='Server'&&h.address()?.port===${Number(runtime.port)});return a.length===1?a[0].listeners('request')[0]:null})()`});if(!app.result?.objectId)throw Error('native_server_missing');
  const wrapper=await call(app.result.objectId,'function(){const a=[];function walk(stack,d){for(const l of stack||[]){if(l.route?.path==="/restart/:instanceName"&&l.route.methods?.post)a.push(l.route.stack.at(-1).handle);else if(l.handle?.stack&&d<5)walk(l.handle.stack,d+1)}}walk(this._router?.stack,0);return a.length===1?a[0]:null}');if(!wrapper.objectId)throw Error('native_route_missing');
  async function scopesOf(objectId){const p=await send('Runtime.getProperties',{objectId,ownProperties:true}),id=p.internalProperties?.find(p=>p.name==='[[Scopes]]')?.value?.objectId;if(!id)throw Error('native_scopes_missing');const a=await send('Runtime.getProperties',{objectId:id,ownProperties:true});return a.result.filter(p=>p.value?.objectId&&!/Global/.test(p.value.description||'')).slice(0,8)}
  let handler;for(const scope of await scopesOf(wrapper.objectId)){const p=await send('Runtime.getProperties',{objectId:scope.value.objectId,ownProperties:true}),fn=p.result?.find(v=>v.name==='fn')?.value;if(fn?.type==='function'){const source=await call(fn.objectId,'function(){return Function.prototype.toString.call(this)}');if(source.value?.includes('Ke.restartInstance')){handler=fn.objectId;break}}}if(!handler)throw Error('native_async_handler_missing');
  let controller;for(const scope of await scopesOf(handler)){const p=await send('Runtime.getProperties',{objectId:scope.value.objectId,ownProperties:true});controller=p.result?.find(v=>v.name==='Ke')?.value?.objectId;if(controller)break}if(!controller)throw Error('native_controller_missing');
  const instance=await call(controller,'function(expected){const c=process.getBuiltinModule("crypto"),h=v=>c.createHash("sha256").update(String(v)).digest("hex"),a=Object.entries(this.waMonitor.waInstances).filter(([name])=>h(name)===expected);return a.length===1?a[0][1]:null}',[{value:expected.instance_name_hash}]);if(!instance.objectId)throw Error('native_registry_missing');
  const projection=await call(instance.objectId,snapshotNativeClient.toString(),[],true),before=projection.value;
  const gates=validateNativeTarget(before,expected);
  if(mode==='inspect')return{at:new Date().toISOString(),mode,proof:before,gates,explicit_calls:0};
  if(!gates.can_attempt_once)throw Error('native_target_gate_denied');
  const old=await call(instance.objectId,'function(){return this.client}');if(!old.objectId)throw Error('native_old_client_missing');
  const definitions='const validateNativeTarget='+validateNativeTarget.toString()+';const snapshotNativeClient='+snapshotNativeClient.toString()+';';
  const invoke='function(pinned,expected,claim){'+definitions+'return ('+startNativeReload.toString()+')(this,pinned,expected,claim)}';
  const claim=options.claim_file||'/evolution/instances/.jp-maintenance/jp-reloadConnection-20261109-once.json';
  const record=await call(controller,invoke,[{objectId:instance.objectId},{value:expected},{value:claim}]);if(!record.objectId)throw Error('native_claim_outcome_uncertain');
  const observe='function(pinned,record,expected,old){'+definitions+'return ('+inspectNativeReload.toString()+')(this,pinned,record,expected,old)}';
  const deadline=Date.now()+Math.min(Number(options.observe_ms)||20000,30000);let latest;
  do{
   const row=await call(controller,observe,[{objectId:instance.objectId},{objectId:record.objectId},{value:expected},{objectId:old.objectId}],true);latest=row.value;
   if(latest.safety_stop||latest.status==='rejected'||latest.status==='resolved'&&latest.after?.socket?.is_open)break;
   await new Promise(resolve=>setTimeout(resolve,250));
  }while(Date.now()<deadline);
  return{at:new Date().toISOString(),mode,...latest,claim_file:claim,completion_is_not_delivery:true};
 }finally{
  if(ws?.readyState===1){ws.send(JSON.stringify({id:++id,method:'Runtime.evaluate',params:{expression:"process.getBuiltinModule('node:inspector').close()"}}));await new Promise(resolve=>{ws.addEventListener('close',resolve,{once:true});setTimeout(resolve,1500)});ws.close()}
 }
}

export function nativeCommand(options) {
 const definitions=[validateNativeTarget,snapshotNativeClient,startNativeReload,inspectNativeReload].map(fn=>'const '+fn.name+'='+fn.toString()+';').join('\n');
 // Only fixed error categories cross the administrative transport.
 return definitions+'\n('+operateNativeClient.toString()+')('+JSON.stringify(options)+').then(v=>console.log(JSON.stringify(v))).catch(e=>console.log(JSON.stringify({error:e.code==="EEXIST"?"native_already_claimed":/^(native_|external_fence_|inspector_|existing_inspector_|claim_)/.test(e.message)?e.message:"native_operation_failed"})))';
}
