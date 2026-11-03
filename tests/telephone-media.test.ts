import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test, { type TestContext } from 'node:test';
import { performance } from 'node:perf_hooks';
import WebSocket, { WebSocketServer } from 'ws';
import { Pcm16Framer, StreamingPcm16Resampler } from '../server/media/pcm.js';
import { SIPHON_DRAIN_PROTOCOL, SIPHON_DRAIN_SCOPE, SiphonMediaAdapter, type SiphonMediaOptions } from '../server/media/siphon.js';
import type { MediaInput } from '../server/media/port.js';

function tone(hertz: number, samples = 24000) {
  const pcm = Buffer.alloc(samples * 2);
  for (let sample = 0; sample < samples; sample++) pcm.writeInt16LE(Math.round(12000 * Math.sin(sample * 2 * Math.PI * hertz / 24000)), sample * 2);
  return pcm;
}
function rms(pcm: Buffer) {
  let energy = 0;
  let count = 0;
  for (let index = 200; index < pcm.length - 200; index += 2) { energy += pcm.readInt16LE(index) ** 2; count++; }
  return Math.sqrt(energy / count);
}

test('24k→16k窗口低通重采样保留跨包相位、样本数，并抑制9kHz混叠', () => {
  const input = tone(3000, 24007);
  const continuous = new StreamingPcm16Resampler();
  const expected = Buffer.concat([continuous.push(input), continuous.flush()]);
  assert.equal(expected.length, Math.ceil(24007 * 2 / 3) * 2);
  const streaming = new StreamingPcm16Resampler();
  const outputs: Buffer[] = [];
  let offset = 0;
  for (let chunk = 0; offset < input.length; chunk++) {
    const length = Math.min(input.length - offset, [2, 640, 196, 960, 14, 322][chunk % 6]);
    outputs.push(streaming.push(input.subarray(offset, offset + length)));
    offset += length;
  }
  outputs.push(streaming.flush());
  assert.deepEqual(Buffer.concat(outputs), expected, 'chunk boundaries cannot reset filter phase or history');
  assert.equal(streaming.flush().length, 0);
  assert.throws(() => streaming.push(Buffer.alloc(2)), /flushed/);
  assert.ok(rms(expected) > 8000, '3kHz speech-band amplitude should survive');
  const stopband = new StreamingPcm16Resampler();
  const suppressed = Buffer.concat([stopband.push(tone(9000)), stopband.flush()]);
  assert.ok(rms(suppressed) < rms(expected) / 30, 'anti-alias filter must reject above the 16kHz Nyquist frequency');
  assert.throws(() => new StreamingPcm16Resampler().push(Buffer.alloc(1)), /16-bit/);
});

test('20ms PCM帧化跨包保序，只在完成时补零尾帧', () => {
  const frame = new Pcm16Framer();
  const input = Buffer.alloc(966, 3);
  assert.deepEqual(frame.push(input.subarray(0, 200)), []);
  const first = frame.push(input.subarray(200));
  assert.equal(first.length, 1);
  assert.equal(first[0].length, 640);
  const last = frame.finish();
  assert.equal(last.length, 1);
  assert.equal(last[0].length, 640);
  assert.deepEqual(last[0].subarray(0, 326), Buffer.alloc(326, 3));
  assert.deepEqual(last[0].subarray(326), Buffer.alloc(314));
  assert.deepEqual(frame.finish(), []);
});

