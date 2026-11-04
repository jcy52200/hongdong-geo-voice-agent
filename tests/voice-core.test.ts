import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test, { type TestContext } from 'node:test';
import WebSocket, { WebSocketServer } from 'ws';
import type { MediaInput, MediaPort, PlaybackSegment } from '../server/media/port.js';
import { ControlError, VoiceSessionManager } from '../server/voice/session.js';
import { OPENING } from '../server/prompt.js';
import { Store } from '../server/store.js';
import type { ServerEvent, Session } from '../shared/session.js';

type Message = { type: string; [key: string]: any };
type SessionEvent = Exclude<ServerEvent, { type: 'audio' | 'audio_done' | 'interrupted' }>;
type Match = string | ((message: Message) => boolean);

class Events {
  readonly history: Message[] = [];
  private queue: Message[] = [];
  private waiters: { match: (message: Message) => boolean; resolve: (message: Message) => void }[] = [];

  push(message: Message) {
    this.history.push(message);
    const index = this.waiters.findIndex(waiter => waiter.match(message));
    if (index >= 0) this.waiters.splice(index, 1)[0].resolve(message);
    else this.queue.push(message);
  }

  take(match: Match): Promise<Message> {
    const predicate = typeof match === 'string' ? (message: Message) => message.type === match : match;
    const index = this.queue.findIndex(predicate);
    if (index >= 0) return Promise.resolve(this.queue.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = { match: predicate, resolve: (message: Message) => { clearTimeout(timer); resolve(message); } };
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter(candidate => candidate !== waiter);
        reject(new Error(`等待 ${typeof match === 'string' ? match : '会话事件'} 超时；已收到 ${this.history.map(message => message.type).join(', ')}`));
      }, 2500);
      this.waiters.push(waiter);
    });
  }
}

class Provider extends Events {
  constructor(readonly socket: WebSocket) {
    super();
    socket.on('error', () => {});
    socket.on('message', (data, binary) => {
      assert.equal(binary, false, 'SeedDuplex 仍使用 JSON 文本帧');
      this.push(JSON.parse(String(data)));
    });
  }
  send(event: Message) { this.socket.send(JSON.stringify(event)); }
}

/** A service-side PCM endpoint, with no browser WebSocket or JSON dependency. */
class FakeMedia implements MediaPort {
  readonly capabilities = { canConfirmPlaybackDrain: true };
  readonly audio: { pcm: Buffer; segment: PlaybackSegment }[] = [];
  readonly completions: PlaybackSegment[] = [];
  readonly listeners = new Set<(event: MediaInput) => void>();
  clears = 0;
  closes = 0;
  acceptAudio = true;
  acceptComplete = true;
  onEvent(handler: (event: MediaInput) => void) { this.listeners.add(handler); return () => { this.listeners.delete(handler); }; }
  writeAudio(pcm: Buffer, segment: PlaybackSegment) {
    if (!this.acceptAudio) return false;
    this.audio.push({ pcm: Buffer.from(pcm), segment: { ...segment } }); return true;
  }
  completePlayback(segment: PlaybackSegment) {
    if (!this.acceptComplete) return false;
    this.completions.push({ ...segment }); return true;
  }
  clearPlayback() { this.clears++; return true; }
  close() { this.closes++; }
  emit(event: MediaInput) { for (const listener of [...this.listeners]) listener(event); }
}

// Ping is ordered after preceding frames. Negative assertions use this barrier
// instead of sleeps, and all provider traffic stays on the loopback mock.
async function barrier(socket: WebSocket) {
  await new Promise<void>((resolve, reject) => {
    const done = () => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => { socket.off('pong', done); reject(new Error('模型协议同步超时')); }, 2500);
    socket.once('pong', done); socket.ping();
  });
}

interface Call {
  session: Session;
  media: FakeMedia;
  provider: Provider;
  observer: Events;
  unsubscribe: () => void;
}

