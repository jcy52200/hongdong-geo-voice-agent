import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test, { type TestContext } from 'node:test';
import WebSocket, { WebSocketServer } from 'ws';
import { createApp } from '../server/app.js';

type Event = { type: string; [key: string]: any };

class Inbox {
  readonly events: Event[] = [];
  readonly closed: Promise<number>;
  private queue: Event[] = [];
  private wake = new Set<() => void>();
  constructor(readonly socket: WebSocket) {
    this.closed = new Promise(resolve => socket.once('close', code => resolve(code)));
    socket.on('error', () => {});
    socket.on('message', (data, binary) => {
      assert.equal(binary, false);
      const event = JSON.parse(String(data));
      this.events.push(event); this.queue.push(event);
      for (const check of this.wake) check();
    });
  }
  send(event: Event | Buffer) { this.socket.send(Buffer.isBuffer(event) ? event : JSON.stringify(event)); }
  take(type: string | ((event: Event) => boolean)): Promise<Event> {
    const match = typeof type === 'string' ? (event: Event) => event.type === type : type;
    return new Promise((resolve, reject) => {
      const check = () => {
        const index = this.queue.findIndex(match);
        if (index >= 0) { clearTimeout(timer); this.wake.delete(check); resolve(this.queue.splice(index, 1)[0]); }
      };
      const timer = setTimeout(() => { this.wake.delete(check); reject(new Error('等待只读观察协议事件超时')); }, 2500);
      this.wake.add(check); check();
    });
  }
}

async function barrier(socket: WebSocket) {
  await new Promise<void>((resolve, reject) => {
    const done = () => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => { socket.off('pong', done); reject(new Error('观察协议同步超时')); }, 2500);
    socket.once('pong', done); socket.ping();
  });
}

async function fixture(t: TestContext, options: { manualProviderClose?: boolean } = {}) {
  const cloud = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(cloud, 'listening');
  const runtime = createApp({ databasePath: ':memory:', apiKey: 'observer-private-test-key', seedUrl: `ws://127.0.0.1:${(cloud.address() as AddressInfo).port}` });
  await new Promise<void>(resolve => runtime.server.listen(0, '127.0.0.1', resolve));
  const base = `ws://127.0.0.1:${(runtime.server.address() as AddressInfo).port}`;
  const sockets: WebSocket[] = [];
  t.after(async () => {
    await runtime.close();
    for (const socket of sockets) socket.terminate();
    for (const socket of cloud.clients) socket.terminate();
    await new Promise<void>((resolve, reject) => cloud.close(error => error ? reject(error) : resolve()));
  });
  const customer = runtime.store.importCustomers([{ camp: '测试门窗公司', name: '测试联系人', phone: '13800000001', address: '石家庄', industry: '门窗' }])[0];
  const session = runtime.store.createSession(customer, 'seed');
  const accepted = new Promise<Inbox>(resolve => cloud.once('connection', socket => {
    const provider = new Inbox(socket);
    socket.on('message', data => {
      if (JSON.parse(String(data)).type === 'session.close' && !options.manualProviderClose) {
        socket.send(JSON.stringify({ type: 'session.closed' }), () => socket.close());
      }
    });
    resolve(provider);
  }));
  const mediaSocket = new WebSocket(`${base}/ws/sessions/${session.id}`); sockets.push(mediaSocket);
  const media = new Inbox(mediaSocket);
  const provider = await accepted;
  await provider.take('session.create');
  provider.send({ type: 'session.created', session: { id: 'observer-cloud-session' } });
  await media.take(event => event.type === 'state' && event.status === 'opening');
  await provider.take('speech_text_buffer.commit');
  provider.send({ type: 'response.output_audio.delta', response_id: 'opening', delta: Buffer.alloc(240, 1).toString('base64') });
  provider.send({ type: 'response.output_audio.done', response_id: 'opening' });
  const done = await media.take('audio_done');
  media.send({ type: 'playback_done', playbackId: done.playbackId });
  await media.take(event => event.type === 'state' && event.status === 'active');
  await provider.take('input_audio_unmute.commit');

  async function observe() {
    const socket = new WebSocket(`${base}/ws/sessions/${session.id}/observe`); sockets.push(socket);
    const inbox = new Inbox(socket);
    await once(socket, 'open');
    await inbox.take('session');
    return inbox;
  }
  async function denied(path: string, headers?: Record<string, string>) {
    const socket = new WebSocket(`${base}${path}`, { headers }); sockets.push(socket);
    socket.on('error', () => {});
    return new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => { socket.terminate(); reject(new Error('升级请求未被拒绝')); }, 2500);
      socket.once('unexpected-response', (_request, response) => {
        clearTimeout(timer); response.resume(); socket.terminate(); resolve(response.statusCode ?? 0);
      });
      socket.once('open', () => { clearTimeout(timer); socket.close(); reject(new Error('受限观察请求意外连接成功')); });
    });
  }
  return { ...runtime, base, customer, session, media, provider, observe, denied };
}

