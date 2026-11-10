// Pure verifier for one instance-scoped native PN/LID pair. No Redis client here.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {recordId} from './ingress.mjs';

const PN=/^55\d{10,11}@s\.whatsapp\.net$/;
const LID=/^\d{6,20}@lid$/;
const hex=/^[0-9a-f]{64}$/;
const hash=value=>createHash('sha256').update(value).digest('hex');
function unwrap(value){
  for(let i=0;i<2&&typeof value==='string'&&value.startsWith('"');i++){
    try{value=JSON.parse(value);}catch{return null;}
  }
  return typeof value==='string'&&/^\d{6,20}$/.test(value)?value:null;
}

export async function proveNativePair({instance,expectedInstance,instanceId,expectedInstanceIdHash,
  epoch,expectedEpoch,recordId,address,alternate=null,hmget}){
  assert(typeof instance==='string'&&instance===expectedInstance&&
    typeof instanceId==='string'&&hex.test(expectedInstanceIdHash)&&
    hash(instanceId)===expectedInstanceIdHash,'instance_identity_mismatch');
  assert(typeof epoch==='string'&&epoch===expectedEpoch&&/^[0-9a-f-]{36}$/.test(epoch),'closed_epoch');
  assert(typeof recordId==='string'&&hex.test(recordId),'record_scope_invalid');
  assert(typeof hmget==='function'&&typeof address==='string'&&
    (PN.test(address)||LID.test(address))&&
    (alternate===null||typeof alternate==='string'&&(PN.test(alternate)||LID.test(alternate))),
  'invalid_native_address');
  if(alternate!==null && PN.test(address)===PN.test(alternate)){
    assert(address===alternate,'conflicting_native_addresses');
  }
  const pnAddress=PN.test(address)?address:PN.test(alternate)?alternate:null;
  const lidAddress=LID.test(address)?address:LID.test(alternate)?alternate:null;
  let pn=pnAddress?.split('@')[0],lid=lidAddress?.split('@')[0];
  if(!pn&&!lid)throw Error('native_pair_missing');
  if(!pn){
    const [value]=await hmget(instanceId,['lid-mapping-'+lid+'_reverse']);
    pn=unwrap(value);
  }
  if(!lid){
    assert(pn,'native_pair_missing');
    const [value]=await hmget(instanceId,['lid-mapping-'+pn]);
    lid=unwrap(value);
  }
  assert(pn&&lid&&PN.test(pn+'@s.whatsapp.net')&&LID.test(lid+'@lid'),
    'native_pair_missing');
  const pair=await hmget(instanceId,['lid-mapping-'+pn,'lid-mapping-'+lid+'_reverse']);
  assert(Array.isArray(pair)&&pair.length===2&&unwrap(pair[0])===lid&&unwrap(pair[1])===pn,
    'native_pair_not_bidirectional');
  if(pnAddress)assert.equal(pnAddress,pn+'@s.whatsapp.net','presented_pn_mismatch');
  if(lidAddress)assert.equal(lidAddress,lid+'@lid','presented_lid_mismatch');
  const pnJid=pn+'@s.whatsapp.net',lidJid=lid+'@lid';
  return {instance,instance_id_hash:expectedInstanceIdHash,epoch,record_id:recordId,paused:false,
    forward:{[pnJid]:lidJid},reverse:{[lidJid]:pnJid}};
}

// The caller opens the authenticated collector record before invoking this reader.
// Redis access is limited to at most two HMGETs for this individual instance.
export async function proveRecordedSender(record,scope,hmget){
  const {instance,instanceIdHash,epoch,id}=scope;
  assert(record.meta?.source==='evolution' && record.meta.instance===instance &&
    record.id===id && Buffer.isBuffer(record.raw) && recordId(instance,record.raw)===id,'record_scope_invalid');
  const envelope=JSON.parse(record.raw);
  assert(envelope?.instance===instance && typeof envelope.event==='string' &&
    envelope.event.toLowerCase().replaceAll('_','.')==='messages.upsert','wrong_event');
  const data=envelope.data,key=data?.key;
  assert(key?.fromMe===false && !key.participant && !key.participantAlt &&
    !data.participant && !data.participantAlt && typeof key.id==='string' &&
    /^[A-Za-z0-9_-]{6,160}$/.test(key.id),'not_an_individual_inbound');
  const addresses=[key.remoteJid,key.remoteJidAlt,data.remoteJidAlt,data.remoteJid]
    .filter(value=>value!==null && value!==undefined);
  assert(addresses.length>0 && addresses.every(v=>typeof v==='string'&&(PN.test(v)||LID.test(v))),'invalid_native_address');
  const distinct=[...new Set(addresses)];
  assert(distinct.length<=2,'conflicting_native_addresses');
  return proveNativePair({instance:envelope.instance,expectedInstance:instance,instanceId:data.instanceId,
    expectedInstanceIdHash:instanceIdHash,epoch,expectedEpoch:epoch,recordId:id,address:distinct[0],
    alternate:distinct[1]??null,hmget});
}
