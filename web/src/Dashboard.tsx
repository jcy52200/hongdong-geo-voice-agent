import { useEffect, useMemo, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import {
  ArrowUpRight,
  ArrowRight,
  ArrowClockwise,
  Phone,
  PhoneCall,
  UsersThree,
  ChatCircleDots,
  SlidersHorizontal,
  Waveform,
  MagnifyingGlass,
  Check,
  Clock,
  WarningCircle,
  CaretRight,
  PlugsConnected,
  Headphones,
  FileAudio,
  Sparkle,
} from "@phosphor-icons/react";
import { GRADES, GRADE_LABELS, type Grade } from "../../shared/analysis";
import type { DashboardCall, DashboardData } from "../../shared/dashboard";
import type { Session } from "./types";
import { messageOf } from "./api";

type Destination =
  "voice" | "prompt" | "customers" | "sessions" | "integrations";
type Tab = "recent" | "leads" | "tasks";
interface Props {
  refreshKey: number;
  onNavigate: (page: Destination) => void;
  onOpenSession: (id: string) => void;
  onGrade: (grade: Grade, range: { from: string; to: string }) => void;
}
const number = new Intl.NumberFormat("zh-CN");
const dateText = (value: string) =>
  new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
const percent = (value: number, total: number) =>
  total ? `${Math.round((value / total) * 100)}%` : "—";
const statuses: Record<DashboardCall["status"], string> = {
  created: "等待连接",
  connecting: "连接中",
  opening: "开场中",
  active: "通话中",
  completed: "已结束",
  failed: "异常结束",
};
function dateRange(days: number) {
  const to = new Date();
  to.setHours(24, 0, 0, 0);
  const from = new Date(to);
  from.setDate(from.getDate() - days);
  return {
    from: from.toISOString(),
    to: to.toISOString(),
    offsetMinutes: -from.getTimezoneOffset(),
  };
}
function GradePill({ call }: { call: DashboardCall }) {
  if (call.analysisStatus === "completed" && call.analysis)
    return (
      <span className={`intent-pill grade-${call.analysis.grade}`}>
        {call.analysis.grade}
        <span>{GRADE_LABELS[call.analysis.grade]}</span>
      </span>
    );
  return (
    <span
      className={`intent-pill neutral ${call.analysisStatus === "failed" ? "failed" : ""}`}
    >
      {call.analysisStatus === "failed"
        ? "评估失败"
        : ["pending", "running"].includes(call.analysisStatus)
          ? "待评估"
          : call.answeredAt
            ? statuses[call.status]
            : "未接通"}
    </span>
  );
}

export function Dashboard({
  refreshKey,
  onNavigate,
  onOpenSession,
  onGrade,
}: Props) {
  const [days, setDays] = useState(7);
  const [revision, setRevision] = useState(0);
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<Tab>("recent");
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [detail, setDetail] = useState<Session | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");
  const reducedMotion = useReducedMotion();
  const range = useMemo(() => dateRange(days), [days, revision, refreshKey]);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    void fetch(
      `/api/dashboard?${new URLSearchParams({ ...range, offsetMinutes: String(range.offsetMinutes) })}`,
      { signal: controller.signal },
    )
      .then(async (response) => {
        const result = await response.json();
        if (!response.ok)
          throw new Error(result.error || "暂时无法读取工作台数据");
        return result as DashboardData;
      })
      .then((result) => {
        if (!controller.signal.aborted) setData(result);
      })
      .catch((reason) => {
        if (!controller.signal.aborted) setError(messageOf(reason));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [range]);
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (!document.hidden) setRevision((value) => value + 1);
    }, 30000);
    return () => window.clearInterval(timer);
  }, []);
  const list = useMemo(() => {
    const source = (tab === "leads" ? data?.leads : data?.recent) ?? [];
    const term = search.trim().toLowerCase();
    return term
      ? source.filter((call) =>
          `${call.customer.camp} ${call.customer.name} ${call.customer.phone}`
            .toLowerCase()
            .includes(term),
        )
      : source;
  }, [data, tab, search]);
  const selected = list.find((call) => call.id === selectedId) ?? list[0];
  useEffect(() => {
    if (!selected?.id || tab === "tasks") {
      setDetail(null);
      return;
    }
    const id = selected.id,
      controller = new AbortController();
    setDetailLoading(true);
    setDetail(null);
    setDetailError("");
    void fetch(`/api/sessions/${id}`, { signal: controller.signal })
      .then(async (response) => {
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "详情暂不可用");
        return result as Session;
      })
      .then((result) => {
        if (!controller.signal.aborted) setDetail(result);
      })
      .catch((reason) => {
        if (!controller.signal.aborted) setDetailError(messageOf(reason));
      })
      .finally(() => {
        if (!controller.signal.aborted) setDetailLoading(false);
      });
    return () => controller.abort();
  }, [selected?.id, selected?.analysisStatus, tab, data?.generatedAt]);

  function filterGrade(grade: Grade) {
    onGrade(grade, {
      from: data?.range.from ?? range.from,
      to: data?.range.to ?? range.to,
    });
  }
  function changeRange(value: number) {
    if (value !== days) {
      setData(null);
      setDays(value);
      setSelectedId("");
    }
  }
  if (!data)
    return (
      <div className="dashboard">
        <div className="dashboard-range-bar">
          <span>把值得跟进的对话，放在眼前。</span>
          <RangeSwitch days={days} onChange={changeRange} />
        </div>
        {error ? (
          <div className="panel dashboard-empty">
            <WarningCircle size={32} />
            <h2>工作台数据暂不可用</h2>
            <p>{error}</p>
            <button
              className="button primary"
              onClick={() => setRevision((value) => value + 1)}
            >
              <ArrowClockwise />
              重新加载
            </button>
          </div>
        ) : (
          <div
            className="dashboard-skeleton"
            role="status"
            aria-label="正在读取工作台数据"
          >
            <div />
            <div />
            <div />
            <div />
          </div>
        )}
      </div>
    );
  const leadTotal = data.grades.A + data.grades.B;
  const pendingTotal =
    data.jobs.pending +
    data.jobs.running +
    data.jobs.industryPending +
    data.jobs.industryRunning;
  const failedTotal = data.jobs.failed + data.jobs.industryFailed;
  const maxDaily = Math.max(1, ...data.daily.map((day) => day.total));
  const readiness = data.customers.total
    ? (data.customers.industryReady / data.customers.total) * 100
    : 0;
  const tasks = [
    {
      id: "industry",
      icon: UsersThree,
      label: "客户行业补全",
      count: data.jobs.industryPending + data.jobs.industryRunning,
      fail: data.jobs.industryFailed,
      ready: data.provider.analysisConfigured,
      action: () => onNavigate("customers"),
      description: "补齐下一通电话的行业上下文",
    },
    {
      id: "analysis",
      icon: Sparkle,
      label: "通话意向评估",
      count: data.jobs.pending + data.jobs.running,
      fail: data.jobs.failed,
      ready: data.provider.analysisConfigured,
      action: () => onNavigate("sessions"),
      description: "从接通的对话中整理意向与微信",
    },
    {
      id: "voice",
      icon: Waveform,
      label: "SeedDuplex 语音",
      count: data.calls.active,
      fail: 0,
      ready: data.provider.seedConfigured,
      action: () => onNavigate("voice"),
      description: "独立语音会话，逐句保存记录",
    },
  ];
  return (
    <div className="dashboard" aria-busy={loading}>
      <div className="dashboard-range-bar">
        <div className="dashboard-context">
          <span className="context-pill">
            <span className="semantic-dot" />
            本地语音试打
          </span>
          <p>
            {loading
              ? "正在同步…"
              : `${new Date(data.range.from).toLocaleDateString("zh-CN", { month: "long", day: "numeric" })} — ${new Date(Date.parse(data.range.to) - 1).toLocaleDateString("zh-CN", { month: "long", day: "numeric" })}`}
          </p>
        </div>
        <RangeSwitch days={days} onChange={changeRange} />
      </div>
      {error && (
        <div className="alert error" role="alert">
          <p>更新失败，当前保留上次读取的数据：{error}</p>
          <button
            onClick={() => setRevision((value) => value + 1)}
            aria-label="重试更新"
          >
            <ArrowClockwise />
          </button>
        </div>
      )}
      <section className="dashboard-bento" aria-label="关键业务指标">
        <motion.article
          className="metric-card connections-card"
          initial={reducedMotion ? false : { opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35 }}
        >
          <div className="metric-card-top">
            <span>
              <PhoneCall size={18} />
              语音连接
            </span>
            <button
              className="round-action"
              aria-label="查看语音通话记录"
              onClick={() => onNavigate("sessions")}
            >
              <ArrowUpRight size={19} />
            </button>
          </div>
          <div className="connection-metric">
            <strong>{number.format(data.calls.answered)}</strong>
            <span>/ {number.format(data.calls.total)} 通已发起</span>
            <span className="metric-delta">
              较上期{" "}
              {data.calls.answered - data.previous.answered >= 0 ? "+" : ""}
              {data.calls.answered - data.previous.answered}
            </span>
          </div>
          <div
            className="daily-chart"
            role="img"
            aria-label={`所选期间共发起 ${data.calls.total} 通语音测试，连接成功 ${data.calls.answered} 通`}
          >
            {data.daily.map((day, index) => (
              <div
                className="daily-column"
                key={day.date}
                tabIndex={0}
                aria-label={`${day.date} 发起${day.total}通，连接${day.answered}通`}
              >
                <div className="daily-track">
                  <span
                    className="daily-total"
                    style={{ height: `${(day.total / maxDaily) * 100}%` }}
                  />
                  <span
                    className="daily-answered"
                    style={{ height: `${(day.answered / maxDaily) * 100}%` }}
                  />
                </div>
                <span className="daily-tooltip">
                  {day.date.slice(5)} · {day.answered} / {day.total} 通
                </span>
                <small>
                  {data.daily.length <= 7 ||
                  index % 5 === 0 ||
                  index === data.daily.length - 1
                    ? `${Number(day.date.slice(5, 7))}/${Number(day.date.slice(8))}`
                    : ""}
                </small>
              </div>
            ))}
          </div>
          <div className="metric-foot">
            <span>
              连接成功率 <b>{percent(data.calls.answered, data.calls.total)}</b>
            </span>
            <span>
              <i />
              成功连接 <i />
              全部发起
            </span>
          </div>
        </motion.article>
        <motion.article
          className="metric-card leads-card"
          initial={reducedMotion ? false : { opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35, delay: 0.05 }}
        >
          <div className="metric-card-top">
            <span>
              <ChatCircleDots size={18} />
              值得跟进的对话
            </span>
            <button
              className="round-action"
              aria-label="筛选A级意向通话"
              onClick={() => filterGrade("A")}
            >
              <ArrowUpRight size={19} />
            </button>
          </div>
          <div className="lead-metrics">
            <button onClick={() => filterGrade("A")}>
              <span className="intent-pill grade-A">A 级<span className="lead-grade-description"> · 微信已确认</span></span>
              <strong>
                {number.format(data.grades.A)}
                <ArrowUpRight size={24} />
              </strong>
            </button>
            <button onClick={() => filterGrade("B")}>
              <span className="intent-pill grade-B">B 级<span className="lead-grade-description"> · 可能有意向</span></span>
              <strong>
                {number.format(data.grades.B)}
                <ArrowUpRight size={24} />
              </strong>
            </button>
          </div>
          <div
            className="striped-meter"
            role="progressbar"
            aria-label="微信获取率，分母为已评估通话"
            aria-valuenow={
              data.calls.analyzed
                ? Math.round((data.grades.A / data.calls.analyzed) * 100)
                : 0
            }
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <span
              style={{
                width: `${data.calls.analyzed ? (data.grades.A / data.calls.analyzed) * 100 : 0}%`,
              }}
            />
          </div>
          <div className="metric-foot">
            <span>
              微信获取率 <b>{percent(data.grades.A, data.calls.analyzed)}</b>
            </span>
            <span>已评估 {data.calls.analyzed} 通</span>
          </div>
        </motion.article>
        <motion.article
          className="metric-card customers-card"
          initial={reducedMotion ? false : { opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35, delay: 0.1 }}
        >
          <div className="metric-card-top">
            <span>
              <UsersThree size={18} />
              客户资料库
            </span>
            <button
              className="round-action"
              aria-label="管理客户资料"
              onClick={() => onNavigate("customers")}
            >
              <ArrowUpRight size={19} />
            </button>
          </div>
          <div className="customer-metric">
            <strong>{number.format(data.customers.total)}</strong>
            <div className="avatar-stack" aria-label="最近导入的客户">
              {data.customers.examples.map((customer, index) => (
                <span
                  key={customer.id}
                  title={customer.camp}
                  style={{ zIndex: 4 - index }}
                >
                  {(customer.name || customer.camp).slice(0, 1)}
                </span>
              ))}
              {data.customers.total > 4 && (
                <span>+{Math.min(99, data.customers.total - 4)}</span>
              )}
            </div>
          </div>
          <div className="readiness-label">
            <span>行业资料就绪</span>
            <strong>
              {percent(data.customers.industryReady, data.customers.total)}
            </strong>
          </div>
          <div
            className="readiness-track"
            role="progressbar"
            aria-label="全量客户行业资料就绪比例"
            aria-valuenow={Math.round(readiness)}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <span style={{ width: `${readiness}%` }} />
          </div>
          <div className="metric-foot">
            <span>{data.customers.industryReady} 位可带入行业</span>
            <button onClick={() => onNavigate("customers")}>
              {data.customers.industryMissing + data.customers.industryUnknown}{" "}
              位待完善 <ArrowRight size={13} />
            </button>
          </div>
        </motion.article>
      </section>
      <section className="operations-ribbon" aria-label="数据处理状态">
        <button
          onClick={() => {
            setTab("tasks");
            setSearch("");
          }}
        >
          <span className="ribbon-icon">
            <Clock />
          </span>
          <span>
            后台待办
            <strong>
              {pendingTotal}
              <small>项处理中 / 等待</small>
            </strong>
          </span>
          <ArrowUpRight />
        </button>
        <button onClick={() => onNavigate("sessions")}>
          <span className="ribbon-icon">
            <Sparkle />
          </span>
          <span>
            评估进度
            <strong>
              {percent(data.calls.analyzed, data.calls.ended)}
              <small>
                {data.calls.analyzed} / {data.calls.ended} 通已结束
              </small>
            </strong>
          </span>
          <ArrowUpRight />
        </button>
        <button onClick={() => onNavigate("sessions")}>
          <span className="ribbon-icon">
            <FileAudio />
          </span>
          <span>
            录音已保存
            <strong>
              {data.calls.recorded}
              <small>通可回放</small>
            </strong>
          </span>
          <ArrowUpRight />
        </button>
        <button
          className={failedTotal ? "has-issue" : ""}
          onClick={() => {
            setTab("tasks");
            setSearch("");
          }}
        >
          <span className="ribbon-icon">
            {failedTotal ? <WarningCircle /> : <Check />}
          </span>
          <span>
            需要留意
            <strong>
              {failedTotal}
              <small>项任务失败</small>
            </strong>
          </span>
          <ArrowUpRight />
        </button>
      </section>
      <section className="business-workspace" aria-label="业务工作区">
        <div className="business-tabs-bar">
          <div className="business-tabs" role="tablist" aria-label="业务视图">
            {(
              [
                ["recent", "最近通话", data.calls.total],
                ["leads", "意向线索", leadTotal],
                ["tasks", "待处理任务", pendingTotal + failedTotal],
              ] as const
            ).map(([value, label, count]) => (
              <button
                role="tab"
                aria-selected={tab === value}
                key={value}
                className={tab === value ? "selected" : ""}
                onClick={() => {
                  setTab(value);
                  setSearch("");
                  setSelectedId("");
                }}
              >
                {label}
                <span>{count}</span>
              </button>
            ))}
          </div>
          <button
            className="workspace-link"
            onClick={() =>
              onNavigate(tab === "tasks" ? "integrations" : "sessions")
            }
          >
            {tab === "tasks" ? "系统接入" : "全部通话"}
            <ArrowUpRight size={18} />
          </button>
        </div>
        <div className="business-body">
          {tab === "tasks" ? (
            <div className="task-workspace">
              <div className="task-list">
                {tasks.map((task) => (
                  <button
                    key={task.id}
                    className="task-item"
                    onClick={task.action}
                  >
                    <span className="task-icon">
                      <task.icon size={25} />
                    </span>
                    <div>
                      <strong>{task.label}</strong>
                      <p>{task.description}</p>
                    </div>
                    <span
                      className={`task-state ${task.fail ? "attention" : ""}`}
                    >
                      {!task.ready
                        ? "等待配置密钥"
                        : task.fail
                          ? `${task.fail} 项失败`
                          : task.count
                            ? `${task.count} 项待处理`
                            : task.id === "voice"
                              ? "可发起测试"
                              : "暂无待办"}
                    </span>
                    <ArrowUpRight size={19} />
                  </button>
                ))}
              </div>
              <aside className="task-aside">
                <span className="task-aside-icon">
                  <PlugsConnected size={30} />
                </span>
                <h3>模型配置状态</h3>
                <div className="service-checks">
                  <div>
                    <span>SeedDuplex</span>
                    <b
                      className={
                        data.provider.seedConfigured ? "configured" : ""
                      }
                    >
                      {data.provider.seedConfigured ? "已配置密钥" : "待配置"}
                    </b>
                  </div>
                  <div>
                    <span>DeepSeek Flash</span>
                    <b
                      className={
                        data.provider.analysisConfigured ? "configured" : ""
                      }
                    >
                      {data.provider.analysisConfigured
                        ? "已配置密钥"
                        : "待配置"}
                    </b>
                  </div>
                </div>
                <p>
                  接入详情中可查看模型与媒体规格。密钥状态不代表实时网络检测结果。
                </p>
                <button
                  className="button primary"
                  onClick={() => onNavigate("integrations")}
                >
                  查看接入状态 <ArrowRight />
                </button>
              </aside>
            </div>
          ) : (
            <div className="workspace-columns">
              <div className="workspace-master">
                <div className="workspace-list-header">
                  <div>
                    <h2>
                      {tab === "leads"
                        ? "优先跟进这些对话"
                        : "从每一通里，看见进展"}
                    </h2>
                    <p>
                      {tab === "leads"
                        ? "最近 8 条 A / B 级记录"
                        : "最近 8 通语音测试"}
                    </p>
                  </div>
                  <label className="workspace-search">
                    <MagnifyingGlass size={17} />
                    <input
                      aria-label="搜索工作区通话"
                      placeholder="搜索客户或公司"
                      value={search}
                      onChange={(event) => setSearch(event.target.value)}
                    />
                  </label>
                </div>
                <div
                  className="workspace-list"
                  role="region"
                  aria-label={tab === "leads" ? "意向客户" : "最近通话"}
                >
                  {list.length ? (
                    list.map((call) => (
                      <button
                        aria-current={
                          selected?.id === call.id ? "true" : undefined
                        }
                        className={`workspace-call ${selected?.id === call.id ? "selected" : ""}`}
                        key={call.id}
                        onClick={() => setSelectedId(call.id)}
                      >
                        <span className="call-initial">
                          {(call.customer.name || call.customer.camp).slice(
                            0,
                            1,
                          )}
                        </span>
                        <span className="workspace-customer">
                          <strong>{call.customer.name || "未填写姓名"}</strong>
                          <small>{call.customer.camp}</small>
                        </span>
                        <span className="workspace-call-time">
                          {dateText(call.createdAt)}
                        </span>
                        <GradePill call={call} />
                        <CaretRight size={17} />
                      </button>
                    ))
                  ) : (
                    <div className="workspace-empty">
                      <Headphones size={38} />
                      <h3>
                        {search
                          ? "没有匹配的对话"
                          : tab === "leads"
                            ? "意向线索正在路上"
                            : "还没有语音通话"}
                      </h3>
                      <p>
                        {search
                          ? "试试其他姓名、公司或电话号码。"
                          : tab === "leads"
                            ? "完成通话评估后，A / B 级客户会出现在这里。"
                            : "从一通真实的模拟电话开始，验证您的销售话术。"}
                      </p>
                      <button
                        className="button primary"
                        onClick={() =>
                          onNavigate(
                            search || tab === "leads" ? "sessions" : "voice",
                          )
                        }
                      >
                        {search || tab === "leads"
                          ? "查看全部记录"
                          : "开始模拟电话"}
                        <ArrowUpRight />
                      </button>
                    </div>
                  )}
                </div>
              </div>
              <aside className="workspace-detail" aria-label="所选通话摘要">
                {selected ? (
                  <>
                    <div className="workspace-detail-top">
                      <span>对话速览</span>
                      <GradePill call={selected} />
                    </div>
                    <h3>{selected.customer.camp}</h3>
                    <div className="workspace-detail-meta">
                      <span>
                        <Phone size={14} />
                        {selected.customer.phone}
                      </span>
                      <span>{selected.customer.industry || "行业待确认"}</span>
                    </div>
                    <div className="workspace-summary">
                      <span>意向摘要</span>
                      <p>
                        {selected.analysisStatus === "completed" &&
                        selected.analysis
                          ? selected.analysis.summary
                          : selected.analysisStatus === "failed"
                            ? "评估暂未成功，可打开完整记录后重试。"
                            : selected.answeredAt
                              ? data.provider.analysisConfigured
                                ? "通话结束后，模型会整理客户意向与判断依据。"
                                : "对话已保存，配置 DeepSeek 密钥后将继续评估。"
                              : "此通话未连接成功，不计入客户意向评估。"}
                      </p>
                    </div>
                    {selected.analysisStatus === "completed" &&
                      selected.analysis?.grade === "A" && (
                        <div className="detail-wechat">
                          <ChatCircleDots size={17} />
                          <span>
                            微信 ·{" "}
                            {selected.analysis.wechat.sameAsDialed
                              ? "与电话同号"
                              : selected.analysis.wechat.phone ||
                                selected.analysis.wechat.identifier}
                          </span>
                        </div>
                      )}
                    <div className="workspace-snippets" aria-live="polite">
                      {detailLoading ? (
                        <p className="detail-loading">正在读取对话…</p>
                      ) : detailError ? (
                        <p className="detail-loading">{detailError}</p>
                      ) : detail?.transcripts.length ? (
                        detail.transcripts
                          .filter((item) => item.final)
                          .slice(-2)
                          .map((item) => (
                            <div
                              className={
                                item.kind === "AsrText"
                                  ? "customer-snippet"
                                  : ""
                              }
                              key={item.id}
                            >
                              <span>
                                {item.kind === "AsrText" ? "客户" : "智能体"}
                              </span>
                              <p>{item.text}</p>
                            </div>
                          ))
                      ) : (
                        <p className="detail-loading">暂无逐句对话内容</p>
                      )}
                    </div>
                    <button
                      className="button detail-open"
                      onClick={() => onOpenSession(selected.id)}
                    >
                      打开完整通话 <ArrowUpRight size={18} />
                    </button>
                  </>
                ) : (
                  <div className="detail-no-selection">
                    <Waveform size={40} />
                    <p>
                      选择一通对话，
                      <br />
                      看看客户怎么说。
                    </p>
                  </div>
                )}
              </aside>
            </div>
          )}
        </div>
        <div className="workspace-footer">
          <span>
            <span className="semantic-dot" />
            仅统计语音试打 · 文字预演已排除
          </span>
          <span>
            数据更新于{" "}
            {new Date(data.generatedAt).toLocaleTimeString("zh-CN", {
              hour: "2-digit",
              minute: "2-digit",
              hour12: false,
            })}
            <button
              aria-label="刷新工作台"
              onClick={() => setRevision((value) => value + 1)}
              disabled={loading}
            >
              <ArrowClockwise
                className={loading ? "is-spinning" : ""}
                size={15}
              />
            </button>
          </span>
        </div>
      </section>
      <section className="dashboard-bottom" aria-label="意向分布与快捷操作">
        <div className="intent-distribution">
          <div>
            <h2>对话里的意向分布</h2>
            <p>已完成评估 {data.calls.analyzed} 通 · 点击等级筛选记录</p>
          </div>
          <div
            className="distribution-track"
            role="img"
            aria-label={GRADES.map(
              (grade) => `${grade}级${data.grades[grade]}通`,
            ).join("，")}
          >
            {data.calls.analyzed ? (
              GRADES.filter((grade) => data.grades[grade]).map((grade) => (
                <button
                  key={grade}
                  className={`grade-${grade}`}
                  aria-label={`筛选${grade}级 ${data.grades[grade]}通`}
                  title={`${grade} 级 · ${GRADE_LABELS[grade]} ${data.grades[grade]} 通`}
                  onClick={() => filterGrade(grade)}
                  style={{ flex: data.grades[grade] }}
                />
              ))
            ) : (
              <span>等待第一份评估结果</span>
            )}
          </div>
          <div className="distribution-legend">
            {GRADES.map((grade) => (
              <button key={grade} onClick={() => filterGrade(grade)}>
                <i className={`grade-${grade}`}>{grade}</i>
                <span>{GRADE_LABELS[grade]}</span>
                <b>{data.grades[grade]}</b>
              </button>
            ))}
          </div>
        </div>
        <button
          className="dashboard-quick-action"
          onClick={() => onNavigate("prompt")}
        >
          <span className="quick-action-icon">
            <SlidersHorizontal size={27} />
          </span>
          <span>
            <strong>让下一通，更自然一点。</strong>
            <small>调整声音、话术与模型参数</small>
          </span>
          <span className="round-action">
            <ArrowUpRight size={22} />
          </span>
        </button>
      </section>
    </div>
  );
}
function RangeSwitch({
  days,
  onChange,
}: {
  days: number;
  onChange: (days: number) => void;
}) {
  return (
    <div className="range-switch" role="group" aria-label="工作台统计周期">
      {[
        [1, "今天"],
        [7, "近 7 天"],
        [30, "近 30 天"],
      ].map(([value, label]) => (
        <button
          key={value}
          aria-pressed={days === value}
          onClick={() => onChange(Number(value))}
        >
          {days === value && (
            <motion.span
              layoutId="dashboard-range"
              className="range-slider"
              transition={{ type: "spring", stiffness: 400, damping: 35 }}
            />
          )}
          <span>{label}</span>
        </button>
      ))}
    </div>
  );
}