interface Received { binary: boolean; data: Buffer; at: number; }
async function fixture(t: TestContext, overrides: Partial<SiphonMediaOptions> = {}) {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(wss, 'listening');
  let accepted!: SiphonMediaAdapter;
  const connected = new Promise<void>(resolve => wss.once('connection', socket => {
    accepted = new SiphonMediaAdapter(socket, { expectedCallId: 'call-1', verifiedDrainProtocol: SIPHON_DRAIN_PROTOCOL, ...overrides });
    resolve();
  }));
  const peer = new WebSocket(`ws://127.0.0.1:${(wss.address() as AddressInfo).port}`);
  peer.on('error', () => {});
  const received: Received[] = [];
  peer.on('message', (data, binary) => received.push({ binary, data: Buffer.from(data as Buffer), at: performance.now() }));
  await Promise.all([connected, once(peer, 'open')]);
  const adapter = accepted;
  const events: { event: MediaInput; at: number }[] = [];
  adapter.onEvent(event => events.push({ event, at: performance.now() }));
  const send = (type: string, data: object) => peer.send(JSON.stringify({ type, data: { streamId: 'stream-1', ...data } }));
  const startData = {
    streamId: 'stream-1', callId: 'call-1', direction: 'duplex',
    media: { encoding: 'L16', endianness: 'little', bitDepth: 16, sampleRate: 16000, channels: 1, ptime: 20 },
    metadata: { playbackDrainProtocol: SIPHON_DRAIN_PROTOCOL, playbackDrainScope: SIPHON_DRAIN_SCOPE },
  };
  const start = async (data: object = {}) => { send('start', { ...startData, ...data }); await adapter.ready; };
  const controls = () => received.filter(message => !message.binary).map(message => JSON.parse(message.data.toString()) as { type: string; data: Record<string, unknown> });
  t.after(async () => {
    adapter.close();
    for (const socket of wss.clients) socket.terminate();
    peer.terminate();
    await new Promise<void>(resolve => wss.close(() => resolve()));
  });
  return { adapter, peer, received, events, send, start, startData, controls };
}

async function until(predicate: () => boolean, message: string) {
  const deadline = performance.now() + 2500;
  while (!predicate()) {
    if (performance.now() > deadline) assert.fail(message);
    await new Promise(resolve => setTimeout(resolve, 3));
  }
}
async function barrier(peer: WebSocket) {
  const pong = once(peer, 'pong');
  peer.ping();
  await pong;
}

test('Siphon start仅接受关联正确的16k单声道格式及已核验自定义drain能力', async t => {
  for (const [label, data, options] of [
    ['unpatched', { metadata: undefined }, {}],
    ['wrong scope', { metadata: { playbackDrainProtocol: SIPHON_DRAIN_PROTOCOL, playbackDrainScope: 'ws_send' } }, {}],
    ['unverified deployment', {}, { verifiedDrainProtocol: '' }],
    ['wrong call', { callId: 'another-call' }, {}],
    ['8k wire', { media: { encoding: 'L16', endianness: 'little', bitDepth: 16, sampleRate: 8000, channels: 1, ptime: 20 } }, {}],
    ['wrong stream', {}, { expectedStreamId: 'another-stream' }],
  ] as [string, object, Partial<SiphonMediaOptions>][]) {
    await t.test(label, async child => {
      const app = await fixture(child, options);
      assert.equal(app.adapter.capabilities.canConfirmPlaybackDrain, false);
      await assert.rejects(app.start(data));
      assert.equal(app.adapter.capabilities.canConfirmPlaybackDrain, false);
      assert.equal(app.adapter.writeAudio(Buffer.alloc(960), { id: 'p', opening: true }), false);
    });
  }
});

test('首句只在已发送play_stop后匹配played解锁，cleared、提前/过期mark均无效', async t => {
  const app = await fixture(t);
  await app.start();
  assert.equal(app.adapter.capabilities.canConfirmPlaybackDrain, true);
  const segment = { id: 'opening-1', opening: true };
  assert.equal(app.adapter.writeAudio(tone(400, 1920), segment), true);
  assert.equal(app.adapter.clearPlayback(), false, 'opening cannot be cleared');
  app.send('mark', { playId: segment.id, name: 'played' });
  await barrier(app.peer);
  assert.equal(app.events.filter(row => row.event.type === 'playback_drained').length, 0);
  assert.equal(app.adapter.completePlayback(segment), true);
  await until(() => app.controls().some(message => message.type === 'play_stop'), 'play_stop did not arrive');
  const start = app.controls().find(message => message.type === 'play_start');
  assert.deepEqual(start?.data, { streamId: 'stream-1', playId: segment.id, source: 'binary', interruptible: false, markName: 'played' });
  assert.equal(app.received.filter(message => message.binary).length, 4);
  app.send('mark', { playId: 'stale-play', name: 'played' });
  app.send('mark', { playId: segment.id, name: 'cleared' });
  await barrier(app.peer);
  assert.equal(app.events.filter(row => row.event.type === 'playback_drained').length, 0);
  app.send('mark', { playId: segment.id, name: 'played' });
  await until(() => app.events.some(row => row.event.type === 'playback_drained'), 'drain was not emitted');
  app.send('mark', { playId: segment.id, name: 'played' });
  await barrier(app.peer);
  assert.equal(app.events.filter(row => row.event.type === 'playback_drained').length, 1);
  assert.equal(app.adapter.writeAudio(Buffer.alloc(960), segment), false, 'played IDs cannot be reused by stale chunks');
});

