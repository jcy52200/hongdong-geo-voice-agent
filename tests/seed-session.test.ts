import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import test, { type TestContext } from 'node:test';
import WebSocket, { WebSocketServer } from 'ws';
import { createApp } from '../server/app.js';
import { OPENING } from '../server/prompt.js';
import { DEFAULT_CONFIG } from '../server/store.js';
import type { Customer, Session } from '../server/types.js';

type Message = { type: string; [key: string]: any };
type Match = string | ((message: Message) => boolean);

class Inbox {
  readonly history: Message[] = [];
  readonly closed: Promise<void>;
  private queue: Message[] = [];
  private waiters: { match: (message: Message) => boolean; resolve: (message: Message) => void }[] = [];

  constructor(readonly socket: WebSocket) {
    this.closed = new Promise(resolve => socket.once('close', () => resolve()));
    socket.on('error', () => {}); // Connection failures are asserted through the application's events.
    socket.on('message', (data, binary) => {
      assert.equal(binary, false, 'both transports must use JSON text frames');
      const message = JSON.parse(data.toString()) as Message;
      this.history.push(message);
      const index = this.waiters.findIndex(waiter => waiter.match(message));
      if (index >= 0) this.waiters.splice(index, 1)[0].resolve(message);
      else this.queue.push(message);
    });
  }

  take(match: Match): Promise<Message> {
    const predicate = typeof match === 'string' ? (message: Message) => message.type === match : match;
    const index = this.queue.findIndex(predicate);
    if (index >= 0) return Promise.resolve(this.queue.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = { match: predicate, resolve: (message: Message) => { clearTimeout(timer); resolve(message); } };
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter(candidate => candidate !== waiter);
        reject(new Error(`Timed out waiting for ${typeof match === 'string' ? match : 'matching message'}; received ${this.history.map(message => message.type).join(', ')}`));
      }, 2500);
      this.waiters.push(waiter);
    });
  }

  send(message: Message) { this.socket.send(JSON.stringify(message)); }
}

// A pong follows earlier frames on the same connection. This makes negative
// assertions deterministic without arbitrary sleeps or test-only API routes.
async function barrier(socket: WebSocket) {
  await new Promise<void>((resolve, reject) => {
    const done = () => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => { socket.off('pong', done); reject(new Error('WebSocket barrier timed out')); }, 2500);
    socket.once('pong', done);
    socket.ping();
  });
}

interface Call {
  session: Session;
  browser: Inbox;
  provider: Inbox;
  headers: IncomingHttpHeaders;
}

async function fixture(t: TestContext) {
  const mock = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(mock, 'listening');
  const mockUrl = `ws://127.0.0.1:${(mock.address() as AddressInfo).port}`;
  const running = createApp({ databasePath: ':memory:', apiKey: 'test-key', seedUrl: mockUrl });
  await new Promise<void>(resolve => running.server.listen(0, '127.0.0.1', resolve));
  const address = (running.server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${address}`;
  const browsers: WebSocket[] = [];
  t.after(async () => {
    await running.close();
    for (const socket of browsers) socket.terminate();
    for (const socket of mock.clients) socket.terminate();
    await new Promise<void>((resolve, reject) => mock.close(error => error ? reject(error) : resolve()));
  });

  async function request(path: string, body?: unknown): Promise<any> {
    const response = await fetch(`${base}${path}`, body === undefined ? undefined : {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    assert.ok(response.ok, `${path}: HTTP ${response.status}`);
    return response.json();
  }
  const imported = await request('/api/customers/import', { customers: [
    { camp: '甲方石家庄门窗公司', name: '张甲', phone: '13800000001', address: '石家庄', industry: '门窗' },
    { camp: '乙方保定机械公司', name: '李乙', phone: '13900000002', address: '保定', industry: '机械' },
  ] });
  const customers = (imported.customers as Customer[]).sort((a, b) => a.phone.localeCompare(b.phone));

  async function connect(customerIndex = 0): Promise<Call> {
    const session = await request('/api/sessions', { customerId: customers[customerIndex].id, mode: 'seed' }) as Session;
    const accepted = new Promise<{ inbox: Inbox; headers: IncomingHttpHeaders }>(resolve => {
      mock.once('connection', (socket, request) => {
        const inbox = new Inbox(socket);
        socket.on('message', data => {
          if (JSON.parse(data.toString()).type === 'session.close') {
            socket.send(JSON.stringify({ type: 'session.closed' }), () => socket.close());
          }
        });
        resolve({ inbox, headers: request.headers });
      });
    });
    const socket = new WebSocket(`ws://127.0.0.1:${address}/ws/sessions/${session.id}`);
    browsers.push(socket);
    const browser = new Inbox(socket);
    await once(socket, 'open');
    const provider = await accepted;
    return { session, browser, provider: provider.inbox, headers: provider.headers };
  }

  return { ...running, request, connect, customers };
}