async function fixture(t: TestContext) {
  const cloud = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(cloud, 'listening');
  const seedUrl = `ws://127.0.0.1:${(cloud.address() as AddressInfo).port}`;
  const store = new Store(':memory:');
  const manager = new VoiceSessionManager(store, 'local-core-test-key', seedUrl);
  const customers = store.importCustomers([
    { camp: '甲方石家庄门窗公司', name: '张甲', phone: '13800000001', address: '石家庄', industry: '门窗' },
    { camp: '乙方保定机械公司', name: '李乙', phone: '13900000002', address: '保定', industry: '机械' },
  ]).sort((a, b) => a.phone.localeCompare(b.phone));
  t.after(async () => {
    await manager.shutdown();
    for (const socket of cloud.clients) socket.terminate();
    await new Promise<void>((resolve, reject) => cloud.close(error => error ? reject(error) : resolve()));
    store.close();
  });

  async function connect(customerIndex = 0): Promise<Call> {
    const session = store.createSession(customers[customerIndex], 'seed');
    const observer = new Events();
    const unsubscribe = manager.observe(session.id, (event: SessionEvent) => observer.push(event));
    const accepted = new Promise<Provider>(resolve => cloud.once('connection', socket => {
      const provider = new Provider(socket);
      socket.on('message', data => {
        if (JSON.parse(String(data)).type === 'session.close') {
          socket.send(JSON.stringify({ type: 'session.closed' }), () => socket.close());
        }
      });
      resolve(provider);
    }));
    const media = new FakeMedia();
    manager.attachMedia(session.id, media);
    const provider = await accepted;
    return { session, media, provider, observer, unsubscribe };
  }

  async function beginOpening(call: Call) {
    const created = await call.provider.take('session.create');
    assert.equal(created.session.instructions, call.session.prompt);
    call.provider.send({ type: 'session.created', session: { id: `cloud-${call.session.id}` } });
    await call.observer.take(event => event.type === 'state' && event.status === 'opening');
    await call.provider.take('input_audio_mute.commit');
    assert.equal((await call.provider.take('speech_text_buffer.commit')).text, OPENING);
  }

  async function generatedOpening(call: Call, responseId = 'opening-response') {
    call.provider.send({ type: 'response.output_audio.started', response_id: responseId });
    call.provider.send({ type: 'response.output_audio.delta', response_id: responseId, delta: Buffer.alloc(240, 2).toString('base64') });
    call.provider.send({ type: 'response.output_audio.done', response_id: responseId });
    await barrier(call.provider.socket);
    assert.equal(call.media.completions.length, 1);
    const segment = call.media.completions[0];
    assert.equal(segment.opening, true);
    return segment;
  }

  async function activate(call: Call) {
    await beginOpening(call);
    const segment = await generatedOpening(call);
    call.media.emit({ type: 'playback_drained', playbackId: segment.id });
    await call.observer.take(event => event.type === 'state' && event.status === 'active');
    await call.provider.take('input_audio_unmute.commit');
  }
  return { store, manager, customers, cloud, seedUrl, connect, beginOpening, generatedOpening, activate };
}

