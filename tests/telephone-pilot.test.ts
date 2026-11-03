import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test, { type TestContext } from 'node:test';
import WebSocket, { WebSocketServer } from 'ws';
import type { EventFrame } from '@siphon-project/control';
import type { MediaInput, MediaPort, PlaybackSegment } from '../server/media/port.js';
import { SIPHON_DRAIN_PROTOCOL, SIPHON_DRAIN_SCOPE, type SiphonMediaAdapter } from '../server/media/siphon.js';
import { Recordings } from '../server/recordings.js';
import { Store } from '../server/store.js';
import { TelephoneMediaServer } from '../server/telephony/media-server.js';
import { TelephonePilot, type CccControl } from '../server/telephony/pilot.js';
import type { CccData } from '../server/telephony/aliyun.js';
import type { GatewayControl } from '../server/telephony/siphon-control.js';
import { VoiceSessionManager } from '../server/voice/session.js';

const TEST_PHONE = '13800000000';
const CALLER = '01000000000';
const EXTENSION = 'pilot-test-extension';
const JOB = 'job-fixture';
const CHANNEL = 'gateway-fixture';
const SIP_CALL = 'sip-fixture';
const INSTANCE = 'instance-fixture';
const USER = 'seat-fixture';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  void promise.catch(() => {});
  return { promise, resolve, reject };
}
async function until(predicate: () => boolean, message = '等待测试事件超时') {
  const deadline = Date.now() + 2500;
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail(message);
    await new Promise(resolve => setTimeout(resolve, 3));
  }
}

function customerStatus(state: string): CccData {
  return { CallContext: { InstanceId: INSTANCE, JobId: JOB, ChannelContexts: [
    { ChannelId: 'seat-leg', UserId: USER, Destination: EXTENSION, ChannelState: 'ANSWERED', Timestamp: Date.now() },
    { ChannelId: 'customer-leg', Destination: TEST_PHONE, JobId: JOB, ChannelState: state, Timestamp: Date.now() },
  ] } };
}
function seatOnly(): CccData {
  return { CallContext: { InstanceId: INSTANCE, JobId: JOB, ChannelContexts: [
    { ChannelId: 'seat-leg', UserId: USER, Destination: EXTENSION, ChannelState: 'ANSWERED', Timestamp: Date.now() },
  ] } };
}

