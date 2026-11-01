import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DeepSeekClient } from '../server/deepseek.js';
import { AnalysisWorker } from '../server/jobs.js';
import { Store } from '../server/store.js';

const customer = { camp: '河北测试门窗有限公司', name: '王先生', phone: '13812345678', address: '河北' };
const analysisOutput = {
  grade: 'E', summary: '未形成有效对话。', reason: '缺少客户回复。', evidence: [],
  wechat: { consent: false, phone: null, sameAsDialed: false, identifier: null },
};
async function until(predicate: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('后台任务未在预期时间内完成');
}
const settled = () => new Promise<void>(resolve => setImmediate(resolve));
async function provider(handler: (input: Record<string, any>, response: ServerResponse, index: number) => void) {
  const requests: Record<string, any>[] = [];
  const server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    const envelope = JSON.parse(body);
    const input = JSON.parse(envelope.messages[1].content);
    requests.push(input);
    handler(input, response, requests.length);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return {
    requests,
    client: new DeepSeekClient({ apiKey: 'test-only-key', baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}` }),
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}
function success(response: ServerResponse, output: unknown) {
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(output) } }] }));
}
function answeredCall(store: Store) {
  const call = store.createSession({ ...customer, id: 'call-customer', industry: '门窗' }, 'seed');
  store.answered(call.id);
  store.transcript(call.id, 'opening', 'ChatText', '您好，您方便了解一下吗？', true);
  store.status(call.id, 'completed');
  return call;
}

test('401 认证失败对通话与行业任务均停止重试，不保存假结果', async t => {
  const store = new Store(':memory:');
  const imported = store.importCustomers([customer])[0];
  const call = answeredCall(store);
  const http = await provider((_input, response) => { response.statusCode = 401; response.end('reflected-test-key'); });
  const worker = new AnalysisWorker(store, http.client);
  t.after(async () => { await worker.close(); store.close(); await http.close(); });
  await until(() => store.session(call.id)?.analysisStatus === 'failed' && store.customer(imported.id)?.industryStatus === 'failed');
  const analysis = store.db.prepare('SELECT attempts,next_attempt,result,error FROM analysis_jobs WHERE session_id=?').get(call.id)!;
  const industry = store.db.prepare('SELECT attempts,next_attempt,error FROM industry_jobs WHERE customer_id=?').get(imported.id)!;
  assert.equal(analysis.attempts, 1); assert.equal(industry.attempts, 1);
  assert.equal(analysis.next_attempt, null); assert.equal(industry.next_attempt, null);
  assert.equal(analysis.result, null); assert.equal(store.customer(imported.id)?.industry, '');
  assert.match(String(analysis.error), /身份验证失败/);
  assert.ok(!String(analysis.error).includes('reflected-test-key'));
  await settled(); worker.wake(); await settled();
  assert.equal(http.requests.length, 2, '认证失败的两项任务均未再次发起网络请求');
});

test('503 将通话任务设为稍后重试，重试成功才写入评估结果', async t => {
  const store = new Store(':memory:'); const call = answeredCall(store);
  const http = await provider((_input, response, index) => {
    if (index === 1) { response.statusCode = 503; response.end(); }
    else success(response, analysisOutput);
  });
  const worker = new AnalysisWorker(store, http.client);
  t.after(async () => { await worker.close(); store.close(); await http.close(); });
  await until(() => store.session(call.id)?.analysisStatus === 'pending');
  const first = store.db.prepare('SELECT status,attempts,next_attempt,result FROM analysis_jobs WHERE session_id=?').get(call.id)!;
  assert.equal(first.status, 'pending'); assert.equal(first.attempts, 1); assert.equal(first.result, null);
  assert.ok(Date.parse(String(first.next_attempt)) > Date.now());
  assert.equal(store.session(call.id)?.analysis, undefined);
  // Move only the retry deadline; do not bypass the worker's claim/completion path.
  store.db.prepare('UPDATE analysis_jobs SET next_attempt=? WHERE session_id=?').run('2000-01-01T00:00:00.000Z', call.id);
  await settled(); worker.wake();
  await until(() => store.session(call.id)?.analysisStatus === 'completed');
  assert.equal(http.requests.length, 2);
  const final = store.db.prepare('SELECT attempts,next_attempt,error FROM analysis_jobs WHERE session_id=?').get(call.id)!;
  assert.equal(final.attempts, 2); assert.equal(final.next_attempt, null); assert.equal(final.error, null);
  assert.ok(store.session(call.id)?.analysis);
});

test('第三次可重试错误耗尽重试次数，将行业任务标为失败', async t => {
  const store = new Store(':memory:'); const imported = store.importCustomers([customer])[0];
  store.db.prepare('UPDATE industry_jobs SET attempts=2 WHERE customer_id=?').run(imported.id);
  const http = await provider((_input, response) => { response.statusCode = 503; response.end(); });
  const worker = new AnalysisWorker(store, http.client);
  t.after(async () => { await worker.close(); store.close(); await http.close(); });
  await until(() => store.customer(imported.id)?.industryStatus === 'failed');
  const job = store.db.prepare('SELECT attempts,next_attempt FROM industry_jobs WHERE customer_id=?').get(imported.id)!;
  assert.equal(job.attempts, 3); assert.equal(job.next_attempt, null);
  await settled(); worker.wake(); await settled();
  assert.equal(http.requests.length, 1);
});

for (const kind of ['analysis', 'industry'] as const) {
  test(`关闭时中止 ${kind} 网络请求并恢复为待处理，重启数据库后继续完成`, async t => {
    const directory = mkdtempSync(join(tmpdir(), 'geo-worker-close-'));
    const path = join(directory, 'calls.sqlite');
    let store: Store | undefined = new Store(path);
    const target = kind === 'analysis' ? answeredCall(store) : store.importCustomers([customer])[0];
    const http = await provider((input, response, index) => {
      if (index === 1) return; // Keep the first response open until AbortSignal cancels it.
      success(response, kind === 'analysis' ? analysisOutput : {
        customers: input.customers.map((item: { id: string }) => ({ id: item.id, industry: '门窗' })),
      });
    });
    let worker = new AnalysisWorker(store, http.client);
    t.after(async () => { await worker.close(); store?.close(); await http.close(); rmSync(directory, { recursive: true, force: true }); });
    await until(() => http.requests.length === 1);
    assert.equal(kind === 'analysis' ? store!.session(target.id)?.analysisStatus : store!.customer(target.id)?.industryStatus, 'running');
    await worker.close();
    assert.equal(kind === 'analysis' ? store.session(target.id)?.analysisStatus : store.customer(target.id)?.industryStatus, 'pending');
    assert.equal(worker.status().running + worker.status().industryRunning, 0);
    store.close(); store = undefined;
    store = new Store(path);
    assert.equal(kind === 'analysis' ? store.session(target.id)?.analysisStatus : store.customer(target.id)?.industryStatus, 'pending');
    worker = new AnalysisWorker(store, http.client);
    await until(() => (kind === 'analysis' ? store!.session(target.id)?.analysisStatus : store!.customer(target.id)?.industryStatus) === 'completed');
    assert.equal(http.requests.length, 2);
    if (kind === 'industry') assert.equal(store.customer(target.id)?.industry, '门窗');
    else assert.ok(store.session(target.id)?.analysis);
  });
}
