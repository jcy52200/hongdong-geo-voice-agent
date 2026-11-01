import type { Store } from "./store.js";
import { GRADES } from "../shared/analysis.js";
import type { DashboardCall, DashboardData } from "../shared/dashboard.js";

type Row = Record<string, any>;
export interface DashboardRange {
  from: string;
  to: string;
  offsetMinutes: number;
}
/** Aggregate all matching rows in SQLite; bootstrap's recent-call limit never affects metrics. */
export function readDashboard(
  store: Store,
  range: DashboardRange,
): Omit<DashboardData, "jobs" | "provider"> {
  const { from, to, offsetMinutes } = range;
  const source = `FROM sessions s LEFT JOIN analysis_jobs a ON a.session_id=s.id WHERE s.mode='seed' AND s.created_at>=? AND s.created_at<?`;
  const counts = (start: string, end: string) =>
    store.db
      .prepare(
        `SELECT COUNT(*) AS total,
    COALESCE(SUM(s.answered_at IS NOT NULL),0) AS answered,
    COALESCE(SUM(s.answered_at IS NOT NULL AND s.status IN ('completed','failed')),0) AS ended,
    COALESCE(SUM(s.status IN ('connecting','opening','active')),0) AS active,
    COALESCE(SUM(s.answered_at IS NULL AND s.status='failed'),0) AS notConnected,
    COALESCE(SUM(s.answered_at IS NOT NULL AND s.analysis_status='completed'),0) AS analyzed,
    COALESCE(SUM(s.answered_at IS NOT NULL AND s.analysis_status IN ('pending','running')),0) AS pending,
    COALESCE(SUM(s.answered_at IS NOT NULL AND s.analysis_status='failed'),0) AS failed,
    COALESCE(SUM(s.recording IS NOT NULL),0) AS recorded,
    COALESCE(SUM(CASE WHEN s.answered_at IS NOT NULL AND s.ended_at IS NOT NULL THEN MAX(0,(julianday(s.ended_at)-julianday(s.answered_at))*86400) ELSE 0 END),0) AS durationSeconds,
    COALESCE(SUM(s.answered_at IS NOT NULL AND s.analysis_status='completed' AND json_extract(a.result,'$.grade')='A'),0) AS leads
    ${source}`,
      )
      .get(start, end) as Row;
  const current = counts(from, to);
  const duration = Date.parse(to) - Date.parse(from);
  const before = counts(
    new Date(Date.parse(from) - duration).toISOString(),
    from,
  );
  const grades = Object.fromEntries(
    GRADES.map((grade) => [grade, 0]),
  ) as DashboardData["grades"];
  const evaluated = ` AND s.answered_at IS NOT NULL AND s.analysis_status='completed'`;
  for (const row of store.db
    .prepare(
      `SELECT json_extract(a.result,'$.grade') AS grade,COUNT(*) AS count ${source}${evaluated} GROUP BY grade`,
    )
    .all(from, to) as Row[]) {
    if (GRADES.includes(row.grade))
      grades[row.grade as keyof typeof grades] = Number(row.count);
  }
  const dailyRows = store.db
    .prepare(
      `SELECT date(s.created_at,?) AS date,COUNT(*) AS total,
    SUM(s.answered_at IS NOT NULL) AS answered,
    SUM(s.answered_at IS NOT NULL AND s.analysis_status='completed' AND json_extract(a.result,'$.grade')='A') AS leads
    ${source} GROUP BY date ORDER BY date`,
    )
    .all(
      `${offsetMinutes >= 0 ? "+" : ""}${offsetMinutes} minutes`,
      from,
      to,
    ) as Row[];
  const daily: DashboardData["daily"] = [];
  const localStart = new Date(Date.parse(from) + offsetMinutes * 60000)
    .toISOString()
    .slice(0, 10);
  const localEnd = Date.parse(to) + offsetMinutes * 60000;
  for (
    let day = new Date(`${localStart}T00:00:00Z`);
    day.getTime() < localEnd;
    day.setUTCDate(day.getUTCDate() + 1)
  ) {
    const date = day.toISOString().slice(0, 10);
    const row = dailyRows.find((row) => row.date === date);
    daily.push({
      date,
      total: Number(row?.total ?? 0),
      answered: Number(row?.answered ?? 0),
      leads: Number(row?.leads ?? 0),
    });
  }
  const customers = store.customers();
  const missing = customers.filter(
    (customer) => !customer.industry?.trim(),
  ).length;
  const unknown = customers.filter((customer) =>
    /^(未知|待确认|待确认行业|未识别|unknown)$/i.test(
      customer.industry?.trim() ?? "",
    ),
  ).length;
  const map = (row: Row): DashboardCall => ({
    id: row.id,
    customer: JSON.parse(row.customer),
    status: row.status,
    createdAt: row.created_at,
    answeredAt: row.answered_at ?? undefined,
    endedAt: row.ended_at ?? undefined,
    analysisStatus: row.analysis_status,
    analysis: row.result ? JSON.parse(row.result) : undefined,
    hasRecording: Boolean(row.recording),
  });
  const select = `SELECT s.id,s.customer,s.status,s.created_at,s.answered_at,s.ended_at,s.analysis_status,s.recording,a.result `;
  return {
    range,
    calls: {
      total: Number(current.total),
      answered: Number(current.answered),
      ended: Number(current.ended),
      active: Number(current.active),
      notConnected: Number(current.notConnected),
      analyzed: Number(current.analyzed),
      pending: Number(current.pending),
      failed: Number(current.failed),
      recorded: Number(current.recorded),
      durationSeconds: Math.round(Number(current.durationSeconds)),
    },
    previous: {
      total: Number(before.total),
      answered: Number(before.answered),
      analyzed: Number(before.analyzed),
      leads: Number(before.leads),
    },
    grades,
    daily,
    customers: {
      total: customers.length,
      industryReady: customers.length - missing - unknown,
      industryMissing: missing,
      industryUnknown: unknown,
      examples: customers
        .slice(0, 4)
        .map(({ id, camp, name }) => ({ id, camp, name })),
    },
    recent: (
      store.db
        .prepare(
          `${select}${source} ORDER BY s.created_at DESC,s.rowid DESC LIMIT 8`,
        )
        .all(from, to) as Row[]
    ).map(map),
    leads: (
      store.db
        .prepare(
          `${select}${source}${evaluated} AND json_extract(a.result,'$.grade') IN ('A','B') ORDER BY json_extract(a.result,'$.grade'),s.created_at DESC,s.rowid DESC LIMIT 8`,
        )
        .all(from, to) as Row[]
    ).map(map),
    generatedAt: new Date().toISOString(),
  };
}
