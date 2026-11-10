// One operator-run appointment, using the captured native adapters mounted read-only.
// Nothing listens on a port. Every write requires its own action and durable intent.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {createHash,randomBytes} from 'node:crypto';
import {readCurrentVisitCatalog,readExistingVisitItems,createOfficialVisitItem,readCreatedVisitItem,cancelControlledTestVisit} from '/native/jp-appbarber-new-visit.mjs';
import {moveOfficialAppointment} from '/native/jp-appbarber-confirmation.mjs';
import {promoteSession,readSession} from '/native/jp-appbarber-session-store.mjs';

process.umask(0o077);
const action=process.argv[2], base='/proof', origin='https://sistema.appbarber.com.br';
const read=name=>JSON.parse(fs.readFileSync(base+'/'+name+'.json'));
const exists=name=>fs.existsSync(base+'/'+name+'.json');
const hash=value=>createHash('sha256').update(value).digest('hex');
function save(name,value) {
  const fd=fs.openSync(base+'/'+name+'.json','wx',0o600);
  try {fs.writeFileSync(fd,JSON.stringify(value));fs.fsyncSync(fd);} finally {fs.closeSync(fd);}
  const dir=fs.openSync(base,'r');try {fs.fsyncSync(dir);} finally {fs.closeSync(dir);}
}
const raw=JSON.parse(fs.readFileSync('/input/appbarber'));
const grant=read('grant'), selected=grant.selection, date=selected.date;
assert(['preflight','create','move','cancel','check'].includes(action));
assert(raw.origin===origin && raw.source_generation===grant.generation && grant.customer_sha256 && grant.service);
assert(grant.zero_price && grant.personal && grant.times_authorized && selected.times.length===2);
assert(grant.deadline && Date.now()<Date.parse(grant.deadline));
const pin=JSON.parse(fs.readFileSync('/input/pin')).destination;
const phone=value=>{const n=String(value||'').replace(/\D/g,'');return /^\d{10,11}$/.test(n)?'55'+n:n;};
const key=randomBytes(32).toString('hex');
process.env.JP_APPBARBER_SESSION_KEY=key;
process.env.JP_APPBARBER_SESSION_STORE_FILE='/tmp/session.json';
promoteSession('/tmp/session.json',key,{session:raw,identity:{verified_at:raw.source_verified_at,verification_id:grant.verification_id}});
const config={session:readSession('/tmp/session.json',key).session};
async function official(path,params=null) {
  const response=await fetch(origin+path,{method:params?'POST':'GET',redirect:'error',signal:AbortSignal.timeout(10000),
    headers:{Cookie:config.session.cookieHeader,Origin:origin,Referer:origin+'/index.php','X-Requested-With':'XMLHttpRequest',
      ...(params?{'Content-Type':'application/x-www-form-urlencoded; charset=UTF-8'}:{})},...(params?{body:new URLSearchParams(params)}:{})});
  assert(response.ok && response.url===origin+path);
  return response.json();
}
const rows=(value,k)=>{const a=k?value[k]:value;assert(Array.isArray(a)&&a.every(x=>x&&String(x.erro??'0')==='0'));return a;};
const clients=rows(await official('/pages/cadastros/buscaClientes.php',{}),'data');
const matches=clients.filter(c=>[c.Celular,c.Cli_Celular,c.Telefone].some(v=>phone(v)===phone(pin)));
assert.equal(matches.length,1);
const client=matches[0],id=String(client.Codigo||client.Cli_Codigo);
assert.equal(hash(id),grant.customer_sha256);
assert(!String(client.Email||'').trim() && ['','0'].includes(String(client.UsuCodigo||'')));
const prices=rows(await official('/pages/cadastros/buscaServicosv2.php',{}),'data').filter(x=>String(x.Ser_Codigo)===grant.service);
assert(prices.length===1 && String(prices[0].Ser_Valor).trim()==='0,00' && String(prices[0].Moeda).trim()==='R$');
const sms=rows(await official('/pages/actions/buscaSaldoSMS.php'),'result');
const wa=rows(await official('/pages/cadastros/buscaSaldoWhats.php',{tipo:'1'}),'data');
assert(sms.length===1 && wa.length===1 && String(sms[0].Saldo)==='0' && String(wa[0].Saldo)==='0');
const item={client_code:id,destination_e164:pin,professional_code:selected.professional,service_code:grant.service,
  date,time:selected.times[0],duration_minutes:selected.duration,attempt_id:grant.operation,controlled_test:true,historical_appointment_ids:[]};