test('公共语音核心直接接入 PCM 端口，首句只由匹配响应的生成完成和排空解锁', { timeout: 10000 }, async t => {
  const app = await fixture(t);
  const call = await app.connect();
  assert.equal(call.observer.history[0]?.type, 'session');
  await app.beginOpening(call);
  assert.ok(app.store.session(call.session.id)?.modelReadyAt);
  const input = Buffer.alloc(640, 1);
  call.media.emit({ type: 'audio', audio: input });
  call.media.emit({ type: 'playback_drained', playbackId: 'forged-playback' });
  call.provider.send({ type: 'response.output_audio.started', response_id: 'fixed-opening' });
  const output = Buffer.alloc(240, 3);
  call.provider.send({ type: 'response.output_audio.delta', response_id: 'fixed-opening', delta: output.toString('base64') });
  call.provider.send({ type: 'conversation.item.input_audio_transcription.started', item_id: 'noise-in-opening' });
  call.provider.send({ type: 'response.canceled' });
  call.provider.send({ type: 'response.output_text.done', response_id: 'ignored-text', text: '不能替换固定首句' });
  await barrier(call.provider.socket);
  assert.equal(call.media.audio.length, 1);
  assert.deepEqual(call.media.audio[0].pcm, output);
  const segment = call.media.audio[0].segment;
  assert.equal(segment.opening, true);
  assert.equal(segment.responseId, 'fixed-opening');
  assert.ok(segment.id);
  call.media.emit({ type: 'playback_drained', playbackId: segment.id }); // Even the right ID is premature before generation ends.
  call.provider.send({ type: 'response.output_audio.done', response_id: 'unrelated-response' });
  call.provider.send({ type: 'response.output_audio.done' }); // A missing ID cannot finish an already correlated greeting.
  await barrier(call.provider.socket);
  assert.equal(app.store.session(call.session.id)?.status, 'opening');
  assert.equal(call.media.completions.length, 0, 'an unrelated model response cannot finish the fixed greeting');
  assert.equal(call.media.clears, 0, 'opening must ignore interruption and cancellation');
  assert.equal(call.provider.history.some(event => ['input_audio_buffer.append', 'input_audio_unmute.commit', 'response.cancel'].includes(event.type)), false);
  assert.deepEqual(app.store.transcripts(call.session.id).map(row => row.text), [OPENING]);

  call.provider.send({ type: 'response.output_audio.done', response_id: 'fixed-opening' });
  await barrier(call.provider.socket);
  assert.deepEqual(call.media.completions, [segment]);
  assert.equal(app.store.session(call.session.id)?.status, 'opening');
  call.media.emit({ type: 'playback_drained', playbackId: 'stale-playback' });
  assert.equal(app.store.session(call.session.id)?.status, 'opening');
  call.media.emit({ type: 'playback_drained', playbackId: segment.id });
  await call.provider.take('input_audio_unmute.commit');
  assert.equal(app.store.session(call.session.id)?.status, 'active');
  call.media.emit({ type: 'audio', audio: input });
  assert.equal((await call.provider.take('input_audio_buffer.append')).audio, input.toString('base64'));
  assert.equal(call.observer.history.some(event => ['audio', 'audio_done', 'interrupted'].includes(event.type)), false, 'observers receive domain events, not playable media');
});

test('观察者退出和异常均不结束媒体会话，状态订阅可独立重连', { timeout: 10000 }, async t => {
  const app = await fixture(t);
  const call = await app.connect();
  let badObserverCalls = 0;
  assert.doesNotThrow(() => app.manager.observe(call.session.id, () => { badObserverCalls++; throw new Error('observer only'); }));
  await app.activate(call);
  assert.equal(badObserverCalls, 1, 'a failing listener is removed without changing the call');
  call.unsubscribe(); call.unsubscribe();
  const detachedCount = call.observer.history.length;
  call.provider.send({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'without-page', transcript: '页面关闭以后还在通话' });
  await barrier(call.provider.socket);
  assert.equal(call.observer.history.length, detachedCount);
  assert.equal(app.store.session(call.session.id)?.status, 'active');
  assert.ok(app.store.transcripts(call.session.id).some(row => row.text === '页面关闭以后还在通话'));
  assert.equal(call.media.closes, 0);
  const reconnect = new Events();
  const stop = app.manager.observe(call.session.id, event => reconnect.push(event));
  assert.equal(reconnect.history[0]?.type, 'session');
  assert.equal(reconnect.history[0]?.session.status, 'active');
  assert.ok(reconnect.history[0]?.session.transcripts.some((row: { text: string }) => row.text === '页面关闭以后还在通话'));
  call.unsubscribe(); // A stale disposer must not remove a newly registered observer set.
  call.provider.send({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'after-observer-reconnect', transcript: '重连的页面继续收到转写' });
  await reconnect.take(event => event.type === 'transcript' && event.transcript.text === '重连的页面继续收到转写');
  call.media.emit({ type: 'audio', audio: Buffer.alloc(640, 4) });
  await call.provider.take('input_audio_buffer.append');
  stop(); app.manager.finish(call.session.id);
  await call.provider.take('session.close');
  assert.equal(call.media.closes, 1);
});

