import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.js';
import { buildPrompt, DEFAULT_SYSTEM_PROMPT, getOpening } from '../server/prompt.js';

const customer = { id: 'c', camp: '河北示例门窗有限公司', name: '王先生', phone: '13912345678', address: '保定市', industry: '门窗' };
for (const version of ['v1', 'v2']) {
  test(`旧默认限制词 ${version} 自动升级并备份，保留声音、开场与旧会话快照`, t => {
    const dir = mkdtempSync(join(tmpdir(), 'geo-prompt-upgrade-')); const path = join(dir, 'db.sqlite');
    let store = new Store(path);
    t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
    const oldPrompt = readFileSync(new URL(`./fixtures/sales-agent-${version}.md`, import.meta.url), 'utf8').trim();
    const config = { ...store.config(), systemPrompt: oldPrompt, voice: 'custom_voice', speed: 3, loudness: -5, opening: '客户&name您好，这是保存的首句。', extraInstructions: '使用我的定制称呼。', quickReplyEnabled: false };
    store.saveConfig(config);
    const oldCall = store.createSession(customer, 'simulation');
    store.close(); store = new Store(path);
    const updated = store.config();
    assert.deepEqual(updated, { ...config, systemPrompt: DEFAULT_SYSTEM_PROMPT });
    assert.match(updated.systemPrompt!, /sales-prompt-version: 2026-11-02-faq/);
    assert.equal(getOpening(updated, customer), '客户王先生您好，这是保存的首句。');
    const backup = store.db.prepare('SELECT value FROM settings WHERE key=?').get('agent_backup_2026-11-02-faq') as { value: string };
    assert.deepEqual(JSON.parse(backup.value), config);
    const next = store.createSession(customer, 'seed');
    assert.match(next.prompt, /全年累计发布一万多条内容/);
    assert.match(next.prompt, /3000多个全维度的词汇/);
    assert.match(next.prompt, /讯灵、摘星/);
    assert.match(next.prompt, /首轮简单拒绝后的直接介绍规则/);
    assert.notEqual(next.promptHash, oldCall.promptHash);
    assert.equal(store.session(oldCall.id)?.prompt, oldCall.prompt);
    assert.equal(store.session(oldCall.id)?.configSnapshot.systemPrompt, oldPrompt);
    store.close(); store = new Store(path);
    assert.deepEqual(store.config(), updated);
    assert.equal((store.db.prepare('SELECT COUNT(*) AS n FROM settings WHERE key=?').get('agent_backup_2026-11-02-faq') as { n: number }).n, 1);
  });
}

test('用户改写的完整限制词不被自动替换；当前模板保留客户数据和首句边界', t => {
  const dir = mkdtempSync(join(tmpdir(), 'geo-prompt-custom-')); const path = join(dir, 'db.sqlite');
  let store = new Store(path);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const custom = { ...store.config(), systemPrompt: '用户自己编辑的完整销售话术，保留个性化内容并等待人工编辑。', extraInstructions: '我的补充要求。' };
  store.saveConfig(custom); store.close(); store = new Store(path);
  assert.deepEqual(store.config(), custom);
  assert.equal(store.db.prepare('SELECT value FROM settings WHERE key=?').get('agent_backup_2026-11-02-faq'), undefined);
  const prompt = buildPrompt(customer, { ...custom, systemPrompt: DEFAULT_SYSTEM_PROMPT });
  assert.match(prompt, /"&industry": "门窗"/);
  assert.match(prompt, /"&address": "保定市"/);
  assert.match(prompt, /第一句话的播放不可打断/);
  assert.match(prompt, /后续明确终止时的收束规则/);
});
