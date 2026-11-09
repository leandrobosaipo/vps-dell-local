import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {validateNativeTarget} from './evolution-native-guard.mjs';

const h = char => char.repeat(64);
const expected = {
  instance_name_hash: h('a'), instance_id_hash: h('b'), native_method_hash: h('c'),
  create_method_hash: h('d'), integration: 'WHATSAPP-BAILEYS',
  auth: {me_hash: h('e'), identity_key_hash: h('f')},
  closed_wrapper_evidence: {confirmed: true, last_close_at_ms: 1_000_000, observed_at_ms: 1_061_001}
};
const proof = {
  instance_name_hash: h('a'), instance_id_hash: h('b'), native_method_hash: h('c'),
  create_method_hash: h('d'), integration: 'WHATSAPP-BAILEYS', end_session: false,
  auth: {me_present: true, identity_key_present: true, me_hash: h('e'), identity_key_hash: h('f'), registered: false},
  socket: {is_open: false, is_connecting: false, is_closing: false, is_closed: true,
    underlying_ready_state: 3, underlying_absent: false}
};

test('known Baileys me identity allows a closed socket even when registered is false', () => {
  const result = validateNativeTarget(proof, expected);
  assert.equal(result.can_attempt_once, true);
  assert.equal(result.auth_present, true);
  assert.equal(result.socket_proven_closed, true);
  assert.equal(Object.values(result).every(value => typeof value === 'boolean'), true);
  assert.equal(JSON.stringify(result).includes(h('e')), false);
  // Runner integrity is separate; source_main_sha cannot substitute a method hash.
  assert.equal(validateNativeTarget({...proof, source_main_sha: h('0')}, {...expected, source_main_sha: h('1')}).can_attempt_once, true);
});

test('wrong instance, methods, integration and auth each fail closed', () => {
  for (const [field, value] of [
    ['instance_name_hash', h('0')], ['instance_id_hash', h('0')],
    ['native_method_hash', h('0')], ['create_method_hash', h('0')], ['integration', 'OTHER'],
    ['end_session', true]
  ]) assert.equal(validateNativeTarget({...proof, [field]: value}, expected).can_attempt_once, false, field);
  for (const [field, value] of [
    ['me_present', false], ['identity_key_present', false], ['me_hash', h('0')], ['identity_key_hash', h('0')]
  ]) assert.equal(validateNativeTarget({...proof, auth: {...proof.auth, [field]: value}}, expected).can_attempt_once, false, field);
  assert.equal(validateNativeTarget({...proof, auth: {registered: true}}, expected).can_attempt_once, false);
  assert.equal(validateNativeTarget(proof, {...expected, auth: {...expected.auth, me_hash: h('0')}}).can_attempt_once, false);
});

test('open, connecting, closing, and bare null underlying socket are rejected', () => {
  for (const [field, value] of [['is_open', true], ['is_connecting', true], ['is_closing', true], ['is_closed', false]])
    assert.equal(validateNativeTarget({...proof, socket: {...proof.socket, [field]: value}}, expected).can_attempt_once, false, field);
  assert.equal(validateNativeTarget({...proof, socket: {...proof.socket, underlying_ready_state: null}}, expected).can_attempt_once, false);
  assert.equal(validateNativeTarget({...proof, socket: {...proof.socket, underlying_ready_state: null, underlying_absent: true}},
    {...expected, closed_wrapper_evidence: null}).can_attempt_once, false);
  assert.equal(validateNativeTarget({...proof, socket: {...proof.socket, underlying_ready_state: 2}}, expected).can_attempt_once, false);
});

test('absent underlying socket requires explicit older-than-60-seconds wrapper evidence', () => {
  // Installed Baileys wrapper reports isClosing=true when socket is null.
  const absent = {...proof, socket: {...proof.socket, is_closing: true, underlying_ready_state: null, underlying_absent: true}};
  assert.equal(validateNativeTarget(absent, expected).can_attempt_once, true);
  assert.equal(validateNativeTarget(absent, {...expected, closed_wrapper_evidence: undefined}).can_attempt_once, false);
  for (const evidence of [
    null, true, {confirmed: false, last_close_at_ms: 1_000_000, observed_at_ms: 1_061_001},
    {confirmed: true, last_close_at_ms: 1_000_000, observed_at_ms: 1_060_000},
    {confirmed: true, last_close_at_ms: 1_000_000, observed_at_ms: 1_059_999}
  ]) assert.equal(validateNativeTarget(absent, {...expected, closed_wrapper_evidence: evidence}).can_attempt_once, false);
});

// Fictional wrapper only: a durable exclusive claim precedes the fake call.
// It discards the return value because native methods may return secrets/QRs.
async function claimedFakeReload(claimFile, fake) {
  const fd = fs.openSync(claimFile, 'wx', 0o600);
  try { fs.writeSync(fd, 'claimed\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  await fake.reloadConnection();
  return {claimed: true, attempted: true};
}

test('exclusive claim permits one fake call and never exposes its returned object', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jp-native-guard-test-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const claim = path.join(dir, 'claim');
  let calls = 0;
  const fake = {async reloadConnection() { calls++; return {qr: 'fictional-private-value', auth: 'fictional-private-value'}; }};
  const outcome = await claimedFakeReload(claim, fake);
  assert.deepEqual(outcome, {claimed: true, attempted: true});
  assert.equal(JSON.stringify(outcome).includes('fictional-private-value'), false);
  await assert.rejects(claimedFakeReload(claim, fake), {code: 'EEXIST'});
  assert.equal(calls, 1);
  assert.equal(fs.statSync(claim).mode & 0o777, 0o600);
});

test('failed or uncertain fake result still consumes the only claim', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jp-native-guard-test-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  for (const state of ['failed', 'uncertain']) {
    const claim = path.join(dir, state);
    let calls = 0;
    const fake = {async reloadConnection() { calls++; if (state === 'failed') throw Error('fictional_failure'); return undefined; }};
    if (state === 'failed') await assert.rejects(claimedFakeReload(claim, fake));
    else assert.deepEqual(await claimedFakeReload(claim, fake), {claimed: true, attempted: true});
    await assert.rejects(claimedFakeReload(claim, fake), {code: 'EEXIST'});
    assert.equal(calls, 1);
  }
});
