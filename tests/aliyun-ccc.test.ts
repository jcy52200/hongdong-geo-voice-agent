import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import { AliyunCccClient, AliyunCccError, normalizeCccCall, signAcs3Request, type CccData } from '../server/telephony/aliyun.js';
import { readAliyunCccConfig, type AliyunCccConfig } from '../server/telephony/aliyun-config.js';

const config: AliyunCccConfig = {
  accessKeyId: 'test-id', accessKeySecret: 'test-secret', regionId: 'cn-shanghai', endpoint: 'ccc.cn-shanghai.aliyuncs.com',
  instanceId: 'ccc-test', userId: 'agent@ccc-test', caller: '01012345678', deviceId: 'hongdong-pilot', timeoutMs: 1000,
};
const expected = { instanceId: 'ccc-test', jobId: 'job-test', callee: '13800138000' };
function context(state: string, overrides: Record<string, unknown> = {}): CccData {
  return { CallContext: { InstanceId: expected.instanceId, JobId: expected.jobId, ChannelContexts: [
    { ChannelId: 'seat-leg', UserId: config.userId, Destination: '80000001', ChannelState: 'ANSWERED', Timestamp: 1793650000000 },
    { ChannelId: 'customer-leg', UserId: '', Destination: expected.callee, JobId: expected.jobId, ChannelState: state, Timestamp: 1793650001000, ...overrides },
  ] } };
}

test('ACS3 signer matches the official Alibaba Cloud fixed-parameter test vector', () => {
  // https://help.aliyun.com/zh/sdk/product-overview/v3-request-structure-and-signature
  const signed = signAcs3Request({ host: 'ecs.cn-shanghai.aliyuncs.com', action: 'RunInstances', version: '2014-05-26',
    accessKeyId: 'YourAccessKeyId', accessKeySecret: 'YourAccessKeySecret', date: '2023-10-26T10:22:32Z',
    nonce: '3156853299f313e23d1673dc12e1703d', query: { RegionId: 'cn-shanghai', ImageId: 'win2019_1809_x64_dtc_zh-cn_40G_alibase_20230811.vhd' } });
  assert.equal(signed.query, 'ImageId=win2019_1809_x64_dtc_zh-cn_40G_alibase_20230811.vhd&RegionId=cn-shanghai');
  assert.equal(signed.headers.authorization, 'ACS3-HMAC-SHA256 Credential=YourAccessKeyId,SignedHeaders=host;x-acs-action;x-acs-content-sha256;x-acs-date;x-acs-signature-nonce;x-acs-version,Signature=06563a9e1b43f5dfe96b81484da74bceab24a1d853912eee15083a6f0f3283c0');
});

test('ACS3 signs STS token and uses RFC3986 query escaping with stable ordering', () => {
  const input = { host: config.endpoint, action: 'MakeCall', version: '2020-07-01', accessKeyId: config.accessKeyId,
    accessKeySecret: config.accessKeySecret, securityToken: 'test-sts', date: '2026-11-03T00:00:00Z', nonce: 'test-nonce', query: { UserId: 'a+b@ccc-test', Tags: "中 文!*'()" } };
  const signed = signAcs3Request(input);
  assert.equal(signed.query, 'Tags=%E4%B8%AD%20%E6%96%87%21%2A%27%28%29&UserId=a%2Bb%40ccc-test');
  assert.equal(signed.headers['x-acs-security-token'], 'test-sts');
  assert.ok(signed.headers.authorization.includes('x-acs-security-token;'));
  assert.notEqual(signed.headers.authorization, signAcs3Request({ ...input, securityToken: 'other-sts' }).headers.authorization);
});

test('platform number discovery is read-only, preserves demo numbers exactly and validates pagination', async () => {
  let request: URL | undefined;
  const client = new AliyunCccClient({ ...config, fetch: async (url, init) => {
    request = new URL(String(url)); assert.equal(new Headers(init?.headers).get('x-acs-action'), 'ListOutboundNumbersOfUser');
    return Response.json({ Code: 'OK', Data: { PageNumber: 1, PageSize: 100, TotalCount: 1, List: [{ Number: '669059400000002' }] } });
  } });
  assert.equal((await client.listOutboundNumbersOfUser()).List?.[0].Number, '669059400000002');
  assert.equal(request?.searchParams.get('InstanceId'), config.instanceId); assert.equal(request?.searchParams.get('UserId'), config.userId);
  assert.equal(request?.searchParams.get('PageSize'), '100'); assert.equal(request?.searchParams.has('Callee'), false);
  assert.throws(() => client.listOutboundNumbersOfUser({ pageSize: 101 }), (error: unknown) => error instanceof AliyunCccError && error.code === 'configuration');
});

