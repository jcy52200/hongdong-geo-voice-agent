import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app.js';
import { Store } from '../server/store.js';
import type { CallAnalysis } from '../shared/analysis.js';

const customer = { camp: '河北测试门窗有限公司', name: '王先生', phone: '13812345678', address: '河北' };
const result = (grade: CallAnalysis['grade']): CallAnalysis => ({ grade, summary: '测试评估', reason: '客户原话', evidence: [], wechat: { consent: false, phone: null, sameAsDialed: false, identifier: null }, customerTurns: 0, assistantTurns: 0, model: 'deepseek-flash', evaluatedAt: new Date().toISOString() });
async function until(predicate: () => boolean) {
  for (let index = 0; index < 100; index++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 30)); }
  assert.fail('等待后台任务超时');
}

test('CRM 行业后台补全、提示词注入、通话评估和分页 API 使用同一持久数据', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'geo-analysis-'));
  const seen: any[] = [];
  const provider = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); seen.push(body);
    const input = JSON.parse(body.messages[1].content);
    const answer = input.customers
      ? { customers: input.customers.map((item: any) => ({ id: item.id, industry: '门窗' })) }
      : { grade: 'A', summary: '客户同意加微信并确认同号。', reason: '许可和同号均已确认。', evidence: input.transcripts.filter((item: any) => item.kind === 'AsrText').map((item: any) => ({ transcriptId: item.id, quote: item.text })), wechat: { consent: true, phone: customer.phone, sameAsDialed: true, identifier: null } };
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(answer) } }] }));
  });
  provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
  const runtime = createApp({ databasePath: join(dir, 'calls.sqlite'), deepseekApiKey: 'fake-test-only-key', deepseekBaseUrl: `http://127.0.0.1:${(provider.address() as any).port}` });
  runtime.server.listen(0, '127.0.0.1'); await once(runtime.server, 'listening');
  const base = `http://127.0.0.1:${(runtime.server.address() as any).port}/api`;
  const post = (path: string, body: unknown) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  t.after(async () => { await runtime.close(); await new Promise<void>(resolve => provider.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); });
  const imported = await (await post('/customers/import', { customers: [{ ...customer, crmTag: '保留原始CRM附加字段' }] })).json();
  const id = imported.customers[0].id;
  await until(() => runtime.store.customer(id)?.industry === '门窗');
  const enriched = await (await fetch(base + '/customers/export')).json();
  assert.equal(enriched.customers[0].crmTag, '保留原始CRM附加字段');
  assert.equal(enriched.customers[0].industry, '门窗');
  const call = runtime.store.createSession(runtime.store.customer(id)!, 'seed');
  assert.match(call.prompt, /"&industry": "门窗"/);
  runtime.store.answered(call.id);
  runtime.store.transcript(call.id, 'opening', 'ChatText', '您方便加个微信吗？', true);
  runtime.store.transcript(call.id, 'a1', 'AsrText', '可以，加我微信吧。', true);
  runtime.store.transcript(call.id, 'r1', 'ChatText', '这个电话就是您微信绑定的手机号吗？', true);
  runtime.store.transcript(call.id, 'a2', 'AsrText', '对，就是这个号码。', true);
  runtime.store.status(call.id, 'completed');
  runtime.worker.wake();
  await until(() => runtime.store.session(call.id)?.analysisStatus === 'completed');
  const analyzed = await (await fetch(base + `/sessions/${call.id}`)).json();
  assert.equal(analyzed.analysis.grade, 'A'); assert.equal(analyzed.analysis.wechat.sameAsDialed, true);
  assert.equal(analyzed.analysis.wechat.phone, customer.phone);
  assert.equal(analyzed.analysis.customerTurns, 2);
  runtime.store.status(call.id, 'completed');
  assert.equal(runtime.store.session(call.id)?.analysisStatus, 'completed', '重复finish不回退已完成评估');
  const pending = runtime.store.createSession(runtime.store.customer(id)!, 'simulation'); runtime.store.status(pending.id, 'completed');
  const page = await (await fetch(base + '/sessions?pageSize=1&grade=A&sortBy=grade&sortDir=desc')).json();
  assert.equal(page.total, 1); assert.equal(page.items[0].id, call.id); assert.deepEqual(page.items[0].transcripts, []);
  assert.equal((await (await fetch(base + '/sessions?answeredOnly=false')).json()).total, 2);
  assert.equal((await fetch(base + '/sessions?sortBy=sql_injection')).status, 400);
  assert.equal((await post(`/sessions/${pending.id}/analyze`, {})).status, 409);
  const body = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 1, 2, 3]);
  const saved = await fetch(base + `/sessions/${call.id}/recording`, { method: 'POST', headers: { 'Content-Type': 'audio/webm;codecs=opus' }, body });
  assert.equal(saved.status, 201);
  const playback = await fetch(base + `/sessions/${call.id}/recording`, { headers: { Range: 'bytes=0-3' } });
  assert.equal(playback.status, 206); assert.deepEqual(Buffer.from(await playback.arrayBuffer()), body.subarray(0, 4));
  assert.equal((await (await fetch(base + '/bootstrap')).json()).analysis.configured, true);
  assert.ok(seen.every(body => body.model === 'deepseek-flash' && body.thinking.type === 'disabled'));
});

