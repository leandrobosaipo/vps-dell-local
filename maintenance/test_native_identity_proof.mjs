import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {proveNativePair,proveRecordedSender} from './native_identity_proof.mjs';
import {recordId} from './ingress.mjs';

const instanceId='fixture-instance-id',epoch=randomUUID();
const pn='5511990000001',lid='100000001';
const hash=v=>createHash('sha256').update(v).digest('hex');
function args(hmget){return {instance:'fixture',expectedInstance:'fixture',instanceId,
  expectedInstanceIdHash:hash(instanceId),epoch,expectedEpoch:epoch,recordId:'a'.repeat(64),
  address:lid+'@lid',alternate:pn+'@s.whatsapp.net',hmget};}
function lookup(rows){return async (id,keys)=>{
  assert.equal(id,instanceId);return keys.map(k=>rows[k]??null);
};}
test('proves both directions for the exact instance and epoch',async()=>{
  const hmget=lookup({['lid-mapping-'+pn]:JSON.stringify(lid),
    ['lid-mapping-'+lid+'_reverse']:pn});
  const proof=await proveNativePair(args(hmget));
  assert.equal(proof.forward[pn+'@s.whatsapp.net'],lid+'@lid');
  assert.equal(proof.reverse[lid+'@lid'],pn+'@s.whatsapp.net');
  assert.equal((await proveNativePair({...args(hmget),alternate:null})).forward[pn+'@s.whatsapp.net'],lid+'@lid');
  assert.equal((await proveNativePair({...args(hmget),address:pn+'@s.whatsapp.net',alternate:null})).reverse[lid+'@lid'],pn+'@s.whatsapp.net');
});
test('reads only the pair on the authenticated individual record',async()=>{
  const instance='fixture',mk=(changes={},extra={})=>{
    const raw=Buffer.from(JSON.stringify({instance,event:'messages.upsert',data:{instanceId,
      key:{id:'INBOUND123',fromMe:false,remoteJid:lid+'@lid',...changes},...extra}}));
    return {id:recordId(instance,raw),meta:{source:'evolution',instance},raw};
  };
  const record=mk(),scope={instance,instanceIdHash:hash(instanceId),epoch,id:record.id},reads=[];
  const hmget=(id,names)=>{reads.push(names);return lookup({['lid-mapping-'+pn]:lid,['lid-mapping-'+lid+'_reverse']:pn})(id,names);};
  const result=await proveRecordedSender(record,scope,hmget);
  assert.deepEqual(reads,[['lid-mapping-'+lid+'_reverse'],['lid-mapping-'+pn,'lid-mapping-'+lid+'_reverse']]);
  assert.equal(result.record_id,record.id);
  for(const bad of [mk({fromMe:true}),mk({participant:pn}),mk({},{instanceId:'other'}),
                    mk({},{remoteJidAlt:'100000002@lid'}),mk({remoteJid:'123@g.us'})]){
    await assert.rejects(proveRecordedSender(bad,{...scope,id:bad.id},hmget));
  }
  await assert.rejects(proveRecordedSender(record,{...scope,id:'0'.repeat(64)},hmget));
  assert.equal(reads.length,2);
});
test('holds wrong instance, epoch, incomplete or conflicting mapping',async()=>{
  const good=lookup({['lid-mapping-'+pn]:lid,['lid-mapping-'+lid+'_reverse']:pn});
  await assert.rejects(proveNativePair({...args(good),expectedInstance:'other'}));
  await assert.rejects(proveNativePair({...args(good),expectedEpoch:randomUUID()}));
  await assert.rejects(proveNativePair({...args(good),recordId:'0'}));
  await assert.rejects(proveNativePair(args(lookup({['lid-mapping-'+pn]:lid}))));
  await assert.rejects(proveNativePair(args(lookup({['lid-mapping-'+pn]:lid,
    ['lid-mapping-'+lid+'_reverse']:'5511990000002'}))));
  await assert.rejects(proveNativePair({...args(good),alternate:'5511990000002@s.whatsapp.net'}));
});
