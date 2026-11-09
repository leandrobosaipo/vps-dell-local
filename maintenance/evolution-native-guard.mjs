// Pure guard for one explicitly authorized native reloadConnection attempt.
// Self-contained so the function can be stringified into an isolated runner.
// source_main_sha belongs to the runner's separate source-integrity gate.
export function validateNativeTarget(proof, expected) {
  const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  const sameHash = key => hash(proof?.[key]) && hash(expected?.[key]) && proof[key] === expected[key];
  const instance_name_match = sameHash('instance_name_hash');
  const instance_id_match = sameHash('instance_id_hash');
  const native_method_match = sameHash('native_method_hash');
  const create_method_match = sameHash('create_method_hash');
  const integration_match = proof?.integration === 'WHATSAPP-BAILEYS' && expected?.integration === 'WHATSAPP-BAILEYS';
  const end_session_false = proof?.end_session === false;
  const auth_present = proof?.auth?.me_present === true && proof?.auth?.identity_key_present === true;
  const me_match = hash(proof?.auth?.me_hash) && hash(expected?.auth?.me_hash) &&
    proof.auth.me_hash === expected.auth.me_hash;
  const identity_key_match = hash(proof?.auth?.identity_key_hash) && hash(expected?.auth?.identity_key_hash) &&
    proof.auth.identity_key_hash === expected.auth.identity_key_hash;
  // registered is deliberately not a login gate: Baileys credentials use me.
  const socket_flags_closed = proof?.socket?.is_open === false && proof.socket.is_connecting === false &&
    proof.socket.is_closed === true;
  const evidence = expected?.closed_wrapper_evidence;
  const priorClose = evidence && typeof evidence === 'object' && evidence.confirmed === true &&
    Number.isSafeInteger(evidence.last_close_at_ms) && Number.isSafeInteger(evidence.observed_at_ms) &&
    evidence.last_close_at_ms > 0 && evidence.observed_at_ms - evidence.last_close_at_ms > 60000;
  const underlying_closed = proof?.socket?.underlying_ready_state === 3 && proof.socket.underlying_absent !== true &&
    proof.socket.is_closing === false;
  const absent_with_prior_close = proof?.socket?.underlying_absent === true &&
    (proof.socket.underlying_ready_state === null || proof.socket.underlying_ready_state === undefined) &&
    priorClose === true;
  const socket_proven_closed = socket_flags_closed && (underlying_closed || absent_with_prior_close);
  const can_attempt_once = instance_name_match && instance_id_match && native_method_match &&
    create_method_match && integration_match && end_session_false && auth_present && me_match &&
    identity_key_match && socket_proven_closed;
  return {instance_name_match, instance_id_match, native_method_match, create_method_match,
    integration_match, end_session_false, auth_present, me_match, identity_key_match,
    socket_flags_closed, underlying_closed, absent_with_prior_close, socket_proven_closed, can_attempt_once};
}