test('独立观察 WS 推送快照和元数据，断开与重连不承担媒体生命周期', { timeout: 10000 }, async t => {
  const app = await fixture(t);
  const observer = await app.observe();
  assert.equal(observer.events[0].session.id, app.session.id);
  assert.equal(observer.events[0].session.status, 'active');
  assert.ok(observer.events[0].session.transcripts.length);
  app.provider.send({ type: 'response.output_audio.delta', response_id: 'active-audio', delta: Buffer.alloc(240, 2).toString('base64') });
  await app.media.take(event => event.type === 'audio' && event.audio === Buffer.alloc(240, 2).toString('base64'));
  app.provider.send({ type: 'conversation.item.input_audio_transcription.started', item_id: 'observed-asr' });
  app.provider.send({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'observed-asr', transcript: '可以发一下案例' });
  app.provider.send({ type: 'response.output_text.done', response_id: 'observed-chat', text: '嗯，可以加您微信吗？' });
  await observer.take(event => event.type === 'transcript' && event.transcript.text === '嗯，可以加您微信吗？');
  assert.equal(observer.events.some(event => ['audio', 'audio_done', 'interrupted'].includes(event.type)), false);
  assert.equal(JSON.stringify(observer.events).includes('observer-private-test-key'), false);
  observer.socket.close();
  await observer.closed;
  assert.equal(app.manager.runtime(app.session.id).active, true);
  assert.equal(app.store.session(app.session.id)?.status, 'active');
  assert.equal(app.media.socket.readyState, WebSocket.OPEN);
  app.provider.send({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'after-page-close', transcript: '这个电话就是微信' });
  await app.media.take(event => event.type === 'transcript' && event.transcript.text === '这个电话就是微信');
  const reconnected = await app.observe();
  assert.ok(reconnected.events[0].session.transcripts.some((row: { text: string }) => row.text === '这个电话就是微信'));
  app.manager.finish(app.session.id);
  await reconnected.take(event => event.type === 'state' && event.status === 'completed');
  await app.provider.take('session.close');
});

test('观察 WS 拒绝控制、音频、文字和二进制输入，只关闭观察连接', { timeout: 10000 }, async t => {
  const app = await fixture(t);
  const input = Buffer.alloc(640, 3).toString('base64');
  for (const event of [
    { type: 'finish' }, { type: 'mute', muted: true }, { type: 'audio', audio: input },
    { type: 'text', text: '伪造用户输入' }, { type: 'playback_done', playbackId: 'forged' }, Buffer.from('binary'),
  ]) {
    const observer = await app.observe();
    observer.send(event);
    assert.equal(await observer.closed, 1008);
    assert.equal(app.manager.runtime(app.session.id).active, true);
    assert.equal(app.manager.runtime(app.session.id).muted, false);
    assert.equal(app.store.session(app.session.id)?.status, 'active');
  }
  await barrier(app.provider.socket);
  assert.equal(app.provider.events.some(event => event.type === 'input_audio_buffer.append'), false);
  assert.equal(app.provider.events.some(event => event.type === 'session.close'), false);
  assert.equal(app.provider.events.filter(event => event.type === 'input_audio_mute.commit').length, 1, 'only the fixed greeting muted model input');
  assert.equal(app.store.transcripts(app.session.id).some(row => row.text === '伪造用户输入'), false);
  app.media.send({ type: 'audio', audio: input });
  assert.equal((await app.provider.take('input_audio_buffer.append')).audio, input, 'the original media owner remains usable');
});

test('观察 WS 保持本机来源校验，未知会话在升级前返回404', { timeout: 10000 }, async t => {
  const app = await fixture(t);
  const missing = '/ws/sessions/00000000-0000-4000-8000-000000000000/observe';
  assert.equal(await app.denied(missing), 404);
  assert.equal(await app.denied(`/ws/sessions/${app.session.id}/observe`, { Origin: 'https://evil.example' }), 403);
  assert.equal(await app.denied(`/ws/sessions/${app.session.id}/observe`, { Host: 'public.example' }), 403);
  assert.equal(await app.denied(missing, { Origin: 'https://evil.example' }), 403);
  assert.equal(app.manager.runtime(app.session.id).active, true);
});

test('应用关闭入口复用 Promise，等待模型关闭确认期间拒绝 HTTP/WS 新工作', { timeout: 10000 }, async t => {
  const app = await fixture(t, { manualProviderClose: true });
  const closing = app.close();
  assert.equal(app.close(), closing);
  let finished = false;
  void closing.then(() => { finished = true; });
  await app.provider.take('session.close');
  assert.equal(finished, false, 'the model close acknowledgement has not arrived');
  assert.equal(app.store.session(app.session.id)?.status, 'failed', 'the database remains open while the model closes');
  assert.equal(app.manager.runtime(app.session.id).active, false);
  const existing = app.store.sessionCount();
  const base = app.base.replace(/^ws:/, 'http:');
  const create = await fetch(`${base}/api/sessions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ customerId: app.customer.id, mode: 'seed' }),
  });
  assert.equal(create.status, 503);
  assert.equal((await fetch(`${base}/api/bootstrap`)).status, 503);
  assert.equal(await app.denied(`/ws/sessions/${app.session.id}/observe`), 503);
  assert.equal(await app.denied(`/ws/sessions/${app.session.id}`), 503);
  assert.equal(app.store.sessionCount(), existing);
  assert.equal(finished, false, 'new requests must not force premature model or database teardown');
  app.provider.send({ type: 'session.closed' });
  await closing;
  assert.equal(finished, true);
  assert.equal(app.server.listening, false);
  assert.equal(app.close(), closing);
  await app.close();
  assert.throws(() => app.store.session(app.session.id), 'the database closes after the model connection');
  assert.equal(app.provider.events.filter(event => event.type === 'session.close').length, 1);
});
