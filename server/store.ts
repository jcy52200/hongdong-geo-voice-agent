import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { buildPrompt, DEFAULT_SYSTEM_PROMPT, OPENING } from './prompt.js';
import type { AgentConfig, Customer, Session, SessionStatus, Transcript } from './types.js';
import type { CallAnalysis } from '../shared/analysis.js';
import { INITIAL_INTRODUCTION_TEMPLATE } from './sales-script.js';

export const DEFAULT_CONFIG: AgentConfig = {
  agentName: '小泓', voice: 'zh_male_m191_uranus_bigtts', speed: 0, extraInstructions: '',
  systemPrompt: DEFAULT_SYSTEM_PROMPT, loudness: 0, opening: OPENING, modelOptions: {},
  quickReplyEnabled: true,
  quickReplyText: INITIAL_INTRODUCTION_TEMPLATE,
};
type Row = Record<string, any>;
export interface SessionQuery {
  source?: 'all' | 'sip' | 'browser' | 'softphone_bridge';
  page: number; pageSize: number; answeredOnly: boolean;
  dateField: 'createdAt' | 'answeredAt' | 'endedAt'; from?: string; to?: string;
  sortBy: 'createdAt' | 'status' | 'grade'; sortDir: 'asc' | 'desc'; grade?: string; search?: string;
}
export interface IndustryJob { customerId: string; camp: string; attempts: number }
export class Store {
  readonly db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS customers (id TEXT PRIMARY KEY, phone TEXT UNIQUE NOT NULL, data TEXT NOT NULL);
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
      CREATE TABLE IF NOT EXISTS playback_facts (
        session_id TEXT NOT NULL REFERENCES sessions(id), playback_id TEXT NOT NULL,
        response_id TEXT, opening INTEGER NOT NULL, started_at TEXT NOT NULL, drained_at TEXT,
        PRIMARY KEY(session_id, playback_id)
      );
      CREATE TABLE IF NOT EXISTS analysis_jobs (
        id TEXT PRIMARY KEY, session_id TEXT UNIQUE NOT NULL REFERENCES sessions(id),
        status TEXT NOT NULL DEFAULT 'pending', result TEXT, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS industry_jobs (
        customer_id TEXT PRIMARY KEY REFERENCES customers(id), camp TEXT NOT NULL,
        status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, error TEXT,
        next_attempt TEXT, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_transcripts_session ON transcripts(session_id);
      CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_created ON sessions(created_at);
    `);
    // Additive migrations retain existing customers, calls and configuration.
    // Keep retired demo provenance readable. Telephone creation has its own explicit entry point.
    this.addColumns('sessions', {
      answered_at: 'TEXT', answer_source: 'TEXT', model_ready_at: 'TEXT',
      end_reason: 'TEXT', recording: 'TEXT', transport: "TEXT NOT NULL DEFAULT 'browser'", telephone: 'TEXT',
    });
    this.addColumns('analysis_jobs', { error: 'TEXT', attempts: 'INTEGER NOT NULL DEFAULT 0', next_attempt: 'TEXT', updated_at: 'TEXT' });
    this.migrateLegacySessionReadiness();
    this.upgradeStockPrompt();
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_answered ON sessions(answered_at);
      UPDATE analysis_jobs SET status='not_requested' WHERE session_id IN (SELECT id FROM sessions WHERE answered_at IS NULL);
      UPDATE sessions SET analysis_status='not_requested' WHERE answered_at IS NULL;
      UPDATE analysis_jobs SET status='pending' WHERE status='running';
      UPDATE sessions SET analysis_status='pending' WHERE analysis_status='running';
      UPDATE industry_jobs SET status='pending' WHERE status='running';`);
    // A restarted process cannot know whether an external CCC/SIP resource is still alive.
    // Retain correlation IDs, mark it unknown, and never automatically resume or redial it.
    for (const row of this.db.prepare(`SELECT id,telephone FROM sessions WHERE transport='sip' AND status IN ('created','connecting','opening','active')`).all() as Row[]) {
      let telephone: Session['telephone'];
      try { telephone = row.telephone ? JSON.parse(row.telephone) : undefined; } catch { telephone = undefined; }
      this.db.prepare(`UPDATE sessions SET status='failed',error='服务重启，电话资源状态未知；请先在平台核实',ended_at=?,end_reason='service_restart',telephone=? WHERE id=?`)
        .run(new Date().toISOString(), JSON.stringify({ ...telephone, provider: telephone?.provider === 'aliyun_udp_trunk' ? 'aliyun_udp_trunk' : 'aliyun_ccc', gateway: 'siphon', state: 'unknown', endedReason: 'service_restart',
          recordingStatus: telephone?.recordingStatus === 'recording' ? 'failed' : telephone?.recordingStatus }), row.id);
    }
    this.db.prepare(`UPDATE sessions SET status='failed', error='服务重启，会话已结束；请新建测试', ended_at=?,end_reason='service_restart'
      WHERE status IN ('connecting','opening','active')`).run(new Date().toISOString());
    for (const row of this.db.prepare(`SELECT id FROM sessions WHERE answered_at IS NOT NULL AND status IN ('completed','failed')
      AND (analysis_status='not_requested' OR NOT EXISTS (SELECT 1 FROM analysis_jobs WHERE session_id=sessions.id))`).all() as Row[]) this.enqueueAnalysis(row.id);
    for (const customer of this.customers()) if (!customer.industry?.trim()) this.enqueueIndustry(customer);
  }
  private addColumns(table: string, columns: Record<string, string>) {
    const existing = new Set((this.db.prepare(`PRAGMA table_info(${table})`).all() as Row[]).map(row => row.name));
    for (const [name, type] of Object.entries(columns)) if (!existing.has(name)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
  }
  private migrateLegacySessionReadiness() {
    const id = '2026-11-03-session-readiness-provenance';
    if (this.db.prepare('SELECT id FROM schema_migrations WHERE id=?').get(id)) return;
    this.db.exec('BEGIN');
    try {
      // Releases before this migration used session.created as the connection
      // proxy for browser / retired softphone demos. Recover only those rows,
      // once. A future telephone transport must supply its own answer event.
      this.db.exec(`UPDATE sessions SET
        model_ready_at=COALESCE(model_ready_at,(SELECT MIN(created_at) FROM events WHERE session_id=sessions.id AND type='session.created')),
        answered_at=COALESCE(answered_at,(SELECT MIN(created_at) FROM events WHERE session_id=sessions.id AND type='session.created'))
        WHERE mode='seed' AND transport IN ('browser','softphone_bridge');
        UPDATE sessions SET answer_source=CASE transport
          WHEN 'browser' THEN 'legacy_browser_session' ELSE 'legacy_softphone_bridge' END
        WHERE mode='seed' AND transport IN ('browser','softphone_bridge')
          AND answered_at IS NOT NULL AND answer_source IS NULL;`);
      this.db.prepare('INSERT INTO schema_migrations(id,applied_at) VALUES (?,?)').run(id, new Date().toISOString());
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  close() { this.db.close(); }
  private upgradeStockPrompt() {
    const row = this.db.prepare('SELECT value FROM settings WHERE key=?').get('agent') as Row | undefined;
    if (!row) return;
    const config: AgentConfig = JSON.parse(row.value);
    if (!config.systemPrompt) return; // A missing prompt already follows the current default.
    const hash = createHash('sha256').update(config.systemPrompt.trim()).digest('hex');
    // Only the two shipped defaults are eligible; never overwrite an edited prompt.
    const shippedDefaults = new Set([
      '76b9d71b82d1736083b9c9c8212c83d53a50bc26fb55acca31b7b3512d17637b',
      '57d875f7958a82c08d48336825810cd5b5535332d694bb4eefcb966c1197f07b',
    ]);
    if (!shippedDefaults.has(hash)) return;
    this.db.exec('BEGIN');
    try {
      this.db.prepare('INSERT OR IGNORE INTO settings(key,value) VALUES (?,?)').run('agent_backup_2026-11-02-faq', row.value);
      this.saveConfig({ ...config, systemPrompt: DEFAULT_SYSTEM_PROMPT });
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  config(): AgentConfig {
    const row = this.db.prepare('SELECT value FROM settings WHERE key=?').get('agent') as Row | undefined;
    return row ? { ...DEFAULT_CONFIG, ...JSON.parse(row.value) } : { ...DEFAULT_CONFIG };
  }
  saveConfig(config: AgentConfig) {
    this.db.prepare('INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('agent', JSON.stringify(config));
    return config;
  }
  private customerRow(row: Row): Customer {
    const customer = JSON.parse(row.data);
    if (row.industry_status) customer.industryStatus = row.industry_status;
    if (row.industry_error) customer.industryError = row.industry_error;
    return customer;
  }
  customers(): Customer[] {
    return (this.db.prepare(`SELECT c.data,j.status AS industry_status,j.error AS industry_error FROM customers c
      LEFT JOIN industry_jobs j ON j.customer_id=c.id ORDER BY c.rowid DESC`).all() as Row[]).map(row => this.customerRow(row));
  }
  customer(id: string): Customer | undefined {
    const row = this.db.prepare(`SELECT c.data,j.status AS industry_status,j.error AS industry_error FROM customers c
      LEFT JOIN industry_jobs j ON j.customer_id=c.id WHERE c.id=?`).get(id) as Row | undefined;
    return row ? this.customerRow(row) : undefined;
  }
  importCustomers(input: Omit<Customer, 'id'>[]): Customer[] {
    this.db.exec('BEGIN');
    try {
      for (const item of input) {
        const normalizedPhone = item.phone.replace(/[ ()-]/g, '');
        const existing = this.db.prepare('SELECT id,data FROM customers WHERE phone=?').get(normalizedPhone) as Row | undefined;
        const old = existing ? JSON.parse(existing.data) as Customer : undefined;
        const industry = item.industry?.trim() || (old?.camp === item.camp ? old.industry : '') || '';
        const { industryStatus: _status, industryError: _error, ...original } = item;
        const customer: Customer = { ...original, phone: normalizedPhone, industry, id: existing?.id ?? randomUUID() };
        this.db.prepare(`INSERT INTO customers(id,phone,data) VALUES (?,?,?) ON CONFLICT(phone) DO UPDATE SET data=excluded.data`)
          .run(customer.id, customer.phone, JSON.stringify(customer));
        if (industry) this.db.prepare('DELETE FROM industry_jobs WHERE customer_id=?').run(customer.id);
        else this.enqueueIndustry(customer, old?.camp !== customer.camp);
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return this.customers();
  }
  enqueueIndustry(customer: Customer, force = false) {
    if (!force && customer.industry?.trim()) return;
    this.db.prepare(`INSERT INTO industry_jobs(customer_id,camp,status,updated_at) VALUES (?,?,'pending',?)
      ON CONFLICT(customer_id) DO UPDATE SET camp=excluded.camp,status='pending',attempts=0,error=NULL,next_attempt=NULL,updated_at=excluded.updated_at
      WHERE industry_jobs.camp!=excluded.camp OR ?=1`).run(customer.id, customer.camp, new Date().toISOString(), force ? 1 : 0);
  }
  claimIndustries(limit = 20): IndustryJob[] {
    const rows = this.db.prepare(`SELECT customer_id AS customerId,camp,attempts FROM industry_jobs
      WHERE status='pending' AND (next_attempt IS NULL OR next_attempt<=?) ORDER BY updated_at LIMIT ?`).all(new Date().toISOString(), limit) as unknown as IndustryJob[];
    const update = this.db.prepare(`UPDATE industry_jobs SET status='running',attempts=attempts+1 WHERE customer_id=? AND camp=?`);
    for (const row of rows) { update.run(row.customerId, row.camp); row.attempts++; }
    return rows;
  }
  completeIndustry(job: IndustryJob, industry: string) {
    const current = this.customer(job.customerId);
    if (!current || current.camp !== job.camp || current.industryStatus !== 'running') return;
    const { industryStatus: _status, industryError: _error, ...data } = current;
    this.db.prepare('UPDATE customers SET data=? WHERE id=?').run(JSON.stringify({ ...data, industry }), current.id);
    this.db.prepare(`UPDATE industry_jobs SET status='completed',error=NULL,next_attempt=NULL,updated_at=? WHERE customer_id=? AND camp=?`)
      .run(new Date().toISOString(), job.customerId, job.camp);
  }
  failIndustry(job: IndustryJob, error: string, retryAt?: string) {
    this.db.prepare(`UPDATE industry_jobs SET status=?,error=?,next_attempt=?,updated_at=? WHERE customer_id=? AND camp=? AND status='running'`)
      .run(retryAt ? 'pending' : 'failed', error, retryAt ?? null, new Date().toISOString(), job.customerId, job.camp);
  }
  createSession(customer: Customer, mode: Session['mode']): Session {
    return this.insertSession(customer, mode, 'browser');
  }
  createTelephoneSession(customer: Customer): Session {
    return this.insertSession(customer, 'seed', 'sip');
  }
  createTrunkSession(customer: Customer): Session {
    const session = this.insertSession(customer, 'seed', 'sip');
    this.db.prepare('UPDATE sessions SET telephone=? WHERE id=?').run(JSON.stringify({ ...session.telephone, provider: 'aliyun_udp_trunk' }), session.id);
    return this.session(session.id)!;
  }
  private insertSession(customer: Customer, mode: Session['mode'], transport: 'browser' | 'sip'): Session {
    const config = this.config();
    const prompt = buildPrompt(customer, config);
    const id = randomUUID();
    this.db.prepare(`INSERT INTO sessions(id,customer,config,mode,status,prompt,prompt_hash,created_at,analysis_status,transport,telephone)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(id, JSON.stringify(customer), JSON.stringify(config), mode, 'created', prompt,
        createHash('sha256').update(prompt).digest('hex'), new Date().toISOString(), 'not_requested', transport,
        transport === 'sip' ? JSON.stringify({ provider: 'aliyun_ccc', gateway: 'siphon', state: 'prepared', recordingStatus: 'pending' }) : null);
    return this.session(id)!;
  }
  private sessionRow(row: Row, full = true): Session {
    return {
      id: row.id, customer: JSON.parse(row.customer), configSnapshot: full ? JSON.parse(row.config) : undefined,
      mode: row.mode, transport: row.transport ?? 'browser', status: row.status, prompt: full ? row.prompt : '', promptHash: row.prompt_hash, createdAt: row.created_at,
      telephone: row.telephone ? JSON.parse(row.telephone) : undefined,
      endedAt: row.ended_at ?? undefined, answeredAt: row.answered_at ?? undefined,
      answerSource: row.answer_source ?? undefined, modelReadyAt: row.model_ready_at ?? undefined,
      endReason: row.end_reason ?? undefined,
      error: row.error ?? undefined, analysisStatus: row.analysis_status, analysis: row.result ? JSON.parse(row.result) : undefined,
      analysisError: row.analysis_error ?? undefined, recording: row.recording ? JSON.parse(row.recording) : undefined,
      transcripts: full ? this.transcripts(row.id) : [],
      playbacks: row.transport === 'sip' ? (full ? this.playbacks(row.id) : []) : undefined,
    } as Session;
  }
  session(id: string): Session | undefined {
    const row = this.db.prepare(`SELECT s.*,a.result,a.error AS analysis_error FROM sessions s LEFT JOIN analysis_jobs a ON a.session_id=s.id WHERE s.id=?`).get(id) as Row | undefined;
    return row ? this.sessionRow(row) : undefined;
  }
  sessions(): Session[] {
    return (this.db.prepare('SELECT id FROM sessions ORDER BY rowid DESC LIMIT 10').all() as Row[]).map(row => this.session(row.id)!);
  }
  sessionCount(): number { return Number((this.db.prepare('SELECT COUNT(*) AS count FROM sessions').get() as Row).count); }
  listSessions(query: SessionQuery) {
    const clauses: string[] = []; const values: (string | number)[] = [];
    if (query.source && query.source !== 'all') { clauses.push('s.transport=?'); values.push(query.source); }
    if (query.answeredOnly) clauses.push('s.answered_at IS NOT NULL');
    const dateField = ({ createdAt: 's.created_at', answeredAt: 's.answered_at', endedAt: 's.ended_at' })[query.dateField];
    if (query.from) { clauses.push(`${dateField}>=?`); values.push(query.from); }
    if (query.to) { clauses.push(`${dateField}<?`); values.push(query.to); }
    if (query.grade) { clauses.push(`json_extract(a.result,'$.grade')=?`); values.push(query.grade); }
    if (query.search) {
      clauses.push(`(json_extract(s.customer,'$.camp') LIKE ? ESCAPE '\\' OR json_extract(s.customer,'$.name') LIKE ? ESCAPE '\\' OR json_extract(s.customer,'$.phone') LIKE ? ESCAPE '\\')`);
      const term = `%${query.search.replace(/[\\%_]/g, '\\$&')}%`; values.push(term, term, term);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const join = 'FROM sessions s LEFT JOIN analysis_jobs a ON a.session_id=s.id';
    const total = Number((this.db.prepare(`SELECT COUNT(*) AS count ${join} ${where}`).get(...values) as Row).count);
    const page = Math.max(1, Math.min(query.page, Math.max(1, Math.ceil(total / query.pageSize))));
    const field = ({ createdAt: 's.created_at', status: 's.status', grade: `CASE json_extract(a.result,'$.grade') WHEN 'A' THEN 7 WHEN 'B' THEN 6 WHEN 'C' THEN 5 WHEN 'D' THEN 4 WHEN 'E' THEN 3 WHEN 'F' THEN 2 WHEN 'G' THEN 1 END` })[query.sortBy];
    const direction = query.sortDir === 'asc' ? 'ASC' : 'DESC';
    const rows = this.db.prepare(`SELECT s.*,a.result,a.error AS analysis_error ${join} ${where}
      ORDER BY ${field} IS NULL ASC,${field} ${direction},s.created_at DESC,s.id ASC LIMIT ? OFFSET ?`).all(...values, query.pageSize, (page - 1) * query.pageSize) as Row[];
    return { items: rows.map(row => this.sessionRow(row, false)), total, page, pageSize: query.pageSize };
  }
  answered(id: string) {
    // Compatibility for browser tests only. Model readiness on other transports
    // must never count as the remote customer answering a telephone call.
    this.db.prepare(`UPDATE sessions SET answered_at=COALESCE(answered_at,?),answer_source=COALESCE(answer_source,'browser_session')
      WHERE id=? AND mode='seed' AND transport='browser'`).run(new Date().toISOString(), id);
  }
  updateTelephone(id: string, patch: Partial<NonNullable<Session['telephone']>>): Session | undefined {
    const session = this.session(id);
    if (!session || session.transport !== 'sip' || !session.telephone) return undefined;
    const old = session.telephone;
    if ((patch.provider !== undefined && patch.provider !== old.provider) || (patch.gateway !== undefined && patch.gateway !== 'siphon')) return undefined;
    const states = ['prepared', 'dialing', 'ringing', 'answered', 'ended', 'busy', 'no_answer', 'rejected', 'cancelled', 'failed', 'unknown'] as const;
    if (patch.state !== undefined && !states.includes(patch.state)) return undefined;
    if (patch.recordingStatus !== undefined && !['pending', 'recording', 'ready', 'failed'].includes(patch.recordingStatus)) return undefined;
    if (patch.cleanupStatus !== undefined && !['pending', 'confirmed', 'unknown'].includes(patch.cleanupStatus)) return undefined;
    for (const key of ['jobId', 'channelId', 'sipCallId', 'customerChannelId', 'endedReason'] as const) {
      if (patch[key] !== undefined && (typeof patch[key] !== 'string' || !patch[key]?.trim() || patch[key]!.length > 1024 || /[\r\n\0]/.test(patch[key]!))) return undefined;
      if (key !== 'endedReason' && old[key] && patch[key] !== undefined && patch[key] !== old[key]) return undefined;
    }
    const terminal = states.slice(4).includes(old.state as typeof states[4]);
    const rank = (state: typeof old.state) => states.indexOf(state) < 4 ? states.indexOf(state) : 4;
    const allowed = new Set(['state', 'jobId', 'channelId', 'sipCallId', 'customerChannelId', 'endedReason', 'recordingStatus', 'cleanupStatus']);
    const defined = Object.fromEntries(Object.entries(patch).filter(([key, value]) => allowed.has(key) && value !== undefined));
    const proposed = { ...old, ...defined, provider: old.provider, gateway: 'siphon' as const };
    if (terminal || (['completed', 'failed'].includes(session.status) && rank(proposed.state) < 4)
      || (patch.state !== undefined && rank(patch.state) < rank(old.state))) proposed.state = old.state;
    // Only telephoneAnswered can establish the answered state and its evidence together.
    if (proposed.state === 'answered' && !session.answeredAt) proposed.state = old.state;
    if (old.recordingStatus === 'ready') proposed.recordingStatus = 'ready';
    this.db.prepare('UPDATE sessions SET telephone=? WHERE id=?').run(JSON.stringify(proposed), id);
    return this.session(id);
  }
  telephoneAnswered(id: string, evidence: { jobId: string; customerChannelId: string; at?: string }): Session | undefined {
    const session = this.session(id);
    if (!session || session.mode !== 'seed' || session.transport !== 'sip' || session.telephone?.provider !== 'aliyun_ccc'
      || !session.telephone.jobId || session.telephone.jobId !== evidence.jobId || !evidence.customerChannelId?.trim()
      || evidence.customerChannelId.length > 1024 || /[\r\n\0]/.test(evidence.customerChannelId)
      || (session.telephone.customerChannelId && session.telephone.customerChannelId !== evidence.customerChannelId)) return undefined;
    if (session.answeredAt) return session;
    if (['completed', 'failed'].includes(session.status) || !['prepared', 'dialing', 'ringing', 'answered'].includes(session.telephone.state)) return undefined;
    const time = evidence.at === undefined ? Date.now() : Date.parse(evidence.at);
    if (!Number.isFinite(time) || time < Date.parse(session.createdAt) - 5000 || time > Date.now() + 60_000) return undefined;
    const telephone = { ...session.telephone, state: 'answered' as const, customerChannelId: evidence.customerChannelId };
    this.db.prepare(`UPDATE sessions SET answered_at=?,answer_source='ccc_customer',telephone=? WHERE id=? AND answered_at IS NULL AND transport='sip'`)
      .run(new Date(time).toISOString(), JSON.stringify(telephone), id);
    return this.session(id);
  }
  trunkAnswered(id: string, evidence: { channelId: string; sipCallId: string }): Session | undefined {
    const session = this.session(id);
    if (!session || session.transport !== 'sip' || session.telephone?.provider !== 'aliyun_udp_trunk'
      || session.telephone.channelId !== evidence.channelId || session.telephone.sipCallId !== evidence.sipCallId
      || !evidence.channelId || !evidence.sipCallId || ['completed', 'failed'].includes(session.status)
      || !['prepared', 'dialing', 'ringing', 'answered'].includes(session.telephone.state)) return undefined;
    if (session.answeredAt) return session;
    this.db.prepare("UPDATE sessions SET answered_at=?,answer_source='sip_gateway',telephone=? WHERE id=? AND answered_at IS NULL")
      .run(new Date().toISOString(), JSON.stringify({ ...session.telephone, state: 'answered' }), id);
    return this.session(id);
  }
  markModelReady(id: string) {
    this.db.prepare(`UPDATE sessions SET model_ready_at=COALESCE(model_ready_at,?) WHERE id=? AND mode='seed'`)
      .run(new Date().toISOString(), id);
  }
  status(id: string, status: SessionStatus, error?: string, endReason?: string) {
    const ended = status === 'completed' || status === 'failed';
    const old = this.session(id);
    if (!old || ['completed', 'failed'].includes(old.status)) return;
    this.db.prepare('UPDATE sessions SET status=?,error=?,ended_at=?,end_reason=? WHERE id=?')
      .run(status, error ?? null, ended ? new Date().toISOString() : null, ended ? (endReason ?? (status === 'failed' ? 'transport_error' : 'local_finish')) : null, id);
    if (ended && old.answeredAt) this.enqueueAnalysis(id);
  }
  enqueueAnalysis(id: string, force = false) {
    const session = this.session(id);
    if (!session?.answeredAt || !['completed', 'failed'].includes(session.status)) return false;
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO analysis_jobs(id,session_id,status,created_at,updated_at) VALUES (?,?,'pending',?,?)
      ON CONFLICT(session_id) DO UPDATE SET status='pending',error=NULL,attempts=0,next_attempt=NULL,updated_at=excluded.updated_at
      WHERE analysis_jobs.status='not_requested' OR (?=1 AND analysis_jobs.status NOT IN ('pending','running'))`).run(randomUUID(), id, now, now, force ? 1 : 0);
    const job = this.db.prepare('SELECT status FROM analysis_jobs WHERE session_id=?').get(id) as Row;
    this.db.prepare('UPDATE sessions SET analysis_status=? WHERE id=?').run(job.status, id);
    return true;
  }
  claimAnalysis(): { session: Session; attempts: number } | undefined {
    const row = this.db.prepare(`SELECT session_id,attempts FROM analysis_jobs WHERE status='pending'
      AND (next_attempt IS NULL OR next_attempt<=?) ORDER BY created_at LIMIT 1`).get(new Date().toISOString()) as Row | undefined;
    if (!row) return undefined;
    this.db.prepare(`UPDATE analysis_jobs SET status='running',attempts=attempts+1,updated_at=? WHERE session_id=?`).run(new Date().toISOString(), row.session_id);
    this.db.prepare(`UPDATE sessions SET analysis_status='running' WHERE id=?`).run(row.session_id);
    return { session: this.session(row.session_id)!, attempts: row.attempts + 1 };
  }
  completeAnalysis(id: string, result: CallAnalysis) {
    this.db.prepare(`UPDATE analysis_jobs SET status='completed',result=?,error=NULL,next_attempt=NULL,updated_at=? WHERE session_id=?`)
      .run(JSON.stringify(result), new Date().toISOString(), id);
    this.db.prepare(`UPDATE sessions SET analysis_status='completed' WHERE id=?`).run(id);
  }
  failAnalysis(id: string, error: string, retryAt?: string) {
    const status = retryAt ? 'pending' : 'failed';
    this.db.prepare(`UPDATE analysis_jobs SET status=?,error=?,next_attempt=?,updated_at=? WHERE session_id=?`).run(status, error, retryAt ?? null, new Date().toISOString(), id);
    this.db.prepare('UPDATE sessions SET analysis_status=? WHERE id=?').run(status, id);
  }
  jobCounts() {
    const counts = { pending: 0, running: 0, failed: 0, industryPending: 0, industryRunning: 0, industryFailed: 0 };
    for (const row of this.db.prepare('SELECT status,COUNT(*) AS count FROM analysis_jobs GROUP BY status').all() as Row[]) {
      if (row.status in counts) counts[row.status as 'pending' | 'running' | 'failed'] = Number(row.count);
    }
    for (const row of this.db.prepare('SELECT status,COUNT(*) AS count FROM industry_jobs GROUP BY status').all() as Row[]) {
      const key = ({ pending: 'industryPending', running: 'industryRunning', failed: 'industryFailed' } as const)[row.status as 'pending'];
      if (key) counts[key] = Number(row.count);
    }
    return counts;
  }
  saveRecording(id: string, recording: NonNullable<Session['recording']>) {
    this.db.prepare('UPDATE sessions SET recording=? WHERE id=?').run(JSON.stringify(recording), id);
  }
  transcripts(id: string): Transcript[] {
    return (this.db.prepare('SELECT * FROM transcripts WHERE session_id=? ORDER BY rowid').all(id) as Row[]).map(r => ({
      id: r.id, responseId: r.kind === 'ChatText' ? r.provider_key : undefined,
      eventId: r.event_id ?? undefined, kind: r.kind, text: r.text, final: Boolean(r.final), createdAt: r.created_at,
    }));
  }
  transcript(id: string, key: string, kind: Transcript['kind'], text: string, final: boolean, eventId?: string, replaceFinal = false): Transcript {
    const row = this.db.prepare('SELECT * FROM transcripts WHERE session_id=? AND provider_key=? AND kind=?').get(id, key, kind) as Row | undefined;
    // Authoritative provider text may replace the known audio-only quick-reply
    // fallback. Ordinary late deltas must never overwrite a final transcript.
    if (row?.final && !replaceFinal) return this.transcripts(id).find(t => t.id === row.id)!;
    const transcript = { id: row?.id ?? randomUUID(), responseId: kind === 'ChatText' ? key : undefined, eventId, kind, text, final, createdAt: row?.created_at ?? new Date().toISOString() };
    this.db.prepare(`INSERT INTO transcripts(id,session_id,provider_key,event_id,kind,text,final,created_at)
      VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(session_id,provider_key,kind)
      DO UPDATE SET text=excluded.text,final=excluded.final,event_id=excluded.event_id`).run(
        transcript.id, id, key, eventId ?? null, kind, text, final ? 1 : 0, transcript.createdAt);
    return transcript;
  }
  playbacks(id: string): NonNullable<Session['playbacks']> {
    return (this.db.prepare('SELECT * FROM playback_facts WHERE session_id=? ORDER BY started_at,rowid').all(id) as Row[]).map(row => ({
      playbackId: row.playback_id, responseId: row.response_id ?? undefined, opening: Boolean(row.opening),
      startedAt: row.started_at, drainedAt: row.drained_at ?? undefined, scope: 'gateway_rtp_egress',
    }));
  }
  playback(id: string, segment: { id: string; responseId?: string; opening: boolean }, phase: 'started' | 'drained') {
    if (this.db.prepare('SELECT transport FROM sessions WHERE id=?').get(id)?.transport !== 'sip') return;
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO playback_facts(session_id,playback_id,response_id,opening,started_at,drained_at)
      VALUES (?,?,?,?,?,?) ON CONFLICT(session_id,playback_id) DO UPDATE SET drained_at=COALESCE(playback_facts.drained_at,excluded.drained_at)`)
      .run(id, segment.id, segment.responseId ?? null, segment.opening ? 1 : 0, now, phase === 'drained' ? now : null);
  }
  event(id: string, type: string, payload: unknown) {
    this.db.prepare('INSERT INTO events(session_id,type,payload,created_at) VALUES (?,?,?,?)').run(id, type, JSON.stringify(payload), new Date().toISOString());
  }
  exportSession(id: string) {
    const session = this.session(id);
    return { session,
      events: (this.db.prepare('SELECT type,payload,created_at AS createdAt FROM events WHERE session_id=? ORDER BY id').all(id) as Row[])
        .map(r => ({ type: r.type, payload: JSON.parse(r.payload), createdAt: r.createdAt })),
      analysis: { status: session?.analysisStatus, result: session?.analysis ?? null, note: session?.analysis ? '自动评估结果，请结合客户原话复核' : '尚未运行成功；仅接通的语音通话参与评估' },
    };
  }
}
