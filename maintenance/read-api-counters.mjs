// One-shot, read-only observation of the existing JP API. No hot patch,
// breakpoint, queue operation, variable assignment or business API call.
export async function readApiCounters(port = 8791) {
  const fs = require('node:fs');
  const pids = fs.readdirSync('/proc').filter(n => /^\d+$/.test(n) && n !== String(process.pid)).filter(n => {
    try { return fs.readFileSync(`/proc/${n}/cmdline`, 'utf8').includes("import('/app/scripts/jp-evolution-local-api.mjs')"); }
    catch { return false; }
  });
  if (pids.length !== 1) throw Error('api_process_identity_ambiguous');
  const origin = 'http://127.0.0.1:9229';
  try {
    if ((await fetch(origin + '/json/list', {signal: AbortSignal.timeout(700)})).ok) throw Error('existing_inspector_preserved');
  } catch (error) { if (error.message === 'existing_inspector_preserved') throw error; }
  process.kill(Number(pids[0]), 'SIGUSR1');
  let socket, id = 0;
  const pending = new Map();
  try {
    let target;
    for (let n = 0; n < 40; n++) {
      try { target = (await (await fetch(origin + '/json/list', {signal: AbortSignal.timeout(700)})).json())[0]; break; }
      catch { await new Promise(r => setTimeout(r, 100)); }
    }
    if (!target) throw Error('api_inspector_unavailable');
    socket = new WebSocket(target.webSocketDebuggerUrl);
    socket.addEventListener('message', event => {
      const row = JSON.parse(event.data), p = pending.get(row.id);
      if (p) { pending.delete(row.id); row.error ? p.reject(Error('inspector_read_failed')) : p.resolve(row.result); }
    });
    await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, {once:true}); socket.addEventListener('error', reject, {once:true}); });
    const send = (method, params) => new Promise((resolve, reject) => {
      const current = ++id; pending.set(current, {resolve, reject}); socket.send(JSON.stringify({id:current, method, params}));
    });
    const handler = await send('Runtime.evaluate', {expression:`process._getActiveHandles().filter(h=>h.constructor.name==='Server'&&h.address()?.port===${Number(port)})[0]?.listeners('request')[0]`});
    if (!handler.result?.objectId) throw Error('api_handler_missing');
    const props = await send('Runtime.getProperties', {objectId:handler.result.objectId, ownProperties:true});
    const scopes = props.internalProperties?.find(p => p.name === '[[Scopes]]')?.value?.objectId;
    if (!scopes) throw Error('api_scopes_missing');
    const list = await send('Runtime.getProperties', {objectId:scopes, ownProperties:true});
    const moduleScope = list.result.find(p => p.value?.description === 'Module')?.value?.objectId;
    if (!moduleScope) throw Error('api_module_scope_missing');
    const module = await send('Runtime.getProperties', {objectId:moduleScope, ownProperties:true});
    const selected = {};
    for (const prop of module.result) {
      if ((prop.name === 'activeMutationRequests' || /Busy$/.test(prop.name)) && ['boolean','number'].includes(prop.value?.type)) selected[prop.name] = prop.value.value;
    }
    if (!Number.isInteger(selected.activeMutationRequests)) throw Error('api_counter_missing');
    for (const name of ['reactivation','rescheduleOffers','newVisits','currentVisitResolution','replyAutomation']) {
      const objectId = module.result.find(p => p.name === name)?.value?.objectId;
      if (!objectId) throw Error('api_busy_object_missing');
      const result = await send('Runtime.callFunctionOn', {objectId, functionDeclaration:'function(){return this.isBusy()}', returnByValue:true});
      if (result.exceptionDetails || result.result?.type !== 'boolean') throw Error('api_busy_read_failed');
      selected[name + 'Busy'] = result.result.value;
    }
    return {at:new Date().toISOString(), pid:Number(pids[0]), counters:selected,
      idle:Object.values(selected).every(value => value === false || value === 0),
      scope:'existing_counters_exclude_inbound_not_a_provider_queue_proof'};
  } finally {
    if (socket?.readyState === 1) {
      socket.send(JSON.stringify({id:++id,method:'Runtime.evaluate',params:{expression:"process.getBuiltinModule('node:inspector').close()"}}));
      await new Promise(resolve => { socket.addEventListener('close', resolve, {once:true}); setTimeout(resolve, 1500); });
      socket.close();
    }
  }
}
