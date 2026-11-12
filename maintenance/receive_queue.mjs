// The original encrypted file is the payload. SQLite records who may process its ID.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {readRecord} from './ingress.mjs';

const validId=id=>typeof id==='string'&&/^[0-9a-f]{64}$/.test(id);
const mode=stat=>stat.mode&0o777;
export class ReceiveQueue {
  constructor(folder, records, key, instance) {
    const dir=fs.lstatSync(folder);
    assert(dir.isDirectory()&&dir.uid===process.getuid()&&mode(dir)===0o700&&fs.realpathSync(folder)===folder);
    this.records=records;this.key=key;this.instance=instance;
    const dbPath=path.join(folder,'receive.sqlite3');
    try {fs.closeSync(fs.openSync(dbPath,'wx',0o600));} catch(e){if(e.code!=='EEXIST')throw e;}
    const st=fs.lstatSync(dbPath);assert(st.isFile()&&st.nlink===1&&st.uid===process.getuid()&&mode(st)===0o600);
    this.db=new DatabaseSync(dbPath);
    this.db.exec(`PRAGMA busy_timeout=4000;PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS owner(slot INTEGER PRIMARY KEY CHECK(slot=1),epoch TEXT NOT NULL,fixture TEXT);
      CREATE TABLE IF NOT EXISTS epochs(id TEXT PRIMARY KEY);
      INSERT OR IGNORE INTO owner VALUES(1,'',NULL);
      CREATE TABLE IF NOT EXISTS receipts(seq INTEGER PRIMARY KEY,id TEXT NOT NULL UNIQUE,epoch TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('reserved','retained','ready','claimed','completed','uncertain')),
        execution TEXT, outcome TEXT, at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS receipts_state_seq ON receipts(state,seq);`);
  }
  tx(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {const result=fn();this.db.exec('COMMIT');return result;}catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  owner(){return this.db.prepare('SELECT epoch,fixture FROM owner WHERE slot=1').get();}
  // Operators compare the exact prior epoch. Existing receipts keep their first eligibility.
  changeOwner(expected,epoch,fixture=null) {
    assert(epoch===''||/^[0-9a-f-]{36}$/.test(epoch));assert(fixture===null||validId(fixture));
    this.tx(()=>{
      assert.equal(this.owner().epoch,expected);
      assert(expected!==epoch&&!(expected&&epoch),'close_previous_epoch_first');
      if(epoch){
        assert(!this.db.prepare("SELECT 1 FROM receipts WHERE state='claimed' LIMIT 1").get(),'previous_execution_in_flight');
        this.db.prepare('INSERT INTO epochs VALUES(?)').run(epoch);
      }
      if(expected){
        this.db.prepare("UPDATE receipts SET state='retained' WHERE epoch=? AND state='ready'").run(expected);
      }
      this.db.prepare('UPDATE owner SET epoch=?,fixture=? WHERE slot=1').run(epoch,fixture);
    });
  }
  reserve(id) {
    assert(validId(id));
    this.tx(()=>{
      if(this.db.prepare('SELECT 1 FROM receipts WHERE id=?').get(id))return;
      const {epoch,fixture}=this.owner();
      // Covers files captured before indexing was installed.
      const old=fs.existsSync(path.join(this.records,id+'.json'));
      const admitted=epoch&&!old&&(!fixture||fixture===id);
      this.db.prepare("INSERT INTO receipts(id,epoch,state,at) VALUES(?,?,'reserved',?)").run(id,admitted?epoch:'',new Date().toISOString());
    });
  }
  committed({id}) {
    assert(validId(id));
    this.tx(()=>{
      const row=this.status(id);assert(row,'missing_reservation');
      if(row.state!=='reserved')return;
      const state=row.epoch&&row.epoch===this.owner().epoch?'ready':'retained';
      this.db.prepare('UPDATE receipts SET state=? WHERE id=?').run(state,id);
    });
  }
  recover(id) {
    const row=this.status(id);
    if(row?.state!=='reserved')return row;
    readRecord(path.join(this.records,id+'.json'),this.key,this.instance);
    this.committed({id});return this.status(id);
  }
  recoverPage(after=0,limit=32) {
    assert(Number.isSafeInteger(after)&&after>=0&&Number.isSafeInteger(limit)&&limit>=1&&limit<=128);
    const rows=this.db.prepare("SELECT seq,id FROM receipts WHERE state='reserved' AND seq>? ORDER BY seq LIMIT ?").all(after,limit);
    let repaired=0;
    for(const row of rows){
      // A reservation before the file was committed has never been acknowledged.
      // Keep it for a provider retry. Other reservations in the page can proceed.
      if(fs.existsSync(path.join(this.records,row.id+'.json'))){this.recover(row.id);repaired++;}
    }
    return {repaired,next:rows.length===limit?rows.at(-1).seq:0};
  }
  status(id) {
    assert(validId(id));
    return this.db.prepare('SELECT seq,id,epoch,state,execution,outcome FROM receipts WHERE id=?').get(id);
  }
  ready(limit=1) {
    assert(Number.isSafeInteger(limit)&&limit>=1&&limit<=100);
    return this.db.prepare("SELECT id FROM receipts WHERE state='ready' AND epoch=(SELECT epoch FROM owner WHERE slot=1) ORDER BY seq LIMIT ?").all(limit).map(r=>r.id);
  }
  // A native n8n execution claims before any business effect. A lost result stays visible.
  claim(id,execution) {
    assert(validId(id)&&typeof execution==='string'&&/^\d{1,20}$/.test(execution));
    return this.tx(()=>{
      const row=this.status(id);assert(row,'unknown_record');
      if(row.state==='completed')return {state:row.state,execution:row.execution,outcome:JSON.parse(row.outcome)};
      assert(row.epoch&&row.epoch===this.owner().epoch&&row.state==='ready','record_not_available');
      const record=readRecord(path.join(this.records,id+'.json'),this.key,this.instance);
      assert.equal(record.meta.source,'evolution');
      this.db.prepare("UPDATE receipts SET state='claimed',execution=? WHERE id=?").run(execution,id);
      return {state:'claimed',epoch:row.epoch,raw:record.raw};
    });
  }
  finish(id,execution,ok,outcome) {
    assert(validId(id)&&typeof ok==='boolean');
    assert(typeof outcome==='string'&&/^[a-z_]{1,64}$/.test(outcome));
    assert.equal(this.db.prepare("UPDATE receipts SET state=?,outcome=? WHERE id=? AND execution=? AND state='claimed'").run(
      ok?'completed':'uncertain',JSON.stringify(outcome),id,execution).changes,1,'claim_mismatch');
  }
  health(){return {lastSequence:this.db.prepare('SELECT COALESCE(max(seq),0) AS n FROM receipts').get().n};}
  close(){this.db.close();}
}
