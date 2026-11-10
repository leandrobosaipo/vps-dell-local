"""Verify and extract a preparation package into a new private directory only."""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import tempfile
import zipfile
from cryptography.hazmat.primitives.ciphers.aead import AESGCM


def restore_package(blob,key,dest):
    if blob[:6]!=b'JP-RC1' or len(key)!=32:raise ValueError('invalid_package')
    raw=AESGCM(key).decrypt(blob[6:18],blob[18:],blob[:6])
    if dest.exists() or dest.is_symlink():raise FileExistsError(dest.name)
    with zipfile.ZipFile(io.BytesIO(raw)) as z:
        meta=json.loads(z.read('manifest.json'))
        files=meta['files']
        if sorted(z.namelist())!=sorted(['manifest.json',*files]) or sum(e.file_size for e in z.infolist())>256*1024**2:
            raise ValueError('invalid_manifest')
        with tempfile.TemporaryDirectory(dir=dest.parent) as tmp:
            stage=Path(tmp)/'verified';stage.mkdir(mode=0o700)
            for name,expected in files.items():
                path=PurePosixPath(name)
                if path.is_absolute() or '..' in path.parts or '\\' in name or path.as_posix()!=name:
                    raise ValueError('invalid_name')
                data=z.read(name)
                if hashlib.sha256(data).hexdigest()!=expected:raise ValueError('member_mismatch')
                target=stage/path;target.parent.mkdir(parents=True,exist_ok=True)
                with target.open('xb') as f:f.write(data)
                target.chmod(0o600)
            (stage/'manifest.json').write_bytes(z.read('manifest.json'))
            # Reserve the destination; never replace a pre-existing directory.
            dest.mkdir(mode=0o700)
            for p in stage.iterdir():p.rename(dest/p.name)
    return {'files':len(files),'cutoff':meta['cutoff'],'sha256':hashlib.sha256(blob).hexdigest()}


if __name__=='__main__':
    ap=argparse.ArgumentParser()
    for k in ('package','key','destination'):ap.add_argument(k,type=Path)
    args=ap.parse_args();os.umask(0o077)
    if args.key.is_symlink() or args.key.stat().st_mode&0o077:raise SystemExit('private key file required')
    print(json.dumps(restore_package(args.package.read_bytes(),bytes.fromhex(args.key.read_text().strip()),args.destination)))
