import {test} from 'node:test';
import assert from 'node:assert/strict';
import {canonical,digest,reconcile} from './snapshot.mjs';
import {recordDelta,assertCheckpointUnchanged,RehearsalFence,rehearseReturn} from './reconciliation.mjs';

test('per-position and ID hashes retain duplicates, unknowns and removals without inference',()=>{
 const before={credits:{balance:3},messages:[{id:'a',status:'delivery_unknown'},{id:'a',status:'delivery_unknown'}]};
 const after=structuredClone(before);after.messages.pop();after.messages[0].status='delivered';
 const d=recordDelta(before,after);
 assert.equal(d.changed.length,1);assert.equal(d.removed.length,1);
 assert.equal(d.changed[0].before.identityHash,d.removed[0].identityHash);
 assert.notEqual(d.changed[0].before.index,d.removed[0].index);
 assert.equal(d.missingRecordMeansCancellation,false);assert.equal(d.automaticMergeAllowed,false);
 assert.equal(before.messages[0].status,'delivery_unknown');
});
test('full snapshot equality protects scalar credit, identity and authorization maps',()=>{
 const source={credits:{remaining:3},identity:{instance:'fixture'},authorization:{granted:true},messages:[]};
 assert(reconcile(source,structuredClone(source)).semanticEquality);
 for(const name of ['credits','identity','authorization']){
  const altered=structuredClone(source);altered[name]={};
  assert.throws(()=>assertCheckpointUnchanged(altered,digest(canonical(source))),/new_events_require_reconciliation/);
 }
});
test('active operation cannot be fenced and old generations cannot send after handoff or return',()=>{
 const fence=new RehearsalFence('old'),old=fence.ticket();
 assert.throws(()=>fence.freeze(old,{activeOperations:1}),/active_operations_preserved/);
 fence.assertWriter(old);fence.freeze(old,{activeOperations:0});
 assert.throws(()=>fence.assertWriter(old),/stale_writer_refused/);
 const current=fence.transfer('new');fence.assertWriter(current);
 assert.throws(()=>fence.assertWriter(old),/stale_writer_refused/);
});
test('return after a new event retains unknown delivery, credits and the new event',()=>{
 const initial={credits:{remaining:2},messages:[{id:'old',status:'delivery_unknown'}]};
 const result=rehearseReturn(initial,structuredClone(initial),s=>s.messages.push({id:'new',status:'accepted'}));
 assert(result.newEventsRetained&&result.staleRestoreRefused&&result.staleWriterRefused);
 assert.equal(result.delta.added.length,1);assert.equal(result.returnOwner,'old');assert(result.simulationOnly);
 assert.equal(initial.messages.length,1);assert.equal(initial.messages[0].status,'delivery_unknown');
});