test('媒体断开幂等收尾、保留转写与单次评估，并中止待确认控制', { timeout: 10000 }, async t => {
  const app = await fixture(t);
  const call = await app.connect();
  await app.activate(call);
  call.provider.send({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'before-close', transcript: '先发案例给我' });
  await call.observer.take(event => event.type === 'transcript' && event.transcript.kind === 'AsrText');
  const pending = app.manager.control(call.session.id, { action: 'apply_config' });
  const rejected = assert.rejects(pending, error => typeof error === 'object' && error !== null && 'status' in error && error.status === 410);
  await call.provider.take('session.update');
  call.media.emit({ type: 'close' });
  call.media.emit({ type: 'error', message: 'duplicate close' });
  app.manager.finish(call.session.id);
  app.manager.fail(call.session.id, 'late failure');
  await rejected;
  await call.provider.take('session.close');
  const record = app.store.session(call.session.id)!;
  assert.equal(record.status, 'failed');
  assert.ok(record.endedAt);
  assert.ok(record.transcripts.some(row => row.text === '先发案例给我'));
  assert.equal(record.analysisStatus, 'pending');
  assert.equal(app.manager.runtime(call.session.id).active, false);
  assert.equal(call.media.closes, 1);
  assert.equal(call.media.listeners.size, 0);
  assert.equal(call.provider.history.filter(event => event.type === 'session.close').length, 1);
  assert.equal(app.store.db.prepare('SELECT COUNT(*) AS total FROM analysis_jobs WHERE session_id=?').get(call.session.id)?.total, 1);
});

test('公共核心保持首轮快回复、audio-only 转写归并和迟到实际文本优先', { timeout: 10000 }, async t => {
  const app = await fixture(t);
  const call = await app.connect();
  await app.activate(call);
  call.provider.send({ type: 'conversation.item.input_audio_transcription.started', item_id: 'initial-refusal' });
  call.provider.send({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'initial-refusal', delta: '不需' });
  call.provider.send({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'initial-refusal', transcript: '不需要，谢谢。' });
  const replacement = await call.provider.take('speech_text_buffer.replacement.commit');
  assert.ok(replacement.text.includes('门窗'));
  assert.equal(app.store.transcripts(call.session.id).filter(row => row.kind === 'ChatText').length, 1, 'no invented assistant text before matching output audio');
  assert.equal(call.media.clears, 1, 'active ASR clears queued playback through the port');
  call.provider.send({ type: 'response.output_audio.started', tts_type: 'chat_tts_text', question_id: 'quick-question', response_id: '' });
  call.provider.send({ type: 'response.output_audio.delta', question_id: 'quick-question', response_id: 'quick-response', delta: Buffer.alloc(240, 5).toString('base64') });
  await call.observer.take(event => event.type === 'transcript' && event.transcript.kind === 'ChatText' && !event.transcript.final);
  call.provider.send({ type: 'response.output_audio.done', question_id: 'quick-question', response_id: 'quick-response' });
  await call.observer.take(event => event.type === 'transcript' && event.transcript.kind === 'ChatText' && event.transcript.text === replacement.text && event.transcript.final);
  const actual = '那这样老板，我发您行业案例，您看看怎么样？';
  call.provider.send({ type: 'response.output_text.delta', response_id: 'quick-response', delta: '那这样老板' });
  call.provider.send({ type: 'response.output_text.done', response_id: 'quick-response', text: actual });
  await call.observer.take(event => event.type === 'transcript' && event.transcript.text === actual && event.transcript.final);
  call.provider.send({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'initial-refusal', transcript: '不需要，谢谢。' });
  await barrier(call.provider.socket);
  assert.equal(call.provider.history.filter(event => event.type === 'speech_text_buffer.replacement.commit').length, 1);
  assert.deepEqual(app.store.transcripts(call.session.id).map(row => [row.kind, row.text, row.final]), [
    ['ChatText', OPENING, true], ['AsrText', '不需要，谢谢。', true], ['ChatText', actual, true],
  ]);
});

