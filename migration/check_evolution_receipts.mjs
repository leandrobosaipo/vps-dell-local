// Extract the compiled native group-receipt handler from a captured image file.
// All callbacks are local doubles. Never load the whole Evolution application.
import fs from 'node:fs';
import {digest} from './snapshot.mjs';
try {
  const source = fs.readFileSync(process.argv[2], 'utf8');
  const matches = [...source.matchAll(/if\(([A-Za-z_$][\w$]*)\["message-receipt\.update"\]\)\{/g)];
  if (matches.length !== 1) throw Error('handler_ambiguous');
  const match = matches[0], begin = match.index, brace = source.indexOf('{', begin);
  let depth = 0, quote = null, escaped = false, end;
  for (let i = brace; i < source.length; i++) {
    const c = source[i];
    if (quote) {if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === quote) quote = null; continue;}
    if (c === '"' || c === "'") {quote = c; continue;}
    if (c === '`') throw Error('unsupported_template_in_handler');
    if (c === '{') depth++;
    if (c === '}' && --depth === 0) {end = i + 1; break;}
  }
  if (!end) throw Error('handler_unclosed');
  const sent = [], reads = [];
  const receiver = {sendDataWebhook: (...args) => sent.push(args), updateMessagesReadedByTimestamp: async (...args) => reads.push(args)};
  const events = {'message-receipt.update': [
    {key: {id: 'fictional-read', remoteJid: '100000000@g.us'}, receipt: {readTimestamp: 1800000100}},
    {key: {id: 'fictional-delivery', remoteJid: '100000000@g.us'}, receipt: {receiptTimestamp: 1800000070}}
  ]};
  const run = new Function(match[1], 'return (async function(){' + source.slice(begin, end) + '}).call(this);');
  await run.call(receiver, events);
  const has = (id, status) => sent.some(([event, payload]) => event === 'messages.update' && payload?.keyId === id && payload?.status === status);
  const passed = has('fictional-read', 'READ') && has('fictional-delivery', 'DELIVERY_ACK');
  console.log(JSON.stringify({passed, compiledSourceSha256: digest(source), fictionalEvents: true,
    scope: 'native_message_receipt_update_handler_only', webhookCalls: sent.length, readTimestampCallbacks: reads.length,
    productionSends: 0, ...(passed ? {} : {gap: 'native_group_receipt_event_did_not_emit_webhook_updates'})}));
  if (!passed) process.exitCode = 1;
} catch (error) {
  console.log(JSON.stringify({passed: false, errorType: error.name, productionSends: 0}));
  process.exitCode = 1;
}
