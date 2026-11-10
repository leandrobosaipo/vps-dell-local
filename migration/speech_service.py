"""Start a verified offline speech worker, test a fictional WAV, then enable restart."""
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import socket
import subprocess
import time
import unicodedata


def stage_speech(image,expected_source_sha,audio):
    root=Path('/var/lib/jp-migracao-revisao/speech')
    if socket.gethostname()!='agentes-lab' or os.geteuid()!=0 or not re.fullmatch(r'sha256:[0-9a-f]{64}',image):
        raise ValueError('invalid_deployment_scope')
    if not audio.startswith(b'RIFF') or len(audio)>300_000:raise ValueError('fixture_required')
    def docker(*a,stdin=None):
        return subprocess.check_output(['docker',*a],input=stdin,text=True,stderr=subprocess.PIPE,timeout=100).strip()
    name='jp-speech-dell';net='atendimento-piloto_pilot';models=root/'models'
    assert json.loads((root/'model-verified.json').read_text())['verifiedFiles']==4
    assert json.loads(docker('network','inspect',net))[0]['Internal']
    assert json.loads(docker('image','inspect',image))[0]['Architecture']=='amd64'
    assert not docker('ps','-aq','--filter','name=^/'+name+'$')
    check="import hashlib;print(hashlib.sha256(open('/app/server.py','rb').read()).hexdigest())"
    assert docker('run','--rm','--pull=never','--network','none','--read-only','--cap-drop','ALL',image,'python','-c',check)==expected_source_sha
    for path in [models,*models.rglob('*')]:
        assert not path.is_symlink();path.chmod(0o555 if path.is_dir() else 0o444)
    secret=secrets.token_hex(32);auth=root/'worker.token'
    with auth.open('x') as f:f.write(secret)
    os.chown(auth,65534,65534);auth.chmod(0o400)
    launch="import os,runpy;os.environ['JP_SPEECH_SHARED_SECRET']=open('/worker-token').read();runpy.run_path('/app/server.py',run_name='__main__')"
    cid=docker('run','-d','--name',name,'--pull=never','--read-only','--user','65534:65534','--network',net,'--cap-drop','ALL',
        '--security-opt','no-new-privileges:true','--pids-limit','96','--memory','1344m','--cpus','1.5','--tmpfs','/tmp:rw,nosuid,noexec,size=32m,mode=1777',
        '--env','HF_HUB_OFFLINE=1','--env','JP_SPEECH_ALLOW_MODEL_DOWNLOAD=0','--env','HOME=/tmp','--label','cod5.jp.role=speech-standby',
        '--mount','type=bind,src='+str(models)+',dst=/models,readonly','--mount','type=bind,src='+str(auth)+',dst=/worker-token,readonly',
        image,'python','-B','-c',launch)
    details=json.loads(docker('inspect',cid))[0]
    assert list(details['NetworkSettings']['Networks'])==[net] and not details['HostConfig']['PortBindings']
    clock=docker('ps','-q','--filter','label=com.docker.compose.project=atendimento-piloto','--filter','label=com.docker.compose.service=clock')
    assert clock and '\n' not in clock
    for _ in range(45):
        try:
            s=docker('exec',clock,'node','-e',"fetch('http://jp-speech-dell:8796/healthz').then(r=>r.json()).then(x=>console.log(JSON.stringify(x)))")
            if json.loads(s)['ready']:break
        except (subprocess.CalledProcessError,ValueError):pass
        if not json.loads(docker('inspect',cid))[0]['State']['Running']:raise RuntimeError('worker_stopped')
        time.sleep(.5)
    else:raise RuntimeError('worker_unready')
    js="""const p=JSON.parse(require('fs').readFileSync(0)),b=Buffer.from(p.audio,'base64');fetch('http://jp-speech-dell:8796/transcribe',{
    method:'POST',body:b,headers:{'Content-Type':'audio/wav','Authorization':'Bearer '+p.token,'X-Audio-SHA256':p.hash,'X-Job-ID':'jp-audio:'+p.hash}}).then(async r=>console.log(JSON.stringify({status:r.status,body:await r.json()})))"""
    h=hashlib.sha256(audio).hexdigest()
    p={'audio':base64.b64encode(audio).decode(),'token':secret,'hash':h}
    response=json.loads(docker('exec','-i',clock,'node','-e',js,stdin=json.dumps(p)))
    r=response['body'];text=''.join(c for c in unicodedata.normalize('NFD',r.get('transcript','').lower()) if not unicodedata.combining(c))
    assert response['status']==200 and r.get('audio_sha256')==h and r['requires_human_review'] and r.get('official_agenda_mutated') is False
    assert 'horario' in text and 'atendimento' in text,'synthetic_transcription_mismatch'
    docker('update','--restart','unless-stopped',cid)
    v=json.loads(docker('inspect',cid))[0]
    assert v['State']['Running'] and not v['State']['OOMKilled'] and v['HostConfig']['RestartPolicy']['Name']=='unless-stopped'
    return {'image':image,'sourceSha':expected_source_sha,'fixtureSha':h,'http':response['status'],'transcript':r['transcript'],
            'humanReview':True,'officialWrites':0,'fromDellClockNetwork':True,'restartPolicy':'unless-stopped'}