test('manual CCC adapter sends official POST RPC query parameters and never sends SIP secrets', async () => {
  const requests: Array<{ url: string; headers: Record<string, unknown>; body: string }> = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    requests.push({ url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString() });
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ Code: 'OK', HttpStatusCode: 200, Data: context('RINGING') }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  const client = new AliyunCccClient({ ...config, securityToken: 'test-sts', now: () => new Date('2026-11-03T00:00:00Z'), nonce: () => 'fixed-nonce',
    fetch: async (url, init) => { const parsed = new URL(String(url)); return fetch(`http://127.0.0.1:${port}${parsed.pathname}${parsed.search}`, init); } });
  try {
    await client.makeCall({ callee: expected.callee }); await client.pollUserStatus(); await client.releaseCall({ jobId: expected.jobId, channelId: 'customer-leg' });
    assert.equal(requests.length, 3);
    const query = new URL(requests[0].url, 'https://mock').searchParams;
    assert.equal(query.get('Callee'), expected.callee); assert.equal(query.get('Caller'), config.caller);
    assert.equal(query.get('UserId'), config.userId); assert.equal(query.get('InstanceId'), config.instanceId);
    assert.equal(query.get('DeviceId'), config.deviceId); assert.equal(query.get('TimeoutSeconds'), '60'); assert.equal(query.get('MediaType'), 'AUDIO');
    assert.equal(query.has('Password'), false); assert.equal(requests[0].body, '');
    assert.equal(requests[0].headers['x-acs-action'], 'MakeCall'); assert.equal(requests[1].headers['x-acs-action'], 'PollUserStatus');
    assert.equal(requests[2].headers['x-acs-action'], 'ReleaseCall'); assert.equal(new URL(requests[2].url, 'https://mock').searchParams.get('ChannelId'), 'customer-leg');
    assert.equal(requests[0].headers['x-acs-security-token'], 'test-sts');
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test('CCC configuration distinguishes RAM API identity from SIP extension and redacts invalid values', () => {
  const env: NodeJS.ProcessEnv = { ALIBABA_CLOUD_ACCESS_KEY_ID: 'id', ALIBABA_CLOUD_ACCESS_KEY_SECRET: 'secret', ALIYUN_CCC_INSTANCE_ID: 'ccc-test', ALIYUN_CCC_USER_ID: 'agent@ccc-test', ALIYUN_CCC_CALLER: '01012345678' };
  const result = readAliyunCccConfig(env); assert.ok(result.config); assert.deepEqual(result.missing, []); assert.deepEqual(result.errors, []);
  assert.equal(result.config.endpoint, 'ccc.cn-shanghai.aliyuncs.com');
  assert.ok(readAliyunCccConfig({ ...env, ALIYUN_CCC_USER_ID: '80000001' }).errors.some((message) => message.includes('不能填写 SIP 分机号')));
  assert.ok(readAliyunCccConfig({ ...env, ALIYUN_CCC_ENDPOINT: 'evil.example' }).errors.length);
  assert.ok(readAliyunCccConfig({ ...env, ALIYUN_CCC_TIMEOUT_MS: 'NaN' }).errors.length);
  const invalid = readAliyunCccConfig({ ...env, ALIBABA_CLOUD_ACCESS_KEY_SECRET: 'do-not-reflect\r\n' });
  assert.ok(!JSON.stringify(invalid).includes('do-not-reflect'));
  assert.deepEqual(readAliyunCccConfig({ ALIYUN_SIP_EXTENSION: '80000001', ALIYUN_SIP_PASSWORD: 'sip-password' }).missing.sort(), Object.keys(env).sort());
});

test('MakeCall does not retry unknown outcomes and provider errors never reflect sensitive body/error data', async () => {
  const cases: Array<{ run: () => Promise<Response>; code: string; unknown: boolean }> = [
    { run: async () => { throw new Error('test-secret phone 13800138000'); }, code: 'network', unknown: true },
    { run: async () => new Response('test-secret phone 13800138000', { status: 500 }), code: 'provider', unknown: true },
    { run: async () => new Response('test-secret phone 13800138000', { status: 403 }), code: 'provider', unknown: false },
    { run: async () => Response.json({ Code: 'InvalidOperation.UserState', Message: 'test-secret phone 13800138000' }), code: 'provider', unknown: false },
    { run: async () => Response.json({ Code: 'test-secret', Message: '13800138000' }), code: 'provider', unknown: true },
    { run: async () => new Response('test-secret phone 13800138000'), code: 'invalid_response', unknown: true },
    { run: async () => Response.json({ Code: 'OK', Data: {} }), code: 'invalid_response', unknown: true },
  ];
  for (const item of cases) {
    let requests = 0; const client = new AliyunCccClient({ ...config, fetch: async () => { requests += 1; return item.run(); } });
    await assert.rejects(client.makeCall({ callee: expected.callee }), (error: unknown) => error instanceof AliyunCccError && error.code === item.code && error.outcomeUnknown === item.unknown && !/test-secret|13800138000/.test(`${error.message} ${error.providerCode ?? ''}`));
    assert.equal(requests, 1);
  }
});

test('CCC cancellation prevents dispatch and in-flight timeout preserves unknown MakeCall outcome', async () => {
  let requested = false;
  const client = new AliyunCccClient({ ...config, fetch: async () => { requested = true; throw new Error('should not happen'); } });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(client.makeCall({ callee: expected.callee }, controller.signal), (error: unknown) => error instanceof AliyunCccError && error.code === 'cancelled' && !error.outcomeUnknown);
  assert.equal(requested, false);
  const slow = new AliyunCccClient({ ...config, timeoutMs: 100, fetch: async (_url, init) => new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal; signal?.addEventListener('abort', () => reject(new Error('test-secret')), { once: true });
    // Keep the test process alive: AbortSignal.timeout uses an unref timer.
    const keepAlive = setTimeout(() => reject(new Error('mock timed out')), 1000); signal?.addEventListener('abort', () => clearTimeout(keepAlive), { once: true });
  }) });
  await assert.rejects(slow.makeCall({ callee: expected.callee }), (error: unknown) => error instanceof AliyunCccError && error.code === 'timeout' && error.outcomeUnknown);
});

