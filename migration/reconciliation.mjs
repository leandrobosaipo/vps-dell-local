// Offline migration evidence only. No network, send, runtime activation or in-place restore.
import assert from 'node:assert/strict';
import {canonical,digest,ledger} from './snapshot.mjs';

export function recordDelta(before,after) {
  const prior=ledger(before),next=ledger(after);
  const indexed=rows=>new Map(rows.map(r=>[r.scopeHash+':'+r.index,r]));
  const a=indexed(prior),b=indexed(next),added=[],removed=[],changed=[];
  for(const [position,row] of b) {
    const old=a.get(position);
    if(!old)added.push(row);
    else if(old.recordHash!==row.recordHash)changed.push({before:old,after:row});
  }
  for(const [position,row] of a)if(!b.has(position))removed.push(row);
  return {baseline:digest(canonical(before)),final:digest(canonical(after)),
    baselineRecords:prior.length,finalRecords:next.length,added,removed,changed,
    action:'capture_final_after_fence_and_drain_then_restore_in_a_new_namespace',
    missingRecordMeansCancellation:false,replayAllowed:false,automaticMergeAllowed:false};
}

export function assertCheckpointUnchanged(current,expectedHash) {
  assert.equal(digest(canonical(current)),expectedHash,'new_events_require_reconciliation');
  return true;
}

// An offline exercise is not runtime fencing. The caller must separately prove
// that all real writers/send paths enforce this owner and epoch before cutover.
export class RehearsalFence {
  constructor(owner) {assert(owner);this.owner=owner;this.epoch=1;this.frozen=false;}
  ticket() {return {owner:this.owner,epoch:this.epoch};}
  assertWriter(ticket) {
    assert(!this.frozen&&ticket?.owner===this.owner&&ticket?.epoch===this.epoch,'stale_writer_refused');
  }
  freeze(ticket,{activeOperations}) {
    this.assertWriter(ticket);assert.equal(activeOperations,0,'active_operations_preserved');
    this.frozen=true;this.epoch++;this.owner=null;
  }
  transfer(owner) {assert(this.frozen&&owner,'fence_required');this.owner=owner;this.frozen=false;return this.ticket();}
}

export function rehearseReturn(baseline,finalSnapshot,newEvents) {
  const authority=new RehearsalFence('old'),old=authority.ticket();
  authority.freeze(old,{activeOperations:0});const target=authority.transfer('new');
  assert.throws(()=>authority.assertWriter(old),/stale_writer_refused/);
  authority.assertWriter(target);
  const current=structuredClone(finalSnapshot);newEvents(current);
  assert.throws(()=>assertCheckpointUnchanged(current,digest(canonical(finalSnapshot))),/new_events_require_reconciliation/);
  const delta=recordDelta(finalSnapshot,current);
  authority.freeze(target,{activeOperations:0});const returned=authority.transfer('old');
  assert.throws(()=>authority.assertWriter(target),/stale_writer_refused/);authority.assertWriter(returned);
  // Code/owner can return; the latest data remains the authority, never baseline.
  return {simulationOnly:true,baseline:digest(canonical(baseline)),final:digest(canonical(finalSnapshot)),
    current:digest(canonical(current)),newEventsRetained:true,staleRestoreRefused:true,
    staleWriterRefused:true,returnOwner:returned.owner,delta,productionMutations:0};
}
