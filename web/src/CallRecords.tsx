import { useCallback, useEffect, useRef, useState } from 'react';
import { GRADES, GRADE_LABELS, type Grade } from '../../shared/analysis';
import { api, messageOf } from './api';
import type { AnalysisProviderStatus, Session, SessionPage, SessionStatus } from './types';

type DateField = 'createdAt' | 'answeredAt' | 'endedAt';
type SortField = 'createdAt' | 'status' | 'grade';
interface Filters {
  page: number; pageSize: number; answeredOnly: boolean; dateField: DateField;
  from: string; to: string; range: string; sortBy: SortField; sortDir: 'asc' | 'desc';
  grade: string; search: string;
}
const defaults: Filters = { page: 1, pageSize: 20, answeredOnly: true, dateField: 'createdAt', from: '', to: '', range: 'all', sortBy: 'createdAt', sortDir: 'desc', grade: '', search: '' };
const statusLabels: Record<SessionStatus, string> = { created: '等待连接', connecting: '连接中', opening: '开场播放中', active: '对话中', completed: '已结束', failed: '未接通' };
const dateFormatter = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const timeFormatter = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
function dateText(value?: string) { return value && Number.isFinite(Date.parse(value)) ? dateFormatter.format(new Date(value)) : '—'; }
function localDate(date: Date) { return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`; }
function boundary(value: string, end = false) {
  if (!value) return undefined;
  const date = new Date(`${value}T00:00:00`);
  if (!Number.isFinite(date.getTime())) return undefined;
  // The server uses an exclusive upper bound. Advance the local calendar day
  // before converting to UTC so the entire selected end date is included.
  if (end) date.setDate(date.getDate() + 1);
  return date.toISOString();
}
function elapsed(session: Session) {
  if (!session.answeredAt || !session.endedAt) return '—';
  const seconds = Math.max(0, Math.round((Date.parse(session.endedAt) - Date.parse(session.answeredAt)) / 1000));
  return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}
function statusText(session: Session) { return session.status === 'failed' && session.answeredAt ? '异常结束' : statusLabels[session.status]; }
function isWorking(session: Session | null) { return Boolean(session && (['pending', 'running'].includes(session.analysisStatus) || ['created', 'connecting', 'opening', 'active'].includes(session.status))); }

async function get<T>(path: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(`/api${path}`, { signal });
  const body = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(body?.error ?? `请求失败（${response.status}）`);
  return body;
}

function GradeBadge({ grade }: { grade: Grade }) {
  return <span className={`call-grade grade-${grade}`}><b>{grade}</b><span>{GRADE_LABELS[grade]}</span></span>;
}
function CallStatus({ session }: { session: Session }) {
  return <span className={`badge status-${session.status}`}><i />{statusText(session)}</span>;
}
function Contact({ session }: { session: Session }) {
  if (session.analysis?.grade !== 'A') return null;
  const contact = session.analysis.wechat;
  const text = contact.sameAsDialed ? '与电话同号' : contact.phone && /^1\d{10}$/.test(contact.phone) ? contact.phone : null;
  return text ? <small className="call-wechat">微信 · {text}</small> : null;
}
function AnalysisState({ session }: { session: Session }) {
  if (session.analysis) return <span className="call-analysis-result"><GradeBadge grade={session.analysis.grade} />{['pending', 'running'].includes(session.analysisStatus) && <small>重新评估中</small>}{session.analysisStatus === 'failed' && <small className="failed">重新评估失败</small>}</span>;
  if (session.analysisStatus === 'failed') return <span className="call-analysis-label failed">评估失败</span>;
  if (session.analysisStatus === 'running') return <span className="call-analysis-label">正在评估…</span>;
  if (session.analysisStatus === 'pending') return <span className="call-analysis-label">等待评估</span>;
  return <span className="call-analysis-label">{session.mode === 'simulation' ? '文字模拟不评估' : session.answeredAt ? '通话结束后评估' : '未接通不评估'}</span>;
}

export function CallRecords({ initialSessionId, initialGrade, initialRange, onCloseDetail }: { initialSessionId?: string; initialGrade?: Grade; initialRange?: { from: string; to: string }; onCloseDetail?: () => void }) {
  const [filters, setFilters] = useState<Filters>(() => ({ ...defaults, grade: initialGrade ?? '', ...(initialRange ? { from: localDate(new Date(initialRange.from)), to: localDate(new Date(Date.parse(initialRange.to) - 1)), range: 'custom' } : {}) }));
  const [page, setPage] = useState<SessionPage>({ items: [], total: 0, page: 1, pageSize: 20 });
  const [provider, setProvider] = useState<AnalysisProviderStatus | null>(null);
  const [providerError, setProviderError] = useState('');
  const [selectedId, setSelectedId] = useState(initialSessionId ?? '');
  const [detail, setDetail] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [error, setError] = useState('');
  const [detailError, setDetailError] = useState('');
  const [revision, setRevision] = useState(0);
  const [detailRevision, setDetailRevision] = useState(0);
  const [searchDraft, setSearchDraft] = useState('');
  const listRequest = useRef(0);
  const detailRequest = useRef(0);
  const retryRequest = useRef(0);
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;

  useEffect(() => { if (initialSessionId) setSelectedId(initialSessionId); }, [initialSessionId]);
  useEffect(() => { setFilters(current => ({ ...current, grade: initialGrade ?? '', page: 1, ...(initialRange ? { from: localDate(new Date(initialRange.from)), to: localDate(new Date(Date.parse(initialRange.to) - 1)), range: 'custom' } : {}) })); }, [initialGrade, initialRange]);
  useEffect(() => { retryRequest.current++; setRetrying(false); }, [selectedId]);
  useEffect(() => {
    const timeout = window.setTimeout(() => setFilters(current => current.search === searchDraft.trim() ? current : { ...current, page: 1, search: searchDraft.trim() }), 300);
    return () => window.clearTimeout(timeout);
  }, [searchDraft]);

  const updateFilters = (change: Partial<Filters>) => setFilters(current => ({ ...current, ...change, page: 1 }));
  const invalidRange = Boolean(filters.from && filters.to && filters.from > filters.to);
  useEffect(() => {
    if (invalidRange) { setLoading(false); return; }
    const controller = new AbortController();
    const request = ++listRequest.current;
    const params = new URLSearchParams({ page: String(filters.page), pageSize: String(filters.pageSize), answeredOnly: String(filters.answeredOnly), dateField: filters.dateField, sortBy: filters.sortBy, sortDir: filters.sortDir });
    const from = boundary(filters.from), to = boundary(filters.to, true);
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    if (filters.grade) params.set('grade', filters.grade);
    if (filters.search) params.set('search', filters.search);
    setLoading(true); setError('');
    void get<SessionPage>(`/sessions?${params}`, controller.signal).then(result => {
      if (controller.signal.aborted || request !== listRequest.current) return;
      const maxPage = Math.max(1, Math.ceil(result.total / filters.pageSize));
      if (filters.page > maxPage) { setFilters(current => ({ ...current, page: maxPage })); return; }
      setPage(result);
    }).catch(reason => { if (!controller.signal.aborted && request === listRequest.current) setError(messageOf(reason)); })
      .finally(() => { if (!controller.signal.aborted && request === listRequest.current) setLoading(false); });
    return () => controller.abort();
  }, [filters, revision, invalidRange]);

  useEffect(() => {
    const controller = new AbortController();
    void get<AnalysisProviderStatus>('/analysis/status', controller.signal).then(result => { if (!controller.signal.aborted) { setProvider(result); setProviderError(''); } }).catch(reason => { if (!controller.signal.aborted) setProviderError(messageOf(reason)); });
    return () => controller.abort();
  }, [revision]);

  useEffect(() => {
    const controller = new AbortController();
    const request = ++detailRequest.current;
    setDetailError('');
    if (!selectedId) { setDetail(null); setDetailLoading(false); return () => controller.abort(); }
    setDetailLoading(current => !detail || detail.id !== selectedId ? true : current);
    void get<Session>(`/sessions/${encodeURIComponent(selectedId)}`, controller.signal).then(result => {
      if (!controller.signal.aborted && request === detailRequest.current) setDetail(result);
    }).catch(reason => { if (!controller.signal.aborted && request === detailRequest.current) setDetailError(messageOf(reason)); })
      .finally(() => { if (!controller.signal.aborted && request === detailRequest.current) setDetailLoading(false); });
    return () => controller.abort();
  }, [selectedId, detailRevision]);

  useEffect(() => {
    const pending = (provider?.pending ?? 0) + (provider?.running ?? 0) + (provider?.industryPending ?? 0);
    // Also refresh a recently ended call while its browser recording is saved.
    const recordingPending = Boolean(detail?.mode === 'seed' && !detail.recording && detail.answeredAt && detail.endedAt && Date.now() - Date.parse(detail.endedAt) < 30_000);
    if (!pending && !isWorking(detail) && !recordingPending) return;
    const timer = window.setInterval(() => {
      setRevision(current => current + 1);
      if (selectedIdRef.current) setDetailRevision(current => current + 1);
    }, 5000);
    return () => window.clearInterval(timer);
  }, [provider, detail]);

  useEffect(() => () => { listRequest.current++; detailRequest.current++; retryRequest.current++; }, []);

  const refresh = useCallback(() => { setRevision(current => current + 1); setDetailRevision(current => current + 1); }, []);
  function setRange(range: string) {
    if (range === 'all') { updateFilters({ range, from: '', to: '' }); return; }
    const today = new Date();
    const start = new Date(today);
    start.setDate(start.getDate() - Number(range) + 1);
    updateFilters({ range, from: localDate(start), to: localDate(today) });
  }
  function sort(field: SortField) {
    setFilters(current => ({ ...current, page: 1, sortBy: field, sortDir: current.sortBy === field && current.sortDir === 'desc' ? 'asc' : 'desc' }));
  }
  function openDetail(id: string) { setDetail(null); setSelectedId(id); window.scrollTo({ top: 0, behavior: 'instant' }); }
  function closeDetail() { setSelectedId(''); setDetail(null); setDetailError(''); onCloseDetail?.(); }
  async function retryAnalysis() {
    if (!detail || retrying) return;
    const id = detail.id, request = ++retryRequest.current;
    // A detail read begun before this mutation must not restore an old grade.
    detailRequest.current++;
    setRetrying(true); setDetailError('');
    try {
      const result = await api<Session>(`/sessions/${encodeURIComponent(id)}/analyze`, {});
      if (selectedIdRef.current === id && request === retryRequest.current) { setDetail(result); setDetailRevision(current => current + 1); setRevision(current => current + 1); }
    } catch (reason) { if (selectedIdRef.current === id && request === retryRequest.current) setDetailError(messageOf(reason)); }
    finally { if (selectedIdRef.current === id && request === retryRequest.current) setRetrying(false); }
  }

  const pages = Math.max(1, Math.ceil(page.total / filters.pageSize));
  const currentDetail = detail?.id === selectedId ? detail : null;
  const pageNumbers = [...new Set([1, filters.page - 1, filters.page, filters.page + 1, pages])].filter(number => number >= 1 && number <= pages).sort((a, b) => a - b);
  const rangeStart = page.total ? (filters.page - 1) * filters.pageSize + 1 : 0;
  const rangeEnd = Math.min(filters.page * filters.pageSize, page.total);

  return <div className="call-records">
    <div className="call-analysis-status" role="status">
      <div><span className={`call-provider-dot ${provider?.configured ? 'ready' : ''}`} /><strong>{providerError ? '暂时无法读取评估状态' : provider?.configured ? '通话评估已就绪' : provider ? '等待配置 DeepSeek API Key' : '正在读取评估状态…'}</strong>{provider && <span className="call-provider-model">{provider.model}</span>}</div>
      <p>{providerError || (provider?.configured ? `待评估 ${provider.pending} · 评估中 ${provider.running} · 失败 ${provider.failed}` : provider ? '在 .env 中配置 DEEPSEEK_API_KEY 后重启服务，待处理任务会继续执行。' : '接通且结束的语音通话会自动加入评估队列。')}</p>
    </div>

    {selectedId ? <>
      <div className="call-detail-toolbar"><button type="button" className="text-button" onClick={closeDetail}>← 返回通话列表</button><div><a className="button secondary small" href={`/api/sessions/${encodeURIComponent(selectedId)}/export`} download>导出 JSON</a><button type="button" className="button secondary small" onClick={refresh} disabled={detailLoading}>刷新</button></div></div>
      {detailError && <div className="alert error" role="alert"><p>{detailError}</p></div>}
      {detailLoading && !currentDetail ? <div className="panel call-record-empty" role="status">正在读取通话详情…</div> : currentDetail ? <>
        <section className="panel call-detail-header">
          <div><span className="call-eyebrow">通话详情</span><h2>{currentDetail.customer.camp}</h2><p>{currentDetail.customer.name || '未填写姓名'}<span>·</span><a href={`tel:${currentDetail.customer.phone}`}>{currentDetail.customer.phone}</a></p></div>
          <div className="call-detail-tags"><CallStatus session={currentDetail} /><span className="subtle-tag">{currentDetail.mode === 'seed' ? '语音测试' : '文字模拟'}</span></div>
          <dl className="call-detail-facts"><div><dt>开始时间</dt><dd>{dateText(currentDetail.createdAt)}</dd></div><div><dt>接通时间</dt><dd>{dateText(currentDetail.answeredAt)}</dd></div><div><dt>通话时长</dt><dd>{elapsed(currentDetail)}</dd></div><div><dt>客户行业</dt><dd>{currentDetail.customer.industry || '未识别'}</dd></div></dl>
          {currentDetail.error && <p className="call-detail-warning">{currentDetail.error}</p>}
        </section>
        <div className="call-detail-grid">
          <section className="panel call-dialogue"><div className="panel-heading"><h2>逐句对话</h2><span className="subtle-tag">{currentDetail.transcripts.length} 条发言</span></div>
            {currentDetail.transcripts.length ? <ol className="call-message-list">{currentDetail.transcripts.map(item => <li id={`transcript-${item.id}`} key={item.id} className={`call-message ${item.kind === 'AsrText' ? 'from-customer' : 'from-agent'}`}>
              <div className="call-message-meta"><strong>{item.kind === 'AsrText' ? '客户' : '销售智能体'}</strong><time dateTime={item.createdAt}>{timeFormatter.format(new Date(item.createdAt))}</time>{!item.final && <span>未完成的片段</span>}</div><p>{item.text}</p>
            </li>)}</ol> : <div className="call-record-empty"><strong>没有保存到对话内容</strong><p>{currentDetail.answeredAt ? '此通话尚无识别结果。' : '通话未接通，未产生对话记录。'}</p></div>}
          </section>
          <aside className="call-detail-side">
            <section className="panel call-assessment"><div className="panel-heading"><h2>意向评估</h2><AnalysisState session={currentDetail} /></div><div className="panel-body">
              {currentDetail.analysis ? <>
                <p className="call-assessment-summary">{currentDetail.analysis.summary}</p><p className="call-assessment-reason">{currentDetail.analysis.reason}</p>
                {currentDetail.analysis.grade === 'A' && <div className="call-contact-card"><strong>微信联系信息</strong><p>{currentDetail.analysis.wechat.sameAsDialed ? '与电话同号' : currentDetail.analysis.wechat.phone || currentDetail.analysis.wechat.identifier || '已获得添加许可'}</p>{currentDetail.analysis.wechat.sameAsDialed && <span className="mono">{currentDetail.customer.phone}</span>}</div>}
                {currentDetail.analysis.evidence.length > 0 && <div className="call-evidence"><h3>判断依据</h3>{currentDetail.analysis.evidence.map((item, index) => <a key={`${item.transcriptId}-${index}`} href={`#transcript-${item.transcriptId}`} onClick={event => { event.preventDefault(); document.getElementById(`transcript-${item.transcriptId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }); }}><span>“</span>{item.quote}<span>”</span></a>)}</div>}
                <p className="call-assessment-meta">客户发言 {currentDetail.analysis.customerTurns} 轮 · 智能体发言 {currentDetail.analysis.assistantTurns} 轮<br />{dateText(currentDetail.analysis.evaluatedAt)} 评估{currentDetail.analysisStatus !== 'completed' && <><br />当前显示上次成功评估的结果</>}</p>
                {currentDetail.analysisStatus === 'failed' && <p className="call-assessment-error" role="alert">{currentDetail.analysisError || '本次重新评估失败，上次评估结果已保留。'}</p>}
              </> : <p className="call-no-analysis">{currentDetail.analysisStatus === 'failed' ? currentDetail.analysisError || '评估未完成，可重试。' : currentDetail.analysisStatus === 'running' ? '模型正在阅读对话并整理判断依据。' : currentDetail.analysisStatus === 'pending' ? provider?.configured ? '通话已进入评估队列，完成后会自动更新。' : '通话已进入队列，配置 DeepSeek API Key 后会自动评估。' : currentDetail.mode === 'simulation' ? '文字模拟仅用于测试话术，不计入接通电话评估。' : currentDetail.answeredAt ? '通话结束后会自动评估。' : '仅对接通的语音通话进行意向评估。'}</p>}
              {currentDetail.mode === 'seed' && currentDetail.answeredAt && ['completed', 'failed'].includes(currentDetail.status) && <button type="button" className="button secondary small call-retry-analysis" onClick={() => void retryAnalysis()} disabled={retrying || !provider?.configured || ['pending', 'running'].includes(currentDetail.analysisStatus)}>{retrying ? '提交中…' : currentDetail.analysis ? '重新评估' : '重试评估'}</button>}
            </div></section>
            <section className="panel call-recording"><div className="panel-heading"><h2>原始录音</h2>{currentDetail.recording && <a className="text-button" href={currentDetail.recording.url} download>下载</a>}</div><div className="panel-body">{currentDetail.recording ? <><audio controls preload="metadata" src={currentDetail.recording.url} aria-label="播放本通电话的原始录音" /><p>双向通话录音 · {(currentDetail.recording.bytes / 1024 / 1024).toFixed(2)} MB</p></> : <p>{currentDetail.mode === 'simulation' ? '文字模拟不产生录音。' : ['created', 'connecting', 'opening', 'active'].includes(currentDetail.status) ? '通话结束后，录音会保存在此处。' : '此通话没有可用录音。历史通话无法补录。'}</p>}</div></section>
          </aside>
        </div>
        <details className="panel call-prompt-snapshot"><summary>限制词快照<span>查看本通电话实际使用的完整限制词</span></summary><pre>{currentDetail.prompt || '此通话没有保存限制词快照。'}</pre></details>
      </> : !detailError && <div className="panel call-record-empty">未找到此通话。</div>}
    </> : <>
      <section className="panel call-filter-panel" aria-label="通话筛选器">
        <div className="call-filter-top"><div className="call-date-presets" aria-label="日期快捷筛选">{[['all', '全部时间'], ['1', '今天'], ['7', '近 7 天'], ['30', '近 30 天']].map(([value, label]) => <button key={value} type="button" aria-pressed={filters.range === value} className={filters.range === value ? 'selected' : ''} onClick={() => setRange(value)}>{label}</button>)}</div><label className="call-answered-toggle"><input type="checkbox" checked={filters.answeredOnly} onChange={event => updateFilters({ answeredOnly: event.target.checked })} />仅显示接通</label></div>
        <div className="call-filter-fields">
          <label><span>日期维度</span><select value={filters.dateField} onChange={event => updateFilters({ dateField: event.target.value as DateField })}><option value="createdAt">开始时间</option><option value="answeredAt">接通时间</option><option value="endedAt">结束时间</option></select></label>
          <label><span>开始日期</span><input type="date" value={filters.from} max={filters.to || undefined} onChange={event => updateFilters({ from: event.target.value, range: 'custom' })} /></label>
          <label><span>结束日期</span><input type="date" value={filters.to} min={filters.from || undefined} onChange={event => updateFilters({ to: event.target.value, range: 'custom' })} /></label>
          <label><span>意向等级</span><select value={filters.grade} onChange={event => updateFilters({ grade: event.target.value })}><option value="">全部等级</option>{GRADES.map(grade => <option value={grade} key={grade}>{grade} 级 · {GRADE_LABELS[grade]}</option>)}</select></label>
          <label className="call-search"><span>搜索客户</span><input value={searchDraft} onChange={event => setSearchDraft(event.target.value)} placeholder="姓名、公司或电话" /></label>
        </div>
        {invalidRange && <p className="call-filter-error" role="alert">开始日期不能晚于结束日期。</p>}
      </section>
      {error && <div className="alert error" role="alert"><p>{error}</p><button type="button" onClick={refresh} aria-label="重新加载通话列表">↻</button></div>}
      <section className="panel call-table-panel" aria-label="通话记录">
        <div className="panel-heading"><div className="call-list-heading"><h2>通话记录</h2><span>{loading ? '正在加载…' : `共 ${page.total} 通`}</span></div><button type="button" className="button secondary small" onClick={refresh} disabled={loading}>刷新</button></div>
        <div className="table-wrap" aria-busy={loading}><table className="call-table"><thead><tr><th scope="col">客户 / 公司</th><th scope="col">电话</th>{(['createdAt', 'status', 'grade'] as SortField[]).map((field, index) => <th key={field} scope="col" aria-sort={filters.sortBy === field ? filters.sortDir === 'asc' ? 'ascending' : 'descending' : 'none'}><button type="button" className={`call-sort ${filters.sortBy === field ? 'active' : ''}`} onClick={() => sort(field)}>{['开始时间', '状态', '意向度'][index]}<span aria-hidden="true">{filters.sortBy === field ? filters.sortDir === 'asc' ? '↑' : '↓' : '↕'}</span></button></th>)}<th scope="col">操作</th></tr></thead><tbody>
          {page.items.map(session => <tr key={session.id}><td className="call-company"><strong>{session.customer.name || '未填写姓名'}</strong><small title={session.customer.camp}>{session.customer.camp}</small></td><td className="mono">{session.customer.phone}</td><td className="call-started"><time dateTime={session.createdAt}>{dateText(session.createdAt)}</time><small>{session.mode === 'simulation' ? '文字模拟' : '语音测试'}</small></td><td><CallStatus session={session} /></td><td><AnalysisState session={session} /><Contact session={session} /></td><td><button type="button" className="text-button" onClick={() => openDetail(session.id)} aria-label={`查看${session.customer.name || session.customer.camp}的通话详情`}>查看详情 →</button></td></tr>)}
          {!page.items.length && <tr><td colSpan={6} className="call-record-empty">{loading ? '正在读取通话…' : <><strong>没有符合条件的通话</strong><p>{filters.answeredOnly ? '仅显示已接通的语音通话。可取消“仅显示接通”查看文字模拟或未接通记录。' : '调整日期、等级或搜索条件后重试。'}</p></>}</td></tr>}
        </tbody></table></div>
        <div className="call-pagination"><div><span>第 {rangeStart}–{rangeEnd} 条，共 {page.total} 条</span><label>每页<select aria-label="每页条数" value={filters.pageSize} onChange={event => updateFilters({ pageSize: Number(event.target.value) })}>{[10, 20, 50, 100].map(count => <option key={count} value={count}>{count} 条</option>)}</select></label></div><nav aria-label="通话记录翻页"><button type="button" aria-label="上一页" disabled={loading || filters.page <= 1} onClick={() => setFilters(current => ({ ...current, page: current.page - 1 }))}>‹</button>{pageNumbers.map((number, index) => <span key={number}>{index > 0 && number - pageNumbers[index - 1] > 1 && <span className="call-page-gap">…</span>}<button type="button" aria-current={number === filters.page ? 'page' : undefined} disabled={loading} onClick={() => setFilters(current => ({ ...current, page: number }))}>{number}</button></span>)}<button type="button" aria-label="下一页" disabled={loading || filters.page >= pages} onClick={() => setFilters(current => ({ ...current, page: current.page + 1 }))}>›</button></nav></div>
      </section>
      <p className="call-grade-legend">{GRADES.map(grade => <span key={grade}><i className={`grade-${grade}`}>{grade}</i>{GRADE_LABELS[grade]}</span>)}</p>
    </>}
  </div>;
}