test('customer-leg normalization accepts only matched job/instance/number, never seat answer or early media', () => {
  for (const state of ['CREATED', 'NONE', 'RINGING', 'EARLY_MEDIA', 'ANSWERED', 'RELEASED', 'RETIRED']) {
    const normalized = normalizeCccCall(context(state), expected);
    assert.equal(normalized.answered, state === 'ANSWERED'); assert.equal(normalized.ended, state === 'RELEASED' || state === 'RETIRED');
    assert.equal(normalized.customerChannelId, 'customer-leg'); assert.equal(normalized.serverTime, new Date(1793650001000).toISOString());
  }
  assert.equal(normalizeCccCall(context('ANSWERED', { Destination: '+8613800138000' }), expected).answered, true);
  for (const data of [
    {}, { CallContext: null },
    { CallContext: { ...context('ANSWERED').CallContext, InstanceId: 'other-instance' } },
    { CallContext: { ...context('ANSWERED').CallContext, JobId: 'other-job' } },
    context('ANSWERED', { Destination: '13900139000' }), context('ANSWERED', { UserId: config.userId }), context('ANSWERED', { JobId: 'other-job' }),
  ]) {
    assert.equal(normalizeCccCall(data, expected).status, 'unknown'); assert.equal(normalizeCccCall(data, expected).answered, false); assert.equal(normalizeCccCall(data, expected).ended, false);
  }
});

test('normalization preserves terminal evidence but never invents answer time from release or local clock', () => {
  const released = normalizeCccCall(context('RELEASED', { ReleaseReason: '486 - Busy Here', Timestamp: undefined }), expected);
  assert.equal(released.releaseCode, 486); assert.equal(released.ended, true); assert.equal(released.answered, false); assert.equal(released.serverTime, undefined);
  const ambiguous = context('ANSWERED'); ambiguous.CallContext!.ChannelContexts!.push({ ...ambiguous.CallContext!.ChannelContexts![1], ChannelId: 'another-customer-leg' });
  assert.equal(normalizeCccCall(ambiguous, expected).phase, 'unknown');
});