class FakeCcc implements CccControl {
  preflight: CccData = { CallContext: null, UserContext: { UserId: USER, InstanceId: INSTANCE, UserState: 'READY' } };
  status: CccData = customerStatus('RINGING');
  outbound: CccData = { List: [{ Number: CALLER }] };
  made: { callee: string }[] = [];
  released: string[] = [];
  polls = 0;
  lists: number[] = [];
  makeFailure?: Error;
  pendingMake?: ReturnType<typeof deferred<CccData>>;
  pendingPreflight?: ReturnType<typeof deferred<CccData>>;
  releaseFailure?: Error;
  async makeCall(input: { callee: string }): Promise<CccData> {
    this.made.push(input);
    if (this.makeFailure) throw this.makeFailure;
    if (this.pendingMake) return this.pendingMake.promise;
    return { CallContext: { InstanceId: INSTANCE, JobId: JOB } };
  }
  async pollUserStatus(): Promise<CccData> { return ++this.polls === 1 ? this.pendingPreflight?.promise ?? this.preflight : this.status; }
  async releaseCall(input: { jobId: string }): Promise<CccData> {
    this.released.push(input.jobId);
    if (this.releaseFailure) throw this.releaseFailure;
    return {};
  }
  async listOutboundNumbersOfUser(input: { pageNumber?: number } = {}): Promise<CccData> { this.lists.push(input.pageNumber ?? 1); return this.outbound; }
}
class FakeGateway implements GatewayControl {
  listeners = new Set<(event: EventFrame) => void>();
  commands: { channel: string; verb: string; args: Record<string, unknown> }[] = [];
  onCommand?: (command: FakeGateway['commands'][number]) => void;
  commandFailure?: string;
  hangingCommand?: string;
  onEvent(listener: (event: EventFrame) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  emit(event: string, payload: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
    for (const listener of [...this.listeners]) listener({ type: 'event', event, channel: CHANNEL, app: 'hongdong-pilot', sip_call_id: SIP_CALL, payload, ...extra } as EventFrame);
  }
  async command(channel: string, verb: string, args: Record<string, unknown> = {}) {
    const command = { channel, verb, args };
    this.commands.push(command); this.onCommand?.(command);
    if (this.commandFailure === verb) throw new Error('fixture gateway command failure');
    if (this.hangingCommand === verb) return new Promise<Record<string, unknown>>(() => {});
    return verb === 'record_start' ? { recording_id: 'recording-fixture' } : {};
  }
  async registrations() { return {}; }
  async close() {}
}
class FakeMedia implements MediaPort {
  readonly capabilities = { canConfirmPlaybackDrain: true };
  readonly listeners = new Set<(event: MediaInput) => void>();
  closes = 0;
  onEvent(listener: (event: MediaInput) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  emit(event: MediaInput) { for (const listener of [...this.listeners]) listener(event); }
  writeAudio(_pcm: Buffer, _segment: PlaybackSegment) { return true; }
  completePlayback(_segment: PlaybackSegment) { return true; }
  clearPlayback() { return true; }
  close() { this.closes++; }
}
class FakeMediaServer {
  readonly port = new FakeMedia();
  readonly pending = deferred<SiphonMediaAdapter>();
  authorizations: { sessionId: string; callId: string }[] = [];
  cancels = 0;
  authorize = (sessionId: string, callId: string) => {
    this.authorizations.push({ sessionId, callId });
    return { uri: 'ws://127.0.0.1:1/fixture-only', ready: this.pending.promise, cancel: () => { this.cancels++; this.pending.reject(new Error('cancelled')); } };
  };
  ready() { this.pending.resolve(this.port as unknown as SiphonMediaAdapter); }
}
class FakeRecordings extends Recordings {
  imports: { id: string; source: string; root: string; incomplete?: boolean }[] = [];
  constructor() { super('/tmp/geo-telephone-test-unused-archive'); }
  override async importGatewayWav(id: string, source: string, root: string, options: { incomplete?: boolean } = {}) {
    this.imports.push({ id, source, root, ...options });
    return { url: `/api/sessions/${id}/recording`, mimeType: 'audio/wav', bytes: 64044, createdAt: new Date().toISOString(), source: 'siphon' as const, channels: 2, sampleRate: 16000, duration: 1, incomplete: options.incomplete ?? false };
  }
}

async function fixture(t: TestContext, options: { cleanupTimeoutMs?: number } = {}) {
  const cloud = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(cloud, 'listening');
  const store = new Store(':memory:');
  const voice = new VoiceSessionManager(store, 'fixture-only-key', `ws://127.0.0.1:${(cloud.address() as AddressInfo).port}`);
  const customers = store.importCustomers([
    { camp: '模拟门窗公司', name: '测试人', phone: TEST_PHONE, address: '河北', industry: '门窗' },
    { camp: '模拟机械公司', name: '非测试人', phone: '13900000000', address: '河北', industry: '机械' },
  ]);
  const customer = customers.find(value => value.phone === TEST_PHONE)!;
  const other = customers.find(value => value.phone !== TEST_PHONE)!;
  const api = new FakeCcc(); const gateway = new FakeGateway(); const media = new FakeMediaServer(); const recordings = new FakeRecordings();
  const pilot = new TelephonePilot(store, voice, api, gateway, media, recordings, {
    ccc: { instanceId: INSTANCE, userId: USER, caller: CALLER }, extension: EXTENSION, testPhone: TEST_PHONE,
    recordingRoot: '/tmp/geo-telephone-test-unused-recordings', gatewayRecordingRoot: '/recordings',
    pollMs: 5, unknownTimeoutMs: 1000, ringTimeoutMs: 10000, recordingTimeoutMs: 20,
    ...options,
  });
  let peer: WebSocket | undefined;
  const model: { type: string; [key: string]: any }[] = [];
  cloud.on('connection', socket => {
    peer = socket; socket.on('error', () => {});
    socket.on('message', raw => {
      const message = JSON.parse(raw.toString()); model.push(message);
      if (message.type === 'session.close') { socket.send(JSON.stringify({ type: 'session.closed' })); socket.close(); }
    });
  });
  const invite = () => gateway.emit('StasisStart', { invite: { ruri: `sip:${EXTENSION}@example.invalid` }, vars: { pilot_source: 'aliyun_ccc', pilot_seat: EXTENSION } });
  const connect = async () => { invite(); await until(() => media.authorizations.length > 0); media.ready(); await until(() => model.some(message => message.type === 'session.create')); };
  const created = () => peer!.send(JSON.stringify({ type: 'session.created', session: { id: 'model-fixture' } }));
  t.after(async () => {
    await pilot.close().catch(() => {});
    await voice.shutdown();
    for (const socket of cloud.clients) socket.terminate();
    await new Promise<void>(resolve => cloud.close(() => resolve()));
    store.close();
  });
  return { store, voice, customer, other, api, gateway, media, recordings, pilot, model, invite, connect, created };
}

test('单通测试仅允许测试手机，经空坐席和精确主叫授权后只发起一次MakeCall', async t => {
  const app = await fixture(t);
  await assert.rejects(app.pilot.start(app.other.id), /指定测试手机/);
  assert.equal(app.api.polls, 0); assert.equal(app.api.made.length, 0);
  const results = await Promise.allSettled([app.pilot.start(app.customer.id), app.pilot.start(app.customer.id)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.deepEqual(app.api.made, [{ callee: TEST_PHONE }]);
  assert.ok(app.api.lists.length > 0);
  await assert.rejects(app.pilot.start(app.customer.id), /占用/);
  assert.equal(app.api.made.length, 1);
});

test('坐席已有通话或主叫不在授权列表时不调用MakeCall', async t => {
  await t.test('occupied seat', async child => {
    const app = await fixture(child);
    app.api.preflight = { CallContext: { JobId: 'existing-job' } };
    await assert.rejects(app.pilot.start(app.customer.id), /坐席当前存在通话/);
    assert.equal(app.api.made.length, 0);
  });
  await t.test('occupied UserContext', async child => {
    const app = await fixture(child);
    app.api.preflight = { UserContext: { InstanceId: INSTANCE, UserId: USER, JobId: 'existing-job' } };
    await assert.rejects(app.pilot.start(app.customer.id));
    assert.equal(app.api.made.length, 0);
  });
  await t.test('missing UserContext', async child => {
    const app = await fixture(child);
    app.api.preflight = {};
    await assert.rejects(app.pilot.start(app.customer.id));
    assert.equal(app.api.made.length, 0);
  });
  await t.test('wrong seat identity', async child => {
    const app = await fixture(child);
    for (const context of [
      { InstanceId: 'other-instance', UserId: USER },
      { InstanceId: INSTANCE, UserId: 'other-user' },
      { InstanceId: INSTANCE },
    ]) {
      app.api.polls = 0;
      app.api.preflight = { UserContext: context };
      await assert.rejects(app.pilot.start(app.customer.id));
    }
    assert.equal(app.api.made.length, 0);
  });
  await t.test('unauthorized caller', async child => {
    const app = await fixture(child);
    app.api.outbound = { List: [{ Number: '01099999999' }] };
    await assert.rejects(app.pilot.start(app.customer.id), /主叫未在/);
    assert.equal(app.api.made.length, 0);
  });
});

test('SIP和模型已就绪，坐席answered或未知客户状态均不能触发开场，客户接通才开始', async t => {
  const app = await fixture(t);
  app.api.status = seatOnly();
  const call = await app.pilot.start(app.customer.id);
  await app.connect(); app.created();
  await until(() => !!app.store.session(call.id)?.modelReadyAt);
  assert.equal(app.store.session(call.id)?.answeredAt, undefined);
  assert.equal(app.model.some(message => message.type === 'speech_text_buffer.commit'), false);
  app.api.status = {};
  const before = app.api.polls;
  await until(() => app.api.polls > before + 2);
  assert.equal(app.store.session(call.id)?.answeredAt, undefined);
  assert.equal(app.model.some(message => message.type === 'speech_text_buffer.commit'), false);
  app.api.status = customerStatus('ANSWERED');
  await until(() => app.model.some(message => message.type === 'speech_text_buffer.commit'));
  const answered = app.store.session(call.id)!;
  assert.equal(answered.answerSource, 'ccc_customer'); assert.equal(answered.telephone?.customerChannelId, 'customer-leg');
  assert.ok(answered.answeredAt); assert.equal(answered.status, 'opening');
  const polls = app.api.polls;
  await until(() => app.api.polls > polls + 2);
  assert.equal(app.model.filter(message => message.type === 'speech_text_buffer.commit').length, 1);
});

test('客户已answered仍等待mediaReady与modelReady，两项齐备后才允许固定开场', async t => {
  const app = await fixture(t);
  app.api.status = customerStatus('ANSWERED');
  const call = await app.pilot.start(app.customer.id);
  await until(() => !!app.store.session(call.id)?.answeredAt);
  app.invite(); await until(() => app.media.authorizations.length === 1);
  assert.equal(app.model.length, 0, 'pending media must not initialize the model');
  app.media.ready();
  await until(() => app.model.some(message => message.type === 'session.create'));
  assert.equal(app.model.some(message => message.type === 'speech_text_buffer.commit'), false);
  app.created();
  await until(() => app.model.some(message => message.type === 'speech_text_buffer.commit'));
  assert.equal(app.model.filter(message => message.type === 'speech_text_buffer.commit').length, 1);
});

test('stop幂等关闭媒体并只释放一次CCC和网关，录音仅RecordingFinished后导入', async t => {
  const app = await fixture(t);
  const call = await app.pilot.start(app.customer.id);
  await app.connect();
  assert.equal(app.recordings.imports.length, 0);
  app.gateway.emit('RecordingFinished', { recording_id: 'unrelated', path: `/recordings/${call.id}.wav`, reason: 'stopped' });
  await until(() => app.gateway.commands.some(command => command.verb === 'record_start'));
  assert.equal(app.recordings.imports.length, 0);
  const first = app.pilot.stop(); const second = app.pilot.stop();
  assert.equal(first, second);
  await until(() => app.gateway.commands.some(command => command.verb === 'record_stop'));
  assert.equal(app.recordings.imports.length, 0);
  app.gateway.emit('RecordingFinished', { recording_id: 'recording-fixture', path: `/recordings/${call.id}.wav`, reason: 'stopped' });
  await first;
  assert.equal(app.gateway.commands.filter(command => command.verb === 'record_stop').length, 1);
  assert.equal(app.gateway.commands.filter(command => command.verb === 'hangup').length, 1);
  assert.deepEqual(app.api.released, [JOB]); assert.equal(app.media.port.closes, 1);
  assert.equal(app.recordings.imports.length, 1); assert.equal(app.recordings.imports[0].incomplete, false);
  assert.equal(app.store.session(call.id)?.telephone?.recordingStatus, 'ready');
  app.gateway.emit('RecordingFinished', { recording_id: 'recording-fixture', path: `/recordings/${call.id}.wav`, reason: 'stopped' });
  assert.equal(app.recordings.imports.length, 1);
});

test('媒体错误触发失败收尾和远端挂断，不把桥断开当正常客户挂机', async t => {
  const app = await fixture(t);
  const call = await app.pilot.start(app.customer.id);
  await app.connect();
  app.media.port.emit({ type: 'error', message: 'fixture bridge failed' });
  await until(() => app.api.released.length > 0 && app.gateway.commands.some(command => command.verb === 'hangup'));
  assert.equal(app.store.session(call.id)?.status, 'failed');
  assert.equal(app.store.session(call.id)?.telephone?.endedReason, 'voice_error');
  assert.equal(app.api.made.length, 1);
});

test('未经路由标记的SIP邀请被拒绝，合法StasisEnd正常结束并避免重复hangup', async t => {
  const app = await fixture(t);
  const call = await app.pilot.start(app.customer.id);
  app.gateway.emit('StasisStart', { invite: { ruri: `sip:${EXTENSION}@example.invalid` } }, { channel: 'untrusted-channel' });
  await until(() => app.gateway.commands.some(command => command.channel === 'untrusted-channel' && command.verb === 'reject'));
  assert.equal(app.media.authorizations.length, 0);
  await app.connect();
  app.gateway.emit('StasisEnd', { reason: 'normal_clearing', code: 200 });
  await until(() => app.api.released.length === 1);
  assert.equal(app.gateway.commands.filter(command => command.verb === 'hangup').length, 0);
  assert.equal(app.store.session(call.id)?.status, 'completed');
  assert.equal(app.store.session(call.id)?.telephone?.endedReason, 'sip_hangup');
});

test('释放CCC失败保留cleanup未知状态，新的pilot也不能绕过历史资源核对', async t => {
  const app = await fixture(t);
  const call = await app.pilot.start(app.customer.id);
  await app.connect();
  app.api.releaseFailure = new Error('fixture release outcome unknown');
  await assert.rejects(app.pilot.stop(), /清理未全部确认/);
  assert.equal(app.store.session(call.id)?.telephone?.cleanupStatus, 'unknown');
  app.gateway.emit('StasisEnd', { reason: 'normal_clearing', code: 200 });
  assert.equal(app.store.session(call.id)?.telephone?.cleanupStatus, 'unknown');
  const second = new TelephonePilot(app.store, app.voice, app.api, app.gateway, app.media, app.recordings, {
    ccc: { instanceId: INSTANCE, userId: USER, caller: CALLER }, extension: EXTENSION, testPhone: TEST_PHONE,
    recordingRoot: '/tmp/geo-telephone-test-unused-recordings', gatewayRecordingRoot: '/recordings',
  });
  t.after(() => second.close());
  await assert.rejects(second.start(app.customer.id), /资源状态未知的历史电话/);
  assert.equal(app.api.made.length, 1);
});

test('MakeCall结果未知不自动重试，并持久化unknown以阻止直接重拨', async t => {
  const app = await fixture(t);
  app.api.makeFailure = new Error('fixture network timeout after write');
  await assert.rejects(app.pilot.start(app.customer.id), /禁止直接重拨/);
  assert.equal(app.api.made.length, 1);
  const calls = app.store.listSessions({ page: 1, pageSize: 10, answeredOnly: false, dateField: 'createdAt', sortBy: 'createdAt', sortDir: 'desc' });
  assert.equal(calls.items.length, 1);
  assert.equal(calls.items[0].telephone?.state, 'unknown');
  assert.equal(calls.items[0].answeredAt, undefined);
  await assert.rejects(app.pilot.start(app.customer.id));
  assert.equal(app.api.made.length, 1); assert.equal(app.api.released.length, 0);
});

test('MakeCall仍等待回复时stop等待迟到JobId且仅释放一次，不遗留异步拨号', async t => {
  const app = await fixture(t);
  app.api.pendingMake = deferred<CccData>();
  const starting = app.pilot.start(app.customer.id); void starting.catch(() => {});
  await until(() => app.api.made.length === 1);
  let stopped = false;
  const stopping = app.pilot.stop().then(call => { stopped = true; return call; });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(stopped, false, 'cleanup cannot finish while an already dispatched MakeCall is unconfirmed');
  app.api.pendingMake.resolve({ CallContext: { InstanceId: INSTANCE, JobId: JOB } });
  const [started, ended] = await Promise.all([starting, stopping]);
  assert.equal(started.id, ended.id); assert.equal(ended.status, 'completed');
  assert.deepEqual(app.api.released, [JOB]); assert.equal(app.api.made.length, 1);
  assert.equal(app.model.length, 0);
  assert.equal(app.store.session(ended.id)?.telephone?.jobId, JOB);
  assert.equal((await app.pilot.finished).id, ended.id);
  await app.pilot.close();
  assert.deepEqual(app.api.released, [JOB]);
});

test('用户在预检等待期间关闭pilot，迟到预检结果不会再拨出电话', async t => {
  const app = await fixture(t);
  app.api.pendingPreflight = deferred<CccData>();
  const starting = app.pilot.start(app.customer.id); void starting.catch(() => {});
  await until(() => app.api.polls === 1);
  await app.pilot.close();
  app.api.pendingPreflight.resolve(app.api.preflight);
  await assert.rejects(starting, /关闭/);
  assert.equal(app.api.made.length, 0);
  assert.equal(app.gateway.listeners.size, 0);
});

test('停止时SQLite写入失败也尝试所有远端释放，并保留错误/有界拒绝finished', async t => {
  const app = await fixture(t, { cleanupTimeoutMs: 100 });
  await app.pilot.start(app.customer.id); await app.connect();
  const update = app.store.updateTelephone.bind(app.store);
  const failure = new Error('fixture SQLite write failed');
  app.store.updateTelephone = () => { throw failure; };
  try {
    await assert.rejects(app.pilot.stop(), (error: unknown) => error instanceof AggregateError && error.errors.includes(failure));
    await assert.rejects(app.pilot.finished, /清理未全部确认/);
    assert.equal(app.gateway.commands.filter(command => command.verb === 'record_stop').length, 1);
    assert.equal(app.gateway.commands.filter(command => command.verb === 'hangup').length, 1);
    assert.deepEqual(app.api.released, [JOB]);
    await assert.rejects(app.pilot.close(), /关闭未全部确认/);
    assert.equal(app.gateway.listeners.size, 0, 'close must unsubscribe even when stop rejected');
  } finally { app.store.updateTelephone = update; }
});

test('MakeCall成功后的首次落库故障仍释放已知JobId，不遗留已拨出的外部电话', async t => {
  const app = await fixture(t, { cleanupTimeoutMs: 100 });
  const update = app.store.updateTelephone.bind(app.store);
  app.store.updateTelephone = (id, patch) => {
    if (patch.jobId) throw new Error('fixture job persistence failed');
    return update(id, patch);
  };
  try {
    await assert.rejects(app.pilot.start(app.customer.id), /禁止直接重拨/);
    assert.deepEqual(app.api.released, [JOB]);
    assert.equal(app.api.made.length, 1);
    assert.equal(app.model.length, 0);
  } finally { app.store.updateTelephone = update; }
});

test('网关释放请求悬挂不阻止CCC释放，finished与close有时限且最后退订', async t => {
  const app = await fixture(t, { cleanupTimeoutMs: 30 });
  await app.pilot.start(app.customer.id); await app.connect();
  app.gateway.hangingCommand = 'hangup';
  const began = Date.now();
  await assert.rejects(app.pilot.stop(), /清理未全部确认/);
  assert.ok(Date.now() - began < 500, 'a stuck gateway must not hang shutdown indefinitely');
  assert.deepEqual(app.api.released, [JOB]);
  assert.equal(app.gateway.commands.filter(command => command.verb === 'record_stop').length, 1);
  await assert.rejects(app.pilot.finished, /清理未全部确认/);
  await assert.rejects(app.pilot.close(), /关闭未全部确认/);
  assert.equal(app.gateway.listeners.size, 0);
});

test('网关RecordingFinished早于record_start回复时仍可归档一次', async t => {
  const app = await fixture(t);
  const call = await app.pilot.start(app.customer.id);
  app.gateway.onCommand = command => {
    if (command.verb === 'record_start') app.gateway.emit('RecordingFinished', { recording_id: 'recording-fixture', path: `/recordings/${call.id}.wav`, reason: 'stopped' });
  };
  await app.connect();
  await until(() => app.recordings.imports.length === 1, 'early RecordingFinished was lost');
  assert.equal(app.store.session(call.id)?.telephone?.recordingStatus, 'ready');
});

async function rejectedUpgrade(uri: string) {
  const ws = new WebSocket(uri); ws.on('error', () => {});
  const result = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('expected rejected upgrade')), 1000);
    ws.once('unexpected-response', (_request, response) => { clearTimeout(timer); response.resume(); resolve(response.statusCode!); ws.terminate(); });
    ws.once('open', () => { clearTimeout(timer); ws.terminate(); reject(new Error('unexpected authorized socket')); });
  });
  return result;
}
async function mediaServerFixture(t: TestContext) {
  const server = new TelephoneMediaServer(); await server.listen(0);
  const peers: WebSocket[] = [];
  t.after(async () => { for (const peer of peers) peer.terminate(); await server.close(); });
  const connect = async (uri: string) => { const peer = new WebSocket(uri); peers.push(peer); peer.on('error', () => {}); await once(peer, 'open'); return peer; };
  const handshake = (peer: WebSocket, callId = SIP_CALL) => peer.send(JSON.stringify({ type: 'start', data: {
    streamId: 'stream-fixture', callId, direction: 'duplex',
    media: { encoding: 'L16', bitDepth: 16, endianness: 'little', sampleRate: 16000, channels: 1, ptime: 20 },
    metadata: { playbackDrainProtocol: SIPHON_DRAIN_PROTOCOL, playbackDrainScope: SIPHON_DRAIN_SCOPE },
  } }));
  return { server, connect, handshake };
}

