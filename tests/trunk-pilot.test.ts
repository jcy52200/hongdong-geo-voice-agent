import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import type { EventFrame } from '@siphon-project/control';
import { readTrunkConfig } from '../server/telephony/trunk-config.js';
import { TrunkPilot } from '../server/telephony/trunk-pilot.js';
import { Store } from '../server/store.js';
import type { VoiceSessionManager } from '../server/voice/session.js';
import type { Recordings } from '../server/recordings.js';
import { mkdtemp, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readRecordingClosure } from '../server/telephony/recording-closure.js';

const env = { ALIYUN_TRUNK_HOST: '192.0.2.10', ALIYUN_TRUNK_PORT: '8000', ALIYUN_TRUNK_AUTH: 'ip',
  ALIYUN_TRUNK_CALLER: '01012345678', ALIYUN_TRUNK_TO_TEMPLATE: 'sip:{phone}@{host}:{port};transport=udp',
  ALIYUN_TRUNK_FROM_TEMPLATE: 'sip:{caller}@{public_ip}', ECS_PUBLIC_IP: '198.51.100.5',
  ALIYUN_SIP_SOURCE_CIDRS: '192.0.2.0/24', ALIYUN_RTP_SOURCE_CIDRS: '192.0.2.0/24',
  ALIYUN_TRUNK_LATE_OFFER_CONFIRMED: 'true', ALIYUN_TRUNK_ANSWER_IS_CUSTOMER_CONFIRMED: 'true',
  SIPHON_CONTROL_TOKEN: 'fixture-control-not-real', PILOT_TEST_PHONE: '+8613800000000' };

test('UDP直连配置独立于CCC凭据/分机，必须确认late offer、IP鉴权和接通语义', () => {
  const result = readTrunkConfig(env); assert.deepEqual(result.errors, []); assert.deepEqual(result.missing, []);
  assert.equal(result.config?.to, 'sip:13800000000@192.0.2.10:8000;transport=udp');
  assert.equal(result.config?.from, 'sip:01012345678@198.51.100.5');
  for (const key of ['ALIYUN_TRUNK_AUTH', 'ALIYUN_TRUNK_LATE_OFFER_CONFIRMED', 'ALIYUN_TRUNK_ANSWER_IS_CUSTOMER_CONFIRMED']) {
    assert.equal(readTrunkConfig({ ...env, [key]: '' }).config, undefined);
  }
});

test('拒绝未知目的地址、非UDP、无被叫占位符、恶意SIP头和放开全网', () => {
  for (const patch of [
    { ALIYUN_TRUNK_HOST: 'unknown.example' }, { ALIYUN_TRUNK_TRANSPORT: 'tcp' },
    { ALIYUN_TRUNK_TO_TEMPLATE: 'sip:another@192.0.2.10' }, { ALIYUN_TRUNK_FROM_TEMPLATE: 'sip:{missing}@example.com' },
    { ALIYUN_SIP_SOURCE_CIDRS: '0.0.0.0/0' }, { ALIYUN_SIP_SOURCE_CIDRS: '203.0.113.0/24' },
    { ALIYUN_TRUNK_HEADERS_JSON: '{"Via":"bad"}' }, { ALIYUN_TRUNK_HEADERS_JSON: '{"X-SP":"x\\r\\nVia:y"}' },
    { ALIYUN_TRUNK_HEADERS_JSON: '5' },
  ]) assert.equal(readTrunkConfig({ ...env, ...patch }).config, undefined);
});

async function fixture(t: TestContext) {
  const store = new Store(':memory:');
  const customer = store.importCustomers([{ camp: '联调测试公司', name: '测试', phone: env.PILOT_TEST_PHONE, address: '河北', industry: '门窗' }])[0];
  let listener: ((event: EventFrame) => void) | undefined;
  const calls: { verb: string; channel?: string; args: Record<string, unknown> }[] = [];
  let channel = '', attached = 0;
  const emit = (event: string, payload: Record<string, unknown> = {}, override: Partial<EventFrame> = {}) => {
    listener?.({ type: 'event', channel, sip_call_id: 'wire-call-id', event, payload, ...override });
  };
  const config = readTrunkConfig(env).config!;
  const voice = {
    observe: () => () => {}, runtime: () => ({ active: attached > 0 }),
    attachMedia: () => { attached++; }, notifyTelephoneAnswered: () => {},
    finish: (id: string) => store.status(id, 'completed'), fail: (id: string) => store.status(id, 'failed'),
  } as unknown as VoiceSessionManager;
  const gateway = {
    onEvent: (callback: typeof listener) => { listener = callback; return () => { listener = undefined; }; },
    originate: async (args: Record<string, unknown>) => { channel = String(args.channel); calls.push({ verb: 'originate', args }); return { channel, sip_call_id: 'wire-call-id' }; },
    command: async (id: string, verb: string, args: Record<string, unknown> = {}) => {
      calls.push({ verb, channel: id, args });
      if (verb === 'record_start') return { recording_id: 'recording-id' };
      if (verb === 'record_stop') emit('RecordingFinished', { recording_id: 'recording-id', path: argsForRecording(), reason: 'stopped' });
      if (verb === 'hangup') emit('StasisEnd', { code: 200 });
      return {};
    }, registrations: async () => ({}), close: async () => {},
  };
  let sessionId = '';
  const argsForRecording = () => `${sessionId}.wav`;
  const media = { authorize: () => ({ uri: 'ws://127.0.0.1/private-token', cancel: () => {}, ready: Promise.resolve({ close() {} } as any) }) };
  const recordings = { importGatewayWav: async () => ({ url: '/recording', mimeType: 'audio/wav', bytes: 640, createdAt: new Date().toISOString(), source: 'siphon' }) } as unknown as Recordings;
  const pilot = new TrunkPilot(store, voice, gateway, media, recordings, config);
  t.after(async () => { await pilot.close().catch(() => {}); store.close(); });
  const start = async () => { const session = await pilot.start(customer.id); sessionId = session.id; return session; };
  const settle = async () => { for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve)); };
  return { store, customer, pilot, calls, emit, start, settle, get attached() { return attached; } };
}

