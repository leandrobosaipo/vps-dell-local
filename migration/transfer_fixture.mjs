// Isolated cutover exercise. Every input, receipt and effect is fictional.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {persistRaw,readRecord,recordId} from '../maintenance/ingress.mjs';
import {ReceiveQueue} from '../maintenance/receive_queue.mjs';

export function step(p) {
  const base='/tmp/jp-transfer-fixture', records=path.join(base,'records'), index=path.join(base,'index');
  const instance='jp-transfer-fixture', file=id=>path.join(records,id+'.json');
  if(p.op==='init'){
    assert(/^[a-f0-9]{64}$/.test(p.key));
    fs.mkdirSync(base,{mode:0o700});
    for(const dir of [records,index])fs.mkdirSync(dir,{mode:0o700});
    fs.writeFileSync(path.join(base,'fixture-key'),p.key,{flag:'wx',mode:0o600});
  }
  const key=Buffer.from(fs.readFileSync(path.join(base,'fixture-key'),'utf8'),'hex');
  const cfg={dir:records,key,source:'evolution',instance,token:'isolated-fixture'};
  const q=new ReceiveQueue(index,records,key,instance);
  const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
  const payload=label=>{
    assert(/^fixture-[a-z0-9-]{1,40}$/.test(label));
    return Buffer.from(JSON.stringify({instance,event:'fixture',label}));
  };
  try {
    q.db.exec('CREATE TABLE IF NOT EXISTS fixture_effects (id TEXT PRIMARY KEY, disposition TEXT NOT NULL)');
    if(p.op==='grant'||p.op==='freeze'){
      assert.equal(q.db.prepare("SELECT count(*) AS n FROM receipts WHERE state='claimed'").get().n,0);
      q.changeOwner(p.previous,p.next);
    }else if(p.op==='put'){
      const raw=payload(p.label),id=recordId(instance,raw);
      q.reserve(id);q.committed(persistRaw(cfg,raw,null));
      return {id,state:q.status(id).state};
    }else if(p.op==='work'){
      if(!p.epoch||q.owner().epoch!==p.epoch)return {rejected:'stale_owner'};
      const id=recordId(instance,payload(p.label));
      if(q.status(id)?.state!=='ready')return {rejected:'ineligible'};
      const claim=q.claim(id,p.execution);
      assert.equal(claim.epoch,p.epoch);assert(claim.raw.equals(payload(p.label)));
      assert(['accepted_fixture','delivery_unknown'].includes(p.disposition));
      q.db.prepare('INSERT INTO fixture_effects VALUES(?,?)').run(id,p.disposition);
      q.finish(id,p.execution,p.disposition==='accepted_fixture',p.disposition);
    }else if(p.op==='export'||p.op==='import'){
      assert.equal(q.owner().epoch,'','requires_closed_owner');
      if(p.op==='export'){
        return {rows:fs.readdirSync(records).sort().map(name=>{
          assert(/^[0-9a-f]{64}\.json$/.test(name));
          const id=name.slice(0,-5),r=readRecord(file(id),key,instance);
          assert.equal(r.id,id);
          return {id,sealed:fs.readFileSync(file(id),'base64'),sha:sha(r.raw),
            effect:q.db.prepare('SELECT disposition FROM fixture_effects WHERE id=?').get(id)?.disposition??null};
        })};
      }
      for(const row of p.rows){
        assert(/^[0-9a-f]{64}$/.test(row.id)&&[null,'accepted_fixture','delivery_unknown'].includes(row.effect));
        const stage=fs.mkdtempSync(path.join(base,'verify-')),tmp=path.join(stage,row.id+'.json');
        try{
          fs.writeFileSync(tmp,Buffer.from(row.sealed,'base64'),{flag:'wx',mode:0o600,flush:true});
          const decoded=readRecord(tmp,key,instance);
          assert.equal(decoded.id,row.id);assert.equal(sha(decoded.raw),row.sha);
          if(fs.existsSync(file(row.id)))assert.equal(sha(readRecord(file(row.id),key,instance).raw),row.sha);
          else {fs.linkSync(tmp,file(row.id));fs.unlinkSync(tmp);
            const fd=fs.openSync(records,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
          q.reserve(row.id);q.committed({id:row.id});
          if(row.effect){
            q.db.prepare('INSERT OR IGNORE INTO fixture_effects VALUES(?,?)').run(row.id,row.effect);
            assert.equal(q.db.prepare('SELECT disposition FROM fixture_effects WHERE id=?').get(row.id).disposition,row.effect);
          }
        }finally{if(fs.existsSync(tmp))fs.unlinkSync(tmp);fs.rmdirSync(stage);}
      }
    }else assert(['init','status'].includes(p.op));
    return {epoch:q.owner().epoch,records:q.db.prepare('SELECT id,state FROM receipts ORDER BY id').all(),
      effects:q.db.prepare('SELECT id,disposition FROM fixture_effects ORDER BY id').all()};
  }finally{q.close();key.fill(0);}
}
