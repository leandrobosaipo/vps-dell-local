import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {fenceApiListener} from './fence-api.mjs';

const linux = process.platform === 'linux' && fs.existsSync('/proc');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jp-api-fence-test-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const modulePath = path.join(root, 'fixture-api.mjs');
  fs.writeFileSync(modulePath, `import http from 'node:http';
let activeMutationRequests = 0;
const reactivation = {isBusy(){return false}};
const rescheduleOffers = {isBusy(){return false}};
const newVisits = {isBusy(){return false}};
const currentVisitResolution = {isBusy(){return false}};
const replyAutomation = {isBusy(){return false}};
let releaseHold;
process.on('message', message => {if(message === 'release')releaseHold?.()});
const server = http.createServer((req,res) => {
  void [reactivation,rescheduleOffers,newVisits,currentVisitResolution,replyAutomation];
  if (req.url !== '/hold') {res.end('probe');return;}
  activeMutationRequests++;
  process.stdout.write('REQUEST_STARTED\\n');
  releaseHold = () => {activeMutationRequests--;res.end('done')};
});
server.listen(0,'127.0.0.1',() => process.stdout.write('PORT '+server.address().port+'\\n'));
`);
  const child = spawn(process.execPath, ['-e', `import('${modulePath}')`], {stdio: ['ignore', 'pipe', 'pipe', 'ipc']});
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  return {child, modulePath};
}

function line(child, prefix) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const onData = chunk => {
      buffer += chunk;
      const rows = buffer.split('\n');
      buffer = rows.pop();
      for (const row of rows) if (row.startsWith(prefix)) { cleanup(); resolve(row.slice(prefix.length)); return; }
    };
    const onExit = code => { cleanup(); reject(Error(`fixture_exited_${code}`)); };
    const cleanup = () => { child.stdout.off('data', onData); child.off('exit', onExit); };
    child.stdout.on('data', onData);
    child.on('exit', onExit);
  });
}

async function childFence(port, modulePath, timeoutMs) {
  const source = `const fence=${fenceApiListener.toString()};fence(${port},${JSON.stringify({modulePath, timeoutMs})}).then(value=>console.log(JSON.stringify(value))).catch(error=>{console.log(JSON.stringify({error:error.message}));process.exitCode=1})`;
  const child = spawn(process.execPath, ['-e', source], {stdio: ['ignore', 'pipe', 'pipe']});
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  const exitCode = await new Promise(resolve => child.once('exit', resolve));
  return {exitCode, output: JSON.parse(output.trim())};
}

function connect(port) {
  return new Promise(resolve => {
    const socket = net.connect({host: '127.0.0.1', port});
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', error => resolve(error.code !== 'ECONNREFUSED'));
  });
}

test('native close fences new admissions and waits for an in-flight HTTP request', {skip: !linux}, async t => {
  const {child, modulePath} = fixture(t);
  const port = Number(await line(child, 'PORT '));
  const started = line(child, 'REQUEST_STARTED');
  let holdDone = false;
  const hold = new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}/hold`, response => {
      let body = '';
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => { holdDone = true; resolve(body); });
    }).on('error', reject);
  });
  await started;
  const fenced = childFence(port, modulePath, 15000);
  let refusedBeforeDrain = false;
  const until = Date.now() + 10000;
  while (Date.now() < until && !holdDone) {
    if (!(await connect(port))) { refusedBeforeDrain = true; break; }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  child.send('release');
  const result = await fenced;
  assert.equal(await hold, 'done');
  const proof = JSON.stringify(result.output);
  assert.equal(result.exitCode, 0, proof);
  assert.equal(result.output.closeCalled, true, proof);
  assert.equal(result.output.closeCallback, true, proof);
  assert.equal(result.output.closeError, false, proof);
  assert.equal(result.output.initialCounters.activeMutationRequests, 1, proof);
  assert.equal(result.output.finalCounters.activeMutationRequests, 0, proof); // fresh handler scope after the held request
  assert.equal(result.output.finalConnections, 0, proof);
  assert.equal(result.output.drained, true, proof);
  assert.equal(result.output.canRestart, false); // external socket proof is a separate gate
  assert.equal(refusedBeforeDrain, true);
  assert.equal(await connect(port), false);
  assert.equal(await connect(9229), false);
});

test('an existing Inspector is preserved and no close is attempted', {skip: !linux}, async t => {
  const {child, modulePath} = fixture(t);
  const port = Number(await line(child, 'PORT '));
  child.kill('SIGUSR1');
  let open = false;
  for (let i = 0; i < 30; i++) {
    try { open = (await fetch('http://127.0.0.1:9229/json/list', {signal: AbortSignal.timeout(300)})).ok; }
    catch { /* startup */ }
    if (open) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(open, true);
  const result = await childFence(port, modulePath, 1000);
  assert.equal(result.exitCode, 1);
  assert.equal(result.output.error, 'existing_inspector_preserved');
  assert.equal(await connect(port), true);
});
