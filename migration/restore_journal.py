"""Restore a captured receive-only journal into a separate, encrypted staging ledger."""
import base64
from datetime import datetime
import gzip
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import stat
import struct

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding
from cryptography.hazmat.primitives.ciphers.aead import AESGCM


def require(condition, error):
    if not condition:
        raise ValueError(error)


def decode(value):
    return base64.b64decode(value, validate=True)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def restore(folder, snapshot, expected_instance):
    require(isinstance(expected_instance, str) and expected_instance.strip(), 'instance_required')
    folder = Path(folder)
    require(folder.is_dir() and not folder.is_symlink() and stat.S_IMODE(folder.stat().st_mode) == 0o700
            and folder.stat().st_uid == os.geteuid(), 'private_directory_required')
    private_key = folder/'custodia-journal.pem'
    def private_file(path):
        metadata = path.lstat()
        require(stat.S_ISREG(metadata.st_mode) and metadata.st_nlink == 1 and
                stat.S_IMODE(metadata.st_mode) == 0o600 and metadata.st_uid == os.geteuid(),
                'private_file_required')
    private_file(private_key)
    key = serialization.load_pem_private_key(private_key.read_bytes(), password=None)
    destination = folder/'retidos.sqlite3'
    try:
        os.close(os.open(destination, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600))
    except FileExistsError:
        pass
    private_file(destination)
    db = sqlite3.connect(destination)
    db.execute('PRAGMA synchronous=FULL')
    try:
        db.executescript('''
          CREATE TABLE IF NOT EXISTS records(source TEXT,file TEXT,digest TEXT,sealed BLOB,PRIMARY KEY(source,file));
          CREATE TABLE IF NOT EXISTS checkpoints(cutoff TEXT,source TEXT,manifest TEXT,wrapped TEXT,total INTEGER,
              PRIMARY KEY(cutoff,source));
        ''')
        db.execute('BEGIN IMMEDIATE')
        counts = []
        require(len(snapshot['sources']) == 2, 'two_sources_required')
        cutoffs = {s['cutoff'] for s in snapshot['sources']}
        require(len(cutoffs) == 1 and re.fullmatch(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z', next(iter(cutoffs))), 'invalid_common_cutoff')
        datetime.fromisoformat(next(iter(cutoffs)).replace('Z','+00:00'))
        for index, item in enumerate(snapshot['sources']):
            source = ['evolution','n8n'][index]
            secret = key.decrypt(decode(item['wrapped']), padding.OAEP(padding.MGF1(hashes.SHA256()), hashes.SHA256(), None))
            cipher = AESGCM(secret)
            files = json.loads(gzip.decompress(decode(item['files'])))
            require(len(files) == item['count'] and len({x['file'] for x in files}) == len(files), 'record_count_mismatch')
            prior_cutoff = db.execute('SELECT max(cutoff) FROM checkpoints WHERE source=?',(source,)).fetchone()[0]
            require(prior_cutoff is None or prior_cutoff <= item['cutoff'], 'older_snapshot')
            incoming = {row['file'] for row in files}
            require(all(name in incoming for (name,) in db.execute('SELECT file FROM records WHERE source=?',(source,))),
                    'previously_captured_record_absent')
            manifest = hashlib.sha256()
            for record in sorted(files, key=lambda r:r['file']):
                name = record['file']
                require(re.fullmatch(r'[0-9a-f]{64}\.json', name), 'invalid_record_name')
                raw = decode(record['bytes'])
                require(sha(raw) == record['sha'], 'ciphertext_mismatch')
                envelope = json.loads(raw)
                meta = envelope['meta']
                instance = meta['instance'].encode()
                require(instance == expected_instance.encode() and meta['source'] == source and
                        meta['receivedAt'] <= item['cutoff'], 'scope_mismatch')
                aad = json.dumps(meta, separators=(',',':'), ensure_ascii=False).encode()
                data = cipher.decrypt(decode(envelope['iv']), decode(envelope['ciphertext']) + decode(envelope['tag']), aad)
                require(sha(data) == meta['rawSha256'] and sha(struct.pack('>I', len(instance))+instance+data)+'.json' == name,
                        'native_record_mismatch')
                db.execute('INSERT OR IGNORE INTO records VALUES (?,?,?,?)', (source,name,record['sha'],raw))
                stored = db.execute('SELECT sealed FROM records WHERE source=? AND file=?',(source,name)).fetchone()[0]
                require(stored == raw, 'existing_record_conflict')
                manifest.update(name.encode())
                manifest.update(stored)
            digest = manifest.hexdigest()
            db.execute('INSERT OR IGNORE INTO checkpoints VALUES (?,?,?,?,?)',
                       (item['cutoff'],source,digest,item['wrapped'],len(files)))
            prior = db.execute('SELECT manifest,total FROM checkpoints WHERE cutoff=? AND source=?',
                               (item['cutoff'],source)).fetchone()
            require(prior == (digest,len(files)), 'checkpoint_conflict')
            counts.append({'source':source,'verified':len(files),'manifest':digest})
        db.commit()
        require(db.execute('PRAGMA quick_check').fetchone() == ('ok',), 'ledger_integrity')
        return {'verified':counts,'cutoff':snapshot['sources'][0]['cutoff'],'automatic_actions':0}
    finally:
        db.close()
