"""Index hashes for human review against verified, encrypted journal records."""
import json
from pathlib import Path
import re
import sqlite3


def index_review(database,cutoff,rows):
    database=Path(database).resolve(strict=True)
    with sqlite3.connect(database.as_uri()+'?mode=rw',uri=True) as db:
        db.execute('BEGIN IMMEDIATE')
        checkpoints=db.execute('SELECT source FROM checkpoints WHERE cutoff=?',(cutoff,)).fetchall()
        if {x[0] for x in checkpoints}!={'n8n','evolution'}:
            raise ValueError('unverified_checkpoint')
        db.execute('CREATE TABLE IF NOT EXISTS review_observations (cutoff TEXT NOT NULL,record TEXT NOT NULL,position INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(cutoff,record,position))')
        for row in rows:
            record=row['recordId']
            if not re.fullmatch('[a-f0-9]{64}',record) or type(row['index']) is not int or row['index']<0:
                raise ValueError('invalid_record_reference')
            if not db.execute('SELECT 1 FROM records WHERE file=?',(record+'.json',)).fetchone():
                raise ValueError('record_not_restored')
            data={k:row[k] for k in ('id','chat','direction','reason','type','time')}
            for k in ('id','chat'):
                if data[k] is not None and not re.fullmatch('[a-f0-9]{64}',data[k]):
                    raise ValueError('invalid_identity_hash')
            if data['reason'] not in {'incomplete_native_identity','conflicting_duplicate','control_event_preserved','quoted_reply_observed','later_outbound_requires_review','no_later_outbound_observed'}:
                raise ValueError('unexpected_review_reason')
            key=(cutoff,record,row['index'])
            payload=json.dumps(data,sort_keys=True,separators=(',',':'))
            db.execute('INSERT OR IGNORE INTO review_observations VALUES(?,?,?,?)',(*key,payload))
            if db.execute('SELECT payload FROM review_observations WHERE cutoff=? AND record=? AND position=?',key).fetchone()!=(payload,):
                raise ValueError('review_conflict')
        count=db.execute('SELECT count(*) FROM review_observations WHERE cutoff=?',(cutoff,)).fetchone()[0]
        if count!=len(rows):raise ValueError('snapshot_count_conflict')
    return {'cutoff':cutoff,'indexed':count,'actions':0}
