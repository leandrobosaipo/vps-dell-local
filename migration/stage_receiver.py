"""Install the verified receive-only collector on the Dell loopback, with fresh local credentials."""
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import socket
import subprocess
import urllib.request
import time


def prepare(source,source_sha,instance,image):
    if os.geteuid()!=0 or socket.gethostname()!='agentes-lab' or hashlib.sha256(source).hexdigest()!=source_sha:
        raise ValueError('source_or_host_mismatch')
    if not re.fullmatch(r'[a-z0-9-]{3,80}',instance) or not re.fullmatch(r'node:22[.0-9]+-alpine@sha256:[0-9a-f]{64}',image):
        raise ValueError('invalid_receiver_configuration')
    def docker(*args):
        return subprocess.check_output(['docker',*args],text=True,stderr=subprocess.PIPE,timeout=45).strip()
    root=Path('/var/lib/jp-migracao-revisao/receiver')
    name='jp-entrada-dell'
    if root.exists() or docker('ps','-aq','--filter','name=^/'+name+'$'):
        raise ValueError('inspect_prior_attempt')
    network='atendimento-piloto_pilot'
    if not json.loads(docker('network','inspect',network))[0]['Internal']:
        raise ValueError('internal_network_required')
    with socket.socket() as check:
        check.bind(('127.0.0.1',18787))
    root.mkdir(mode=0o700)
    (root/'ingress.mjs').write_bytes(source)
    (root/'ingress.mjs').chmod(0o444)
    recorddir=root/'records'
    secret=root/'access'
    for folder in (secret,recorddir):
        folder.mkdir(mode=0o700);os.chown(folder,65534,65534)
    token=secrets.token_hex(32)
    for n,b in [('token',token.encode()),('key',os.urandom(32)),('instance',instance.encode())]:
        path=secret/n;path.write_bytes(b);path.chmod(0o600);os.chown(path,65534,65534)
    args=['run','-d','--name',name,'--pull=never','--network',network,'--publish','127.0.0.1:18787:8787',
          '--read-only','--restart','unless-stopped','--user','65534:65534','--memory','128m','--cpus','0.25',
          '--pids-limit','48','--cap-drop','ALL','--security-opt','no-new-privileges:true','--log-driver','none',
          '--label','cod5.jp.role=receive-only','--label','cod5.source.sha256='+source_sha]
    for src,dst,access in [(secret,'/access',',readonly'),(recorddir,'/records',''),(root/'ingress.mjs','/ingress.mjs',',readonly')]:
        args+=['--mount','type=bind,src='+str(src)+',dst='+dst+access]
    cid=docker(*args,image,'node','/ingress.mjs','--source','evolution','--dir','/records','--bind','0.0.0.0','--port','8787',
               '--token-file','/access/token','--key-file','/access/key','--instance-file','/access/instance','--min-free-bytes','536870912')
    check=json.loads(docker('inspect',cid))[0]
    assert check['HostConfig']['PortBindings']=={'8787/tcp':[{'HostIp':'127.0.0.1','HostPort':'18787'}]}
    local=urllib.request.build_opener(urllib.request.ProxyHandler({}))
    for attempt in range(20):
        try:
            with local.open('http://127.0.0.1:18787/healthz',timeout=2) as r:
                health=json.load(r)
            if health.get('status')=='ready':break
        except OSError:pass
        time.sleep(.25)
    else:raise RuntimeError('loopback_not_ready')
    raw=json.dumps({'instance':instance,'event':'jp.maintenance.fixture','data':{'fixture':secrets.token_hex(12)}}).encode()
    req=urllib.request.Request('http://127.0.0.1:18787/inbound',data=raw,headers={'Content-Type':'application/json','Authorization':'Bearer '+token})
    for attempt in range(2):
        with local.open(req,timeout=4) as r:
            assert 200<=r.status<300
    files=list(recorddir.glob('*.json'));assert len(files)==1
    # Independently decrypt the stored fixture and compare it to the posted bytes.
    js="import fs from 'node:fs';import {readRecord} from '/ingress.mjs';const d='/records/';const p=d+fs.readdirSync(d).find(n=>/^[0-9a-f]{64}\\.json$/.test(n));const v=readRecord(p,fs.readFileSync('/access/key'),fs.readFileSync('/access/instance','utf8'));console.log(v.meta.rawSha256)"
    assert docker('exec',cid,'node','--input-type=module','-e',js)==hashlib.sha256(raw).hexdigest()
    return {'id':cid,'source':source_sha,'loopbackPort':18787,'encryptedFixtureCount':1,'duplicateSuppressed':True,'realRouteChanged':False}