async function activate(call: Call) {
  call.provider.send({ type: 'session.created', session: { id: `cloud-${call.session.id}` } });
  await call.browser.take(message => message.type === 'state' && message.status === 'opening');
  await call.provider.take('input_audio_mute.commit');
  assert.equal((await call.provider.take('speech_text_buffer.commit')).text, OPENING);
  call.provider.send({ type: 'response.output_audio.done' });
  await call.browser.take('audio_done');
  call.browser.send({ type: 'playback_done' });
  await call.browser.take(message => message.type === 'state' && message.status === 'active');
  await call.provider.take('input_audio_unmute.commit');
}

test('真实 WebSocket 握手、固定首句媒体锁、播放确认及完成关闭', { timeout: 15000 }, async t => {
  const app = await fixture(t);
  const call = await app.connect();
  const create = await call.provider.take('session.create');
  assert.equal(call.headers['x-api-key'], 'test-key');
  assert.ok(create.event_id);
  assert.equal(create.session.id, call.session.id);
  assert.equal(create.session.model, '1.2.6.1');
  assert.equal(create.session.instructions, call.session.prompt);
  assert.deepEqual(create.session.audio, {
    input: { format: { type: 'pcm', rate: 16000 } },
    output: { format: { type: 'pcm_s16le', rate: 24000 }, voice: DEFAULT_CONFIG.voice, speed: DEFAULT_CONFIG.speed, loudness: 0 },
  });
  assert.deepEqual(create.extension, {
    asr: { extra: {} }, tts: { extra: {} }, dialog: { extra: { enable_loudness_norm: true, enable_music: false } },
  });
  assert.equal(JSON.stringify(call.browser.history).includes('test-key'), false);

  call.provider.send({ type: 'session.created', session: { id: 'cloud-dialog-1' } });
  await call.browser.take(message => message.type === 'state' && message.status === 'opening');
  await call.provider.take('input_audio_mute.commit');
  assert.equal((await call.provider.take('speech_text_buffer.commit')).text, OPENING);
  const frame = Buffer.alloc(640, 1).toString('base64');
  call.browser.send({ type: 'audio', audio: frame });
  call.browser.send({ type: 'playback_done' }); // A forged early acknowledgement cannot unlock capture.
  await barrier(call.browser.socket);
  call.provider.send({ type: 'conversation.item.input_audio_transcription.started', item_id: 'opening-noise' });
  call.provider.send({ type: 'response.output_text.done', response_id: 'wrong-opening', text: '不能替换首句' });
  const output = Buffer.alloc(240, 2).toString('base64');
  call.provider.send({ type: 'response.output_audio.delta', response_id: 'greeting', delta: output });
  assert.deepEqual(await call.browser.take('audio'), { type: 'audio', audio: output, rate: 24000 });
  await barrier(call.provider.socket);
  assert.equal(app.store.session(call.session.id)?.status, 'opening');
  assert.equal(call.provider.history.some(message => ['input_audio_buffer.append', 'input_audio_unmute.commit', 'response.cancel'].includes(message.type)), false);
  assert.equal(call.browser.history.some(message => message.type === 'interrupted'), false);
  assert.deepEqual(app.store.transcripts(call.session.id).map(row => row.text), [OPENING]);

  call.provider.send({ type: 'response.output_audio.done', response_id: 'greeting', status_code: '20000002' });
  assert.deepEqual(await call.browser.take('audio_done'), { type: 'audio_done', opening: true });
  assert.equal(app.store.session(call.session.id)?.status, 'opening', 'generation done is not playback drained');
  assert.equal(call.provider.history.some(message => message.type === 'input_audio_unmute.commit'), false);
  call.browser.send({ type: 'playback_done' });
  await call.browser.take(message => message.type === 'state' && message.status === 'active');
  await call.provider.take('input_audio_unmute.commit');
  call.browser.send({ type: 'audio', audio: frame });
  assert.equal((await call.provider.take('input_audio_buffer.append')).audio, frame);

  call.browser.send({ type: 'finish' });
  await call.browser.take(message => message.type === 'state' && message.status === 'completed');
  await call.provider.take('session.close');
  await call.browser.closed;
  const completed = await app.request(`/api/sessions/${call.session.id}`) as Session;
  assert.equal(completed.status, 'completed');
  assert.ok(completed.endedAt);
  assert.equal(completed.analysisStatus, 'pending');
  assert.deepEqual(completed.transcripts.map(row => row.text), [OPENING]);
  assert.equal(app.store.db.prepare('SELECT COUNT(*) AS total FROM analysis_jobs WHERE session_id=?').get(call.session.id)?.total, 1);
});

