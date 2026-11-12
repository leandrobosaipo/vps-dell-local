import test from 'node:test';
import assert from 'node:assert/strict';
import {projectEvent,reconcileEvents} from './journal-cutover.mjs';

test('batch, natural duplicates, conflicts, unrelated reply and quoted reply remain distinct',()=>{
  const row=(id,chat,fromMe,quote)=>({key:{id,remoteJid:chat+'@lid',fromMe},messageTimestamp:100,
    message:{extendedTextMessage:{text:'fixture',contextInfo:{stanzaId:quote}}}});
  const input=row('one','123',false);
  const batch=[input,input,{...input,message:{conversation:'different'}},row('two','567',true,'one'),row('three','123',true,'one')];
  const rows=projectEvent(JSON.stringify({instance:'fixture',event:'MESSAGES_UPSERT',data:batch}),'fixture','rec',Date.now());
  const result=reconcileEvents(rows);
  assert.equal(result.distinctMessages,3);
  assert.deepEqual(result.review.map(r=>r.reason),['conflicting_duplicate','quoted_reply_observed']);
  assert.equal(reconcileEvents(rows.slice(0,4)).review.at(-1).reason,'no_later_outbound_observed');
  assert.equal(rows[0].pn,null);
  assert.equal(JSON.stringify(rows).includes('567@lid'),false);
  assert.throws(()=>projectEvent('{"instance":"other"}','fixture','rec',0));
});
