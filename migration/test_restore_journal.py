import base64
import gzip
import json
import os
from pathlib import Path
import sqlite3
import struct
import tempfile
import unittest

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from restore_journal import restore, sha
from review_journal import index_review


def encoded(raw):
    return base64.b64encode(raw).decode()


class RestoreTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        private = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        key = self.root/'custodia-journal.pem'
        key.write_bytes(private.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                              serialization.NoEncryption()))
        key.chmod(0o600)
        self.secret = AESGCM.generate_key(256)
        self.wrapped = encoded(private.public_key().encrypt(self.secret,
            padding.OAEP(padding.MGF1(hashes.SHA256()), hashes.SHA256(), None)))
        self.first = '2001-01-01T00:00:00.000Z'
        self.second = '2001-01-02T00:00:00.000Z'

    def record(self, source, raw):
        instance = 'fixture'
        meta = dict(instance=instance, source=source, receivedAt=self.first, rawSha256=sha(raw))
        iv = os.urandom(12)
        ciphertext = AESGCM(self.secret).encrypt(iv,raw,json.dumps(meta,separators=(',',':')).encode())
        data = json.dumps(dict(meta=meta,iv=encoded(iv),ciphertext=encoded(ciphertext[:-16]),tag=encoded(ciphertext[-16:]))).encode()
        return dict(file=sha(struct.pack('>I',len(instance))+instance.encode()+raw)+'.json',sha=sha(data),bytes=encoded(data))

    def source(self, cutoff, files):
        return dict(cutoff=cutoff,count=len(files),wrapped=self.wrapped,files=encoded(gzip.compress(json.dumps(files).encode())))

    def test_delta_retains_every_record_and_rolls_back_both_sources(self):
        a,b,c = [self.record('evolution',x) for x in (b'a',b'b',b'c')]
        n = self.record('n8n',b'n')
        def apply(first,second):
            return restore(self.root,dict(sources=[first,second]),'fixture')
        initial = self.source(self.first,[a]),self.source(self.first,[n])
        apply(*initial)
        review={'recordId':a['file'][:-5],'index':0,'id':sha(b'id'),'chat':sha(b'chat'),
                'reason':'no_later_outbound_observed','type':'conversation','time':1000,'direction':'in'}
        path=self.root/'retidos.sqlite3'
        self.assertEqual(index_review(path,self.first,[review])['indexed'],1)
        self.assertEqual(index_review(path,self.first,[review])['actions'],0)
        with self.assertRaises(ValueError):index_review(path,self.first,[dict(review,reason='quoted_reply_observed')])
        apply(*initial)
        apply(self.source(self.second,[a,b]),self.source(self.second,[n]))
        for sources in (initial,(self.source(self.second,[a]),self.source(self.second,[n])),
                        (self.source(self.second,[a,b]),self.source(self.first,[n])),
                        (self.source('2001-01-03T00:00:00.000Z',[a,b,c]),self.source('2001-01-03T00:00:00.000Z',[]))):
            with self.assertRaises(ValueError):
                apply(*sources)
        with sqlite3.connect(self.root/'retidos.sqlite3') as db:
            self.assertEqual(db.execute('select count(*) from records').fetchone()[0],3)
            self.assertEqual(db.execute('select count(*) from checkpoints').fetchone()[0],4)