test('首句排空时丢弃保护阶段积压的上行帧，避免解除静音后重放旧插话', async t => {
  const app = await fixture(t);
  await app.start();
  const segment = { id: 'opening-purge', opening: true };
  assert.equal(app.adapter.writeAudio(Buffer.alloc(960), segment), true);
  assert.equal(app.adapter.completePlayback(segment), true);
  await until(() => app.controls().some(message => message.type === 'play_stop'), 'opening stop did not arrive');
  app.peer.send(Buffer.alloc(640, 1));
  app.peer.send(Buffer.alloc(640, 2));
  app.send('mark', { playId: segment.id, name: 'played' });
  await barrier(app.peer);
  const before = app.events.filter(row => row.event.type === 'audio').length;
  app.peer.send(Buffer.alloc(640, 3));
  await until(() => app.events.filter(row => row.event.type === 'audio').length > before, 'post-opening audio did not arrive');
  const latest = app.events.filter(row => row.event.type === 'audio')[before].event;
  assert.equal(latest.type, 'audio');
  if (latest.type === 'audio') assert.deepEqual(latest.audio, Buffer.alloc(640, 3));
});

test('电话WS双向音频均按20ms节拍发送，24k模型输出转换到16k线格式', async t => {
  const app = await fixture(t);
  await app.start();
  for (let index = 0; index < 5; index++) app.peer.send(Buffer.alloc(640, index + 1));
  const segment = { id: 'paced', opening: false };
  const input = tone(1000, 2400);
  assert.equal(app.adapter.writeAudio(input.subarray(0, 722), segment), true);
  assert.equal(app.adapter.writeAudio(input.subarray(722), segment), true);
  assert.equal(app.adapter.completePlayback(segment), true);
  await until(() => app.received.filter(message => message.binary).length === 5 && app.events.filter(row => row.event.type === 'audio').length === 5, 'audio did not arrive');
  const inbound = app.events.filter(row => row.event.type === 'audio');
  const outbound = app.received.filter(message => message.binary);
  assert.ok(inbound[4].at - inbound[0].at >= 50, 'uplink burst must not reach the model in one event-loop turn');
  assert.ok(outbound[4].at - outbound[0].at >= 50, 'downlink must be paced, not dumped into gateway buffers');
  for (let index = 0; index < inbound.length; index++) {
    const event = inbound[index].event;
    assert.equal(event.type, 'audio');
    if (event.type === 'audio') assert.deepEqual(event.audio, Buffer.alloc(640, index + 1));
  }
  assert.ok(outbound.every(message => message.data.length === 640));
  const converter = new StreamingPcm16Resampler();
  assert.deepEqual(Buffer.concat(outbound.map(message => message.data)), Buffer.concat([converter.push(input), converter.flush()]));
});

test('打断同时清空本地队列和远端，旧音频与旧排空确认不能污染后续回复', async t => {
  const app = await fixture(t);
  await app.start();
  const cancelled = { id: 'cancelled', opening: false };
  assert.equal(app.adapter.writeAudio(tone(400, 4800), cancelled), true);
  assert.equal(app.adapter.completePlayback(cancelled), true);
  await until(() => app.received.some(message => message.binary), 'first frame did not arrive');
  assert.equal(app.adapter.clearPlayback(), true);
  await until(() => app.controls().some(message => message.type === 'clear'), 'clear did not arrive');
  const framesAfterClear = app.received.filter(message => message.binary).length;
  app.send('mark', { playId: cancelled.id, name: 'played' });
  app.send('mark', { playId: cancelled.id, name: 'cleared' });
  await barrier(app.peer);
  assert.equal(app.adapter.writeAudio(Buffer.alloc(960), cancelled), false);
  const next = { id: 'next', opening: false };
  assert.equal(app.adapter.writeAudio(Buffer.alloc(960), next), true);
  assert.equal(app.adapter.completePlayback(next), true);
  await until(() => app.controls().some(message => message.type === 'play_stop' && message.data.playId === next.id), 'next segment did not arrive');
  assert.equal(app.received.filter(message => message.binary).length, framesAfterClear + 1, 'cancelled queued frames must not leak');
  assert.equal(app.events.some(row => row.event.type === 'playback_drained'), false);
  app.send('mark', { playId: next.id, name: 'played' });
  await until(() => app.events.some(row => row.event.type === 'playback_drained' && row.event.playbackId === next.id), 'next segment did not drain');
});

