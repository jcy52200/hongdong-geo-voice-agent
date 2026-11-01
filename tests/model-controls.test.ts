import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import WebSocket, { WebSocketServer } from 'ws';
import { createApp } from '../server/app.js';
import { buildPrompt, getOpening } from '../server/prompt.js';
import { createSeedSession } from '../server/seed.js';
import { DEFAULT_CONFIG } from '../server/store.js';
import { configSchema } from '../server/validation.js';
import { controlSchema } from '../shared/model-config.js';

const customer = { id: 'customer', camp: '演示门窗', name: '张&camp先生', phone: '13800000000', address: '石家庄' };
const richConfig = configSchema.parse({ ...DEFAULT_CONFIG, speed: -20, loudness: 35, opening: '您好，&name，这里是泓动引擎。', modelOptions: {
  asr: { enable_asr_twopass: true, boosting_table_id: 'boost-id', boosting_table_name: 'boost-name', regex_correct_table_id: 'regex-id', regex_correct_table_name: 'regex-name', context: { hotwords: [{ word: 'GEO' }], correct_words: { '宏动': '泓动' } } },
  tts: { explicit_dialect: 'beijing', max_length_to_filter_parenthesis: 25, aigc_metadata: { enable: true, content_producer: '泓动', produce_id: 'p1', content_propagator: '本地', propagate_id: 'p2' } },
  dialog: { location: { city: '石家庄', latitude: 38, longitude: 114 }, dialog_context: [{ role: 'user', text: '你好' }, { role: 'assistant', text: '您好' }], extra: { strict_audit: false, audit_response: '换个话题吧', enable_volc_websearch: true, volc_websearch_type: 'web_custom_api', enable_loudness_norm: false, enable_user_query_exit: true } },
  tools: [{ type: 'function', name: 'collect_contact', parameters: { type: 'object', properties: { phone: { type: 'string' } } } }],
} });

test('会话参数完整映射、范围/依赖校验、首句变量仅展开一次', () => {
  const prompt = buildPrompt(customer, richConfig);
  const event = createSeedSession({ id: 'session', configSnapshot: richConfig, prompt }, 'private-search-key');
  assert.equal(event.session.audio.output.loudness, 35);
  assert.equal(event.session.audio.output.speed, -20);
  assert.deepEqual(event.extension.asr.extra, richConfig.modelOptions.asr);
  assert.deepEqual(event.extension.tts.extra, richConfig.modelOptions.tts);
  assert.deepEqual(event.extension.dialog.location, richConfig.modelOptions.dialog?.location);
  assert.deepEqual(event.extension.dialog.dialog_context, richConfig.modelOptions.dialog?.dialog_context);
  assert.equal(event.extension.dialog.extra.enable_music, false);
  assert.equal(event.extension.dialog.extra.enable_loudness_norm, false);
  assert.equal(event.extension.dialog.extra.volc_websearch_api_key, 'private-search-key');
  assert.deepEqual(event.session.tools, richConfig.modelOptions.tools);
  assert.equal(getOpening(richConfig, customer), '您好，张&camp先生，这里是泓动引擎。');
  const update = createSeedSession({ id: 'cloud-id', configSnapshot: richConfig, prompt }, 'private-search-key', true);
  assert.equal(update.type, 'session.update');
  assert.equal(update.session.id, 'cloud-id');
  assert.equal(update.extension.dialog.dialog_context, undefined, '热更新不能重复注入初始历史');
  for (const patch of [
    { loudness: 101 }, { speed: -51 }, { opening: '' }, { modelOptions: { pitch: 5 } },
    { modelOptions: { asr: { context: { hotwords: [{ word: 'GEO' }] } } } },
    { modelOptions: { dialog: { location: { latitude: 100 } } } },
    { modelOptions: { dialog: { dialog_context: [{ role: 'assistant', text: '不能单条注入' }] } } },
  ]) assert.equal(configSchema.safeParse({ ...DEFAULT_CONFIG, ...patch }).success, false);
  assert.equal(controlSchema.safeParse({ action: 'context', event: { type: 'session.close' } }).success, false);
});