test('两个媒体端口隔离音频、排空标识、客户快照与相同供应商转写 ID', { timeout: 10000 }, async t => {
  const app = await fixture(t);
  const first = await app.connect(0);
  const second = await app.connect(1);
  await Promise.all([app.beginOpening(first), app.beginOpening(second)]);
  const [firstSegment, secondSegment] = await Promise.all([app.generatedOpening(first, 'shared-response'), app.generatedOpening(second, 'shared-response')]);
  assert.notEqual(firstSegment.id, secondSegment.id);
  second.media.emit({ type: 'playback_drained', playbackId: firstSegment.id });
  assert.equal(app.store.session(second.session.id)?.status, 'opening');
  first.media.emit({ type: 'playback_drained', playbackId: firstSegment.id });
  second.media.emit({ type: 'playback_drained', playbackId: secondSegment.id });
  await Promise.all([first.provider.take('input_audio_unmute.commit'), second.provider.take('input_audio_unmute.commit')]);
  const firstAudio = Buffer.alloc(640, 6), secondAudio = Buffer.alloc(640, 7);
  first.media.emit({ type: 'audio', audio: firstAudio });
  second.media.emit({ type: 'audio', audio: secondAudio });
  assert.equal((await first.provider.take('input_audio_buffer.append')).audio, firstAudio.toString('base64'));
  assert.equal((await second.provider.take('input_audio_buffer.append')).audio, secondAudio.toString('base64'));
  for (const [call, asr, chat] of [[first, '我想看门窗案例', '门窗案例可以发您微信'], [second, '想了解机械行业', '我发您机械案例']] as const) {
    call.provider.send({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'shared-item', transcript: asr });
    call.provider.send({ type: 'response.output_text.delta', response_id: 'same-chat', delta: chat.slice(0, 2) });
    call.provider.send({ type: 'response.output_text.done', response_id: 'same-chat', text: chat });
    await barrier(call.provider.socket);
    assert.deepEqual(app.store.transcripts(call.session.id).map(row => row.text), [OPENING, asr, chat]);
    const created = call.provider.history.find(event => event.type === 'session.create')!;
    assert.ok(created.session.instructions.includes(call.session.customer.camp));
  }
  assert.equal(first.observer.history.some(event => event.transcript?.text === '想了解机械行业'), false);
  assert.equal(second.observer.history.some(event => event.transcript?.text === '我想看门窗案例'), false);
  app.manager.finish(first.session.id);
  await first.provider.take('session.close');
  assert.equal(app.store.session(second.session.id)?.status, 'active');
  assert.equal(second.media.closes, 0);
  second.media.emit({ type: 'audio', audio: secondAudio });
  await second.provider.take('input_audio_buffer.append');
});

test('核心拒绝不支持可靠排空的端口、缺失凭据与重复媒体所有者', { timeout: 10000 }, async t => {
  const app = await fixture(t);
  const session = app.store.createSession(app.customers[0], 'seed');
  const unsupported = new FakeMedia();
  unsupported.capabilities.canConfirmPlaybackDrain = false;
  assert.throws(() => app.manager.attachMedia(session.id, unsupported));
  assert.equal(app.store.session(session.id)?.status, 'created');
  assert.equal(app.manager.runtime(session.id).active, false);
  const unconfigured = new VoiceSessionManager(app.store, '', app.seedUrl);
  assert.throws(() => unconfigured.attachMedia(session.id, new FakeMedia()));
  assert.equal(app.manager.runtime(session.id).active, false);
  const call = await app.connect();
  await call.provider.take('session.create');
  assert.throws(() => app.manager.attachMedia(call.session.id, new FakeMedia()));
  assert.throws(() => app.manager.attachMedia('00000000-0000-4000-8000-000000000000', new FakeMedia()));
  assert.equal(app.manager.runtime(call.session.id).active, true);
});

test('端口拒收下行音频或播放边界时显式失败，不把丢弃音频当成成功', { timeout: 10000 }, async t => {
  const app = await fixture(t);
  const overflow = await app.connect();
  await app.beginOpening(overflow);
  overflow.media.acceptAudio = false;
  overflow.provider.send({ type: 'response.output_audio.delta', response_id: 'overflow-opening', delta: Buffer.alloc(240, 8).toString('base64') });
  await overflow.observer.take(event => event.type === 'state' && event.status === 'failed');
  await overflow.provider.take('session.close');
  assert.equal(overflow.media.closes, 1);
  assert.equal(app.manager.runtime(overflow.session.id).active, false);

  const boundary = await app.connect(1);
  await app.beginOpening(boundary);
  boundary.media.acceptComplete = false;
  boundary.provider.send({ type: 'response.output_audio.delta', response_id: 'boundary-opening', delta: Buffer.alloc(240, 9).toString('base64') });
  boundary.provider.send({ type: 'response.output_audio.done', response_id: 'boundary-opening' });
  await boundary.observer.take(event => event.type === 'state' && event.status === 'failed');
  await boundary.provider.take('session.close');
  assert.equal(boundary.media.closes, 1);
  assert.equal(boundary.provider.history.some(event => event.type === 'input_audio_unmute.commit'), false);
});

