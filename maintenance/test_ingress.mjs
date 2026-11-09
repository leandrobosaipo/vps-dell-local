import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {createServer, loadConfig, MAX_BODY_BYTES, readRecord} from './ingress.mjs';

const token = 'fictional-local-token';
const instance = 'fictional-instance';
const workflowId = 'fictionalInbound';
const headers = {'authorization': `Bearer ${token}`, 'x-jp-n8n-workflow-id': workflowId, 'x-jp-n8n-execution-id': '123'};

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jp-ingress-test-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const dir = path.join(root, 'records');
  const key = randomBytes(32);
  const paths = {tokenFile: path.join(root, 'token'), keyFile: path.join(root, 'key'), instanceFile: path.join(root, 'instance')};
  for (const [file, contents] of [[paths.tokenFile, token], [paths.keyFile, key], [paths.instanceFile, instance]])
    fs.writeFileSync(file, contents, {mode: 0o600});
  return {root, dir, key, config: loadConfig({dir, ...paths, workflowId}), paths};
}

async function listen(t, config, hooks) {
  const server = createServer(config, hooks);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

async function post(base, raw, overrides = {}) {
  const result = await fetch(`${base}/inbound`, {method: 'POST', headers: {...headers, ...overrides}, body: raw});
  return {status: result.status, body: await result.json()};
}

test('received n8n body preserves batch, group, updates, connection and media metadata; exact retry is one record', async t => {
  const f = fixture(t);
  const base = await listen(t, f.config);
  const events = [
    {instance, event: 'MESSAGES_UPSERT', data: {key: {remoteJid: 'fictional-group@g.us'}, message: {imageMessage: {mimetype: 'image/jpeg', caption: 'fictional'}}}},
    {instance, event: 'MESSAGES_UPDATE', data: {key: {id: 'same-id'}, status: 'SERVER_ACK'}},
    {instance, event: 'CONNECTION_UPDATE', data: {state: 'open'}}
  ];
  const raw = Buffer.from(` [ ${events.map(item => JSON.stringify(item)).join(',\n ')} ] \n`);
  const first = await post(base, raw);
  assert.equal(first.status, 202);
  const second = await post(base, raw, {'x-jp-n8n-execution-id': '124'});
  assert.equal(second.status, 202);
  assert.equal(second.body.id, first.body.id);
  assert.equal(second.body.duplicate, true);
  const record = readRecord(path.join(f.dir, `${first.body.id}.json`), f.key, instance);
  assert.deepEqual(record.raw, raw);
  assert.equal(record.meta.executionId, '123');
  assert.equal(record.meta.workflowId, workflowId);
  assert.equal(record.meta.rawSha256.length, 64);
  assert.equal(fs.readdirSync(f.dir).length, 1);
  assert.equal(fs.statSync(path.join(f.dir, `${first.body.id}.json`)).mode & 0o777, 0o600);
  const updateOneRaw = JSON.stringify(events[1]);
  const updateTwoRaw = JSON.stringify({...events[1], data: {...events[1].data, status: 'DELIVERY_ACK'}});
  const updateOne = await post(base, updateOneRaw);
  const updateTwo = await post(base, updateTwoRaw);
  assert.equal(updateOne.status, 202);
  assert.equal(updateTwo.status, 202);
  assert.notEqual(updateOne.body.id, updateTwo.body.id);
  assert.notEqual(updateOne.body.id, first.body.id);
  assert.notEqual(updateTwo.body.id, first.body.id);
  assert.deepEqual(readRecord(path.join(f.dir, `${updateOne.body.id}.json`), f.key, instance).raw, Buffer.from(updateOneRaw));
  assert.deepEqual(readRecord(path.join(f.dir, `${updateTwo.body.id}.json`), f.key, instance).raw, Buffer.from(updateTwoRaw));
  const health = await fetch(`${base}/healthz`).then(response => response.json());
  assert.deepEqual(health, {status: 'ready', records: 3});
});

test('rejects wrong auth, workflow, execution, instance, malformed JSON and oversized body', async t => {
  const f = fixture(t);
  const base = await listen(t, f.config);
  const raw = JSON.stringify({instance, event: 'CONNECTION_UPDATE'});
  assert.equal((await post(base, raw, {authorization: 'Bearer wrong'})).status, 401);
  assert.equal((await post(base, raw, {'x-jp-n8n-workflow-id': 'other'})).status, 401);
  assert.equal((await post(base, raw, {'x-jp-n8n-execution-id': 'abc'})).status, 401);
  const legacy = await fetch(`${base}/inbound`, {method: 'POST', headers: {
    authorization: `Bearer ${token}`, 'x-jp-workflow-id': workflowId, 'x-jp-execution-id': '123'
  }, body: raw});
  assert.equal(legacy.status, 401);
  assert.equal((await post(base, JSON.stringify({instance: 'other'}))).status, 401);
  assert.equal((await post(base, JSON.stringify([{instance}, {instance: 'other'}]))).status, 401);
  assert.equal((await post(base, '{')).status, 400);
  assert.equal((await post(base, JSON.stringify({instance, padding: 'x'.repeat(MAX_BODY_BYTES)}))).status, 413);
  assert.equal(fs.readdirSync(f.dir).length, 0);
});

test('tampered ciphertext and authenticated metadata block duplicate ACK', async t => {
  const f = fixture(t);
  const base = await listen(t, f.config);
  const raw = Buffer.from(JSON.stringify({instance, event: 'MESSAGES_UPDATE', data: {status: 'one'}}));
  const first = await post(base, raw);
  const file = path.join(f.dir, `${first.body.id}.json`);
  const original = JSON.parse(fs.readFileSync(file));
  for (const change of [
    value => { value.ciphertext = Buffer.from('tamper').toString('base64'); },
    value => { value.meta.executionId = '999'; }
  ]) {
    const changed = structuredClone(original);
    change(changed);
    fs.writeFileSync(file, JSON.stringify(changed));
    assert.throws(() => readRecord(file, f.key, instance));
    assert.equal((await post(base, raw)).status, 503);
  }
});

test('failed persistence returns 503; linked record is recovered and ACKed on retry', async t => {
  const f = fixture(t);
  let failOnce = true;
  const base = await listen(t, f.config, {afterLink() { if (failOnce) { failOnce = false; throw Error('injected_fsync_failure'); } }});
  const raw = Buffer.from(JSON.stringify({instance, event: 'MESSAGES_UPSERT'}));
  assert.equal((await post(base, raw)).status, 503);
  const retried = await post(base, raw);
  assert.equal(retried.status, 202);
  assert.equal(retried.body.duplicate, true);
  assert.deepEqual(readRecord(path.join(f.dir, `${retried.body.id}.json`), f.key, instance).raw, raw);
});

test('file sync failure and free-space floor refuse acknowledgement', async t => {
  const f = fixture(t);
  const raw = JSON.stringify({instance, event: 'CONNECTION_UPDATE'});
  const base = await listen(t, f.config, {afterFileSync() { throw Error('injected_file_sync_failure'); }});
  assert.equal((await post(base, raw)).status, 503);
  assert.equal(fs.readdirSync(f.dir).length, 0);
  const limited = await listen(t, {...f.config, minFreeBytes: Number.MAX_SAFE_INTEGER});
  assert.equal((await post(limited, raw)).status, 503);
  assert.equal(fs.readdirSync(f.dir).length, 0);
});

test('process exit after link and restart retains record and first provenance', async t => {
  const f = fixture(t);
  const runner = path.join(f.root, 'crash.mjs');
  const ingressURL = new URL('./ingress.mjs', import.meta.url).href;
  fs.writeFileSync(runner, `import {createServer, loadConfig} from ${JSON.stringify(ingressURL)};\nconst config=loadConfig(${JSON.stringify({dir: f.dir, ...f.paths, workflowId})});\ncreateServer(config,{afterLink(){process.exit(89)}}).listen(0,'127.0.0.1',function(){process.stdout.write(String(this.address().port)+'\\n')});\n`);
  const child = spawn(process.execPath, [runner], {stdio: ['ignore', 'pipe', 'ignore']});
  const exited = new Promise(resolve => child.once('exit', resolve));
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const port = await new Promise((resolve, reject) => {
    let out = '';
    child.stdout.on('data', chunk => { out += chunk; if (out.includes('\n')) resolve(Number(out.trim())); });
    child.on('exit', code => reject(Error(`early_exit_${code}`)));
  });
  const raw = JSON.stringify({instance, event: 'MESSAGES_UPDATE', data: {status: 'one'}});
  await fetch(`http://127.0.0.1:${port}/inbound`, {method: 'POST', headers, body: raw}).catch(() => {});
  await exited;
  assert.equal(child.exitCode, 89);
  const base = await listen(t, f.config);
  const retry = await post(base, raw, {'x-jp-n8n-execution-id': '456'});
  assert.equal(retry.status, 202);
  assert.equal(retry.body.duplicate, true);
  const record = readRecord(path.join(f.dir, `${retry.body.id}.json`), f.key, instance);
  assert.equal(record.meta.executionId, '123');
  assert.deepEqual(record.raw, Buffer.from(raw));
  assert.equal(fs.readdirSync(f.dir).length, 1);
});
