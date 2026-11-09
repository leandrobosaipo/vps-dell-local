import {validateNativeTarget} from './evolution-native-guard.mjs';

// All values returned by this projection are metadata. Never return the native
// client, credential material, QR, pairing code, phone number or error message.
export function snapshotNativeClient() {
  const crypto=process.getBuiltinModule('node:crypto');
  const hash=value=>typeof value==='string'?crypto.createHash('sha256').update(value).digest('hex'):null;
  const creds=this.instance?.authState?.state?.creds,ws=this.client?.ws,qr=this.qrCode;
  return {instance_name_hash:hash(this.instance?.name),instance_id_hash:hash(this.instance?.id),
    integration:this.instance?.integration,native_method_hash:typeof this.reloadConnection==='function'?hash(Function.prototype.toString.call(this.reloadConnection)):null,
    create_method_hash:typeof this.createClient==='function'?hash(Function.prototype.toString.call(this.createClient)):null,
    state:this.connectionStatus?.state,end_session:this.endSession,phone_number_present:!!this.phoneNumber,
    socket:{is_open:ws?.isOpen===true,is_closed:ws?.isClosed===true,is_connecting:ws?.isConnecting===true,
      is_closing:ws?.isClosing===true,underlying_absent:!ws?.socket,underlying_ready_state:ws?.socket?.readyState??null},
    auth:{registered:creds?.registered===true,me_present:!!creds?.me?.id,me_hash:hash(creds?.me?.id),
      identity_key_present:!!creds?.signedIdentityKey?.public,identity_key_hash:creds?.signedIdentityKey?.public?crypto.createHash('sha256').update(Buffer.from(creds.signedIdentityKey.public)).digest('hex'):null},
    qr:{count:Number.isSafeInteger(qr?.count)?qr.count:null,base64_present:!!qr?.base64,pairing_present:!!qr?.pairingCode},
    settings:{rejectCall:this.localSettings?.rejectCall===true,reply_call_present:!!this.localSettings?.msgCall?.trim(),
      alwaysOnline:this.localSettings?.alwaysOnline===true,readMessages:this.localSettings?.readMessages===true,readStatus:this.localSettings?.readStatus===true}};
}

// This function is evaluated in the existing process with the validated guard
// and snapshot functions in its lexical scope. It claims BEFORE invoking once.
export function startNativeReload(controller,pinned,expected,claimFile) {
  const fs=process.getBuiltinModule('node:fs'),path=process.getBuiltinModule('node:path'),crypto=process.getBuiltinModule('node:crypto');
  const hash=value=>crypto.createHash('sha256').update(String(value)).digest('hex');
  const entries=Object.entries(controller?.waMonitor?.waInstances||{}).filter(([name])=>hash(name)===expected.instance_name_hash);
  if(entries.length!==1||entries[0][1]!==pinned)throw Error('native_registry_changed');
  const before=snapshotNativeClient.call(pinned),gates=validateNativeTarget(before,expected);
  if(!gates.can_attempt_once)throw Error('native_target_gate_denied');
  if(Object.values(before.settings).some(Boolean)||before.qr.pairing_present||before.phone_number_present)throw Error('native_autonomy_or_pairing_gate_denied');
  const dir=path.dirname(claimFile);if(path.basename(claimFile)!=='jp-reloadConnection-20261109-once.json')throw Error('claim_filename_denied');
  if(!fs.existsSync(dir))fs.mkdirSync(dir,{mode:0o700});
  const stat=fs.lstatSync(dir);if(!stat.isDirectory()||stat.isSymbolicLink()||stat.uid!==process.getuid()||(stat.mode&0o777)!==0o700)throw Error('claim_directory_denied');
  const fd=fs.openSync(claimFile,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
  try{fs.writeFileSync(fd,JSON.stringify({version:1,at:new Date().toISOString(),operation:'one_native_reloadConnection',instance_name_hash:before.instance_name_hash,instance_id_hash:before.instance_id_hash,native_method_hash:before.native_method_hash,intent_is_not_proof_of_completion:true}));fs.fsyncSync(fd)}finally{fs.closeSync(fd)}
  const directory=fs.openSync(dir,'r');try{fs.fsyncSync(directory)}finally{fs.closeSync(directory)}
  const record={at:new Date().toISOString(),explicit_calls:0,status:'claimed',before,gates,claim_created:true,error_type:null,safety_stop:false};
  let result;try{record.explicit_calls=1;record.status='pending';result=pinned.reloadConnection()}
  catch(error){record.status='rejected';record.error_type=['Error','TypeError','TimeoutError','InternalServerErrorException','BadRequestException'].includes(error?.name)?error.name:'NativeError';return record}
  // Deliberately discard the native resolved value; it contains auth/socket data.
  Promise.resolve(result).then(()=>{record.status='resolved'},error=>{record.status='rejected';record.error_type=['Error','TypeError','TimeoutError','InternalServerErrorException','BadRequestException'].includes(error?.name)?error.name:'NativeError'});
  return record;
}

// A pairing request ends this maintenance attempt. Close ONLY its newly created
// client, without logout, deletion, code retrieval or another reload. endSession
// suppresses the native automatic reconnect path while this client is held.
export function inspectNativeReload(controller,pinned,record,expected,oldClient) {
  const crypto=process.getBuiltinModule('node:crypto'),hash=value=>crypto.createHash('sha256').update(String(value)).digest('hex');
  const entries=Object.entries(controller?.waMonitor?.waInstances||{}).filter(([name])=>hash(name)===expected.instance_name_hash);
  if(entries.length!==1||entries[0][1]!==pinned)throw Error('native_registry_changed');
  const now=snapshotNativeClient.call(pinned);
  const authDrift=!now.auth.me_present||now.auth.me_hash!==expected.auth.me_hash||now.auth.identity_key_hash!==expected.auth.identity_key_hash;
  const newQr=now.qr.pairing_present||(now.qr.base64_present&&now.qr.count>0&&now.qr.count!==record.before.qr.count);
  if((authDrift||newQr)&&!record.safety_stop){
    record.safety_stop=true;record.stop_reason=authDrift?'auth_changed_or_pairing':'new_pairing_request';
    if(pinned.client!==oldClient){pinned.endSession=true;try{pinned.client?.ws?.close()}catch{}try{pinned.client?.end(new Error('maintenance_pairing_stop'))}catch{}record.new_client_closed=true}
  }
  return {at:new Date().toISOString(),explicit_calls:record.explicit_calls,status:record.status,error_type:record.error_type,
    safety_stop:record.safety_stop,stop_reason:record.stop_reason||null,new_client_closed:record.new_client_closed===true,
    new_client_observed:pinned.client!==oldClient,before:record.before,after:now};
}
