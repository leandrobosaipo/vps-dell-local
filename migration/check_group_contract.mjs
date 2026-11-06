// Fictional events against captured code; never imports the HTTP server.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {digest} from './snapshot.mjs';
const source = path.join(path.resolve(process.argv[2]), 'scripts/jp-delay-support.mjs');
try {
  const {parseSupportEvent, applySupportAction, supportDueStages} = await import(pathToFileURL(source));
  const now = Date.parse('2026-11-06T09:00:00Z');
  const c = {status: 'open', opened_at: new Date(now).toISOString(), received_at: new Date(now).toISOString(),
    customer_acknowledgement_enabled: false, events: [], notifications: {initial: {attempted_at: new Date(now).toISOString(), status: 'delivery_unknown'}}};
  assert.deepEqual(supportDueStages(c, now + 120000), ['two_minutes']);
  applySupportAction(c, 'claim', 'fictional-operator', now + 120000, 'fictional-command');
  assert.deepEqual(supportDueStages(c, now + 300000), [], 'claimed case must not escalate');
  assert.equal(applySupportAction(c, 'claim', 'fictional-operator', now + 300000, 'fictional-command').duplicate, true);
  const payload = {instance: 'fictional-instance', event: 'MESSAGES_UPSERT', data: {key: {id: 'fictional-event', remoteJid: '100000000@g.us', participant: '100001@lid', fromMe: false},
    messageTimestamp: now / 1000, message: {extendedTextMessage: {text: 'OK JP-1234ABCD', contextInfo: {stanzaId: 'fictional-alert'}}}}};
  const event = parseSupportEvent(payload, 'fictional-instance');
  assert.equal(event.kind, 'group_action');
  assert.equal(event.quoted_message_id, 'fictional-alert');
  assert.equal(event.actor, '100001@lid');
  assert.equal(c.notifications.initial.status, 'delivery_unknown');
  console.log(JSON.stringify({passed: true, capturedSourceSha256: digest(fs.readFileSync(source)), fictionalEvents: true,
    checks: ['quote_and_actor_parsing', 'claim_pauses_escalation', 'command_dedup', 'unknown_receipt_preserved'], sends: 0}));
} catch (error) {
  console.log(JSON.stringify({passed: false, errorType: error.name}));
  process.exitCode = 1;
}
