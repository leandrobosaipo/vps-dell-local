"""Restore the four public model files, pinned to the hashes measured on the old host."""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import socket
import sys
import urllib.request


def restore_model(root,manifest):
    revision=manifest['revision']
    if not re.fullmatch('[0-9a-f]{40}',revision):raise ValueError('invalid_revision')
    items=manifest['files']
    expected={'config.json','model.bin','tokenizer.json','vocabulary.txt'}
    if len(items)!=len(expected) or {r['name'] for r in items}!=expected:raise ValueError('unexpected_files')
    if not all(re.fullmatch('[0-9a-f]{64}',r['sha256']) and 0<r['size']<500_000_000 for r in items):raise ValueError('invalid_file')
    root.mkdir(mode=0o700,exist_ok=True)
    if root.is_symlink() or root.stat().st_uid!=os.getuid():raise ValueError('existing_path')
    if shutil.disk_usage(root).free<sum(r['size'] for r in items)+2*1024**3:raise ValueError('insufficient_disk')
    package=root/'models--Systran--faster-whisper-small'
    snapshot=package/'snapshots'/revision;snapshot.mkdir(parents=True,exist_ok=True)
    for r in items:
        dest=snapshot/r['name']
        if dest.exists():
            with dest.open('rb') as f:
                if dest.stat().st_size!=r['size'] or hashlib.file_digest(f,'sha256').hexdigest()!=r['sha256']:
                    raise ValueError('existing_file_mismatch')
            continue
        url='https://huggingface.co/Systran/faster-whisper-small/resolve/'+revision+'/'+r['name']
        temp=dest.with_suffix(dest.suffix+'.partial')
        h=hashlib.sha256();count=0
        with urllib.request.urlopen(url,timeout=40) as response,temp.open('xb') as f:
            while chunk:=response.read(1024*1024):
                count+=len(chunk)
                if count>r['size']:raise ValueError('file_too_large')
                h.update(chunk);f.write(chunk)
            f.flush();os.fsync(f.fileno())
        if count!=r['size'] or h.hexdigest()!=r['sha256']:raise ValueError('download_mismatch')
        os.replace(temp,dest)
    refs=package/'refs';refs.mkdir(exist_ok=True);main=refs/'main'
    if main.exists():
        if main.read_text()!=revision:raise ValueError('revision_conflict')
    else:
        with main.open('x') as f:f.write(revision)
    return {'revision':revision,'verifiedFiles':len(items),'bytes':sum(r['size'] for r in items)}


if __name__=='__main__':
    if socket.gethostname()!='agentes-lab':raise SystemExit('wrong_host')
    root=Path('/var/lib/jp-migracao-revisao/speech')
    try:
        result=restore_model(root/'models',json.loads((root/'manifest.json').read_bytes()))
    except Exception as err:
        # Some CDN errors contain signed URLs; keep only the exception type.
        (root/'download-error.json').write_text(json.dumps({'type':type(err).__name__,'status':getattr(err,'code',None)}))
        raise SystemExit(1) from None
    with (root/'model-verified.json').open('x') as f:json.dump(result,f)
