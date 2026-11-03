import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Store } from '../server/store.js';
import { MAX_GATEWAY_RECORDING_BYTES, MAX_RECORDING_BYTES, RecordingError, Recordings } from '../server/recordings.js';

const customer = { id: 'fixture-only', camp: '测试门窗厂', name: '测试联系人', phone: '13800000000', address: '河北', industry: '门窗' };
const id = '73e4052a-b447-4123-9dcb-22736edf4cf9';
function pcm16Wav(channels = 2, rate = 16000, samples = 1600): Buffer {
  const data = Buffer.alloc(samples * channels * 2); const body = Buffer.alloc(44 + data.length);
  body.write('RIFF', 0); body.writeUInt32LE(body.length - 8, 4); body.write('WAVEfmt ', 8); body.writeUInt32LE(16, 16);
  body.writeUInt16LE(1, 20); body.writeUInt16LE(channels, 22); body.writeUInt32LE(rate, 24);
  body.writeUInt32LE(rate * channels * 2, 28); body.writeUInt16LE(channels * 2, 32); body.writeUInt16LE(16, 34);
  body.write('data', 36); body.writeUInt32LE(data.length, 40); data.copy(body, 44); return body;
}

test('dedicated SIP session preserves customer/prompt snapshots and cannot be marked answered by model/browser events', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const call = store.createTelephoneSession(customer);
  assert.equal(call.mode, 'seed'); assert.equal(call.transport, 'sip'); assert.equal(call.status, 'created');
  assert.deepEqual(call.telephone, { provider: 'aliyun_ccc', gateway: 'siphon', state: 'prepared', recordingStatus: 'pending' });
  assert.equal(call.answeredAt, undefined); assert.equal(call.analysisStatus, 'not_requested'); assert.deepEqual(call.customer, customer);
  store.markModelReady(call.id); store.answered(call.id);
  assert.ok(store.session(call.id)?.modelReadyAt); assert.equal(store.session(call.id)?.answeredAt, undefined);
  store.updateTelephone(call.id, { jobId: 'job-test', state: 'dialing' });
  store.updateTelephone(call.id, { state: 'answered' });
  assert.equal(store.session(call.id)?.telephone?.state, 'dialing', 'only proven customer answer can establish answered metadata');
  assert.equal(store.telephoneAnswered(call.id, { jobId: 'different-job', customerChannelId: 'customer-1' }), undefined);
  assert.equal(store.telephoneAnswered(call.id, { jobId: 'job-test', customerChannelId: 'customer-1', at: 'invalid' }), undefined);
  assert.equal(store.telephoneAnswered(call.id, { jobId: 'job-test', customerChannelId: 'customer-1', at: '2020-01-01T00:00:00Z' }), undefined);
  const at = new Date().toISOString();
  const answered = store.telephoneAnswered(call.id, { jobId: 'job-test', customerChannelId: 'customer-1', at })!;
  assert.equal(answered.answeredAt, at); assert.equal(answered.answerSource, 'ccc_customer'); assert.equal(answered.telephone?.customerChannelId, 'customer-1');
  assert.equal(answered.telephone?.state, 'answered');
  assert.equal(store.telephoneAnswered(call.id, { jobId: 'job-test', customerChannelId: 'other-channel' }), undefined);
  assert.equal(store.telephoneAnswered(call.id, { jobId: 'job-test', customerChannelId: 'customer-1' })?.answeredAt, at);
  store.status(call.id, 'completed', undefined, 'customer_hangup');
  assert.equal(store.session(call.id)?.analysisStatus, 'pending');
  assert.equal(store.claimAnalysis()?.session.id, call.id);
  const browser = store.createSession(customer, 'seed');
  assert.equal(browser.transport, 'browser'); assert.equal(browser.telephone, undefined);
  assert.equal(store.telephoneAnswered(browser.id, { jobId: 'job-test', customerChannelId: 'customer-1' }), undefined);
  assert.equal(store.session(browser.id)?.answeredAt, undefined);
});