test('首句没有任何 PCM 时不能凭 audio.done 排空或解锁', { timeout: 10000 }, async t => {
  const app = await fixture(t);
  const call = await app.connect();
  await app.beginOpening(call);
  call.provider.send({ type: 'response.output_audio.done', response_id: 'empty-opening' });
  await call.observer.take(event => event.type === 'state' && event.status === 'failed');
  await call.provider.take('session.close');
  assert.equal(call.media.audio.length, 0);
  assert.equal(call.media.completions.length, 0);
  assert.equal(call.media.closes, 1);
  assert.equal(call.media.listeners.size, 0);
  assert.equal(app.manager.runtime(call.session.id).active, false);
  assert.equal(call.observer.history.some(event => event.type === 'state' && event.status === 'active'), false);
  assert.equal(call.provider.history.some(event => event.type === 'input_audio_unmute.commit'), false);
});

test('模型 URL 同步构造失败仍完成清理，不留下活动会话和媒体监听', { timeout: 10000 }, async t => {
  const app = await fixture(t);
  const session = app.store.createSession(app.customers[0], 'seed');
  const invalid = new VoiceSessionManager(app.store, 'local-core-test-key', 'this-is-not-a-websocket-url');
  const media = new FakeMedia();
  assert.throws(() => invalid.attachMedia(session.id, media), ControlError);
  const record = app.store.session(session.id)!;
  assert.equal(record.status, 'failed');
  assert.ok(record.endedAt);
  assert.equal(record.answeredAt, undefined);
  assert.equal(record.modelReadyAt, undefined);
  assert.equal(record.analysisStatus, 'not_requested');
  assert.equal(invalid.runtime(session.id).active, false);
  assert.equal(media.closes, 1);
  assert.equal(media.listeners.size, 0);
  await invalid.shutdown();
  assert.equal(media.closes, 1, 'shutdown must not encounter a half-attached call');
});

test('后续插话清空旧响应，迟到旧音频不重播且新响应仍可正常播放', { timeout: 10000 }, async t => {
  const app = await fixture(t);
  const call = await app.connect();
  await app.activate(call);
  call.provider.send({ type: 'response.output_audio.started', response_id: 'old-response' });
  call.provider.send({ type: 'response.output_audio.delta', response_id: 'old-response', delta: Buffer.alloc(240, 10).toString('base64') });
  await barrier(call.provider.socket);
  const beforeClear = call.media.audio.length;
  assert.equal(beforeClear, 2);
  call.provider.send({ type: 'conversation.item.input_audio_transcription.started', item_id: 'barge-in' });
  await barrier(call.provider.socket);
  assert.equal(call.media.clears, 1);
  call.provider.send({ type: 'response.output_audio.delta', response_id: 'old-response', delta: Buffer.alloc(240, 11).toString('base64') });
  call.provider.send({ type: 'response.output_audio.done', response_id: 'old-response' });
  await barrier(call.provider.socket);
  assert.equal(call.media.audio.length, beforeClear, 'cleared response cannot refill the playback queue');
  call.provider.send({ type: 'response.output_audio.started', response_id: 'new-response' });
  const nextAudio = Buffer.alloc(240, 12);
  call.provider.send({ type: 'response.output_audio.delta', response_id: 'new-response', delta: nextAudio.toString('base64') });
  call.provider.send({ type: 'response.output_audio.done', response_id: 'new-response' });
  await barrier(call.provider.socket);
  assert.equal(app.store.session(call.session.id)?.status, 'active');
  assert.equal(call.media.audio.length, beforeClear + 1);
  assert.deepEqual(call.media.audio.at(-1)?.pcm, nextAudio);
  assert.equal(call.media.audio.at(-1)?.segment.responseId, 'new-response');
  assert.equal(call.media.completions.at(-1)?.responseId, 'new-response');
  call.provider.send({ type: 'response.canceled' });
  call.provider.send({ type: 'response.output_audio.delta', response_id: 'new-response', delta: Buffer.alloc(240, 13).toString('base64') });
  await barrier(call.provider.socket);
  assert.equal(call.media.clears, 2);
  assert.equal(call.media.audio.length, beforeClear + 1);
});

