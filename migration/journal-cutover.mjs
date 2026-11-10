// Metadata-only view of verified receive-only records. This module has no send path.
import {createHash} from 'node:crypto';

export const fingerprint = text => createHash('sha256').update(text).digest('hex');

export function projectEvent(raw, expectedInstance, recordId, receivedAt) {
  const body = JSON.parse(raw);
  if (body.instance !== expectedInstance) throw Error('wrong_instance');
  const event = String(body.event).toLowerCase().replaceAll('_','.');
  const batch = Array.isArray(body.data) ? body.data : [body.data];
  return (batch.length ? batch : [null]).map((value, index) => {
    const data = value && typeof value === 'object' ? value : {};
    const key = data.key || {};
    const jid = key.remoteJid || data.remoteJid || '';
    const alt = key.remoteJidAlt || data.remoteJidAlt || '';
    const domain = str => typeof str === 'string' ? str.split('@')[1] : '';
    const kind = ['s.whatsapp.net','lid'].includes(domain(jid)) ? 'direct' :
      domain(jid) === 'g.us' ? 'group' : domain(jid) === 'broadcast' ? 'broadcast' : 'other';
    const fromMe = key.fromMe ?? data.fromMe;
    const native = key.id || data.keyId || data.id;
    const timestamp = Number(data.messageTimestamp);
    const time = timestamp > 0 && Number.isSafeInteger(timestamp) ? (timestamp < 1e12 ? timestamp * 1000 : timestamp) : null;
    const context = Object.values(data.message || {}).find(x => x?.contextInfo)?.contextInfo;
    return {recordId,index,receivedAt,event,kind,
      id: typeof native === 'string' && native.length ? fingerprint(native) : null,
      chat: jid ? fingerprint(jid) : null,
      pn: kind === 'direct' && domain(jid) === 's.whatsapp.net' ? fingerprint(jid) :
          kind === 'direct' && domain(alt) === 's.whatsapp.net' ? fingerprint(alt) : null,
      direction: fromMe === true ? 'out' : fromMe === false ? 'in' : 'unknown',
      time,quote: context?.stanzaId ? fingerprint(context.stanzaId) : null,
      type: /^[a-zA-Z]{1,50}$/.test(data.messageType || '') ? data.messageType : null,
      contentHash: data.message ? fingerprint(JSON.stringify(data.message)) : null};
  });
}

export function reconcileEvents(events, stateIds = new Set()) {
  const counter = {}, messages = new Map(), review = [];
  for (const e of events) {
    counter[e.event] = (counter[e.event] || 0) + 1;
    if (e.event !== 'messages.upsert') continue;
    if (!e.id || !e.chat || !e.time || e.direction === 'unknown') {
      review.push({...e,reason:'incomplete_native_identity'}); continue;
    }
    const key = [e.chat,e.direction,e.id].join('/');
    const prior = messages.get(key);
    if (prior && (prior.contentHash !== e.contentHash || prior.time !== e.time)) {
      review.push({...e,reason:'conflicting_duplicate'}); continue;
    }
    if (!prior) messages.set(key,e);
  }
  const direct = [...messages.values()].filter(e => e.kind === 'direct');
  const controls = new Set(['protocolMessage','reactionMessage','senderKeyDistributionMessage']);
  const outbound = direct.filter(e => e.direction === 'out' && !controls.has(e.type));
  for (const e of direct.filter(e => e.direction === 'in')) {
    if (controls.has(e.type)) {
      review.push({...e,reason:'control_event_preserved',alreadyInCentral:stateIds.has(e.id)});
      continue;
    }
    const replies = outbound.filter(r => (r.chat === e.chat || (e.pn && r.pn === e.pn)) && r.time >= e.time);
    const reason = replies.some(r => r.quote === e.id) ? 'quoted_reply_observed' :
      replies.length ? 'later_outbound_requires_review' : 'no_later_outbound_observed';
    review.push({...e,reason,alreadyInCentral:stateIds.has(e.id)});
  }
  return {eventCounts:counter,distinctMessages:messages.size,review,autoReplay:false};
}
