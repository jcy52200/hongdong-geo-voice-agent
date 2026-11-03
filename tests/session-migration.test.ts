import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.js';

const customer = { id: 'fixture-customer', camp: '迁移测试门窗公司', name: '测试联系人', phone: '13800000000', address: '河北', industry: '门窗' };
const readyAt = '2026-01-01T00:00:01.000Z';
const migrationId = '2026-11-03-session-readiness-provenance';

test('一次性迁移仅恢复旧浏览器/演示来源，保留快照、已有时间和未知来源', t => {
  const directory = mkdtempSync(join(tmpdir(), 'geo-readiness-migration-'));
  const path = join(directory, 'history.sqlite');
  const old = new DatabaseSync(path);
  old.exec(`CREATE TABLE sessions (
    id TEXT PRIMARY KEY,customer TEXT NOT NULL,config TEXT NOT NULL,mode TEXT NOT NULL,status TEXT NOT NULL,
    prompt TEXT NOT NULL,prompt_hash TEXT NOT NULL,created_at TEXT NOT NULL,ended_at TEXT,error TEXT,
    analysis_status TEXT NOT NULL,answered_at TEXT,transport TEXT NOT NULL,recording TEXT,end_reason TEXT
  );
  CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT,session_id TEXT NOT NULL,type TEXT NOT NULL,payload TEXT NOT NULL,created_at TEXT NOT NULL);
  CREATE TABLE transcripts (id TEXT PRIMARY KEY,session_id TEXT NOT NULL,provider_key TEXT NOT NULL,event_id TEXT,kind TEXT NOT NULL,text TEXT NOT NULL,final INTEGER NOT NULL,created_at TEXT NOT NULL,UNIQUE(session_id,provider_key,kind));`);
  const insert = old.prepare('INSERT INTO sessions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  for (const [id, transport, mode, answeredAt] of [
    ['browser-old', 'browser', 'seed', null],
    ['bridge-old', 'softphone_bridge', 'seed', null],
    ['future-old', 'future_sip', 'seed', null],
    ['simulation-old', 'browser', 'simulation', null],
    ['browser-answered', 'browser', 'seed', '2026-01-01T00:00:02.000Z'],
    ['future-answered', 'future_sip', 'seed', '2026-01-01T00:00:03.000Z'],
  ] as const) {
    insert.run(id, JSON.stringify(customer), '{"agentName":"历史声音","voice":"saved_voice","speed":2,"extraInstructions":"保留"}', mode,
      'completed', `历史快照 ${id}`, `saved-hash-${id}`, '2026-01-01T00:00:00.000Z', '2026-01-01T00:01:00.000Z', null,
      'not_requested', answeredAt, transport, '{"url":"/saved-recording","mimeType":"audio/webm","bytes":12,"createdAt":"2026-01-01T00:01:00.000Z"}', 'local_finish');
    old.prepare('INSERT INTO events(session_id,type,payload,created_at) VALUES(?,?,?,?)').run(id, 'session.created', '{"id":"model-id"}', readyAt);
    old.prepare('INSERT INTO transcripts VALUES(?,?,?,?,?,?,?,?)').run(`transcript-${id}`, id, 'opening', 'event-id', 'ChatText', '历史开场白', 1, readyAt);
  }
  const snapshot = () => old.prepare('SELECT id,customer,config,prompt,prompt_hash,recording FROM sessions ORDER BY id').all();
  const original = snapshot();
  old.close();
  let store = new Store(path);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  assert.equal(store.session('browser-old')?.answeredAt, readyAt);
  assert.equal(store.session('browser-old')?.answerSource, 'legacy_browser_session');
  assert.equal(store.session('bridge-old')?.answeredAt, readyAt);
  assert.equal(store.session('bridge-old')?.answerSource, 'legacy_softphone_bridge');
  for (const id of ['browser-old', 'bridge-old', 'browser-answered']) assert.equal(store.session(id)?.modelReadyAt, readyAt);
  for (const id of ['future-old', 'simulation-old']) {
    assert.equal(store.session(id)?.answeredAt, undefined);
    assert.equal(store.session(id)?.answerSource, undefined);
    assert.equal(store.session(id)?.modelReadyAt, undefined);
  }
  assert.equal(store.session('future-answered')?.answeredAt, '2026-01-01T00:00:03.000Z');
  assert.equal(store.session('future-answered')?.answerSource, undefined, '未知来源的既有接通时间不能被重标为浏览器');
  assert.equal(store.session('browser-answered')?.answeredAt, '2026-01-01T00:00:02.000Z');
  assert.deepEqual(store.db.prepare('SELECT id,customer,config,prompt,prompt_hash,recording FROM sessions ORDER BY id').all(), original);
  assert.equal(store.session('bridge-old')?.transcripts[0].text, '历史开场白');
  assert.equal(store.session('browser-old')?.analysisStatus, 'pending', '保留旧接通口径并修复待评估任务');
  const beforeReopen = store.session('bridge-old');
  store.close(); store = new Store(path);
  assert.deepEqual(store.session('bridge-old'), beforeReopen);
  assert.equal((store.db.prepare('SELECT COUNT(*) AS n FROM schema_migrations WHERE id=?').get(migrationId) as { n: number }).n, 1);
});

