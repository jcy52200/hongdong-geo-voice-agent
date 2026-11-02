import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../server/app.js';
import { Store } from '../server/store.js';

const customer = { camp: '桥接测试门窗', name: '测试联系人', phone: '01012345678', address: '北京', industry: '门窗' };

test('软电话演示接口保留Seed模式、要求人工确认、拒绝模拟和未来SIP接入', async t => {
  const runtime = createApp({ databasePath: ':memory:', apiKey: 'local-test-key' });
  t.after(() => runtime.close());
  runtime.server.listen(0, '127.0.0.1');
  await once(runtime.server, 'listening');
  const port = (runtime.server.address() as { port: number }).port;
  const request = (path: string, body?: unknown) => fetch(`http://127.0.0.1:${port}/api${path}`, {
    method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const imported = await (await request('/customers/import', { customers: [customer] })).json();
  const customerId = imported.customers[0].id;
  const original = await (await request('/sessions', { customerId, mode: 'seed' })).json();
  assert.equal(original.transport, 'browser', '原有调用默认浏览器音频，兼容旧客户端');

  const bridge = { customerId, mode: 'seed', transport: 'softphone_bridge' };
  assert.equal((await request('/sessions', bridge)).status, 400);
  assert.equal((await request('/sessions', { ...bridge, bridgeConfirmed: false })).status, 400);
  assert.equal((await request('/sessions', { ...bridge, mode: 'simulation', bridgeConfirmed: true })).status, 400);
  assert.equal((await request('/sessions', { ...bridge, transport: 'freeswitch', bridgeConfirmed: true })).status, 400);
  assert.equal(runtime.store.sessionCount(), 1, '非法接入请求不创建会话');

  const response = await request('/sessions', { ...bridge, bridgeConfirmed: true });
  assert.equal(response.status, 201);
  const call = await response.json();
  assert.equal(call.mode, 'seed');
  assert.equal(call.transport, 'softphone_bridge');
  assert.equal(call.answeredAt, undefined, '人工确认不会伪造AI初始化或SIP接通时间');
  const exported = await (await request(`/sessions/${call.id}/export`)).json();
  const metadata = exported.events.find((event: any) => event.type === 'local.transport.selected').payload;
  assert.equal(metadata.transport, 'softphone_bridge');
  assert.equal(metadata.connectionConfirmation, 'manual');
  assert.equal(metadata.sipSignaling, false);
  assert.equal(metadata.answeredAtSource, 'seed_session_created');
  assert.equal(exported.events.some((event: any) => event.type === 'call.answered'), false);
  const page = await (await request('/sessions?answeredOnly=false')).json();
  assert.equal(page.items.find((item: any) => item.id === call.id).transport, 'softphone_bridge');
  const contracts = await (await request('/integrations/contracts')).json();
  assert.equal(contracts.softphoneBridge.implemented, true);
  assert.equal(contracts.dialer.implemented, false);
  assert.equal(contracts.dialer.status, 'reserved');
});

test('桥接来源、人工确认事件及模型初始化时间在重启后保留', t => {
  const directory = mkdtempSync(join(tmpdir(), 'geo-bridge-'));
  const path = join(directory, 'bridge.sqlite');
  let store = new Store(path);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const saved = store.importCustomers([customer])[0];
  assert.throws(() => store.createSession(saved, 'simulation', { transport: 'softphone_bridge', bridgeConfirmed: true }), /仅用于语音测试/);
  assert.throws(() => store.createSession(saved, 'seed', { transport: 'softphone_bridge' }), /人工确认/);
  const call = store.createSession(saved, 'seed', { transport: 'softphone_bridge', bridgeConfirmed: true });
  store.answered(call.id); // Existing Seed session.created handler; not a SIP event.
  store.status(call.id, 'completed');
  const initializedAt = store.session(call.id)!.answeredAt;
  assert.ok(initializedAt);
  store.close();
  store = new Store(path);
  assert.equal(store.session(call.id)?.transport, 'softphone_bridge');
  assert.equal(store.session(call.id)?.answeredAt, initializedAt);
  assert.equal(store.exportSession(call.id).events[0].payload.connectionConfirmation, 'manual');
});

test('原有无transport列的通话默认迁移为browser，不改原有快照', t => {
  const directory = mkdtempSync(join(tmpdir(), 'geo-bridge-legacy-'));
  const path = join(directory, 'legacy.sqlite');
  const old = new DatabaseSync(path);
  old.exec(`CREATE TABLE sessions(id TEXT PRIMARY KEY,customer TEXT NOT NULL,config TEXT NOT NULL,mode TEXT NOT NULL,status TEXT NOT NULL,prompt TEXT NOT NULL,prompt_hash TEXT NOT NULL,created_at TEXT NOT NULL,ended_at TEXT,error TEXT,analysis_status TEXT NOT NULL);`);
  old.prepare('INSERT INTO sessions VALUES(?,?,?,?,?,?,?,?,?,?,?)').run('legacy', JSON.stringify({ ...customer, id: 'legacy-customer' }), '{}', 'simulation', 'completed', '保留的原始限制词', 'original-hash', '2026-01-01T00:00:00.000Z', '2026-01-01T00:01:00.000Z', null, 'not_requested');
  old.close();
  const store = new Store(path);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  assert.equal(store.session('legacy')?.transport, 'browser');
  assert.equal(store.session('legacy')?.prompt, '保留的原始限制词');
  assert.equal(store.session('legacy')?.answeredAt, undefined);
});
