import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { WebSocketServer, type WebSocket } from 'ws';
import type { EventFrame } from '@siphon-project/control';
import { SiphonControl } from '../server/telephony/siphon-control.js';
import { readPilotConfig } from '../server/telephony/pilot-config.js';

interface Command { id: string; type: string; module?: string; verb: string; target: unknown; args: Record<string, unknown> | null }
const NO_REPLY = Symbol('no-reply');
const token = 'synthetic-control-token-for-tests-only';

async function gateway(handler: (command: Command) => unknown = () => ({})) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const requests: Command[] = []; const headers: Array<{ authorization?: string; protocol: string }> = [];
  const sockets = new Set<WebSocket>(); const events = new EventEmitter(); let closed = false;
  server.on('connection', (socket, request) => {
    sockets.add(socket); socket.once('close', () => sockets.delete(socket)); socket.on('error', () => {});
    headers.push({ authorization: request.headers.authorization, protocol: socket.protocol });
    socket.on('message', raw => {
      const command = JSON.parse(raw.toString()) as Command; requests.push(command); events.emit('command', command);
      let result: unknown;
      if (command.verb === 'hello') result = { app: 'hongdong-pilot', protocol: 1, subprotocol: 'siphon-control.v1' };
      else if (command.verb === 'resync') result = { channels: [] };
      else result = handler(command);
      if (result === NO_REPLY) return;
      if (result && typeof result === 'object' && 'error' in result) socket.send(JSON.stringify({ id: command.id, type: 'reply', status: 'error', error: (result as { error: unknown }).error }));
      else socket.send(JSON.stringify({ id: command.id, type: 'reply', status: 'ok', result }));
    });
  });
  return {
    url: `ws://127.0.0.1:${(server.address() as { port: number }).port}/control/ws`, requests, headers,
    emit(frame: EventFrame) { for (const socket of sockets) socket.send(JSON.stringify(frame)); },
    waitCommand(verb: string, timeout = 10000): Promise<Command> {
      const existing = requests.find(command => command.verb === verb); if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const listener = (command: Command) => { if (command.verb === verb) { clearTimeout(timer); events.off('command', listener); resolve(command); } };
        const timer = setTimeout(() => { events.off('command', listener); reject(new Error(`No test command: ${verb}`)); }, timeout);
        events.on('command', listener);
      });
    },
    async close() {
      if (closed) return; closed = true;
      for (const socket of sockets) socket.terminate();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}

function nextEvent(control: SiphonControl, event: string, timeout = 10000): Promise<EventFrame> {
  return new Promise((resolve, reject) => {
    const unsubscribe = control.onEvent(frame => { if (frame.event === event) { clearTimeout(timer); unsubscribe(); resolve(frame); } });
    const timer = setTimeout(() => { unsubscribe(); reject(new Error(`No test event: ${event}`)); }, timeout);
  });
}

