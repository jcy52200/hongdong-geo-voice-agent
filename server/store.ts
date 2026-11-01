import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { buildPrompt, DEFAULT_SYSTEM_PROMPT, OPENING } from './prompt.js';
import type { AgentConfig, Customer, Session, SessionStatus, Transcript } from './types.js';

export const DEFAULT_CONFIG: AgentConfig = {
  agentName: '小泓', voice: 'zh_male_m191_uranus_bigtts', speed: 0, extraInstructions: '',
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  loudness: 0, opening: OPENING, modelOptions: {},
};
type Row = Record<string, any>;
export class Store {
  readonly db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS customers (
        id TEXT PRIMARY KEY, phone TEXT UNIQUE NOT NULL, data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY, customer TEXT NOT NULL, config TEXT NOT NULL,
        mode TEXT NOT NULL, status TEXT NOT NULL, prompt TEXT NOT NULL, prompt_hash TEXT NOT NULL,
        created_at TEXT NOT NULL, ended_at TEXT, error TEXT, analysis_status TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS transcripts (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id),
        provider_key TEXT NOT NULL, event_id TEXT, kind TEXT NOT NULL,
        text TEXT NOT NULL, final INTEGER NOT NULL, created_at TEXT NOT NULL,
        UNIQUE(session_id, provider_key, kind)
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id),
        type TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS analysis_jobs (
        id TEXT PRIMARY KEY, session_id TEXT UNIQUE NOT NULL REFERENCES sessions(id),
        status TEXT NOT NULL DEFAULT 'pending', result TEXT, created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_transcripts_session ON transcripts(session_id);
      CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
    `);
    // A restarted worker cannot resume a cloud socket or browser playback timeline.
    this.db.prepare(`UPDATE sessions SET status='failed', error='服务重启，会话已结束；请新建测试', ended_at=?
      WHERE status IN ('connecting','opening','active')`).run(new Date().toISOString());
  }
  close() { this.db.close(); }
  config(): AgentConfig {
    const row = this.db.prepare('SELECT value FROM settings WHERE key=?').get('agent') as Row | undefined;
    return row ? { ...DEFAULT_CONFIG, ...JSON.parse(row.value) } : { ...DEFAULT_CONFIG };
  }
  saveConfig(config: AgentConfig) {
    this.db.prepare('INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run('agent', JSON.stringify(config));
    return config;
  }
  customers(): Customer[] {
    return (this.db.prepare('SELECT data FROM customers ORDER BY rowid DESC').all() as Row[]).map(r => JSON.parse(r.data));
  }
  customer(id: string): Customer | undefined {
    const row = this.db.prepare('SELECT data FROM customers WHERE id=?').get(id) as Row | undefined;
    return row ? JSON.parse(row.data) : undefined;
  }
  importCustomers(input: Omit<Customer, 'id'>[]): Customer[] {
    this.db.exec('BEGIN');
    try {
      for (const item of input) {
        const normalizedPhone = item.phone.replace(/[ ()-]/g, '');
        const existing = this.db.prepare('SELECT id FROM customers WHERE phone=?').get(normalizedPhone) as Row | undefined;
        const customer: Customer = { ...item, phone: normalizedPhone, id: existing?.id ?? randomUUID() };
        this.db.prepare(`INSERT INTO customers(id,phone,data) VALUES (?,?,?)
          ON CONFLICT(phone) DO UPDATE SET data=excluded.data`).run(customer.id, customer.phone, JSON.stringify(customer));
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return this.customers();
  }
  createSession(customer: Customer, mode: Session['mode']): Session {
    const config = this.config();
    const prompt = buildPrompt(customer, config);
    const id = randomUUID();
    this.db.prepare(`INSERT INTO sessions(id,customer,config,mode,status,prompt,prompt_hash,created_at,analysis_status)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(id, JSON.stringify(customer), JSON.stringify(config), mode, 'created', prompt,
        createHash('sha256').update(prompt).digest('hex'), new Date().toISOString(), 'not_requested');
    return this.session(id)!;
  }
  session(id: string): Session | undefined {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id=?').get(id) as Row | undefined;
    if (!row) return undefined;
    return {
      id: row.id, customer: JSON.parse(row.customer), configSnapshot: JSON.parse(row.config), mode: row.mode,
      status: row.status, prompt: row.prompt, promptHash: row.prompt_hash, createdAt: row.created_at,
      endedAt: row.ended_at ?? undefined, error: row.error ?? undefined, analysisStatus: row.analysis_status,
      transcripts: this.transcripts(id),
    };
  }
  sessions(): Session[] {
    return (this.db.prepare('SELECT id FROM sessions ORDER BY rowid DESC LIMIT 100').all() as Row[])
      .map(row => this.session(row.id)!);
  }
  status(id: string, status: SessionStatus, error?: string) {
    const ended = status === 'completed' || status === 'failed';
    this.db.prepare('UPDATE sessions SET status=?,error=?,ended_at=? WHERE id=?')
      .run(status, error ?? null, ended ? new Date().toISOString() : null, id);
    if (status === 'completed') {
      this.db.prepare(`INSERT OR IGNORE INTO analysis_jobs(id,session_id,status,created_at) VALUES (?,?,'pending',?)`)
        .run(randomUUID(), id, new Date().toISOString());
      this.db.prepare(`UPDATE sessions SET analysis_status='pending' WHERE id=?`).run(id);
    }
  }
  transcripts(id: string): Transcript[] {
    return (this.db.prepare('SELECT * FROM transcripts WHERE session_id=? ORDER BY rowid').all(id) as Row[]).map(r => ({
      id: r.id, eventId: r.event_id ?? undefined, kind: r.kind, text: r.text, final: Boolean(r.final), createdAt: r.created_at,
    }));
  }
  transcript(id: string, key: string, kind: Transcript['kind'], text: string, final: boolean, eventId?: string): Transcript {
    const row = this.db.prepare('SELECT * FROM transcripts WHERE session_id=? AND provider_key=? AND kind=?')
      .get(id, key, kind) as Row | undefined;
    if (row?.final) return this.transcripts(id).find(t => t.id === row.id)!;
    const transcript = { id: row?.id ?? randomUUID(), eventId, kind, text, final, createdAt: row?.created_at ?? new Date().toISOString() };
    this.db.prepare(`INSERT INTO transcripts(id,session_id,provider_key,event_id,kind,text,final,created_at)
      VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(session_id,provider_key,kind)
      DO UPDATE SET text=excluded.text,final=excluded.final,event_id=excluded.event_id`).run(
        transcript.id, id, key, eventId ?? null, kind, text, final ? 1 : 0, transcript.createdAt);
    return transcript;
  }
  event(id: string, type: string, payload: unknown) {
    this.db.prepare('INSERT INTO events(session_id,type,payload,created_at) VALUES (?,?,?,?)')
      .run(id, type, JSON.stringify(payload), new Date().toISOString());
  }
  exportSession(id: string) {
    return { session: this.session(id),
      events: (this.db.prepare('SELECT type,payload,created_at AS createdAt FROM events WHERE session_id=? ORDER BY id').all(id) as Row[])
        .map(r => ({ type: r.type, payload: JSON.parse(r.payload), createdAt: r.createdAt })),
      analysis: { status: this.session(id)?.analysisStatus, result: null, note: 'LLM 分析模块预留，尚未运行意向分析' },
    };
  }
}