test('输出有界拒收、上行积压/异常格式/握手超时和断线均可收尾', async t => {
  await t.test('bounded output', async child => {
    const app = await fixture(child, { maxOutputFrames: 2 });
    await app.start();
    assert.equal(app.adapter.writeAudio(Buffer.alloc(2880), { id: 'overflow', opening: false }), false);
  });
  await t.test('bounded input', async child => {
    const app = await fixture(child, { maxInputFrames: 2 });
    await app.start();
    app.peer.send(Buffer.alloc(640)); app.peer.send(Buffer.alloc(640)); app.peer.send(Buffer.alloc(640));
    await until(() => app.events.some(row => row.event.type === 'error'), 'input overflow was not detected');
    assert.equal(app.adapter.writeAudio(Buffer.alloc(960), { id: 'after-failure', opening: false }), false);
  });
  await t.test('wrong frame bytes', async child => {
    const app = await fixture(child);
    await app.start();
    app.peer.send(Buffer.alloc(1280));
    await until(() => app.events.some(row => row.event.type === 'error'), 'malformed audio was not rejected');
  });
  await t.test('wrong mark stream', async child => {
    const app = await fixture(child);
    await app.start();
    app.send('mark', { streamId: 'other-stream', playId: 'p', name: 'played' });
    await until(() => app.events.some(row => row.event.type === 'error'), 'wrong stream was not rejected');
    assert.equal(app.events.some(row => row.event.type === 'playback_drained'), false);
  });
  await t.test('nonfatal gateway loss', async child => {
    const app = await fixture(child);
    await app.start();
    app.send('error', { code: 'playout_overflow', message: 'dropped PCM', fatal: false });
    await until(() => app.events.some(row => row.event.type === 'error'), 'gateway PCM loss was ignored');
    assert.equal(app.adapter.capabilities.canConfirmPlaybackDrain, false);
    assert.equal(app.adapter.writeAudio(Buffer.alloc(960), { id: 'after-loss', opening: false }), false);
  });
  await t.test('handshake timeout', async child => {
    const app = await fixture(child, { handshakeTimeoutMs: 25 });
    await assert.rejects(app.adapter.ready, /握手超时/);
  });
  await t.test('disconnect', async child => {
    const app = await fixture(child);
    await app.start();
    app.peer.close();
    await until(() => app.events.some(row => row.event.type === 'close'), 'disconnect was not emitted');
    app.adapter.close(); app.adapter.close();
    assert.equal(app.events.filter(row => row.event.type === 'close').length, 1);
    assert.equal(app.adapter.completePlayback({ id: 'after-close', opening: false }), false);
  });
});

test('playing只记录已关联段一次，不解锁首句，clear后的迟到playing无效', async t => {
  const app = await fixture(t); await app.start();
  const first = { id: 'first-playing', opening: true, responseId: 'opening-response' };
  assert.equal(app.adapter.writeAudio(tone(1000, 960), first), true);
  app.send('mark', { playId: 'forged', name: 'playing' });
  app.send('mark', { playId: first.id, name: 'playing' });
  await barrier(app.peer);
  assert.equal(app.events.filter(row => row.event.type === 'playback_started').length, 0, 'mark before even one audio frame leaves Node is premature');
  await until(() => app.received.some(row => row.binary), 'no audio frame');
  app.send('mark', { playId: first.id, name: 'playing' });
  app.send('mark', { playId: first.id, name: 'playing' });
  await barrier(app.peer);
  assert.equal(app.events.filter(row => row.event.type === 'playback_started').length, 1);
  assert.equal(app.events.some(row => row.event.type === 'playback_drained'), false);
  assert.equal(app.adapter.clearPlayback(), false, 'playing must not release the protected opening');
  assert.equal(app.adapter.completePlayback(first), true);
  await until(() => app.controls().some(control => control.type === 'play_stop'), 'no stop');
  app.send('mark', { playId: first.id, name: 'played' }); await barrier(app.peer);
  const next = { id: 'cancelled-playing', opening: false };
  assert.equal(app.adapter.writeAudio(tone(800, 960), next), true);
  assert.equal(app.adapter.clearPlayback(), true);
  app.send('mark', { playId: next.id, name: 'playing' }); await barrier(app.peer);
  assert.equal(app.events.filter(row => row.event.type === 'playback_started').length, 1);
});
