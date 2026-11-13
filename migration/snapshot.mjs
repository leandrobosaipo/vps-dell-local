// Offline-only snapshot restore and exact reconciliation. No transport or send API.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

export const digest = value => createHash('sha256').update(value).digest('hex');
export function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  return JSON.stringify(value);
}

// Private ledger retains every array record and its composite identity, without
// exposing identities/content. Index keeps duplicates and original order intact.
export function ledger(value) {
  const rows = [];
  const ids = ['id', 'message_id', 'appointment_id', 'event_id', 'case_id', 'job_id', 'task_id', 'request_id', 'client_code', 'candidate_id'];
  function walk(node, scope) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach((record, index) => {
        const identity = record && typeof record === 'object'
          ? Object.fromEntries(ids.filter(k => Object.hasOwn(record, k)).map(k => [k, record[k]])) : {};
        rows.push({scopeHash: digest(scope), index, identityHash: digest(canonical(identity)), recordHash: digest(canonical(record))});
        walk(record, scope + '/' + index);
      });
    } else for (const [key, item] of Object.entries(node)) walk(item, scope + '/' + key);
  }
  walk(value, '$');
  return rows;
}

export function reconcile(source, restored) {
  // Full equality includes scalar maps, nested credits, authorization fields,
  // original unknown delivery states, duplicates and array order.
  // Compare bounded digests rather than retain two full canonical documents in
  // the assertion. Large compact states failed at that comparison on Node 22.
  const sourceCanonicalSha256 = digest(canonical(source));
  assert.equal(digest(canonical(restored)), sourceCanonicalSha256, 'snapshot_semantic_mismatch');
  const before = ledger(source), after = ledger(restored);
  assert.deepEqual(after, before, 'snapshot_record_mismatch');
  return {semanticEquality: true, canonicalSha256: sourceCanonicalSha256, arrayRecordsVerified: before.length, ledgerSha256: digest(canonical(before))};
}

export function restore({sourceFile, targetFile, expectedHash, key, consumerFile, codec}) {
  assert.equal(Buffer.isBuffer(key) && key.length === 32, true, 'snapshot_key_invalid');
  const raw = fs.readFileSync(sourceFile);
  assert.equal(digest(raw), expectedHash, 'snapshot_source_hash_mismatch');
  const envelope = JSON.parse(raw);
  assert.equal(codec.isEncryptedEnvelope(envelope), true, 'snapshot_plaintext_refused');
  const source = JSON.parse(codec.decodeStateEnvelope(envelope, key));
  // New private staging destination only; never overwrite an existing runtime.
  assert.notEqual(path.resolve(sourceFile), path.resolve(targetFile), 'snapshot_same_path_refused');
  fs.mkdirSync(path.dirname(targetFile), {recursive: true, mode: 0o700});
  fs.writeFileSync(targetFile, raw, {mode: 0o600, flag: 'wx'});
  const fd = fs.openSync(targetFile, 'r');
  try {fs.fsyncSync(fd);} finally {fs.closeSync(fd);}
  assert.equal(digest(fs.readFileSync(targetFile)), expectedHash, 'snapshot_restore_hash_mismatch');
  const consumer = fs.readFileSync(consumerFile, 'utf8');
  const start = consumer.indexOf('var stateReadCache = null;');
  const end = consumer.indexOf('function reply(res,', start);
  assert.equal(start >= 0 && end > start, true, 'snapshot_consumer_seam_missing');
  // No network, process, environment, arbitrary imports or write primitives.
  const readOnlyFs = Object.fromEntries(['existsSync', 'statSync', 'openSync', 'readFileSync', 'fstatSync', 'closeSync'].map(name => [name, (...args) => {
    if (name === 'openSync') assert.equal(args[1], 'r', 'snapshot_consumer_write_refused');
    if (['existsSync', 'statSync', 'openSync'].includes(name) || (name === 'readFileSync' && typeof args[0] !== 'number'))
      assert.equal(path.resolve(args[0]), path.resolve(targetFile), 'snapshot_consumer_path_refused');
    return fs[name](...args);
  }]));
  const context = vm.createContext({fs: readOnlyFs, file: targetFile, host: '0.0.0.0', encryptionKey: key, ...codec, Buffer,
    initial: () => {throw Error('snapshot_missing_refused');}});
  vm.runInContext(consumer.slice(start, end), context, {timeout: 5000});
  const restored = JSON.parse(JSON.stringify(vm.runInContext('load()', context, {timeout: 15000})));
  const proof = reconcile(source, restored);
  assert.equal(digest(fs.readFileSync(sourceFile)), expectedHash, 'snapshot_source_changed');
  return {state: source, proof: {...proof, sourceSha256: expectedHash, capturedConsumerLoad: true, encryptedBytesRestored: raw.length}};
}

// Delta is observed and fenced, never merged or replayed automatically.
export function delta(before, after) {
  const fields = new Set([...Object.keys(before), ...Object.keys(after)]);
  return {baselineSha256: digest(canonical(before)), currentSha256: digest(canonical(after)),
    changedFields: [...fields].filter(k => canonical(before[k]) !== canonical(after[k])).sort(),
    action: 'recapture_after_writer_fence_and_drain', replayAllowed: false, staleOverwriteAllowed: false};
}
