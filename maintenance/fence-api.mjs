// Self-contained function for stringify/evaluation in a separate CJS process.
// Fences only the existing API listener; it does not patch application state.
export async function fenceApiListener(port = 8791, {modulePath = '/app/scripts/jp-evolution-local-api.mjs', timeoutMs = 30000, onDrained} = {}) {
  const fs = require('node:fs');
  const net = require('node:net');
  if (!Number.isInteger(port) || port < 1 || port > 65535 ||
      typeof modulePath !== 'string' || !modulePath.startsWith('/') ||
      !Number.isInteger(timeoutMs) || timeoutMs < 1 ||
      (onDrained !== undefined && typeof onDrained !== 'function')) throw Error('fence_arguments_invalid');
  const deadline = Date.now() + Math.min(timeoutMs, 30000);
  const pids = fs.readdirSync('/proc').filter(name => /^\d+$/.test(name) && name !== String(process.pid)).filter(name => {
    try { return fs.readFileSync(`/proc/${name}/cmdline`, 'utf8').includes(`import('${modulePath}')`); }
    catch { return false; }
  });
  if (pids.length !== 1) throw Error('api_process_identity_ambiguous');

  // SIGUSR1 is allowed only when the conventional inspector port is vacant.
  await new Promise((resolve, reject) => {
    const probe = net.connect({host: '127.0.0.1', port: 9229});
    const timer = setTimeout(() => { probe.destroy(); reject(Error('inspector_port_uncertain')); }, 700);
    probe.once('connect', () => { clearTimeout(timer); probe.destroy(); reject(Error('existing_inspector_preserved')); });
    probe.once('error', error => { clearTimeout(timer); error.code === 'ECONNREFUSED' ? resolve() : reject(Error('inspector_port_uncertain')); });
  });
  process.kill(Number(pids[0]), 'SIGUSR1');
  const origin = 'http://127.0.0.1:9229';
  let socket, nextId = 0, result;
  const pending = new Map();
  try {
    let target;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(origin + '/json/list', {signal: AbortSignal.timeout(700)});
        const rows = await response.json();
        if (!response.ok || !Array.isArray(rows) || rows.length !== 1) throw Error('inspector_target_ambiguous');
        target = rows[0];
        break;
      } catch (error) {
        if (error.message === 'inspector_target_ambiguous') throw error;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    if (!target) throw Error('api_inspector_unavailable');
    const endpoint = new URL(target.webSocketDebuggerUrl);
    if (endpoint.protocol !== 'ws:' || endpoint.hostname !== '127.0.0.1' || endpoint.port !== '9229') throw Error('inspector_target_invalid');
    socket = new WebSocket(endpoint);
    socket.addEventListener('message', event => {
      let row;
      try { row = JSON.parse(event.data); } catch { return; }
      const promise = pending.get(row.id);
      if (promise) {
        pending.delete(row.id);
        row.error ? promise.reject(Error('inspector_command_failed')) : promise.resolve(row.result);
      }
    });
    socket.addEventListener('close', () => {
      for (const promise of pending.values()) promise.reject(Error('inspector_closed'));
      pending.clear();
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('inspector_socket_timeout')), 1500);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, {once: true});
      socket.addEventListener('error', () => { clearTimeout(timer); reject(Error('inspector_socket_failed')); }, {once: true});
    });
    const send = (method, params) => new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => { pending.delete(id); reject(Error('inspector_command_timeout')); }, Math.max(1, deadline - Date.now()));
      pending.set(id, {resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); }});
      socket.send(JSON.stringify({id, method, params}));
    });
    const call = async (objectId, functionDeclaration) => {
      const row = await send('Runtime.callFunctionOn', {objectId, functionDeclaration, awaitPromise: false, returnByValue: false});
      if (row.exceptionDetails) throw Error('inspector_call_failed');
      return row.result;
    };

    const serverRow = await send('Runtime.evaluate', {expression:
      `(()=>{const matches=process._getActiveHandles().filter(h=>h.constructor?.name==='Server'&&h.address()?.port===${port});return matches.length===1?matches[0]:null})()`});
    const serverId = serverRow.result?.objectId;
    if (!serverId) throw Error('api_server_identity_ambiguous');
    const handler = await call(serverId, 'function(){const handlers=this.listeners("request");return handlers.length===1?handlers[0]:null}');
    if (!handler?.objectId) throw Error('api_handler_missing');

    const busyNames = ['reactivation', 'rescheduleOffers', 'newVisits', 'currentVisitResolution', 'replyAutomation'];
    async function counters() {
      // Scope remote objects snapshot primitive bindings when materialized.
      // Re-obtain the handler's scopes for every reading so a changed counter
      // is observed after the in-flight request finishes.
      const props = await send('Runtime.getProperties', {objectId: handler.objectId, ownProperties: true});
      const scopesId = props.internalProperties?.find(property => property.name === '[[Scopes]]')?.value?.objectId;
      if (!scopesId) throw Error('api_scopes_missing');
      const scopes = await send('Runtime.getProperties', {objectId: scopesId, ownProperties: true});
      const moduleScopeId = scopes.result?.find(property => property.value?.description === 'Module')?.value?.objectId;
      if (!moduleScopeId) throw Error('api_module_scope_missing');
      const properties = await send('Runtime.getProperties', {objectId: moduleScopeId, ownProperties: true});
      const values = {};
      for (const property of properties.result ?? []) {
        if ((property.name === 'activeMutationRequests' || /Busy$/.test(property.name)) &&
            ['boolean', 'number'].includes(property.value?.type)) values[property.name] = property.value.value;
      }
      if (!Number.isInteger(values.activeMutationRequests) || values.activeMutationRequests < 0) throw Error('api_counter_missing');
      for (const name of busyNames) {
        const objectId = properties.result.find(property => property.name === name)?.value?.objectId;
        if (!objectId) throw Error('api_busy_object_missing');
        const row = await call(objectId, 'function(){return this.isBusy()}');
        if (row.type !== 'boolean') throw Error('api_busy_read_failed');
        values[name + 'Busy'] = row.value;
      }
      return values;
    }
    async function connections() {
      // Node's net.Server maintains this native count synchronously. An
      // Inspector call awaiting getConnections(callback) can hold CDP until
      // the callback and starve the target's request/IPC event loop.
      const row = await call(serverId, 'function(){return this._connections}');
      if (row.type !== 'number' || !Number.isInteger(row.value) || row.value < 0)
        throw Error('api_connections_read_failed');
      return row.value;
    }
    const initialCounters = await counters();
    const initialConnections = await connections();
    result = {pid: Number(pids[0]), closeCalled: false, closeCallback: false, closeError: false,
      drained: false, canRestart: false, inspectorClosed: false, observationFailed: false, observationStage: 0,
      timedOut: false, initialCounters,
      initialConnections, finalCounters: initialCounters, finalConnections: initialConnections};

    // Dispatch exactly one native close(). Keep remote server/handler/scope refs
    // alive in this inspector session until callback, zero connections and idle.
    const closeHandle = await call(serverId,
      'function(){return new Promise(resolve=>this.close(error=>resolve({callback:true,error:!!error}))) }');
    result.closeCalled = true;
    if (!closeHandle.objectId) throw Error('api_close_promise_missing');
    async function closeState() {
      const state = await send('Runtime.getProperties', {objectId: closeHandle.objectId, ownProperties: true});
      const internals = state.internalProperties ?? [];
      const status = internals.find(property => property.name === '[[PromiseState]]')?.value?.value;
      if (status === 'pending') return false;
      if (status !== 'fulfilled') { result.closeError = true; return true; }
      const proofId = internals.find(property => property.name === '[[PromiseResult]]')?.value?.objectId;
      if (!proofId) { result.closeError = true; return true; }
      const proof = await send('Runtime.getProperties', {objectId: proofId, ownProperties: true});
      const values = Object.fromEntries((proof.result ?? []).filter(property => property.name === 'callback' || property.name === 'error')
        .map(property => [property.name, property.value?.value]));
      result.closeCallback = values.callback === true;
      result.closeError = values.error !== false;
      return true;
    }
    while (Date.now() < deadline) {
      try {
        result.observationStage = 1;
        const closeSettled = await closeState();
        result.observationStage = 2;
        result.finalCounters = await counters();
        result.observationStage = 3;
        result.finalConnections = await connections();
        result.observationStage = 0;
        if (closeSettled && result.closeError) break;
        const idle = Object.values(result.finalCounters).every(value => value === false || value === 0);
        if (closeSettled && result.closeCallback && result.finalConnections === 0 && idle) {
          result.drained = true;
          break;
        }
      } catch { result.observationFailed = true; break; }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!result.drained && !result.observationFailed && !result.closeError) result.timedOut = true;
    // A separate, external socket check remains required before restart.
    // The target can exit naturally as soon as Inspector closes. Let the
    // administrative child seal the observed proof before that boundary.
    if (result.drained && onDrained) onDrained(result);
    return result;
  } finally {
    if (socket?.readyState === 1) {
      const closed = new Promise(resolve => {
        const timer = setTimeout(() => resolve(false), 1500);
        socket.addEventListener('close', () => { clearTimeout(timer); resolve(true); }, {once: true});
      });
      try { socket.send(JSON.stringify({id: ++nextId, method: 'Runtime.evaluate',
        params: {expression: "process.getBuiltinModule('node:inspector').close()"}})); } catch { /* no secret output */ }
      const wasClosed = await closed;
      if (result) result.inspectorClosed = wasClosed;
      if (socket.readyState === 1) socket.close();
    }
  }
}