class Inbox {
  private messages: any[] = [];
  private wake = new Set<() => void>();
  constructor(readonly socket: WebSocket) {
    socket.on('error', () => {});
    socket.on('message', data => { this.messages.push(JSON.parse(String(data))); for (const notify of this.wake) notify(); });
  }
  send(event: object) { this.socket.send(JSON.stringify(event)); }
  take(predicate: string | ((event: any) => boolean)): Promise<any> {
    const match = typeof predicate === 'string' ? (event: any) => event.type === predicate : predicate;
    return new Promise((resolve, reject) => {
      const check = () => {
        const index = this.messages.findIndex(match);
        if (index >= 0) { clearTimeout(timer); this.wake.delete(check); resolve(this.messages.splice(index, 1)[0]); }
      };
      const timer = setTimeout(() => { this.wake.delete(check); reject(new Error('等待模拟事件超时')); }, 2500);
      this.wake.add(check); check();
    });
  }
}
async function fixture(t: TestContext) {
  const cloud = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(cloud, 'listening');
  const app = createApp({ databasePath: ':memory:', apiKey: 'private-voice-key', webSearchKey: 'private-search-key', seedUrl: `ws://127.0.0.1:${(cloud.address() as { port: number }).port}` });
  app.store.saveConfig(richConfig);
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const port = (app.server.address() as { port: number }).port;
  const request = (path: string, body?: unknown, method?: string) => fetch(`http://127.0.0.1:${port}/api${path}`, { method: method ?? (body === undefined ? 'GET' : 'POST'), headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const [imported] = app.store.importCustomers([customer]);
  const session = app.store.createSession(imported, 'seed');
  const accepted = new Promise<Inbox>(resolve => cloud.once('connection', socket => {
    const inbox = new Inbox(socket);
    socket.on('message', data => { if (JSON.parse(String(data)).type === 'session.close') inbox.send({ type: 'session.closed' }); });
    resolve(inbox);
  }));
  const browser = new Inbox(new WebSocket(`ws://127.0.0.1:${port}/ws/sessions/${session.id}`));
  const provider = await accepted;
  const created = await provider.take('session.create');
  provider.send({ type: 'session.created', session: { id: 'cloud-test-dialog' } });
  await browser.take((event: any) => event.type === 'state' && event.status === 'opening');
  const greeting = await provider.take('speech_text_buffer.commit');
  assert.equal(greeting.text, '您好，张&camp先生，这里是泓动引擎。');
  t.after(async () => {
    await app.close(); browser.socket.terminate();
    for (const socket of cloud.clients) socket.terminate();
    await new Promise<void>(resolve => cloud.close(() => resolve()));
  });
  const control = (body: unknown) => request(`/sessions/${session.id}/control`, body);
  const activate = async () => {
    provider.send({ type: 'response.output_audio.done' }); await browser.take('audio_done');
    browser.send({ type: 'playback_done' });
    await browser.take((event: any) => event.type === 'state' && event.status === 'active');
  };
  return { ...app, browser, provider, created, request, control, activate, session };
}

test('实时控制：首句门控、更新确认、播报干预、流式片段与双向静音', { timeout: 15000 }, async t => {
  const app = await fixture(t);
  assert.equal((await app.control({ action: 'replace', text: '不能打断首句' })).status, 409);
  await app.activate();
  const oldPrompt = app.store.session(app.session.id)!.prompt;
  app.store.saveConfig({ ...richConfig, loudness: 10, extraInstructions: '更新后的限制词测试' });
  const pending = app.control({ action: 'apply_config' });
  const update = await app.provider.take('session.update');
  assert.equal(update.session.id, 'cloud-test-dialog');
  assert.equal(update.session.audio.output.loudness, 10);
  assert.ok(update.session.instructions.includes('更新后的限制词测试'));
  assert.equal((await app.control({ action: 'commit_input' })).status, 409, '控制确认请求串行化');
  app.provider.send({ type: 'session.updated', event_id: 'provider-ack', session: { id: 'cloud-test-dialog', secretEcho: 'private-search-key' } });
  const response = await pending;
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.status, 'confirmed');
  assert.equal(JSON.stringify(result).includes('private-search-key'), false);
  assert.equal(app.store.session(app.session.id)!.prompt, oldPrompt, '原始快照不能被热更新覆盖');

  for (const [action, type] of [['greet', 'speech_text_buffer.commit'], ['replace', 'speech_text_buffer.replacement.commit']] as const) {
    const sent = await app.control({ action, text: '请看行业案例。' });
    assert.equal((await sent.json()).status, 'sent');
    assert.equal((await app.provider.take(type)).text, '请看行业案例。');
  }
  await app.control({ action: 'replacement_append', text: '第一段，' });
  await app.provider.take('speech_text_buffer.replacement.append');
  await app.control({ action: 'replacement_commit', text: '第二段。' });
  await app.provider.take('speech_text_buffer.replacement.commit');
  assert.ok(app.store.transcripts(app.session.id).some(item => item.text === '第一段，第二段。'));
  await app.control({ action: 'mute', muted: true });
  await app.provider.take('input_audio_mute.commit');
  assert.equal((await app.browser.take('input_state')).muted, true);
  await app.control({ action: 'mute', muted: false });
  await app.provider.take('input_audio_unmute.commit');
  assert.equal((await app.browser.take('input_state')).muted, false);
  const cancel = app.control({ action: 'cancel' });
  await app.provider.take('response.cancel'); app.provider.send({ type: 'response.canceled' });
  assert.equal((await (await cancel).json()).status, 'confirmed');
  const commit = app.control({ action: 'commit_input' });
  await app.provider.take('input_audio_buffer.commit'); app.provider.send({ type: 'input_audio_buffer.committed' });
  assert.equal((await (await commit).json()).status, 'confirmed');
  const exported = app.store.exportSession(app.session.id);
  assert.equal(JSON.stringify(exported).includes('private-search-key'), false);
  assert.ok(exported.events.some(event => event.type === 'local.control.result'));
});

test('上下文/函数结果回传；被拒绝的控制不挂断，结束会话中止待确认请求', { timeout: 15000 }, async t => {
  const app = await fixture(t); await app.activate();
  const retrieval = app.control({ action: 'context', event: { type: 'conversation.item.retrieve', items: [] } });
  await app.provider.take('conversation.item.retrieve');
  app.provider.send({ type: 'conversation.item.retrieved', items: [{ id: 'server-item', role: 'user' }] });
  assert.equal((await (await retrieval).json()).event.items[0].id, 'server-item');
  assert.equal((await app.control({ action: 'tool_result', callId: 'invented', text: '{}' })).status, 400);
  app.provider.send({ type: 'response.function_call_arguments.done', items: [{ call_id: 'call-real', name: 'collect_contact', arguments: '{"phone":"13800000000"}' }] });
  const frame = Buffer.alloc(4).toString('base64');
  app.provider.send({ type: 'response.output_audio.delta', delta: frame }); await app.browser.take('audio');
  const runtime = await (await app.request(`/sessions/${app.session.id}/runtime`)).json();
  assert.equal(runtime.pendingTools[0].call_id, 'call-real');
  const tool = app.control({ action: 'tool_result', callId: 'call-real', text: '{"stored":true}' });
  const packet = await app.provider.take('conversation.item.create');
  assert.equal(packet.items[0].call_id, 'call-real'); assert.equal(packet.items[0].role, 'tool');
  app.provider.send({ type: 'conversation.item.added', items: [] });
  assert.equal((await tool).status, 200);
  assert.equal(app.manager.runtime(app.session.id).pendingTools.length, 0);
  const bad = app.control({ action: 'apply_config' }); await app.provider.take('session.update');
  app.provider.send({ type: 'error', message: 'invalid option private-voice-key' });
  const rejected = await bad;
  assert.equal(rejected.status, 502); assert.equal(JSON.stringify(await rejected.json()).includes('private-voice-key'), false);
  assert.equal(app.store.session(app.session.id)!.status, 'active');
  const pending = app.control({ action: 'apply_config' }); await app.provider.take('session.update');
  app.manager.finish(app.session.id);
  assert.equal((await pending).status, 410);
  assert.equal(app.store.session(app.session.id)!.status, 'completed');
});
