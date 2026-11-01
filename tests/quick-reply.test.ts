import assert from 'node:assert/strict';
import { once } from 'node:events';
import test, { type TestContext } from 'node:test';
import WebSocket, { WebSocketServer } from 'ws';
import { createApp } from '../server/app.js';
import { createInitialQuickReplyState, consumeInitialQuickReply, isPureInitialRefusal } from '../server/quick-reply.js';
import { buildInitialIntroduction } from '../server/sales-script.js';

const ready = { enabled: true, muted: false, controlPending: false, replacementPending: false, toolPending: false };

test('首个拒绝快路径只识别纯拒绝/不了解，完整问题和明确停止交给常规流程', () => {
  for (const text of ['不需要，谢谢。', '我们暂时没需求', '嗯不了解', '没有听说过', '不太清楚', '我不感兴趣呀']) {
    assert.equal(isPureInitialRefusal(text), true, text);
  }
  for (const text of ['我不是不需要', '不需要，你们公司叫什么', '不了解，多少钱', '不需要但是先发微信吧', '不用了别再打了', '不需要，拜拜', '我正忙不需要', '不方便，我也不太了解', '我没有说不需要', '不太了解你们靠不靠谱', '不需要给我报个价格', '不了解你们产品包含哪些服务', '不需要了你讲吧', '不需要？', '我知道了', '']) {
    assert.equal(isPureInitialRefusal(text), false, text);
  }
});

test('快路径每通只消费第一个最终 ASR，重复、乱序和所有控制门控均不补触发', () => {
  const state = createInitialQuickReplyState();
  assert.equal(consumeInitialQuickReply(state, 'first', '您好', ready)?.trigger, false);
  assert.equal(consumeInitialQuickReply(state, 'second', '不需要', ready), undefined);
  assert.equal(consumeInitialQuickReply(state, 'first', '不需要', ready), undefined);
  const outOfOrder = createInitialQuickReplyState();
  outOfOrder.firstItemId = 'first';
  assert.equal(consumeInitialQuickReply(outOfOrder, 'second', '不需要', ready)?.reason, 'out_of_order_asr');
  assert.equal(consumeInitialQuickReply(outOfOrder, 'first', '不需要', ready), undefined);
  for (const [context, reason] of [
    [{ ...ready, enabled: false }, 'disabled'], [{ ...ready, muted: true }, 'input_muted'],
    [{ ...ready, controlPending: true }, 'operator_or_tool_control'], [{ ...ready, replacementPending: true }, 'operator_or_tool_control'],
    [{ ...ready, toolPending: true }, 'operator_or_tool_control'],
  ] as const) {
    assert.equal(consumeInitialQuickReply(createInitialQuickReplyState(), 'first', '不需要', context)?.reason, reason);
  }
  for (const flag of ['outputSeen', 'operatorControlled'] as const) {
    const blocked = createInitialQuickReplyState(); blocked[flag] = true;
    assert.equal(consumeInitialQuickReply(blocked, 'first', '不需要', ready)?.trigger, false);
  }
});

class Inbox {
  readonly history: any[] = [];
  private queue: any[] = [];
  private wake = new Set<() => void>();
  constructor(readonly socket: WebSocket) {
    socket.on('error', () => {});
    socket.on('message', data => {
      const event = JSON.parse(String(data)); this.history.push(event); this.queue.push(event);
      for (const check of this.wake) check();
    });
  }
  send(event: object) { this.socket.send(JSON.stringify(event)); }
  take(type: string | ((event: any) => boolean)): Promise<any> {
    const match = typeof type === 'string' ? (event: any) => event.type === type : type;
    return new Promise((resolve, reject) => {
      const check = () => {
        const index = this.queue.findIndex(match);
        if (index >= 0) { clearTimeout(timer); this.wake.delete(check); resolve(this.queue.splice(index, 1)[0]); }
      };
      const timer = setTimeout(() => { this.wake.delete(check); reject(new Error('等待快路径协议事件超时')); }, 2500);
      this.wake.add(check); check();
    });
  }
}

async function barrier(socket: WebSocket) {
  await new Promise<void>((resolve, reject) => {
    const done = () => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => { socket.off('pong', done); reject(new Error('快路径协议同步超时')); }, 2500);
    socket.once('pong', done); socket.ping();
  });
}