test('迁移执行后重启不再从模型事件回填新会话，包括浏览器与未来电话来源', t => {
  const directory = mkdtempSync(join(tmpdir(), 'geo-readiness-reopen-'));
  const path = join(directory, 'sessions.sqlite');
  let store = new Store(path);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const ids: string[] = [];
  for (const transport of ['browser', 'softphone_bridge', 'future_sip']) {
    const call = store.createSession(customer, 'seed'); ids.push(call.id);
    store.db.prepare('UPDATE sessions SET transport=? WHERE id=?').run(transport, call.id);
    store.event(call.id, 'session.created', { modelReady: true });
    store.status(call.id, 'completed');
  }
  store.close(); store = new Store(path);
  for (const id of ids) {
    const call = store.session(id)!;
    assert.equal(call.answeredAt, undefined);
    assert.equal(call.modelReadyAt, undefined, '新记录必须由明确的方法记录模型就绪，不由每次启动猜测');
    assert.equal(call.analysisStatus, 'not_requested');
  }
  assert.equal(store.claimAnalysis(), undefined);
});

test('模型就绪与浏览器连接独立；兼容 answered 方法不能替未来电话或停用演示标记接通', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  for (const transport of ['browser', 'softphone_bridge', 'future_sip']) {
    const call = store.createSession(customer, 'seed');
    store.db.prepare('UPDATE sessions SET transport=? WHERE id=?').run(transport, call.id);
    store.markModelReady(call.id);
    const ready = store.session(call.id)!;
    assert.ok(ready.modelReadyAt);
    assert.equal(ready.answeredAt, undefined);
    store.db.prepare('UPDATE sessions SET model_ready_at=? WHERE id=?').run(readyAt, call.id);
    store.markModelReady(call.id);
    assert.equal(store.session(call.id)?.modelReadyAt, readyAt, '重复模型就绪事件保留首个时间');
    store.answered(call.id);
    const connected = store.session(call.id)!;
    if (transport === 'browser') {
      assert.ok(connected.answeredAt);
      assert.equal(connected.answerSource, 'browser_session');
    } else {
      assert.equal(connected.answeredAt, undefined);
      assert.equal(connected.answerSource, undefined);
    }
    store.status(call.id, 'completed');
    assert.equal(store.session(call.id)?.analysisStatus, transport === 'browser' ? 'pending' : 'not_requested');
  }
  const simulation = store.createSession(customer, 'simulation');
  store.markModelReady(simulation.id); store.answered(simulation.id);
  assert.equal(store.session(simulation.id)?.modelReadyAt, undefined);
  assert.equal(store.session(simulation.id)?.answeredAt, undefined);
});
