import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { DeepSeekClient, DeepSeekError } from '../server/deepseek.js';
import { conversationFacts, finalizeAnalysis, type AnalysisInput, type AnalysisOutput } from '../server/analysis.js';
import type { Transcript } from '../server/types.js';

const customer = { id: 'c1', camp: '河北某某门窗有限公司', name: '老板', phone: '13800138000', address: '河北' };
function item(id: string, kind: Transcript['kind'], text: string): Transcript {
  return { id, kind, text, final: true, createdAt: '2026-11-01T00:00:00Z' };
}
const call = (transcripts: Transcript[], status = 'completed'): AnalysisInput => ({ id: 's1', customer, transcripts, status, endReason: status === 'failed' ? 'transport_error' : 'local_finish' });
function output(overrides: Partial<AnalysisOutput> = {}): AnalysisOutput {
  return { grade: 'E', summary: '待评估客户', reason: '缺少客户意向证据', evidence: [], wechat: { consent: false, phone: null, sameAsDialed: false, identifier: null }, ...overrides };
}
async function provider(run: (client: DeepSeekClient, requests: any[]) => Promise<void>, content: unknown, options: { status?: number; finishReason?: string; raw?: boolean } = {}) {
  const requests: any[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    requests.push({ url: req.url, authorization: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString()) });
    res.statusCode = options.status ?? 200;
    res.setHeader('content-type', 'application/json');
    res.end(options.raw ? String(content) : JSON.stringify({ choices: [{ finish_reason: options.finishReason ?? 'stop', message: { content: typeof content === 'string' ? content : JSON.stringify(content) } }] }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  const client = new DeepSeekClient({ apiKey: 'test-secret-not-real', baseUrl: `http://127.0.0.1:${port}/v1` });
  try { await run(client, requests); } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
}

test('industry inference sends company names only with strict JSON mode and joins exact IDs', async () => {
  await provider(async (client, requests) => {
    assert.deepEqual(await client.inferIndustries([customer, { id: 'c2', camp: '某某科技有限公司' }]), [{ id: 'c2', industry: '未知' }, { id: 'c1', industry: '门窗' }]);
    const request = requests[0];
    assert.equal(request.url, '/v1/chat/completions');
    assert.equal(request.body.model, 'deepseek-flash');
    assert.deepEqual(request.body.thinking, { type: 'disabled' });
    assert.deepEqual(request.body.response_format, { type: 'json_object' });
    assert.deepEqual(JSON.parse(request.body.messages[1].content), { customers: [{ id: 'c1', camp: customer.camp }, { id: 'c2', camp: '某某科技有限公司' }] });
    assert.ok(!request.body.messages[1].content.includes(customer.phone));
  }, { customers: [{ id: 'c2', industry: 'unknown' }, { id: 'c1', industry: '门窗' }] });
});

test('industry rejects missing, duplicate and invented IDs rather than updating wrong customer', async () => {
  for (const customers of [[{ id: 'invented', industry: '门窗' }], [{ id: 'c1', industry: '门窗' }, { id: 'c1', industry: '门窗' }], []]) {
    await provider(async (client) => { await assert.rejects(client.inferIndustries([customer]), /不匹配/); }, { customers });
  }
});

test('provider refuses empty, non-JSON and truncated results and hides server error bodies', async () => {
  for (const [value, options] of [[' ', {}], ['```json\n{}\n```', {}], ['{"customers":[]}', { finishReason: 'length' }], ['secret-reflected-value', { status: 401, raw: true }]] as const) {
    await provider(async (client) => {
      await assert.rejects(client.inferIndustries([customer]), (error: unknown) => error instanceof DeepSeekError && !error.message.includes('secret-reflected-value'));
    }, value, options);
  }
});

test('caller-supplied cancellation prevents a network request', async () => {
  let requested = false;
  const client = new DeepSeekClient({ apiKey: 'key', fetch: async () => { requested = true; throw new Error('should not run'); } });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(client.inferIndustries([customer], controller.signal), (error: unknown) => error instanceof DeepSeekError && error.code === 'cancelled');
  assert.equal(requested, false);
});

test('meaningful turn counts merge ASR fragments and ignore filler responses', () => {
  const facts = conversationFacts([
    item('a1', 'ChatText', '您好'), item('u1', 'AsrText', '嗯啊'), item('u2', 'AsrText', '不了解'), item('u3', 'AsrText', '你讲一下'),
    item('a2', 'ChatText', '介绍一下'), item('u4', 'AsrText', '多少钱'), item('u5', 'AsrText', '一年呢'),
    { ...item('u6', 'AsrText', '还有啥'), final: false },
  ]);
  assert.equal(facts.customerTurns, 2); assert.equal(facts.assistantTurns, 2);
});

test('A requires actual customer consent and confirmed same-number WeChat evidence', () => {
  const input = call([
    item('a1', 'ChatText', '我加您微信发个行业案例，可以吗？'), item('u1', 'AsrText', '可以，你加吧'),
    item('a2', 'ChatText', '现在打的这个电话，就是您的微信绑定手机号吗？'), item('u2', 'AsrText', '对，就是这个号'),
  ]);
  const result = finalizeAnalysis(input, output({ grade: 'A', evidence: [{ transcriptId: 'u1', quote: '可以，你加吧' }, { transcriptId: 'u2', quote: '对，就是这个号' }], wechat: { consent: true, phone: '13800138000', sameAsDialed: true, identifier: null } }), 'test-model');
  assert.equal(result.grade, 'A'); assert.equal(result.wechat.phone, customer.phone); assert.equal(result.wechat.sameAsDialed, true);
  const fake = finalizeAnalysis(input, output({ grade: 'A', evidence: [{ transcriptId: 'u1', quote: '可以，你加吧' }], wechat: { consent: true, phone: '13911112222', sameAsDialed: false, identifier: null } }), 'test-model');
  assert.equal(fake.grade, 'B'); assert.equal(fake.wechat.phone, null);
});

test('alternate WeChat phone is accepted only when the customer actually gave it', () => {
  const input = call([
    item('a1', 'ChatText', '可以加您微信发行业案例吗？'), item('u1', 'AsrText', '可以'),
    item('a2', 'ChatText', '您微信绑定的手机号是现在打的号码吗？'), item('u2', 'AsrText', '不是，我微信是 139 1111 2222'),
  ]);
  const result = finalizeAnalysis(input, output({ grade: 'A', evidence: [{ transcriptId: 'u1', quote: '可以' }, { transcriptId: 'u2', quote: '不是，我微信是 139 1111 2222' }], wechat: { consent: true, phone: '13911112222', sameAsDialed: false, identifier: null } }), 'test');
  assert.equal(result.grade, 'A'); assert.equal(result.wechat.phone, '13911112222'); assert.equal(result.wechat.sameAsDialed, false);
});

test('two meaningful customer rounds override rejection; early completed hangup C; transport failure E', () => {
  const engaged = call([item('a1', 'ChatText', '了解吗'), item('u1', 'AsrText', '不需要'), item('a2', 'ChatText', '可以发您行业案例'), item('u2', 'AsrText', '什么行业案例')]);
  assert.equal(finalizeAnalysis(engaged, output({ grade: 'C', evidence: [{ transcriptId: 'u1', quote: '不需要' }] }), 'test').grade, 'B');
  const opening = [item('a1', 'ChatText', '您好，您了解吗')];
  assert.equal(finalizeAnalysis(call(opening), output(), 'test').grade, 'C');
  assert.equal(finalizeAnalysis(call(opening, 'failed'), output({ grade: 'C' }), 'test').grade, 'E');
});

test('model may not cite sales text or hallucinate customer quotes', async () => {
  const input = call([item('a1', 'ChatText', '您肯定很感兴趣吧'), item('u1', 'AsrText', '不用了')]);
  for (const evidence of [[{ transcriptId: 'a1', quote: '感兴趣' }], [{ transcriptId: 'u1', quote: '可以加微信' }]]) {
    await provider(async (client) => { await assert.rejects(client.analyzeCall(input), /无效客户证据/); }, output({ grade: 'A', evidence }));
  }
});

test('DeepSeek analysis returns server-computed facts and model metadata', async () => {
  const input = call([item('a1', 'ChatText', '您好'), item('u1', 'AsrText', '我开会呢，明天再说')]);
  await provider(async (client, requests) => {
    const result = await client.analyzeCall(input);
    assert.equal(result.grade, 'D'); assert.equal(result.customerTurns, 1); assert.equal(result.model, 'deepseek-flash');
    assert.ok(!Number.isNaN(Date.parse(result.evaluatedAt)));
    assert.equal(JSON.parse(requests[0].body.messages[1].content).customer.camp, customer.camp);
  }, output({ grade: 'D', evidence: [{ transcriptId: 'u1', quote: '我开会呢' }] }));
});

test('latest WeChat revocation clears consent and contacts even when omitted from model evidence', () => {
  const transcripts = [
    item('a1', 'ChatText', '我加您微信发个行业案例，可以吗？'), item('u1', 'AsrText', '嗯，是的，可以'),
    item('a2', 'ChatText', '现在打的这个电话，就是您的微信绑定手机号吗？'), item('u2', 'AsrText', '嗯，是的'),
    item('a3', 'ChatText', '那我一会儿加您'), item('u3', 'AsrText', '算了别加我微信了'),
  ];
  const raw = output({ grade: 'A', evidence: [{ transcriptId: 'u1', quote: '嗯，是的，可以' }, { transcriptId: 'u2', quote: '嗯，是的' }], wechat: { consent: true, phone: customer.phone, sameAsDialed: true, identifier: null } });
  const beforeRevocation = finalizeAnalysis(call(transcripts.slice(0, 4)), raw, 'test');
  assert.equal(beforeRevocation.grade, 'A'); assert.equal(beforeRevocation.customerTurns, 2);
  const revoked = finalizeAnalysis(call(transcripts), raw, 'test');
  assert.notEqual(revoked.grade, 'A');
  assert.deepEqual(revoked.wechat, { consent: false, phone: null, sameAsDialed: false, identifier: null });
  const grantedAgain = [...transcripts, item('a4', 'ChatText', '好的，了解'), item('u4', 'AsrText', '还是加我微信吧，同号就行')];
  const result = finalizeAnalysis(call(grantedAgain), { ...raw, evidence: [...raw.evidence, { transcriptId: 'u4', quote: '还是加我微信吧，同号就行' }] }, 'test');
  assert.equal(result.grade, 'A'); assert.equal(result.wechat.phone, customer.phone);
  const onlyConsentAgain = [...transcripts, item('a4', 'ChatText', '好的'), item('u4', 'AsrText', '还是加我微信吧')];
  const needsFreshContact = finalizeAnalysis(call(onlyConsentAgain), { ...raw, evidence: [...raw.evidence, { transcriptId: 'u4', quote: '还是加我微信吧' }] }, 'test');
  assert.notEqual(needsFreshContact.grade, 'A'); assert.equal(needsFreshContact.wechat.phone, null);
});

test('busy, assistant and abusive customer evidence retain their distinct grades', () => {
  for (const [grade, text] of [
    ['D', '我在开会呢，明天再联系我'],
    ['F', '您好，我是机主的智能电话助理，请在提示音后留言'],
    ['G', '你有病吧，给我滚'],
  ] as const) {
    const result = finalizeAnalysis(call([item('a1', 'ChatText', '您好，了解吗'), item('u1', 'AsrText', text)]), output({ grade, evidence: [{ transcriptId: 'u1', quote: text }] }), 'test');
    assert.equal(result.grade, grade);
  }
});
