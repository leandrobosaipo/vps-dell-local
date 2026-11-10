"""Archive the isolated inbox's attachment bytes and read them back through a new DiskService."""
import base64
import hashlib
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
from cryptography.hazmat.primitives import hashes,serialization
from cryptography.hazmat.primitives.asymmetric import padding
from cryptography.hazmat.primitives.ciphers.aead import AESGCM


CAPTURE=r"""
require 'base64'
expected=JSON.parse(STDIN.read)
raise 'account_scope' unless expected.is_a?(Hash) && !expected.empty? && Account.order(:id).pluck(:id,:name).to_h.transform_keys(&:to_s)==expected
objects={};unique_bytes=0
result=ActiveRecord::Base.transaction(isolation: :repeatable_read) do
  ActiveRecord::Base.connection.execute('SET TRANSACTION READ ONLY')
  raise 'size_bound' if ActiveStorage::Blob.sum(:byte_size)>512*1024*1024
  ActiveStorage::Blob.order(:id).map do |b|
    raise 'local_disk_required' unless b.service.is_a?(ActiveStorage::Service::DiskService)
    raise 'individual_size_bound' if b.byte_size>16*1024*1024
    bytes=b.download
    raise 'source_mismatch' unless bytes.bytesize==b.byte_size && Digest::MD5.base64digest(bytes)==b.checksum
    sha=Digest::SHA256.hexdigest(bytes)
    unless objects.key?(sha)
      unique_bytes+=bytes.bytesize
      raise 'unique_size_bound' if unique_bytes>24*1024*1024
      objects[sha]=Base64.strict_encode64(bytes)
    end
    {id:b.id,key:b.key,checksum:b.checksum,sha:sha,size:b.byte_size}
  end
end
puts 'RESULT='+JSON.generate({rows:result,objects:objects})
"""
READBACK=r"""
require 'base64'
require 'tmpdir'
require 'stringio'
archive=JSON.parse(STDIN.read);rows=archive.fetch('rows');objects=archive.fetch('objects')
raise 'orphan_asset' unless rows.map{|r|r.fetch('sha')}.uniq.sort==objects.keys.sort
verified=Dir.mktmpdir('jp-verify-assets-') do |dir|
  restored=ActiveStorage::Service::DiskService.new(root:dir)
  rows.map do |b|
    raise 'invalid_key' unless b['key'].match?(/\A[a-zA-Z0-9_-]{16,128}\z/)
    bytes=Base64.strict_decode64(objects.fetch(b['sha']))
    raise 'archive_size' unless bytes.bytesize==b.fetch('size')
    restored.upload(b['key'],StringIO.new(bytes),checksum:b['checksum'])
    value=restored.download(b['key'])
    raise 'restore_mismatch' unless Digest::SHA256.hexdigest(value)==b['sha']
    [b['id'],b['sha'],value.bytesize]
  end
end
puts 'RESULT='+JSON.generate(verified)
"""


def checkpoint(root,allowed_accounts=None):
    if socket.gethostname()!='agentes-lab' or os.geteuid()!=0:raise ValueError('wrong_scope')
    cid=subprocess.check_output(['docker','ps','-q','--filter','label=com.docker.compose.project=atendimento-piloto','--filter','label=com.docker.compose.service=chat'],text=True).strip()
    if not cid or '\n' in cid:raise ValueError('chat_identity')
    def rails(code,data=''):
        cmd=['docker','exec','-i',cid,'bundle','exec','rails','runner','require "json";eval(JSON.parse(STDIN.readline), binding, "asset-proof.rb")']
        output=subprocess.check_output(cmd,input=json.dumps(code)+'\n'+data,text=True,stderr=subprocess.PIPE,timeout=90)
        rows=[s[7:] for s in output.splitlines() if s.startswith('RESULT=')]
        if len(rows)!=1:raise ValueError('invalid_result')
        return json.loads(rows[0])
    data=rails(CAPTURE,json.dumps(allowed_accounts or {'1':'PilotFixture0001'}))
    rows=data['rows']
    if not rows:raise ValueError('missing_pilot_assets')
    output=root/('chat-assets-'+secrets.token_hex(6));output.mkdir(mode=0o700)
    key=serialization.load_pem_private_key((root/'custodia-journal.pem').read_bytes(),password=None)
    wrap=padding.OAEP(padding.MGF1(hashes.SHA256()),hashes.SHA256(),None)
    aes=os.urandom(32);iv=os.urandom(12);aad=b'jp-chat-assets-dedup-v2'
    (output/'wrapped-key').write_bytes(key.public_key().encrypt(aes,wrap))
    sealed=output/'assets.aead';sealed.write_bytes(iv+AESGCM(aes).encrypt(iv,json.dumps(data).encode(),aad))
    blob=sealed.read_bytes();k=key.decrypt((output/'wrapped-key').read_bytes(),wrap)
    verified=rails(READBACK,AESGCM(k).decrypt(blob[:12],blob[12:],aad).decode())
    expected=[[r['id'],r['sha'],r['size']] for r in rows]
    if verified!=expected:raise ValueError('asset_set_mismatch')
    proof={'folder':output.name,'assets':len(rows),'uniqueObjects':len(data['objects']),'format':aad.decode(),'bytes':sum(r[2] for r in verified),'sha256':hashlib.sha256(blob).hexdigest(),'nativeDiskRestore':True}
    (output/'receipt.json').write_text(json.dumps(proof))
    return proof
