import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { Store } from "../server/store.js";
import { readDashboard } from "../server/dashboard.js";
import { createApp } from "../server/app.js";
import type { CallAnalysis } from "../shared/analysis.js";
const customer = {
  id: "customer",
  camp: "测试门窗公司",
  name: "测试客户",
  phone: "13800000000",
  address: "河北",
  industry: "门窗",
};
const analysis: CallAnalysis = {
  grade: "A",
  summary: "测试同号",
  reason: "测试证据",
  evidence: [],
  wechat: {
    consent: true,
    sameAsDialed: true,
    phone: customer.phone,
    identifier: null,
  },
  customerTurns: 2,
  assistantTurns: 2,
  model: "mock",
  evaluatedAt: "2026-11-01T12:00:00.000Z",
};

test("工作台统计全量语音数据，排除文字预演、未接通意向和重新评估中的旧结果", (t) => {
  const store = new Store(":memory:");
  t.after(() => store.close());
  store.importCustomers([
    customer,
    { ...customer, phone: "13900000000", industry: "未知" },
    { ...customer, phone: "13700000000", industry: "" },
  ]);
  for (let i = 0; i < 114; i++) {
    const call = store.createSession(customer, i < 112 ? "seed" : "simulation");
    if (i < 110) store.answered(call.id);
    store.status(call.id, i === 111 ? "failed" : "completed");
    store.db
      .prepare(
        "UPDATE sessions SET created_at=?,answered_at=?,ended_at=? WHERE id=?",
      )
      .run(
        "2026-11-01T12:00:00.000Z",
        i < 110 ? "2026-11-01T12:00:10.000Z" : null,
        "2026-11-01T12:01:10.000Z",
        call.id,
      );
    if (i < 105)
      store.completeAnalysis(call.id, {
        ...analysis,
        grade: i < 5 ? "A" : "B",
      });
    if (i === 0) store.enqueueAnalysis(call.id, true);
    if (i === 1)
      store.saveRecording(call.id, {
        mimeType: "audio/webm",
        bytes: 1024,
        createdAt: analysis.evaluatedAt,
        url: "/recording",
      });
  }
  const previous = store.createSession(customer, "seed");
  store.answered(previous.id);
  store.status(previous.id, "completed");
  store.db
    .prepare("UPDATE sessions SET created_at=? WHERE id=?")
    .run("2026-10-25T12:00:00.000Z", previous.id);
  const dashboard = readDashboard(store, {
    from: "2026-10-26T16:00:00.000Z",
    to: "2026-11-02T16:00:00.000Z",
    offsetMinutes: 480,
  });
  assert.equal(dashboard.calls.total, 112);
  assert.equal(dashboard.calls.answered, 110);
  assert.equal(dashboard.calls.ended, 110);
  assert.equal(dashboard.calls.analyzed, 104);
  assert.equal(dashboard.calls.pending, 6);
  assert.equal(dashboard.calls.notConnected, 1);
  assert.equal(dashboard.calls.recorded, 1);
  assert.equal(dashboard.calls.durationSeconds, 6600);
  assert.equal(dashboard.grades.A, 4);
  assert.equal(dashboard.grades.B, 100);
  assert.equal(dashboard.previous.answered, 1);
  assert.equal(dashboard.recent.length, 8);
  assert.equal(dashboard.leads.length, 8);
  assert.ok(
    dashboard.leads.every((call) => call.analysisStatus === "completed"),
  );
  assert.equal(dashboard.daily.length, 7);
  assert.equal(
    dashboard.daily.find((day) => day.date === "2026-11-01")?.answered,
    110,
  );
  assert.equal(dashboard.customers.total, 3);
  assert.equal(dashboard.customers.industryReady, 1);
  assert.equal(dashboard.customers.industryUnknown, 1);
  assert.equal(dashboard.customers.industryMissing, 1);
});