async function boundedClose(control: SiphonControl, limit = 1500) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([control.close(), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Control close exceeded bound')), limit); })]); }
  finally { clearTimeout(timer); }
}

test('SiphonControl uses real SDK handshake/correlation and forwards late RecordingFinished after StasisEnd', async t => {
  const mock = await gateway(command => {
    if (command.verb === 'outbound_registrations') {
      // This is a substrate verb, not a SIP adapter command (official SDK everyPage).
      if (command.module !== undefined || command.target !== null) return { error: { code: 'protocol_error', message: 'wrong registration envelope' } };
      return { registrations: [{ aor: 'sip:80000001@example.invalid', state: 'registered' }], next: null, seq: 1 };
    }
    if (command.verb === 'record_start') return { recording_id: 'test-recording' };
    if (command.verb === 'reject') return { error: { code: 'bad_request', message: 'private-test-provider-detail' } };
    return {};
  });
  let control: SiphonControl | undefined;
  t.after(async () => { await control?.close(); await mock.close(); });
  control = await SiphonControl.connect({ url: mock.url, token });
  assert.deepEqual(mock.headers, [{ authorization: `Bearer ${token}`, protocol: 'siphon-control.v1' }]);
  assert.deepEqual(mock.requests[0], { id: 'c-1', type: 'command', verb: 'hello', target: null, args: { app: 'hongdong-pilot', protocol: 1 } });
  assert.deepEqual(await control.registrations(), { registrations: [{ aor: 'sip:80000001@example.invalid', state: 'registered' }], next: null, seq: 1 });
  const recorded = await control.command('test-channel', 'record_start', { format: 'wav', direction: 'both', channels: 'stereo' });
  assert.equal(recorded.recording_id, 'test-recording');
  const request = mock.requests.find(command => command.verb === 'record_start')!;
  assert.equal(request.module, 'sip'); assert.deepEqual(request.target, { channel: 'test-channel' }); assert.equal(request.args?.format, 'wav');
  const received: string[] = []; control.onEvent(frame => received.push(frame.event));
  const ended = nextEvent(control, 'StasisEnd');
  mock.emit({ type: 'event', event: 'StasisEnd', channel: 'test-channel', sip_call_id: 'sip-test', payload: { reason: 'normal' } }); await ended;
  const finished = nextEvent(control, 'RecordingFinished');
  mock.emit({ type: 'event', event: 'RecordingFinished', channel: 'test-channel', sip_call_id: 'sip-test', payload: { recording_id: 'test-recording', path: '/recordings/fixture.wav', reason: 'call_ended' } });
  assert.deepEqual((await finished).payload, { recording_id: 'test-recording', path: '/recordings/fixture.wav', reason: 'call_ended' });
  assert.deepEqual(received, ['StasisEnd', 'RecordingFinished']);
  await assert.rejects(control.command('test-channel', 'reject', {}), error => error instanceof Error && !error.message.includes('private-test-provider-detail'));
  await boundedClose(control); await boundedClose(control);
});

test('control disconnect emits PilotControlFailed on describe health check and close remains bounded', { timeout: 12000 }, async t => {
  const mock = await gateway(); let control: SiphonControl | undefined;
  t.after(async () => { await control?.close(); await mock.close(); });
  control = await SiphonControl.connect({ url: mock.url, token });
  const failed = nextEvent(control, 'PilotControlFailed', 8000);
  await mock.close();
  assert.equal((await failed).event, 'PilotControlFailed');
  await boundedClose(control);
});

test('silent control peer times out the actual describe request after health interval and fails closed', { timeout: 14000 }, async t => {
  const mock = await gateway(command => command.verb === 'describe' ? NO_REPLY : {}); let control: SiphonControl | undefined;
  t.after(async () => { await control?.close(); await mock.close(); });
  const start = performance.now(); control = await SiphonControl.connect({ url: mock.url, token });
  const failed = nextEvent(control, 'PilotControlFailed', 10500);
  const describe = await mock.waitCommand('describe');
  assert.equal(describe.module, undefined); assert.equal(describe.target, null); assert.equal(describe.args, null);
  assert.equal((await failed).event, 'PilotControlFailed');
  assert.ok(performance.now() - start >= 6500, '2s health interval + real 5s SDK reply timeout');
  await boundedClose(control);
});

test('closing during an unanswered health request cancels pending work without waiting for its full timeout', { timeout: 6000 }, async t => {
  const mock = await gateway(command => command.verb === 'describe' ? NO_REPLY : {}); let control: SiphonControl | undefined;
  t.after(async () => { await control?.close(); await mock.close(); });
  control = await SiphonControl.connect({ url: mock.url, token });
  await mock.waitCommand('describe', 4000);
  await boundedClose(control);
});

test('pilot config requires bare registrar URI and RAM API credentials independently of the SIP login', () => {
  const env: NodeJS.ProcessEnv = {
    ALIBABA_CLOUD_ACCESS_KEY_ID: 'test-api-id', ALIBABA_CLOUD_ACCESS_KEY_SECRET: 'test-api-secret',
    ALIYUN_CCC_INSTANCE_ID: 'ccc-fixture', ALIYUN_CCC_USER_ID: 'agent@ccc-fixture', ALIYUN_CCC_CALLER: '669059400000002',
    ALIYUN_SIP_EXTENSION: '80000001', ALIYUN_SIP_PASSWORD: 'test-sip-password', ALIYUN_SIP_AUTH_USER: '80000001',
    ALIYUN_SIP_DOMAIN: 'sip.example.invalid', ALIYUN_SIP_REGISTRAR_URI: 'sip:sip.example.invalid:8443', ALIYUN_SIP_SOURCE_CIDRS: '192.0.2.0/24',
    SIPHON_CONTROL_TOKEN: token, PILOT_TEST_PHONE: '13800000000',
  };
  assert.ok(readPilotConfig(env).config);
  const malformed = readPilotConfig({ ...env, ALIYUN_SIP_REGISTRAR_URI: `${env.ALIYUN_SIP_REGISTRAR_URI};transport=tls` });
  assert.equal(malformed.config, undefined); assert.ok(malformed.errors.some(message => message.includes('ALIYUN_SIP_REGISTRAR_URI')));
  const { ALIBABA_CLOUD_ACCESS_KEY_ID: _id, ALIBABA_CLOUD_ACCESS_KEY_SECRET: _secret, ...sipOnly } = env;
  const withoutApi = readPilotConfig(sipOnly);
  assert.equal(withoutApi.config, undefined); assert.ok(withoutApi.missing.includes('ALIBABA_CLOUD_ACCESS_KEY_ID')); assert.ok(withoutApi.missing.includes('ALIBABA_CLOUD_ACCESS_KEY_SECRET'));
  assert.equal(JSON.stringify({ missing: withoutApi.missing, errors: malformed.errors }).includes('test-sip-password'), false);
});
