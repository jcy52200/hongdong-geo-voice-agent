import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../server/app.js';
import { DEFAULT_SYSTEM_PROMPT, OPENING } from '../server/prompt.js';

test('完整限制词：兼容旧设置、草稿预览不保存、持久化且每通使用独立快照', async () => {
  const runtime = createApp({ databasePath: ':memory:' });
  runtime.server.listen(0, '127.0.0.1');
  await once(runtime.server, 'listening');
  const base = `http://127.0.0.1:${(runtime.server.address() as { port: number }).port}/api`;
  const request = (path: string, body?: unknown, method?: string) => fetch(`${base}${path}`, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  try {
    // Existing installations have no systemPrompt field. Preserve their other settings.
    const legacy = { agentName: '原有称呼', voice: 'zh_male_m191_uranus_bigtts', speed: -5, extraInstructions: '原有补充要求' };
    runtime.store.saveConfig(legacy);
    const boot = await (await request('/bootstrap')).json();
    assert.equal(boot.config.agentName, legacy.agentName);
    assert.equal(boot.config.extraInstructions, legacy.extraInstructions);
    assert.equal(boot.config.systemPrompt, DEFAULT_SYSTEM_PROMPT);
    assert.equal((await (await request('/prompt/default')).json()).systemPrompt, DEFAULT_SYSTEM_PROMPT);

    const imported = await (await request('/customers/import', { customers: [{ camp: '试打门窗公司', name: '测试客户', phone: '13800000000', address: '石家庄' }] })).json();
    const customer = imported.customers[0];
    const original = await (await request('/sessions', { customerId: customer.id, mode: 'simulation' })).json();
    const draft = { ...boot.config, systemPrompt: '自定义调试规则：每次只回答一句话，然后等待客户回应，不主动报价。', quickReplyEnabled: false, quickReplyText: '那这样老板，咱们&industry的案例我发您微信。' };
    const preview = await (await request('/prompt/preview', { customer, config: draft })).json();
    assert.ok(preview.prompt.startsWith(draft.systemPrompt));
    assert.ok(preview.prompt.includes(customer.id));
    assert.ok(preview.prompt.includes(customer.camp));
    assert.equal(preview.opening, OPENING);
    assert.equal(runtime.store.config().systemPrompt, DEFAULT_SYSTEM_PROMPT, '预览草稿不能隐式保存');

    const saved = await request('/config', draft, 'PUT');
    assert.equal(saved.status, 200);
    assert.equal(runtime.store.config().systemPrompt, draft.systemPrompt);
    const next = await (await request('/sessions', { customerId: customer.id, mode: 'simulation' })).json();
    assert.ok(next.prompt.startsWith(draft.systemPrompt));
    assert.equal(next.configSnapshot.systemPrompt, draft.systemPrompt);
    assert.equal(next.configSnapshot.quickReplyEnabled, false);
    assert.equal(next.configSnapshot.quickReplyText, draft.quickReplyText);
    assert.notEqual(next.promptHash, original.promptHash);
    assert.equal(runtime.store.session(original.id)!.prompt, original.prompt);

    const invalid = await request('/config', { ...draft, systemPrompt: '' }, 'PUT');
    assert.equal(invalid.status, 400);
    assert.equal(runtime.store.config().systemPrompt, draft.systemPrompt);
    assert.equal((await request('/prompt/preview', { customer, config: { ...draft, speed: 1000 } })).status, 400);
    assert.equal((await request('/config', { ...draft, quickReplyText: '' }, 'PUT')).status, 400);
    assert.equal((await request('/config', { ...draft, quickReplyEnabled: 'yes' }, 'PUT')).status, 400);
    // Reading defaults for the restore button must not mutate the live config either.
    assert.equal((await (await request('/prompt/default')).json()).opening, OPENING);
    assert.equal(runtime.store.config().systemPrompt, draft.systemPrompt);
  } finally { await runtime.close(); }
});