test("工作台按本地日期聚合并包含空白日期，接口校验范围且不暴露模型密钥", async (t) => {
  const runtime = createApp({
    databasePath: ":memory:",
    apiKey: "fake-seed-key",
  });
  runtime.server.listen(0, "127.0.0.1");
  await once(runtime.server, "listening");
  t.after(() => runtime.close());
  for (const time of ["2026-11-01T15:59:59.999Z", "2026-11-01T16:00:00.000Z"]) {
    const call = runtime.store.createSession(customer, "seed");
    runtime.store.answered(call.id);
    runtime.store.status(call.id, "completed");
    runtime.store.db
      .prepare("UPDATE sessions SET created_at=? WHERE id=?")
      .run(time, call.id);
  }
  const base = `http://127.0.0.1:${(runtime.server.address() as any).port}/api/dashboard`;
  const query = new URLSearchParams({
    from: "2026-10-31T16:00:00.000Z",
    to: "2026-11-03T16:00:00.000Z",
    offsetMinutes: "480",
  });
  const response = await fetch(`${base}?${query}`);
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.deepEqual(
    data.daily.map((day: any) => [day.date, day.total]),
    [
      ["2026-11-01", 1],
      ["2026-11-02", 1],
      ["2026-11-03", 0],
    ],
  );
  const partial = await fetch(
    `${base}?${new URLSearchParams({ from: "2026-11-01T15:00:00.000Z", to: "2026-11-01T17:00:00.000Z", offsetMinutes: "480" })}`,
  );
  const partialData = await partial.json();
  assert.deepEqual(
    partialData.daily.map((day: any) => [day.date, day.total]),
    [
      ["2026-11-01", 1],
      ["2026-11-02", 1],
    ],
    "跨本地午夜的非整天范围仍需保留尾日",
  );
  assert.equal(data.provider.seedConfigured, true);
  assert.equal(data.provider.analysisConfigured, false);
  assert.equal(JSON.stringify(data).includes("fake-seed-key"), false);
  assert.equal(
    (await fetch(`${base}?from=2027-01-01T00:00:00Z&to=2026-01-01T00:00:00Z`))
      .status,
    400,
  );
  assert.equal(
    (await fetch(`${base}?from=2026-01-01T00:00:00Z&to=2027-01-01T00:00:00Z`))
      .status,
    400,
  );
  assert.equal(
    (await fetch(`${base}?from=bad&to=2027-01-01T00:00:00Z`)).status,
    400,
  );
});

test('工作台保留默认统计并按真实电话来源隔离，传递线路元数据且不把模型就绪计为客户接通', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const browser = store.createSession(customer, 'seed'); store.answered(browser.id); store.status(browser.id, 'completed'); store.completeAnalysis(browser.id, analysis);
  const phone = store.createTelephoneSession(customer); store.updateTelephone(phone.id, { jobId: 'job-phone', state: 'dialing', recordingStatus: 'recording' });
  store.markModelReady(phone.id); store.telephoneAnswered(phone.id, { jobId: 'job-phone', customerChannelId: 'customer-phone' });
  store.updateTelephone(phone.id, { state: 'ended', recordingStatus: 'failed' }); store.status(phone.id, 'completed'); store.completeAnalysis(phone.id, { ...analysis, grade: 'B' });
  const unanswered = store.createTelephoneSession(customer); store.markModelReady(unanswered.id);
  store.updateTelephone(unanswered.id, { jobId: 'job-no-answer', state: 'no_answer', recordingStatus: 'failed' }); store.status(unanswered.id, 'failed');
  // Even a stale/imported analysis cannot turn an unproven telephone answer into a lead.
  store.db.prepare("INSERT INTO analysis_jobs(id,session_id,status,result,created_at) VALUES(?,?,'completed',?,?)")
    .run('stale-analysis-fixture', unanswered.id, JSON.stringify(analysis), analysis.evaluatedAt);
  store.completeAnalysis(unanswered.id, analysis);
  const legacy = store.createSession(customer, 'seed'); store.answered(legacy.id); store.status(legacy.id, 'completed'); store.completeAnalysis(legacy.id, { ...analysis, grade: 'C' });
  store.db.prepare("UPDATE sessions SET transport='softphone_bridge' WHERE id=?").run(legacy.id);
  for (const id of [browser.id, phone.id, unanswered.id, legacy.id]) store.db.prepare('UPDATE sessions SET created_at=? WHERE id=?').run('2026-11-01T12:00:00Z', id);
  const range = { from: '2026-10-26T16:00:00Z', to: '2026-11-02T16:00:00Z', offsetMinutes: 480 };
  const all = readDashboard(store, range);
  assert.equal(all.calls.total, 4); assert.equal(all.calls.answered, 3); assert.equal(all.grades.A, 1);
  assert.equal(all.recent.find(call => call.id === browser.id)?.transport, 'browser');
  assert.equal(all.recent.find(call => call.id === legacy.id)?.transport, 'softphone_bridge');
  const sip = readDashboard(store, { ...range, source: 'sip' });
  assert.equal(sip.calls.total, 2); assert.equal(sip.calls.answered, 1); assert.equal(sip.calls.analyzed, 1);
  assert.equal(sip.grades.A, 0); assert.equal(sip.grades.B, 1); assert.deepEqual(sip.leads.map(call => call.id), [phone.id]);
  assert.ok(sip.recent.every(call => call.transport === 'sip'));
  assert.equal(sip.recent.find(call => call.id === phone.id)?.telephone?.jobId, 'job-phone');
  assert.equal(sip.recent.find(call => call.id === phone.id)?.telephone?.recordingStatus, 'failed');
  assert.equal(sip.recent.find(call => call.id === phone.id)?.answerSource, 'ccc_customer');
  assert.ok(sip.recent.find(call => call.id === unanswered.id)?.modelReadyAt);
  assert.equal(sip.recent.find(call => call.id === unanswered.id)?.answeredAt, undefined);
  assert.equal(readDashboard(store, { ...range, source: 'browser' }).calls.total, 1);
  assert.equal(readDashboard(store, { ...range, source: 'softphone_bridge' }).calls.total, 1);
});