test('私有媒体授权token仅用一次并绑定sipCallId，未授权URL返回403', async t => {
  const app = await mediaServerFixture(t);
  const ticket = app.server.authorize('session-fixture', SIP_CALL);
  assert.equal(await rejectedUpgrade(ticket.uri.replace(/[^/]+$/, 'invalid-token')), 403);
  const peer = await app.connect(ticket.uri); app.handshake(peer);
  const adapter = await ticket.ready;
  assert.equal(adapter.capabilities.canConfirmPlaybackDrain, true);
  assert.equal(await rejectedUpgrade(ticket.uri), 403);
  adapter.close();
  const wrong = app.server.authorize('session-other', SIP_CALL);
  const other = await app.connect(wrong.uri); app.handshake(other, 'another-call');
  await assert.rejects(wrong.ready, /关联校验失败/);
  assert.equal(await rejectedUpgrade(wrong.uri), 403);
});

test('媒体票据过期、取消和服务关闭使ready拒绝，并禁止连接重用', async t => {
  const app = await mediaServerFixture(t);
  const expired = app.server.authorize('expired-fixture', SIP_CALL, 20);
  await assert.rejects(expired.ready, /时限/);
  assert.equal(await rejectedUpgrade(expired.uri), 403);
  const cancelled = app.server.authorize('cancelled-fixture', SIP_CALL);
  cancelled.cancel(); await assert.rejects(cancelled.ready, /取消/);
  assert.equal(await rejectedUpgrade(cancelled.uri), 403);
  const closing = app.server.authorize('closing-fixture', SIP_CALL);
  const rejected = assert.rejects(closing.ready, /停止/);
  await app.server.close(); await rejected;
});

test('已upgrade但尚未握手的媒体授权也能立即撤销', async t => {
  const app = await mediaServerFixture(t);
  const ticket = app.server.authorize('inflight-fixture', SIP_CALL);
  await app.connect(ticket.uri); ticket.cancel();
  let timer!: ReturnType<typeof setTimeout>;
  try {
    await Promise.race([
      assert.rejects(ticket.ready, /取消/),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('in-flight media cancellation did not reject ready')), 200); }),
    ]);
  } finally { clearTimeout(timer); }
});