test('核心关闭后拒绝新媒体和观察者，重复 shutdown 可等待且不创建模型', { timeout: 10000 }, async t => {
  const app = await fixture(t);
  const active = await app.connect();
  await app.activate(active);
  const pending = app.store.createSession(app.customers[1], 'seed');
  let newConnections = 0;
  app.cloud.on('connection', () => { newConnections++; });
  const first = app.manager.shutdown();
  const second = app.manager.shutdown();
  const refused = new FakeMedia();
  const stopped = (error: unknown) => error instanceof ControlError && error.status === 410;
  assert.throws(() => app.manager.attachMedia(pending.id, refused), stopped);
  let observed = false;
  assert.throws(() => app.manager.observe(pending.id, () => { observed = true; }), stopped);
  await Promise.all([first, second]);
  await app.manager.shutdown();
  assert.throws(() => app.manager.attachMedia(pending.id, refused), stopped);
  assert.throws(() => app.manager.observe(pending.id, () => {}), stopped);
  assert.equal(newConnections, 0);
  assert.equal(observed, false);
  assert.equal(refused.listeners.size, 0);
  assert.equal(app.manager.runtime(pending.id).active, false);
  assert.equal(app.store.session(pending.id)?.status, 'created');
  assert.equal(app.store.session(pending.id)?.modelReadyAt, undefined);
  assert.equal(active.media.closes, 1);
  assert.equal(active.provider.history.filter(event => event.type === 'session.close').length, 1);
});

test('数据库终结写入失败仍关闭模型与媒体，远端事件写入失败也能收尾', async t => {
  const app = await fixture(t);
  const call = await app.connect(); await app.activate(call);
  const status = app.store.status.bind(app.store);
  app.store.status = () => { throw new Error('synthetic disk full'); };
  assert.doesNotThrow(() => app.manager.finish(call.session.id));
  assert.equal(app.manager.runtime(call.session.id).active, false);
  assert.equal(call.media.closes, 1);
  await call.provider.take('session.close');
  app.store.status = status;
  const second = await app.connect(1); await app.activate(second);
  const event = app.store.event.bind(app.store);
  app.store.event = () => { throw new Error('synthetic readonly database'); };
  second.provider.send({ type: 'conversation.item.input_audio_transcription.started', item_id: 'db-failure' });
  await second.provider.take('session.close');
  assert.equal(app.manager.runtime(second.session.id).active, false);
  assert.equal(second.media.closes, 1);
  app.store.event = event;
});

test('真实Seed音频分片可省略response_id，沿用started关联且仍等待首句排空', async t => {
  const app = await fixture(t); const call = await app.connect(); await app.beginOpening(call);
  const pcm = Buffer.alloc(960, 4);
  call.provider.send({ type: 'response.output_audio.started', response_id: 'real-opening', tts_type: 'chat_tts_text' });
  call.provider.send({ type: 'response.output_audio.delta', delta: pcm.toString('base64'), event_id: 'chunk-1' });
  call.provider.send({ type: 'response.output_audio.done', response_id: 'wrong-response' });
  await barrier(call.provider.socket);
  assert.equal(call.media.audio.length, 1); assert.deepEqual(call.media.audio[0].pcm, pcm);
  assert.equal(call.media.audio[0].segment.responseId, 'real-opening');
  assert.equal(call.media.completions.length, 0); assert.equal(app.store.session(call.session.id)?.status, 'opening');
  call.provider.send({ type: 'response.output_audio.done', response_id: 'real-opening' });
  await barrier(call.provider.socket);
  assert.equal(call.media.completions.length, 1);
  assert.equal(app.store.session(call.session.id)?.status, 'opening');
  call.media.emit({ type: 'playback_drained', playbackId: call.media.completions[0].id });
  await call.provider.take('input_audio_unmute.commit');
  assert.equal(app.store.session(call.session.id)?.status, 'active');
  call.provider.send({ type: 'response.output_audio.started', response_id: 'next-response' });
  call.provider.send({ type: 'response.output_audio.delta', delta: pcm.toString('base64') });
  await barrier(call.provider.socket);
  assert.equal(call.media.audio[1].segment.responseId, 'next-response');
});
