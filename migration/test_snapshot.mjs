import {test} from 'node:test';
import assert from 'node:assert/strict';
import {reconcile, delta, ledger} from './snapshot.mjs';
import {restore, digest} from './snapshot.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const state = {version: 2, credits: {a: 3}, messages: [{message_id: 'fictional-1', status: 'delivery_unknown'}, {message_id: 'fictional-1', status: 'delivery_unknown'}], holds: [{case_id: 'case-test', status: 'open'}]};
test('preserves duplicated IDs, exact record values and pending human case', () => {
  const result = reconcile(state, structuredClone(state));
  assert.equal(result.arrayRecordsVerified, 3);
  assert.equal(ledger(state).length, 3);
});
test('rejects erasing an unknown delivery or changing a credit scalar', () => {
  const altered = structuredClone(state); altered.messages[0].status = 'delivered';
  assert.throws(() => reconcile(state, altered), /snapshot_semantic_mismatch/);
  assert.throws(() => reconcile(state, {...state, credits: {a: 0}}), /snapshot_semantic_mismatch/);
});
test('delta never authorizes replay or overwriting newer records', () => {
  const changed = {...state, version: 3, messages: [...state.messages, {message_id: 'fictional-2'}]};
  const result = delta(state, changed);
  assert.deepEqual(result.changedFields, ['messages', 'version']);
  assert.equal(result.replayAllowed, false);
  assert.equal(result.staleOverwriteAllowed, false);
});
test('restore verifies the source before writing and refuses an existing destination', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-fictional-'));
  try {
    const sourceFile = path.join(dir, 'source.json'), targetFile = path.join(dir, 'target.json'), consumerFile = path.join(dir, 'consumer.mjs');
    const raw = Buffer.from(JSON.stringify({fixture: true, payload: state}));
    fs.writeFileSync(sourceFile, raw);
    fs.writeFileSync(consumerFile, "var stateReadCache = null; function load(){return JSON.parse(decodeStateEnvelope(JSON.parse(fs.readFileSync(file)),encryptionKey));} function reply(res, value){}");
    const codec = {isEncryptedEnvelope: x => x.fixture === true, decodeStateEnvelope: x => JSON.stringify(x.payload)};
    const options = {sourceFile, targetFile, consumerFile, codec, key: Buffer.alloc(32), expectedHash: 'incorrect'};
    assert.throws(() => restore(options), /snapshot_source_hash_mismatch/);
    assert.equal(fs.existsSync(targetFile), false);
    options.expectedHash = digest(raw);
    const result = restore(options);
    assert.equal(result.proof.capturedConsumerLoad, true);
    assert.equal(fs.readFileSync(targetFile).equals(raw), true);
    assert.throws(() => restore(options), /EEXIST/);
    assert.equal(fs.readFileSync(targetFile).equals(raw), true);
  } finally {fs.rmSync(dir, {recursive: true, force: true});}
});