test('直连只发一次originate；振铃/早媒体不接通，不同通道或Call-ID不能触发模型', async t => {
  const app = await fixture(t); const session = await app.start();
  assert.equal(session.telephone?.provider, 'aliyun_udp_trunk'); assert.equal(session.answeredAt, undefined);
  assert.equal(app.calls[0].args.media, true); assert.equal(app.calls[0].args.next_hop, 'sip:192.0.2.10:8000;transport=udp');
  app.emit('ChannelStateChange', { state: 'progress', code: 183 });
  app.emit('ChannelStateChange', { state: 'answered' }, { channel: 'unrelated' });
  app.emit('ChannelStateChange', { state: 'answered' }, { sip_call_id: 'wrong' });
  await app.settle(); assert.equal(app.attached, 0); assert.equal(app.store.session(session.id)?.answeredAt, undefined);
  app.emit('ChannelStateChange', { state: 'answered', code: 200 }); await app.settle();
  assert.equal(app.attached, 1); assert.equal(app.store.session(session.id)?.answerSource, 'sip_gateway');
  assert.ok(app.calls.some(item => item.verb === 'stream_start' && item.args.mode === 'bridge'));
  assert.equal(app.calls.find(item => item.verb === 'stream_start')?.args.sample_rate, undefined, 'sample_rate is tee-only on the real gateway');
  await assert.rejects(app.pilot.start(app.customer.id), /不能重复/);
  const [a, b] = await Promise.all([app.pilot.stop(), app.pilot.stop()]);
  assert.equal(a.id, b.id); assert.equal(app.calls.filter(item => item.verb === 'hangup').length, 1);
  assert.equal(app.store.session(session.id)?.telephone?.cleanupStatus, 'confirmed');
  assert.equal(app.store.session(session.id)?.telephone?.recordingStatus, 'ready');
});

test('原生关闭事件凭据严格绑定通话/录音/路径，文件存在不等于完成', async t => {
  const root = await mkdtemp(join(tmpdir(), 'geo-closure-')); t.after(() => rm(root, { recursive: true, force: true }));
  const id = '01a9d35f-2d16-4239-961b-665c85685300', path = join(root, `${id}.wav.closed.json`);
  const record = { schema: 1, source: 'rtpengine.on_recording_finished', call_id: 'sip', recording_id: 'rec', path: join(root, `${id}.wav`), reason: 'call_ended' };
  assert.equal(await readRecordingClosure(root, id, 'sip', 'rec'), undefined);
  for (const patch of [{ call_id: 'another' }, { recording_id: 'another' }, { path: '/elsewhere.wav' }, { source: 'guessed_from_size' }]) {
    await writeFile(path, JSON.stringify({ ...record, ...patch })); assert.equal(await readRecordingClosure(root, id, 'sip', 'rec'), undefined);
  }
  await writeFile(path, JSON.stringify(record)); assert.equal((await readRecordingClosure(root, id, 'sip', 'rec'))?.reason, 'call_ended');
  const outside = join(root, 'untrusted'); await writeFile(outside, JSON.stringify(record)); await rm(path); await symlink(outside, path);
  assert.equal(await readRecordingClosure(root, id, 'sip', 'rec'), undefined);
});

test('未接客户挂机不建意向任务，其他测试手机号不能拨打', async t => {
  const app = await fixture(t); const other = app.store.importCustomers([{ camp: '其他', name: '其他', phone: '13900000000', address: '河北' }])[0];
  await assert.rejects(app.pilot.start(other.id), /固定测试手机/); assert.equal(app.calls.length, 0);
  const call = await app.start(); app.emit('StasisEnd', { code: 486 }); await app.pilot.finished;
  assert.equal(app.store.session(call.id)?.answeredAt, undefined); assert.equal(app.store.session(call.id)?.telephone?.state, 'busy');
  assert.equal(app.store.session(call.id)?.analysisStatus, 'not_requested');
});

test('终态但清理仍pending的历史记录阻止直接重拨', async t => {
  const app = await fixture(t);
  const previous = app.store.createTrunkSession(app.customer);
  app.store.updateTelephone(previous.id, { state: 'ended', cleanupStatus: 'pending' }); app.store.status(previous.id, 'completed');
  await assert.rejects(app.start(), /未知电话资源/);
  assert.equal(app.calls.length, 0);
});

test('直连会话不能由CCC或模型就绪伪造接通', () => {
  const store = new Store(':memory:');
  try {
    const c = store.createTrunkSession({ id: 'c', camp: '测试', phone: '13800000000', name: '测试', address: '河北' });
    store.markModelReady(c.id); store.answered(c.id); assert.equal(store.session(c.id)?.answeredAt, undefined);
    store.updateTelephone(c.id, { channelId: 'channel', sipCallId: 'sip-id', jobId: 'job' });
    assert.equal(store.telephoneAnswered(c.id, { jobId: 'job', customerChannelId: 'channel' }), undefined);
    assert.equal(store.trunkAnswered(c.id, { channelId: 'other', sipCallId: 'sip-id' }), undefined);
    assert.equal(store.trunkAnswered(c.id, { channelId: 'channel', sipCallId: 'sip-id' })?.answerSource, 'sip_gateway');
  } finally { store.close(); }
});