test('telephone state and identifiers never regress, terminal recordings may be finalized later', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const call = store.createTelephoneSession(customer);
  store.updateTelephone(call.id, { state: 'dialing', jobId: 'job-test', channelId: 'gateway-1', sipCallId: 'sip-1' });
  store.updateTelephone(call.id, { state: 'ringing' }); store.updateTelephone(call.id, { state: 'prepared' });
  assert.equal(store.session(call.id)?.telephone?.state, 'ringing');
  assert.equal(store.updateTelephone(call.id, { jobId: 'different-job' }), undefined);
  assert.equal(store.updateTelephone(call.id, { channelId: 'different-channel' }), undefined);
  store.updateTelephone(call.id, { jobId: undefined, channelId: undefined });
  assert.equal(store.session(call.id)?.telephone?.jobId, 'job-test'); assert.equal(store.session(call.id)?.telephone?.channelId, 'gateway-1');
  store.updateTelephone(call.id, { state: 'busy', endedReason: '486' }); store.status(call.id, 'failed', undefined, 'busy');
  store.updateTelephone(call.id, { state: 'dialing', recordingStatus: 'recording' });
  assert.equal(store.session(call.id)?.telephone?.state, 'busy');
  store.updateTelephone(call.id, { recordingStatus: 'ready' }); store.updateTelephone(call.id, { recordingStatus: 'failed' });
  assert.equal(store.session(call.id)?.telephone?.recordingStatus, 'ready');
  assert.equal(store.telephoneAnswered(call.id, { jobId: 'job-test', customerChannelId: 'customer-1' }), undefined);
  assert.equal(store.session(call.id)?.analysisStatus, 'not_requested'); assert.equal(store.claimAnalysis(), undefined);
  const listed = store.listSessions({ page: 1, pageSize: 10, answeredOnly: false, dateField: 'createdAt', sortBy: 'createdAt', sortDir: 'desc' });
  assert.equal(listed.items[0].telephone?.jobId, 'job-test'); assert.equal(listed.items[0].telephone?.state, 'busy');
  const closed = store.createTelephoneSession(customer); store.updateTelephone(closed.id, { state: 'dialing' }); store.status(closed.id, 'failed');
  store.updateTelephone(closed.id, { state: 'ended' }); assert.equal(store.session(closed.id)?.telephone?.state, 'ended', 'gateway termination can be written after voice-core cleanup');
});

test('restart preserves SIP correlation but marks live resources unknown without faking answer or resuming a call', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'geo-sip-store-')); const path = join(directory, 'calls.sqlite');
  let store = new Store(path); t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  const call = store.createTelephoneSession(customer); store.status(call.id, 'connecting');
  store.updateTelephone(call.id, { state: 'dialing', jobId: 'job-test', channelId: 'gateway-1', sipCallId: 'sip-1', recordingStatus: 'recording' });
  store.markModelReady(call.id); store.event(call.id, 'session.created', { ready: true });
  const configSnapshot = store.session(call.id)!.configSnapshot; store.close(); store = new Store(path);
  const after = store.session(call.id)!;
  assert.equal(after.status, 'failed'); assert.equal(after.endReason, 'service_restart'); assert.equal(after.telephone?.state, 'unknown');
  assert.equal(after.telephone?.jobId, 'job-test'); assert.equal(after.telephone?.channelId, 'gateway-1'); assert.equal(after.telephone?.sipCallId, 'sip-1');
  assert.equal(after.telephone?.recordingStatus, 'failed'); assert.equal(after.answeredAt, undefined); assert.equal(after.answerSource, undefined);
  assert.deepEqual(after.configSnapshot, configSnapshot); assert.equal(after.analysisStatus, 'not_requested'); assert.equal(store.claimAnalysis(), undefined);
  store.close(); store = new Store(path); assert.deepEqual(store.session(call.id), after);
});

