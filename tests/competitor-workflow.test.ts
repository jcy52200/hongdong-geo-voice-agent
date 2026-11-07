import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { createApp } from '../server/app.js';
import { AnalysisWorker } from '../server/jobs.js';
import { DeepSeekClient } from '../server/deepseek.js';
import { Store } from '../server/store.js';

const customer = { camp: '测试甲方门窗有限公司', name: '测试联系人', phone: '13800000000', address: '河北省石家庄市', crmTag: 'original-field' };
const company = '石家庄测试乙方门窗有限公司';
const quote = `${company}位于石家庄市，经营门窗生产业务。`;
const output = { competitors: [{ name: company, sourceIndex: 0, nameEvidence: quote, areaEvidence: quote, industryEvidence: quote }] };
async function until(predicate: () => boolean) {
  for (let index = 0; index < 250; index++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 15)); }
  assert.fail('等待同行后台任务超时');
}
async function provider(options: { firstSearchFails?: boolean; firstSearchHangs?: boolean } = {}) {
  const requests: { path: string; body: any }[] = []; let searches = 0;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()); const path = req.url!; requests.push({ path, body });
    if (path === '/v1/tools/search') {
      searches++;
      if (searches === 1 && options.firstSearchHangs) return;
      if (searches === 1 && options.firstSearchFails) { res.statusCode = 503; res.end('private provider body'); return; }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ results: [{ title: `${company}介绍`, url: 'https://peers.example.com/about', content: quote }] })); return;
    }
    const input = JSON.parse(body.messages[1].content);
    const result = input.customers ? { customers: input.customers.map((item: any) => ({ id: item.id, industry: '门窗' })) } : output;
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(result) } }] }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { requests, baseUrl, client: new DeepSeekClient({ apiKey: 'test-key', baseUrl }),
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

test('HTTP导入→行业→Search→Flash筛选→来源展示/JSON导出/逐通Seed限制词和查询去重使用同一持久结果', async t => {
  const http = await provider();
  const runtime = createApp({ databasePath: ':memory:', deepseekApiKey: 'test-key', deepseekBaseUrl: http.baseUrl });
  await new Promise<void>(resolve => runtime.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await runtime.close(); await http.close(); });
  const base = `http://127.0.0.1:${(runtime.server.address() as { port: number }).port}/api`;
  const post = (path: string, body: unknown = {}) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const imported = await (await post('/customers/import', { customers: [customer] })).json();
  const id = imported.customers[0].id;
  await until(() => runtime.store.customer(id)?.competitorStatus === 'completed');
  const profile = runtime.store.customer(id)!;
  assert.equal(profile.industry, '门窗'); assert.equal(profile.competitors?.[0].name, company);
  assert.deepEqual(http.requests.slice(0, 3).map(item => item.path), ['/chat/completions', '/v1/tools/search', '/chat/completions']);
  const exported = await (await fetch(base + '/customers/export')).json();
  assert.equal(exported.customers[0].crmTag, 'original-field'); assert.equal(exported.customers[0].competitors[0].sourceUrl, 'https://peers.example.com/about');
  assert.equal(exported.customers[0].competitorStatus, undefined); assert.equal(exported.customers[0].competitorError, undefined);
  const preview = await (await post('/config/preview', { config: runtime.store.config(), customer: profile })).json();
  assert.match(preview.session.instructions, new RegExp(company)); assert.match(preview.session.instructions, /"competitorPressureEnabled": true/);
  assert.match(preview.session.instructions, /竞对场景高于再次泛泛介绍产品/);
  const request = { ...runtime.store.config(), competitorPressureEnabled: false };
  const saved = await fetch(base + '/config', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request) });
  assert.equal((await saved.json()).competitorPressureEnabled, false);
  await post('/customers/import', { customers: [customer] });
  assert.equal(runtime.store.customer(id)?.competitorStatus, 'completed');
  const oldCall = runtime.store.createSession(runtime.store.customer(id)!, 'simulation');
  assert.match(oldCall.prompt, /"competitorPressureEnabled": false/);
  const revision = () => runtime.store.db.prepare('SELECT revision FROM competitor_jobs WHERE customer_id=?').get(id)!.revision;
  const original = revision();
  assert.equal((await post(`/customers/${id}/competitors/research`)).status, 202);
  const refresh = revision(); assert.notEqual(refresh, original);
  await post(`/customers/${id}/competitors/research`); assert.equal(revision(), refresh, 'pending/running重复点击不可重置在途查询');
  await until(() => runtime.store.customer(id)?.competitorStatus === 'completed');
  assert.equal(runtime.store.session(oldCall.id)!.prompt, oldCall.prompt);
  assert.equal((await post('/customers/missing/competitors/research')).status, 404);
  const bootstrap = await (await fetch(base + '/bootstrap')).json();
  assert.equal(bootstrap.analysis.competitorPending, 0); assert.equal(bootstrap.analysis.competitorRunning, 0);
  assert.ok(!JSON.stringify(bootstrap).includes('test-key'));
});

test('搜索503进入持久重试，成功后才写同行；没有密钥时任务保持pending', async t => {
  const http = await provider({ firstSearchFails: true }); const store = new Store(':memory:');
  const id = store.importCustomers([{ ...customer, industry: '门窗' }])[0].id;
  const idle = new AnalysisWorker(store); assert.equal(store.customer(id)?.competitorStatus, 'pending'); await idle.close();
  const worker = new AnalysisWorker(store, http.client);
  t.after(async () => { await worker.close(); store.close(); await http.close(); });
  await until(() => store.db.prepare('SELECT attempts FROM competitor_jobs WHERE customer_id=?').get(id)?.attempts === 1 && store.customer(id)?.competitorStatus === 'pending');
  assert.equal(store.customer(id)?.competitors, undefined); assert.ok(!store.customer(id)?.competitorError?.includes('private provider body'));
  store.db.prepare("UPDATE competitor_jobs SET next_attempt='2000-01-01T00:00:00Z' WHERE customer_id=?").run(id);
  await new Promise(resolve => setImmediate(resolve)); worker.wake();
  await until(() => store.customer(id)?.competitorStatus === 'completed');
  assert.equal(store.customer(id)?.competitors?.length, 1); assert.equal(store.db.prepare('SELECT attempts FROM competitor_jobs WHERE customer_id=?').get(id)!.attempts, 2);
});

test('关闭会中止在途搜索并将任务恢复待处理；下一worker可继续，旧结果不伪造成功', async t => {
  const http = await provider({ firstSearchHangs: true }); const store = new Store(':memory:');
  const id = store.importCustomers([{ ...customer, industry: '门窗' }])[0].id;
  let worker = new AnalysisWorker(store, http.client);
  t.after(async () => { await worker.close(); store.close(); await http.close(); });
  await until(() => http.requests.length === 1);
  assert.equal(store.customer(id)?.competitorStatus, 'running');
  await worker.close();
  assert.equal(store.customer(id)?.competitorStatus, 'pending'); assert.equal(store.customer(id)?.competitors, undefined);
  worker = new AnalysisWorker(store, http.client);
  await until(() => store.customer(id)?.competitorStatus === 'completed');
  assert.equal(http.requests.filter(item => item.path === '/v1/tools/search').length, 2);
});
