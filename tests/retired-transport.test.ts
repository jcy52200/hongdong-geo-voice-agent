import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { createApp } from '../server/app.js';
import { Store } from '../server/store.js';

const customer = { camp: '测试门窗公司', name: '测试联系人', phone: '01012345678', address: '北京', industry: '门窗' };

test('停用的演示接入不能创建会话，浏览器接口与正式拨号预留不受影响', async t => {
  const runtime = createApp({ databasePath: ':memory:', apiKey: 'local-test-key' });
  t.after(() => runtime.close());
  runtime.server.listen(0, '127.0.0.1');
  await once(runtime.server, 'listening');
  const base = `http://127.0.0.1:${(runtime.server.address() as { port: number }).port}/api`;
  const request = (path: string, body?: unknown) => fetch(`${base}${path}`, body === undefined ? undefined : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const saved = runtime.store.importCustomers([customer])[0];
  for (const mode of ['simulation', 'seed']) {
    for (const transport of ['softphone_bridge', 'freeswitch']) {
      const response = await request('/sessions', { customerId: saved.id, mode, transport, bridgeConfirmed: true });
      assert.equal(response.status, 400);
    }
  }
  assert.equal(runtime.store.sessionCount(), 0, '废弃客户端请求不能静默回落为浏览器会话');
  for (const mode of ['simulation', 'seed']) {
    const response = await request('/sessions', { customerId: saved.id, mode });
    assert.equal(response.status, 201);
    assert.equal((await response.json()).transport, 'browser');
  }
  assert.equal((await request('/sessions', { customerId: saved.id, mode: 'seed', transport: 'browser' })).status, 201);
  const contracts = await (await request('/integrations/contracts')).json();
  assert.equal(contracts.softphoneBridge, undefined);
  assert.equal(contracts.dialer.implemented, false);
  assert.equal(contracts.dialer.status, 'reserved');
});

test('删除演示模块后，历史来源、对话、录音元数据和提示词仍可读取导出', t => {
  const directory = mkdtempSync(join(tmpdir(), 'geo-retired-'));
  const path = join(directory, 'history.sqlite');
  let store = new Store(path);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const saved = store.importCustomers([customer])[0];
  const call = store.createSession(saved, 'seed');
  // Reconstruct an old persisted row; the creation API no longer accepts this transport.
  store.db.prepare('UPDATE sessions SET transport=? WHERE id=?').run('softphone_bridge', call.id);
  store.transcript(call.id, 'old-asr', 'AsrText', '可以发个案例看看', true);
  store.answered(call.id);
  store.status(call.id, 'completed');
  store.saveRecording(call.id, { url: `/api/sessions/${call.id}/recording`, mimeType: 'audio/webm', bytes: 128, createdAt: '2026-11-02T00:00:00.000Z' });
  const before = store.session(call.id)!;
  store.close();
  store = new Store(path);
  assert.deepEqual(store.session(call.id), before);
  const exported = store.exportSession(call.id);
  assert.ok(exported.session);
  assert.equal(exported.session.transport, 'softphone_bridge');
  assert.equal(store.session(call.id)!.transcripts[0].text, '可以发个案例看看');
  assert.equal(store.createSession(saved, 'seed').transport, 'browser');
});

test('废弃页面不能通过旧待连接会话重新启动演示媒体', { timeout: 4000 }, async t => {
  const runtime = createApp({ databasePath: ':memory:', apiKey: 'local-test-key', seedUrl: 'ws://127.0.0.1:1' });
  t.after(() => runtime.close());
  runtime.server.listen(0, '127.0.0.1');
  await once(runtime.server, 'listening');
  const saved = runtime.store.importCustomers([customer])[0];
  const call = runtime.store.createSession(saved, 'seed');
  runtime.store.db.prepare('UPDATE sessions SET transport=? WHERE id=?').run('softphone_bridge', call.id);
  const socket = new WebSocket(`ws://127.0.0.1:${(runtime.server.address() as { port: number }).port}/ws/sessions/${call.id}`);
  t.after(() => socket.terminate());
  const messages: { type: string; message?: string }[] = [];
  socket.on('message', data => messages.push(JSON.parse(String(data))));
  const [code] = await once(socket, 'close');
  assert.equal(code, 1008);
  assert.match(messages.find(event => event.type === 'error')?.message ?? '', /接入已停用/);
  assert.equal(runtime.store.session(call.id)?.answeredAt, undefined);
  assert.equal(runtime.store.session(call.id)?.status, 'failed');
});

test('浏览器媒体不能接管或改写真实电话，线路录音也不能由浏览器上传', async t => {
  const runtime = createApp({ databasePath: ':memory:', apiKey: 'local-test-key' });
  t.after(() => runtime.close());
  await new Promise<void>(resolve => runtime.server.listen(0, '127.0.0.1', resolve));
  const address = `127.0.0.1:${(runtime.server.address() as { port: number }).port}`;
  const saved = runtime.store.importCustomers([customer])[0];
  const call = runtime.store.createTelephoneSession(saved);
  const socket = new WebSocket(`ws://${address}/ws/sessions/${call.id}`);
  const messages: { type: string; message?: string }[] = [];
  socket.on('message', data => messages.push(JSON.parse(String(data))));
  const [code] = await once(socket, 'close');
  assert.equal(code, 1008); assert.match(messages[0].message!, /真实电话/);
  assert.equal(runtime.store.session(call.id)!.status, 'created');
  assert.equal(runtime.manager.runtime(call.id).active, false);
  runtime.store.updateTelephone(call.id, { jobId: 'test-job' });
  runtime.store.telephoneAnswered(call.id, { jobId: 'test-job', customerChannelId: 'test-channel' });
  runtime.store.status(call.id, 'completed');
  const response = await fetch(`http://${address}/api/sessions/${call.id}/recording`, {
    method: 'POST', headers: { 'content-type': 'audio/webm' }, body: Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3]),
  });
  assert.equal(response.status, 409); assert.equal(runtime.store.session(call.id)!.recording, undefined);
});