test('按接通、日期维度、等级、字面搜索排序和翻页，结果跨越旧的100条上限', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  for (let i = 0; i < 112; i++) {
    const call = store.createSession({ ...customer, id: String(i), camp: i === 0 ? '测试%_公司' : customer.camp }, 'seed');
    if (i < 110) store.answered(call.id);
    store.status(call.id, 'completed');
    if (i < 110) store.completeAnalysis(call.id, result(i % 2 ? 'B' : 'A'));
    store.db.prepare('UPDATE sessions SET created_at=?,answered_at=? WHERE id=?').run(new Date(Date.UTC(2026, 9, 1 + i)).toISOString(), i < 110 ? new Date(Date.UTC(2026, 9, 2 + i)).toISOString() : null, call.id);
  }
  const query = { page: 6, pageSize: 20, answeredOnly: true, dateField: 'createdAt', sortBy: 'createdAt', sortDir: 'asc' } as const;
  assert.equal(store.listSessions(query).items.length, 10);
  assert.equal(store.listSessions(query).total, 110);
  const sorted = store.listSessions({ ...query, page: 1, sortBy: 'grade', sortDir: 'desc' });
  assert.ok(sorted.items.every(item => item.analysis?.grade === 'A'));
  const literal = store.listSessions({ ...query, page: 1, search: '%_' });
  assert.equal(literal.total, 1);
  assert.equal(store.listSessions({ ...query, page: 1, dateField: 'answeredAt', from: '2026-10-02T00:00:00.000Z', to: '2026-10-03T00:00:00.000Z' }).total, 1);
});

test('行业回写不覆盖重导入的公司与手工行业，无密钥任务保持待处理', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const old = store.importCustomers([customer])[0];
  const job = store.claimIndustries()[0];
  store.importCustomers([{ ...customer, camp: '新公司', industry: '人工行业' }]);
  store.completeIndustry(job, '过期的行业');
  assert.equal(store.customer(old.id)?.industry, '人工行业');
  const c = store.importCustomers([{ ...customer, phone: '13912345678' }]).find(c => c.phone === '13912345678')!;
  assert.equal(c.industryStatus, 'pending');
  const call = store.createSession(c, 'seed'); store.answered(call.id); store.status(call.id, 'failed', '模拟网络错误');
  assert.equal(store.session(call.id)?.analysisStatus, 'pending');
});

test('从旧表结构无损迁移，并从已保存的session.created恢复接通标记', t => {
  const dir = mkdtempSync(join(tmpdir(), 'geo-old-db-')); const path = join(dir, 'old.sqlite');
  const old = new DatabaseSync(path);
  old.exec(`CREATE TABLE sessions(id TEXT PRIMARY KEY,customer TEXT NOT NULL,config TEXT NOT NULL,mode TEXT NOT NULL,status TEXT NOT NULL,prompt TEXT NOT NULL,prompt_hash TEXT NOT NULL,created_at TEXT NOT NULL,ended_at TEXT,error TEXT,analysis_status TEXT NOT NULL);`);
  old.prepare('INSERT INTO sessions VALUES(?,?,?,?,?,?,?,?,?,?,?)').run('old-call', JSON.stringify({ ...customer, id: 'old-customer' }), '{}', 'seed', 'completed', '旧快照', 'abc', '2026-01-01T00:00:00.000Z', '2026-01-01T00:01:00.000Z', null, 'pending');
  old.exec(`CREATE TABLE events(id INTEGER PRIMARY KEY AUTOINCREMENT,session_id TEXT NOT NULL,type TEXT NOT NULL,payload TEXT NOT NULL,created_at TEXT NOT NULL);`);
  old.prepare('INSERT INTO events(session_id,type,payload,created_at) VALUES(?,?,?,?)').run('old-call','session.created','{}','2026-01-01T00:00:01.000Z'); old.close();
  const store = new Store(path);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  assert.equal(store.session('old-call')?.prompt, '旧快照');
  assert.equal(store.session('old-call')?.answeredAt, '2026-01-01T00:00:01.000Z');
  assert.equal(store.session('old-call')?.recording, undefined);
  // Older releases normally inserted a job with pending; missing jobs are repaired too.
  assert.ok(store.claimAnalysis(), '迁移应修复缺失的待评估任务');
});