async function fixture(t: TestContext, enabled = true, quickReplyText?: string) {
  const cloud = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(cloud, 'listening');
  const app = createApp({ databasePath: ':memory:', apiKey: 'mock-key', seedUrl: `ws://127.0.0.1:${(cloud.address() as { port: number }).port}` });
  app.store.saveConfig({ ...app.store.config(), quickReplyEnabled: enabled, ...(quickReplyText ? { quickReplyText } : {}) });
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const port = (app.server.address() as { port: number }).port;
  const [customer] = app.store.importCustomers([{ camp: '测试门窗公司', name: '张先生', phone: '13800000000', address: '河北省石家庄市长安区某街99号', industry: '门窗' }]);
  const session = app.store.createSession(customer, 'seed');
  const accepted = new Promise<Inbox>(resolve => cloud.once('connection', socket => {
    const inbox = new Inbox(socket);
    socket.on('message', data => { if (JSON.parse(String(data)).type === 'session.close') inbox.send({ type: 'session.closed' }); });
    resolve(inbox);
  }));
  const browser = new Inbox(new WebSocket(`ws://127.0.0.1:${port}/ws/sessions/${session.id}`));
  const provider = await accepted;
  t.after(async () => {
    await app.close(); browser.socket.terminate();
    for (const socket of cloud.clients) socket.terminate();
    await new Promise<void>(resolve => cloud.close(() => resolve()));
  });
  await provider.take('session.create'); provider.send({ type: 'session.created', session: { id: 'mock-cloud' } });
  await browser.take((event: any) => event.type === 'state' && event.status === 'opening');
  await provider.take('input_audio_mute.commit'); await provider.take('speech_text_buffer.commit');
  const activate = async () => {
    provider.send({ type: 'response.output_audio.done' }); await browser.take('audio_done');
    browser.send({ type: 'playback_done' });
    await browser.take((event: any) => event.type === 'state' && event.status === 'active');
    await provider.take('input_audio_unmute.commit');
  };
  const final = (item: string, text: string) => provider.send({ type: 'conversation.item.input_audio_transcription.completed', item_id: item, transcript: text });
  const quickEvents = () => app.store.exportSession(session.id)!.events.filter((event: any) => event.type.startsWith('local.quick_reply.'));
  const control = (body: object) => fetch(`http://127.0.0.1:${port}/api/sessions/${session.id}/control`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { ...app, session, customer, provider, browser, activate, final, quickEvents, control };
}

// Official API: ASR completed means the model detected end-of-speech. Only
// speech_text_buffer.replacement.commit is needed; no fabricated VAD parameters.
// https://docs.volcengine.com/docs/doubao-voice/end-to-end-real-time-voice-full-duplex-version?lang=zh
test('首句真正播完才允许快回复；只发一次官方 replacement，不提前伪造 ChatText', { timeout: 15000 }, async t => {
  const app = await fixture(t);
  app.final('during-opening', '不需要'); await barrier(app.provider.socket);
  assert.equal(app.quickEvents().length, 0);
  assert.equal(app.provider.history.some(event => event.type.includes('replacement')), false);
  await app.activate();
  app.provider.send({ type: 'conversation.item.input_audio_transcription.started', item_id: 'first' });
  app.provider.send({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'first', delta: '不需要' });
  await barrier(app.provider.socket);
  assert.equal(app.provider.history.some(event => event.type.includes('replacement')), false, 'ASR 临时前缀不触发');
  app.final('first', '不需要，谢谢。');
  const request = await app.provider.take('speech_text_buffer.replacement.commit');
  assert.equal(request.text, buildInitialIntroduction(app.customer)); assert.ok(request.event_id);
  assert.equal(request.text.includes('某街99号'), false);
  assert.equal(app.store.transcripts(app.session.id).filter(item => item.kind === 'ChatText').length, 1, '请求不代表已经说完');
  app.final('first', '不需要，谢谢。'); app.final('second', '还是不需要'); await barrier(app.provider.socket);
  assert.equal(app.provider.history.filter(event => event.type.includes('replacement')).length, 1);
  assert.equal(app.provider.history.some(event => ['response.cancel', 'input_audio_buffer.commit'].includes(event.type)), false);
  assert.equal(app.quickEvents().filter(event => event.type === 'local.quick_reply.requested').length, 1);
  app.provider.send({ type: 'response.output_text.done', response_id: 'replacement-reply', text: '那这样老板，我二十秒给您简单介绍下。' });
  await app.browser.take((event: any) => event.type === 'transcript' && event.transcript.kind === 'ChatText' && event.transcript.text.startsWith('那这样老板'));
  assert.equal(app.store.transcripts(app.session.id).filter(item => item.kind === 'ChatText').length, 2);
});

test('已开始的模型输出、人工无 ack 播报和关闭配置均不与快路径争抢', { timeout: 15000 }, async t => {
  const output = await fixture(t); await output.activate();
  output.provider.send({ type: 'response.output_audio.started' }); output.final('first', '不了解');
  await barrier(output.provider.socket);
  assert.equal(output.quickEvents()[0].payload.reason, 'model_output_started');
  assert.equal(output.provider.history.some(event => event.type.includes('replacement')), false);

  const manual = await fixture(t); await manual.activate();
  assert.equal((await manual.control({ action: 'greet', text: '人工测试播报。' })).status, 200);
  await manual.provider.take('speech_text_buffer.commit'); manual.final('first', '不需要');
  await barrier(manual.provider.socket);
  assert.equal(manual.quickEvents()[0].payload.reason, 'operator_or_tool_control');
  assert.equal(manual.provider.history.some(event => event.type.includes('replacement')), false);

  const disabled = await fixture(t, false); await disabled.activate(); disabled.final('first', '不需要');
  await barrier(disabled.provider.socket);
  assert.equal(disabled.quickEvents()[0].payload.reason, 'disabled');
  assert.equal(disabled.provider.history.some(event => event.type.includes('replacement')), false);
});

test('首轮问题、乱序 ASR、静音以及不完整人工 replacement 不会在后续误触发', { timeout: 15000 }, async t => {
  const question = await fixture(t); await question.activate();
  question.final('first', '我不了解你们怎么收费'); question.final('second', '不需要'); await barrier(question.provider.socket);
  assert.equal(question.provider.history.some(event => event.type.includes('replacement')), false);
  assert.equal(question.quickEvents().length, 1);
  const order = await fixture(t); await order.activate();
  order.provider.send({ type: 'conversation.item.input_audio_transcription.started', item_id: 'first' });
  order.final('second', '不需要'); order.final('first', '不需要'); await barrier(order.provider.socket);
  assert.equal(order.quickEvents()[0].payload.reason, 'out_of_order_asr');
  assert.equal(order.provider.history.some(event => event.type.includes('replacement')), false);
  const muted = await fixture(t); await muted.activate();
  muted.browser.send({ type: 'mute', muted: true }); await muted.provider.take('input_audio_mute.commit');
  muted.final('first', '不需要'); await barrier(muted.provider.socket);
  assert.equal(muted.quickEvents()[0].payload.reason, 'input_muted');
  const partial = await fixture(t); await partial.activate();
  assert.equal((await partial.control({ action: 'replacement_append', text: '人工待合成片段' })).status, 200);
  await partial.provider.take('speech_text_buffer.replacement.append'); partial.final('first', '不需要');
  await barrier(partial.provider.socket);
  assert.equal(partial.quickEvents()[0].payload.reason, 'operator_or_tool_control');
  assert.equal(partial.provider.history.filter(event => event.type === 'speech_text_buffer.replacement.commit').length, 0);
});

test('真实快回复使用本通配置的话术快照，空的首轮最终 ASR 不会延后误触发', { timeout: 15000 }, async t => {
  const template = '老板，我发您&industry在&address的案例，您看可以吗？';
  const custom = await fixture(t, true, template); await custom.activate();
  custom.final('first', '暂时不需要');
  const event = await custom.provider.take('speech_text_buffer.replacement.commit');
  assert.equal(event.text, buildInitialIntroduction(custom.customer, template));
  assert.equal(event.text.includes('&industry'), false);
  assert.equal(event.text.includes('门窗'), true);
  assert.equal(event.text.includes('某街99号'), false);
  const empty = await fixture(t); await empty.activate();
  empty.final('first', ''); empty.final('second', '不需要'); await barrier(empty.provider.socket);
  assert.equal(empty.quickEvents().length, 1);
  assert.equal(empty.quickEvents()[0].payload.reason, 'not_pure_initial_refusal');
  assert.equal(empty.provider.history.some(event => event.type.includes('replacement')), false);
});

test('官方 audio-only replacement 按同一响应补记临时/完整对话，迟到实际文字优先且不重行', { timeout: 15000 }, async t => {
  const app = await fixture(t); await app.activate(); app.final('first', '不需要');
  const request = await app.provider.take('speech_text_buffer.replacement.commit');
  app.provider.send({ type: 'response.output_audio.started', tts_type: 'chat_tts_text', question_id: 'q-quick', response_id: '' });
  await barrier(app.provider.socket);
  assert.equal(app.store.transcripts(app.session.id).filter(row => row.kind === 'ChatText').length, 1, 'started 尚不是实际音频');
  app.provider.send({ type: 'response.output_audio.delta', question_id: 'q-quick', response_id: 'r-quick', delta: Buffer.alloc(4).toString('base64') });
  await app.browser.take((event: any) => event.type === 'transcript' && event.transcript.kind === 'ChatText' && !event.transcript.final);
  let row = app.store.transcripts(app.session.id).find(row => row.text === request.text)!;
  assert.equal(row.final, false); const rowId = row.id;
  app.provider.send({ type: 'response.output_audio.done', question_id: 'q-other', response_id: 'r-quick' });
  app.provider.send({ type: 'response.output_audio.done', question_id: 'q-quick', response_id: 'r-other' });
  await barrier(app.provider.socket);
  assert.equal(app.store.transcripts(app.session.id).find(row => row.id === rowId)!.final, false, '不匹配的 done 不确认完整话术');
  app.provider.send({ type: 'response.output_audio.done', question_id: 'q-quick', response_id: 'r-quick' });
  await app.browser.take((event: any) => event.type === 'transcript' && event.transcript.id === rowId && event.transcript.final);
  assert.equal(app.store.transcripts(app.session.id).filter(row => row.kind === 'ChatText' && row.final).length, 2);
  app.provider.send({ type: 'response.output_text.delta', response_id: 'r-quick', delta: '' });
  app.provider.send({ type: 'response.output_text.delta', response_id: 'r-quick', delta: '实际生成的' });
  await app.browser.take((event: any) => event.type === 'transcript' && event.transcript.id === rowId && event.transcript.text === '实际生成的');
  app.provider.send({ type: 'response.output_text.done', response_id: 'r-quick', text: '实际生成的文本，以服务端为准。' });
  await app.browser.take((event: any) => event.type === 'transcript' && event.transcript.id === rowId && event.transcript.final && event.transcript.text === '实际生成的文本，以服务端为准。');
  app.provider.send({ type: 'response.output_audio.done', question_id: 'q-quick', response_id: 'r-quick' });
  app.provider.send({ type: 'response.output_text.done', response_id: 'r-quick', text: '重复终态不能覆盖真实终态' });
  await barrier(app.provider.socket);
  row = app.store.transcripts(app.session.id).find(row => row.id === rowId)!;
  assert.equal(row.text, '实际生成的文本，以服务端为准。');
  assert.equal(app.store.transcripts(app.session.id).filter(row => row.kind === 'ChatText').length, 2);
});

test('替代播报被客户打断保留未定稿，标识不足的音频不会猜测完整对话', { timeout: 15000 }, async t => {
  const interrupted = await fixture(t); await interrupted.activate(); interrupted.final('first', '不需要');
  const request = await interrupted.provider.take('speech_text_buffer.replacement.commit');
  interrupted.provider.send({ type: 'response.output_audio.started', tts_type: 'chat_tts_text', question_id: 'q-quick' });
  interrupted.provider.send({ type: 'response.output_audio.delta', question_id: 'q-quick', response_id: 'r-quick', delta: Buffer.alloc(4).toString('base64') });
  await interrupted.browser.take((event: any) => event.type === 'transcript' && event.transcript.text === request.text);
  interrupted.provider.send({ type: 'conversation.item.input_audio_transcription.started', item_id: 'next' });
  interrupted.provider.send({ type: 'response.output_audio.done', question_id: 'q-quick', response_id: 'r-quick' });
  await barrier(interrupted.provider.socket);
  const row = interrupted.store.transcripts(interrupted.session.id).find(row => row.text === request.text)!;
  assert.equal(row.final, false);
  assert.equal(interrupted.store.transcripts(interrupted.session.id).filter(row => row.kind === 'ChatText' && row.final).length, 1);
  assert.equal(interrupted.quickEvents().some(event => event.type === 'local.quick_reply.interrupted'), true);

  const unknown = await fixture(t); await unknown.activate(); unknown.final('first', '不需要');
  await unknown.provider.take('speech_text_buffer.replacement.commit');
  unknown.provider.send({ type: 'response.output_audio.started', tts_type: 'chat_tts_text', question_id: 'q-quick' });
  unknown.provider.send({ type: 'response.output_audio.delta', question_id: 'q-quick', response_id: '', delta: Buffer.alloc(4).toString('base64') });
  unknown.provider.send({ type: 'response.output_audio.done', question_id: 'q-quick', response_id: '' });
  await barrier(unknown.provider.socket);
  assert.equal(unknown.store.transcripts(unknown.session.id).filter(row => row.kind === 'ChatText').length, 1);
});

test('先到的实际 output_text 与后到音频共用一行，不被备用脚本覆盖', { timeout: 15000 }, async t => {
  const app = await fixture(t); await app.activate(); app.final('first', '不需要');
  await app.provider.take('speech_text_buffer.replacement.commit');
  app.provider.send({ type: 'response.output_text.done', response_id: 'r-quick', text: '服务端已经返回的回复。' });
  app.provider.send({ type: 'response.output_audio.started', tts_type: 'chat_tts_text', question_id: 'q-quick' });
  app.provider.send({ type: 'response.output_audio.delta', question_id: 'q-quick', response_id: 'r-quick', delta: Buffer.alloc(4).toString('base64') });
  app.provider.send({ type: 'response.output_audio.done', question_id: 'q-quick', response_id: 'r-quick' });
  await barrier(app.provider.socket);
  const rows = app.store.transcripts(app.session.id).filter(row => row.kind === 'ChatText');
  assert.equal(rows.length, 2); assert.equal(rows.at(-1)?.text, '服务端已经返回的回复。');
  assert.equal(rows.at(-1)?.final, true);
});
