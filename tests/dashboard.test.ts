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
