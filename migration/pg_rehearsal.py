"""Restore a consistent snapshot per pilot database into a disposable network-isolated PostgreSQL."""
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
from cryptography.hazmat.primitives import hashes,serialization
from cryptography.hazmat.primitives.asymmetric import padding
from cryptography.hazmat.primitives.ciphers.aead import AESGCM


class ReadSnapshot:
    def __init__(self,cid,database):
        self.process=subprocess.Popen(['docker','exec','-i',cid,'psql','-XqAt','--set','ON_ERROR_STOP=1','-U','postgres','-d',database],
            text=True,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
    def query(self,sql):
        sentinel='end_'+secrets.token_hex(12)
        self.process.stdin.write(sql+';\n\\echo '+sentinel+'\n');self.process.stdin.flush()
        lines=[]
        for line in self.process.stdout:
            line=line.rstrip('\n')
            if line==sentinel:return lines
            lines.append(line)
        raise RuntimeError('snapshot_query_failed')
    def close(self):
        self.process.stdin.close()
        if self.process.wait(timeout=10)!=0:raise RuntimeError('snapshot_session_failed')


def manifest(session):
    names=session.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")
    if not names:raise ValueError('missing_tables')
    rows={}
    for name in names:
        if not re.fullmatch('[A-Za-z_][A-Za-z_0-9]*',name):raise ValueError('unexpected_table')
        # The ordered multiset includes the primary key, complete row and duplicate multiplicity.
        result=session.query('SELECT count(*),encode(sha256(convert_to(coalesce(string_agg(h,\'\' ORDER BY h),\'\'),\'UTF8\')),\'hex\') '
            'FROM (SELECT encode(sha256(convert_to(to_jsonb(r)::text,\'UTF8\')),\'hex\') h FROM public."'+name+'" r) rows')
        count,digest=result[0].split('|');rows[name]=[int(count),digest]
    return rows


def rehearse(root):
    if socket.gethostname()!='agentes-lab' or os.geteuid()!=0:raise ValueError('wrong_scope')
    def docker(*args,stdin=None,timeout=120):
        return subprocess.check_output(['docker',*args],input=stdin,stderr=subprocess.PIPE,timeout=timeout)
    source=docker('ps','-q','--filter','label=com.docker.compose.project=atendimento-piloto','--filter','label=com.docker.compose.service=postgres').decode().strip()
    if not source or '\n' in source:raise ValueError('source_identity')
    origin=json.loads(docker('inspect',source))[0]
    key=serialization.load_pem_private_key((root/'custodia-journal.pem').read_bytes(),password=None)
    aes=os.urandom(32);wrapped=key.public_key().encrypt(aes,padding.OAEP(padding.MGF1(hashes.SHA256()),hashes.SHA256(),None))
    stamp=time.strftime('%Y%m%dT%H%M%SZ',time.gmtime());folder=root/('databases-'+stamp);folder.mkdir(mode=0o700)
    (folder/'wrapped-key').write_bytes(wrapped)
    cid=docker('run','-d','--pull=never','--network','none','--memory','300m','--cpus','0.75','--pids-limit','100',
        '--label','cod5.jp.pgrehearsal='+stamp,'--tmpfs','/var/lib/postgresql/data:rw,size=280m','-e','POSTGRES_HOST_AUTH_METHOD=trust',origin['Image']).decode().strip()
    results={}
    try:
        for _ in range(60):
            try:
                docker('exec',cid,'psql','-U','postgres','-d','postgres','-h','127.0.0.1','-Atc','SELECT 1');break
            except subprocess.CalledProcessError:time.sleep(.5)
        else:raise TimeoutError('restore_engine_not_ready')
        for dbname in ('clock','chat','flow'):
            session=ReadSnapshot(source,dbname)
            try:
                session.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
                snap=session.query('SELECT pg_export_snapshot()')[0]
                dump=docker('exec',source,'pg_dump','--no-owner','--no-acl','--snapshot='+snap,'-Fc','-U','postgres','-d',dbname)
                expected=manifest(session)
                session.query('COMMIT')
            finally:session.close()
            aad=(stamp+'/'+dbname).encode()
            iv=os.urandom(12);archive=folder/(dbname+'.pgdump.aead')
            with archive.open('xb') as f:
                f.write(iv+AESGCM(aes).encrypt(iv,dump,aad));f.flush();os.fsync(f.fileno())
            sealed=archive.read_bytes()
            recovered=key.decrypt((folder/'wrapped-key').read_bytes(),padding.OAEP(padding.MGF1(hashes.SHA256()),hashes.SHA256(),None))
            restored=AESGCM(recovered).decrypt(sealed[:12],sealed[12:],aad)
            docker('exec',cid,'createdb','-U','postgres',dbname)
            docker('exec','-i',cid,'pg_restore','--single-transaction','--exit-on-error','--no-owner','--no-acl','-U','postgres','-d',dbname,stdin=restored)
            target=ReadSnapshot(cid,dbname)
            try:actual=manifest(target)
            finally:target.close()
            if expected!=actual:raise ValueError('restored_rows_changed_'+dbname)
            results[dbname]={'tables':len(actual),'rows':sum(v[0] for v in actual.values()),'archiveSha256':hashlib.sha256(sealed).hexdigest()}
            (folder/(dbname+'-manifest.json')).write_text(json.dumps(expected,sort_keys=True))
        proof={'scope':'one_consistent_snapshot_per_database','folder':folder.name,'databases':results,'productionRestore':False}
        (folder/'receipt.json').write_text(json.dumps(proof))
        return proof
    finally:
        v=json.loads(docker('inspect',cid))[0]
        if v['Config']['Labels'].get('cod5.jp.pgrehearsal')==stamp and v['HostConfig']['NetworkMode']=='none':
            docker('rm','-f',cid)