const catalog=await readCurrentVisitCatalog(item,config);
assert.equal(catalog.duration_minutes,selected.duration);
const day=date.split('-').reverse().join('/');
const agenda=async()=>rows(await official('/pages/actions/buscaAgenda3.php',{'profissional[]':selected.professional,tipo:'1',dia:day}));
async function free(time) {
  const offered=rows(await official('/pages/cadastros/buscaHorariosDisponiveisv2.php',{servico:grant.service,profissional:selected.professional,dia:String(+date.slice(8)),mes:String(+date.slice(5,7)),ano:date.slice(0,4)}),'data')
    .filter(x=>String(x.PesCodigoPrincipal)===selected.professional);
  assert(offered.length===1&&offered[0].horarios.some(v=>String(v.DataIni).slice(0,5)===time));
  const start=date+'T'+time,end=new Date(Date.parse(start+':00Z')+selected.duration*60000).toISOString().slice(0,16);
  const active=(await agenda()).filter(r=>String(r.codStatus)!=='4');
  assert(active.every(r=>String(r.resources)===selected.professional&&r.start&&r.end&&
    (String(r.start).slice(0,16)>=end||String(r.end).slice(0,16)<=start)));
}
const guard=operation=>async snapshot=>{
  assert.equal(operation,action);
  save(operation+'-intent',{at:new Date().toISOString(),operation:grant.operation,snapshot});
};
function candidate(created) {
  return {...item,kind:'appointment_confirmation',appointment_id:created.readback.appointment_id,
    appointment_date_iso:date,appointment_date:day,appointment_time:item.time};
}
async function main() {
  if(action==='preflight'||action==='create'){
    await free(selected.times[0]);await free(selected.times[1]);
    const prior=await readExistingVisitItems(item,config);
    assert(!prior.some(r=>r.DataAgendamento===day && selected.times.includes(String(r.HoraAgendamento).slice(0,5))));
    if(action==='preflight')return {status:'ready',futureVisits:prior.length,zeroPrice:true,notificationsDisabled:true};
    assert(exists('preflight-result')&&!exists('create-intent'));
    const created=await createOfficialVisitItem(item,config,{markAttempt:guard('create')});
    assert.equal(created.status,'saved');
    assert(created.readback.appointment_id&&!created.before_appointment_ids.includes(created.readback.appointment_id));
    return created;
  }
  const created=read('create-result'),c=candidate(created);
  const movedItem={...item,time:selected.times[1],appointment_id:c.appointment_id,excluded_appointment_ids:created.before_appointment_ids};
  if(action==='move') {
    if(exists('move-intent')){
      const intent=read('move-intent');
      assert.equal(intent.snapshot.appointment_id,c.appointment_id);
      assert.equal(intent.snapshot.item_code,created.readback.item_code);
      const readback=await readCreatedVisitItem(movedItem,config);
      assert.equal(readback.item_code,created.readback.item_code);
      return {status:'saved',before:intent.snapshot,readback,reconciledByReadOnly:true};
    }
    await free(selected.times[1]);
    const moved=await moveOfficialAppointment(c,{date,time:selected.times[1],professional_code:selected.professional},config,guard('move'));
    assert.equal(moved.status,'saved');assert.equal(moved.readback.appointment_id,c.appointment_id);
    assert.equal(moved.readback.item_code,created.readback.item_code);
    await readCreatedVisitItem(movedItem,config);
    return moved;
  }
  const moved=read('move-result');
  assert.equal(moved.readback.appointment_id,c.appointment_id);
  if(action==='cancel'){
    assert(!exists('cancel-intent'));
    const canceled=await cancelControlledTestVisit({...movedItem,creation_proof:created},config,{markAttempt:guard('cancel')});
    assert.equal(canceled.status,'canceled');assert.equal(canceled.appointment_id,c.appointment_id);
    return canceled;
  }
  assert(exists('cancel-result'));
  const current=(await agenda()).filter(r=>String(r.id)===c.appointment_id);
  assert(current.length===0||(current.length===1&&String(current[0].codStatus)==='4'));
  const future=await readExistingVisitItems(item,config);
  assert(!future.some(r=>String(r.Age_Codigo)===c.appointment_id));
  const otherIds=(await agenda()).map(r=>String(r.id)).filter(i=>i!==c.appointment_id).sort();
  const baseline=[...created.before_appointment_ids].sort();
  return {status:'closed',appointment_id:c.appointment_id,confirmedAbsentFromActiveAgenda:true,confirmedAbsentFromPersonalFuture:true,
    sameOtherAppointmentIds:JSON.stringify(otherIds)===JSON.stringify(baseline),otherAppointments:otherIds.length};
}
try{
  assert(!exists(action+'-result'));
  const value=await main();
  save(action+'-result',value);
  console.log(JSON.stringify({action,status:value.status}));
}catch(e){
  console.log(JSON.stringify({action,status:'held',error:e.code==='ERR_ASSERTION'?'assertion_failed':
    (/^[a-z_]+$/.test(e.message)?e.message:'operation_error'),line:e.stack.split('\n').find(s=>s.includes('personal_booking_cycle'))?.match(/:(\d+):\d+/)?.[1],
    intent:exists(action+'-intent')}));
  process.exitCode=1;
}