test('并行会话隔离；ASR 与 Chat 增量由终态替换且保留单行', { timeout: 15000 }, async t => {
  const app = await fixture(t);
  const first = await app.connect(0);
  const second = await app.connect(1);
  const firstCreate = await first.provider.take('session.create');
  const secondCreate = await second.provider.take('session.create');
  assert.notEqual(firstCreate.session.id, secondCreate.session.id);
  assert.ok(firstCreate.session.instructions.includes(app.customers[0].camp));
  assert.equal(firstCreate.session.instructions.includes(app.customers[1].camp), false);
  assert.ok(secondCreate.session.instructions.includes(app.customers[1].camp));
  assert.equal(secondCreate.session.instructions.includes(app.customers[0].camp), false);
  await Promise.all([activate(first), activate(second)]);

  for (const [call, customerText, assistantText] of [
    [first, '我想了解一下。', '嗯，我发您行业案例，可以加微信吗？'],
    [second, '不需要，谢谢。', '昂，好的，不打扰您。'],
  ] as const) {
    call.provider.send({ type: 'conversation.item.input_audio_transcription.started', item_id: 'shared-item' });
    call.provider.send({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'shared-item', delta: customerText.slice(0, 2) });
    call.provider.send({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'shared-item', delta: customerText.slice(2, 4) });
    call.provider.send({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'shared-item', transcript: customerText, event_id: 'asr-final' });
    call.provider.send({ type: 'response.output_text.delta', response_id: 'shared-response', delta: assistantText.slice(0, 2) });
    call.provider.send({ type: 'response.output_text.delta', response_id: 'shared-response', delta: assistantText.slice(2, 5) });
    call.provider.send({ type: 'response.output_text.done', response_id: 'shared-response', text: assistantText, event_id: 'chat-final' });
    await call.browser.take(message => message.type === 'transcript' && message.transcript.kind === 'AsrText' && message.transcript.final);
    await call.browser.take(message => message.type === 'transcript' && message.transcript.text === assistantText && message.transcript.final);
    assert.deepEqual(app.store.transcripts(call.session.id).map(row => [row.kind, row.text, row.final]), [
      ['ChatText', OPENING, true], ['AsrText', customerText, true], ['ChatText', assistantText, true],
    ]);
    const asrUpdates = call.browser.history.filter(message => message.type === 'transcript' && message.transcript.kind === 'AsrText');
    assert.equal(new Set(asrUpdates.map(message => message.transcript.id)).size, 1);
    assert.equal(asrUpdates.at(-1)?.transcript.eventId, 'asr-final');
    assert.equal(call.browser.history.filter(message => message.type === 'interrupted').length, 1);
    assert.equal(call.provider.history.some(message => message.type === 'response.cancel'), false);
  }
  assert.equal(first.browser.history.some(message => message.transcript?.text === '不需要，谢谢。'), false);
  assert.equal(second.browser.history.some(message => message.transcript?.text === '我想了解一下。'), false);
  first.browser.send({ type: 'finish' });
  second.browser.send({ type: 'finish' });
  await Promise.all([first.provider.take('session.close'), second.provider.take('session.close')]);
});

test('浏览器或云端断开均持久化失败并释放对端连接', { timeout: 15000 }, async t => {
  const app = await fixture(t);
  const browserDisconnect = await app.connect(0);
  await browserDisconnect.provider.take('session.create');
  await activate(browserDisconnect);
  browserDisconnect.provider.send({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'saved-item', transcript: '保留断开前记录' });
  await browserDisconnect.browser.take(message => message.type === 'transcript' && message.transcript.kind === 'AsrText');
  browserDisconnect.browser.socket.terminate();
  await browserDisconnect.provider.take('session.close');
  const first = app.store.session(browserDisconnect.session.id)!;
  assert.equal(first.status, 'failed');
  assert.ok(first.endedAt);
  assert.match(first.error ?? '', /浏览器/);
  assert.ok(first.transcripts.some(row => row.text === '保留断开前记录'));
  assert.equal(first.analysisStatus, 'not_requested');

  const providerDisconnect = await app.connect(1);
  await providerDisconnect.provider.take('session.create');
  await activate(providerDisconnect);
  providerDisconnect.provider.socket.terminate();
  await providerDisconnect.browser.take(message => message.type === 'state' && message.status === 'failed');
  await providerDisconnect.browser.closed;
  const second = await app.request(`/api/sessions/${providerDisconnect.session.id}`) as Session;
  assert.equal(second.status, 'failed');
  assert.ok(second.endedAt);
  assert.match(second.error ?? '', /SeedDuplex.*关闭/);
  assert.equal(second.analysisStatus, 'not_requested');
});