test('gateway recording imports original WAV atomically with PCM metadata and private permissions', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'geo-sip-wav-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, 'source.wav'); const body = pcm16Wav(); await writeFile(source, body);
  const recordings = new Recordings(join(directory, 'archive'));
  const metadata = await recordings.importGatewayWav(id, source, directory);
  assert.equal(metadata.mimeType, 'audio/wav'); assert.equal(metadata.source, 'siphon'); assert.equal(metadata.bytes, body.length);
  assert.equal(metadata.channels, 2); assert.equal(metadata.sampleRate, 16000); assert.equal(metadata.duration, 0.1); assert.equal(metadata.incomplete, false);
  assert.equal(metadata.url, `/api/sessions/${id}/recording`); assert.equal(JSON.stringify(metadata).includes(directory), false);
  assert.deepEqual(await readFile(recordings.path(id, metadata.mimeType)), body); assert.equal((await stat(recordings.path(id, metadata.mimeType))).mode & 0o777, 0o600);
  const partial = await recordings.importGatewayWav(id, source, directory, { incomplete: true }); assert.equal(partial.incomplete, true);
  assert.deepEqual(await readdir(recordings.directory), [`${id}.wav`]); assert.deepEqual(await readFile(source), body, 'original gateway file is retained');
  await assert.rejects(recordings.save(id, body, 'audio/wav'), (error: unknown) => error instanceof RecordingError && error.status === 415, 'browser upload format remains restricted');
  assert.equal(MAX_RECORDING_BYTES, 25 * 1024 * 1024);
});

test('gateway WAV import rejects out-of-root, symlink, directory, oversized, truncated and non-PCM files', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'geo-sip-wav-guard-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const outside = await mkdtemp(join(tmpdir(), 'geo-sip-wav-outside-')); t.after(() => rm(outside, { recursive: true, force: true }));
  const recordings = new Recordings(join(directory, 'archive'));
  const source = join(directory, 'source.wav'); const external = join(outside, 'external.wav'); const link = join(directory, 'linked.wav');
  await writeFile(source, pcm16Wav()); await writeFile(external, pcm16Wav()); await symlink(source, link);
  const rejects = async (path: string, status?: number) => assert.rejects(recordings.importGatewayWav(id, path, directory), (error: unknown) => error instanceof RecordingError && (status === undefined || error.status === status) && !error.message.includes(directory));
  await rejects(external); await rejects(link); await rejects(directory);
  await writeFile(source, 'not a WAV'); await rejects(source, 415);
  for (const mutate of [
    (body: Buffer) => body.writeUInt16LE(3, 20),
    (body: Buffer) => body.writeUInt16LE(24, 34),
    (body: Buffer) => body.writeUInt32LE(0xffffffff, 40),
    (body: Buffer) => body.writeUInt32LE(100, 24),
    (body: Buffer) => body.writeUInt32LE(1234, 28),
    (body: Buffer) => body.writeUInt16LE(3, 22),
  ]) { const body = pcm16Wav(); mutate(body); await writeFile(source, body); await rejects(source, 415); }
  await writeFile(source, pcm16Wav().subarray(0, 100)); await rejects(source, 415);
  await truncate(source, MAX_GATEWAY_RECORDING_BYTES + 1); await rejects(source, 413);
  await assert.rejects(recordings.importGatewayWav('../invalid-id', source, directory), RecordingError);
  await assert.rejects(stat(recordings.directory), { code: 'ENOENT' });
});

test('telephone RTP playback facts correlate response IDs and finalize idempotently without rewriting start time', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const call = store.createTelephoneSession(customer);
  assert.deepEqual(call.playbacks, []);
  const segment = { id: 'playback-one', responseId: 'response-one', opening: true };
  store.playback(call.id, segment, 'started');
  const started = store.session(call.id)!.playbacks![0];
  assert.equal(started.scope, 'gateway_rtp_egress'); assert.equal(started.drainedAt, undefined);
  store.playback(call.id, segment, 'started'); store.playback(call.id, segment, 'drained');
  store.playback(call.id, segment, 'drained');
  const facts = store.session(call.id)!.playbacks!;
  assert.equal(facts.length, 1); assert.equal(facts[0].startedAt, started.startedAt); assert.ok(facts[0].drainedAt);
  assert.equal(facts[0].responseId, 'response-one');
  const text = store.transcript(call.id, 'response-one', 'ChatText', '测试输出', true);
  assert.equal(text.responseId, 'response-one'); assert.equal(store.transcripts(call.id)[0].responseId, 'response-one');
  const browser = store.createSession(customer, 'seed'); store.playback(browser.id, segment, 'started');
  assert.equal(store.session(browser.id)!.playbacks, undefined); assert.deepEqual(store.playbacks(browser.id), []);
});
