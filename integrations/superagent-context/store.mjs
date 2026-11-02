import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, chmodSync, lstatSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const need = (ok, message) => { if (!ok) throw new Error(message); };
export const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value);
const finite = n => typeof n === 'number' && Number.isFinite(n);
const statuses = ['detected', 'not_detected', 'uncertain', 'not_enrolled'];

/** Transport/evidence storage only. Task selection and execution belong to Super Agent. */
export class ContextStore {
  constructor(root, deviceId, clock = Date.now) {
    need(identifier(deviceId), 'Invalid paired device');
    this.deviceId = deviceId; this.clock = clock; this.root = resolve(root);
    mkdirSync(this.root, {recursive:true, mode:0o700});
    need(!lstatSync(this.root).isSymbolicLink(), 'Bridge root must not be a symlink');
    const path = join(this.root, 'context.sqlite');
    try { need(!lstatSync(path).isSymbolicLink(), 'Database must not be a symlink'); } catch(e) { if(e.code !== 'ENOENT') throw e; }
    this.db = new DatabaseSync(path); chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS segments (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, digest TEXT NOT NULL,
        metadata TEXT NOT NULL, audio BLOB NOT NULL, lease TEXT, lease_until INTEGER,
        analysis TEXT, failure TEXT, attempts INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS reports (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, device_id TEXT NOT NULL,
        thread TEXT NOT NULL, text TEXT NOT NULL, at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS intake (event_id TEXT PRIMARY KEY, disposition TEXT NOT NULL);`);
  }
  close() { this.db.close(); }
  ingest(body) {
    const m = body.metadata;
    need(m && identifier(m.id) && identifier(m.session_id), 'Invalid source IDs');
    need(m.device_id === this.deviceId, 'Device is not paired');
    need(['ambient','command'].includes(m.intent), 'Invalid recording intent');
    need(Number.isSafeInteger(m.started_ms) && Number.isSafeInteger(m.ended_ms) && m.ended_ms > m.started_ms && m.ended_ms-m.started_ms<=125000, 'Invalid bounded recording interval');
    need(m.started_ms > 0 && m.ended_ms <= this.clock()+300000, 'Invalid clock');
    need(typeof m.time_zone === 'string' && m.time_zone.length <= 80, 'Missing timezone');
    new Intl.DateTimeFormat('en', {timeZone:m.time_zone});
    need(m.mime_type === 'audio/mp4', 'Only AAC/M4A is supported');
    need(Number.isSafeInteger(m.sequence) && m.sequence >= 0, 'Missing recording sequence');
    if(m.location != null) {
      const p=m.location;
      need(finite(p.latitude) && Math.abs(p.latitude)<=90 && finite(p.longitude) && Math.abs(p.longitude)<=180 && finite(p.accuracy_m) && p.accuracy_m>=0 && Number.isSafeInteger(p.sampled_ms) && p.source==='android_location', 'Invalid automatic location');
    }
    need(typeof body.audio_base64==='string' && body.audio_base64.length<=6*1024*1024 && /^[A-Za-z0-9+/]+={0,2}$/.test(body.audio_base64), 'Invalid audio');
    const bytes=Buffer.from(body.audio_base64,'base64');
    need(bytes.length>=32 && bytes.length<=4*1024*1024 && bytes.toString('base64')===body.audio_base64, 'Invalid audio encoding');
    need(bytes.toString('ascii',4,8)==='ftyp', 'Not an M4A container');
    // Keep only the defined provenance fields; device text never becomes model/system instructions.
    const location=m.location?Object.fromEntries(['latitude','longitude','accuracy_m','sampled_ms','source'].map(k=>[k,m.location[k]])):null;
    const metadata={id:m.id,session_id:m.session_id,device_id:m.device_id,intent:m.intent,started_ms:m.started_ms,ended_ms:m.ended_ms,time_zone:m.time_zone,mime_type:m.mime_type,sequence:m.sequence,location};
    const digest=sha(bytes), serialized=JSON.stringify(metadata);
    const old=this.db.prepare('SELECT digest,metadata FROM segments WHERE id=?').get(m.id);
    if(old) {need(old.digest===digest && old.metadata===serialized,'Source ID already has different content'); return {accepted:true,duplicate:true,sha256:digest};}
    this.db.prepare('INSERT INTO segments(id,digest,metadata,audio) VALUES(?,?,?,?)').run(m.id,digest,serialized,bytes);
    return {accepted:true,duplicate:false,sha256:digest};
  }
  claim() {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row=this.db.prepare('SELECT * FROM segments WHERE analysis IS NULL AND COALESCE(lease_until,0)<? ORDER BY seq LIMIT 1').get(this.clock());
      if(!row) {this.db.exec('COMMIT'); return null;}
      const lease=randomUUID();
      this.db.prepare('UPDATE segments SET lease=?,lease_until=?,attempts=attempts+1 WHERE id=?').run(lease,this.clock()+600000,row.id);
      this.db.exec('COMMIT');
      return {id:row.id,sha256:row.digest,metadata:JSON.parse(row.metadata),lease};
    } catch(e) {this.db.exec('ROLLBACK');throw e;}
  }
  leased(id, lease) {
    const row=this.db.prepare('SELECT * FROM segments WHERE id=? AND lease=? AND lease_until>? AND analysis IS NULL').get(id,lease,this.clock());
    need(row,'Analysis lease expired or source changed');return row;
  }
  audio(id,lease) {const row=this.leased(id,lease);need(sha(row.audio)===row.digest,'Audio integrity failed');return row.audio;}
  analyze(job) {
    const row=this.leased(job.id,job.lease), m=JSON.parse(row.metadata);
    need(job.sha256===row.digest,'Source hash changed');
    if(job.error) {
      // Bounded retry delay; errors never become empty/successful transcripts.
      this.db.prepare('UPDATE segments SET failure=?,lease_until=? WHERE id=?').run(String(job.error).slice(0,300),this.clock()+60000,row.id);
      return {accepted:false,retry:true};
    }
    need(typeof job.model==='string' && job.model.length>0 && job.model.length<=200,'Missing ASR provenance');
    need(Array.isArray(job.utterances) && job.utterances.length<=500,'Invalid timed transcript');
    let last=-1;
    for(const u of job.utterances) {
      need(Number.isSafeInteger(u.start_ms) && Number.isSafeInteger(u.end_ms) && u.start_ms>=last && u.end_ms>u.start_ms && u.end_ms<=m.ended_ms-m.started_ms+1000 && typeof u.text==='string' && u.text.length<=4000,'Invalid timed utterance');last=u.start_ms;
    }
    need(statuses.includes(job.owner_voice?.status),'Invalid owner voice status');
    need(Array.isArray(job.owner_voice.intervals) && job.owner_voice.intervals.length<=200,'Invalid owner intervals');
    for(const i of job.owner_voice.intervals) need(Number.isSafeInteger(i.start_ms)&&Number.isSafeInteger(i.end_ms)&&i.start_ms>=0&&i.end_ms>i.start_ms&&i.end_ms<=m.ended_ms-m.started_ms+1000&&finite(i.score)&&i.score>=-1&&i.score<=1,'Invalid voice interval');
    need(job.owner_voice.status!=='detected' || job.owner_voice.intervals.length>0,'Detected owner needs timed evidence');
    // Never persist/export a worker's accidental profile embedding or private filesystem path.
    const owner_voice={status:job.owner_voice.status,intervals:job.owner_voice.intervals.map(({start_ms,end_ms,score})=>({start_ms,end_ms,score}))};
    for(const field of ['profile_id','model_hash'])if(job.owner_voice[field]!=null) {
      need(typeof job.owner_voice[field]==='string'&&/^[A-Za-z0-9_-]{1,200}$/.test(job.owner_voice[field]),'Invalid voice provenance');owner_voice[field]=job.owner_voice[field];
    }
    if(typeof job.owner_voice.cross_device_calibrated==='boolean')owner_voice.cross_device_calibrated=job.owner_voice.cross_device_calibrated;
    const analysis={model:job.model,utterances:job.utterances.map(({start_ms,end_ms,text})=>({start_ms,end_ms,text})),owner_voice,analyzed_at:new Date(this.clock()).toISOString(),machine_transcript:true};
    need(JSON.stringify(analysis).length<=200000,'Analysis too large');
    this.db.prepare('UPDATE segments SET analysis=?,failure=NULL,lease=NULL,lease_until=NULL WHERE id=?').run(JSON.stringify(analysis),row.id);
    return {accepted:true};
  }
  event(row) {return {seq:Number(row.seq),id:row.id,sha256:row.digest,metadata:JSON.parse(row.metadata),analysis:JSON.parse(row.analysis)};}
  events(after=0) {return this.db.prepare('SELECT * FROM segments WHERE seq>? AND analysis IS NOT NULL ORDER BY seq LIMIT 30').all(after).map(r=>this.event(r));}
  // Don't advance a numeric intake cursor over a still-transcribing earlier source.
  pendingEvents() {return this.db.prepare('SELECT s.* FROM segments s LEFT JOIN intake i ON i.event_id=s.id WHERE s.analysis IS NOT NULL AND i.event_id IS NULL ORDER BY s.seq LIMIT 30').all().map(r=>this.event(r));}
  acknowledge(id,disposition) {need(['stored','duplicate','filtered'].includes(disposition),'Invalid intake receipt');need(this.db.prepare('SELECT id FROM segments WHERE id=? AND analysis IS NOT NULL').get(id),'Unknown source');this.db.prepare('INSERT OR IGNORE INTO intake VALUES(?,?)').run(id,disposition);}
  thread(sessionId, offset=0) {need(identifier(sessionId),'Invalid thread');return this.db.prepare("SELECT * FROM segments WHERE json_extract(metadata,'$.session_id')=? AND analysis IS NOT NULL ORDER BY json_extract(metadata,'$.started_ms'),json_extract(metadata,'$.sequence'),seq LIMIT 30 OFFSET ?").all(sessionId,offset).map(r=>this.event(r));}
  report(body) {
    need(typeof body.id==='string'&&body.id.length>0&&body.id.length<=300&&identifier(body.session_id)&&body.device_id===this.deviceId&&typeof body.text==='string'&&body.text.length>0&&body.text.length<=30000,'Invalid result target');
    need(this.db.prepare("SELECT id FROM segments WHERE json_extract(metadata,'$.session_id')=? AND json_extract(metadata,'$.device_id')=?").get(body.session_id,body.device_id),'Unknown result thread');
    const old=this.db.prepare('SELECT * FROM reports WHERE id=?').get(body.id);
    if(old) {need(old.text===body.text&&old.thread===body.session_id&&old.device_id===body.device_id,'Report ID already has different content');return {accepted:true,duplicate:true};}
    this.db.prepare('INSERT INTO reports(id,device_id,thread,text,at) VALUES(?,?,?,?,?)').run(body.id,body.device_id,body.session_id,body.text,new Date(this.clock()).toISOString());return {accepted:true};
  }
  reports(after=0) {return this.db.prepare('SELECT seq,id,thread,text,at FROM reports WHERE device_id=? AND seq>? ORDER BY seq LIMIT 30').all(this.deviceId,after);}
  health() {return {pending:this.db.prepare('SELECT COUNT(*) n FROM segments WHERE analysis IS NULL').get().n,failed:this.db.prepare('SELECT COUNT(*) n FROM segments WHERE failure IS NOT NULL').get().n,analyzed:this.db.prepare('SELECT COUNT(*) n FROM segments WHERE analysis IS NOT NULL').get().n};}
}
