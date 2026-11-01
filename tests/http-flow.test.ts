import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import WebSocket from 'ws';
import { createApp } from '../server/app.js';

test('本地 HTTP/WS 完整流程：校验、客户导入、异号复核、记录导出与预留接口', async () => {
  const runtime = createApp({ databasePath: ':memory:' });
  runtime.server.listen(0, '127.0.0.1');
  await once(runtime.server, 'listening');
  const port = (runtime.server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;
  const request = (path: string, body?: unknown, headers?: Record<string, string>) => fetch(`${base}/api${path}`, {
    method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let socket: WebSocket | undefined;
  try {
    assert.equal((await request('/health', undefined, { Origin: 'https://evil.example' })).status, 403);
    const customer = { camp: '测试门窗', name: '测试联系人', phone: '010-12345678', address: '北京', industry: '门窗' };
    const invalid = await request('/customers/import', { customers: [customer, { ...customer, phone: 123 }] });
    assert.equal(invalid.status, 400);
    assert.equal((await (await request('/bootstrap')).json()).customers.length, 0, '整批校验失败不写入部分客户');
    const imported = await (await request('/customers/import', { customers: [customer] })).json();
    const customerId = imported.customers[0].id;
    const missingKey = await request('/sessions', { customerId, mode: 'seed' });
    assert.equal(missingKey.status, 409);
    const session = await (await request('/sessions', { customerId, mode: 'simulation' })).json();
    socket = new WebSocket(`ws://127.0.0.1:${port}/ws/sessions/${session.id}`);
    const events: any[] = [];
    const waiters = new Set<() => void>();
    socket.on('message', data => { events.push(JSON.parse(String(data))); for (const wake of waiters) wake(); });
    const waitFor = (predicate: (event: any) => boolean) => new Promise<any>((done, reject) => {
      const check = () => {
        const found = events.find(predicate);
        if (found) { clearTimeout(timer); waiters.delete(check); done(found); }
      };
      const timer = setTimeout(() => { waiters.delete(check); reject(new Error('等待事件超时')); }, 2000);
      waiters.add(check); check();
    });
    await waitFor(event => event.type === 'state' && event.status === 'active');
    const say = async (text: string, expected: string) => {
      socket!.send(JSON.stringify({ type: 'text', text }));
      await waitFor(event => event.type === 'transcript' && event.transcript.kind === 'ChatText' && event.transcript.text.includes(expected));
    };
    await say('了解过', '方便加个微信');
    await say('可以', '是我现在打的这个吗');
    await say('不是', '哪个手机号');
    await say('13912345678', '1 3 9 1 2 3 4 5 6 7 8');
    await say('对', '后续咱们微信联系');
    await waitFor(event => event.type === 'state' && event.status === 'completed');
    const record = await (await request(`/sessions/${session.id}`)).json();
    assert.equal(record.status, 'completed');
    assert.equal(record.mode, 'simulation');
    assert.equal(record.analysisStatus, 'not_requested', '文字预演不参与真实语音的意向评估');
    assert.equal(record.transcripts.length, 11);
    assert.ok(record.transcripts.every((t: any) => t.final));
    const exported = await request(`/sessions/${session.id}/export`);
    assert.match(exported.headers.get('content-disposition')!, /attachment/);
    const payload = await exported.json();
    assert.equal(payload.analysis.result, null);
    assert.equal(payload.session.promptHash.length, 64);
    assert.equal((await request(`/sessions/${session.id}/finish`, {})).status, 200, '结束幂等');
    const contracts = await (await request('/integrations/contracts')).json();
    assert.equal(contracts.dialer.implemented, false);
    assert.equal(contracts.analysis.implemented, true);
    assert.equal((await request('/not-a-route')).status, 404);
  } finally { socket?.terminate(); await runtime.close(); }
});
