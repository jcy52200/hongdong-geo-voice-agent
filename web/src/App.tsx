import { useCallback, useEffect, useRef, useState } from 'react';
import { api, messageOf } from './api';
import { LocalAudio } from './audio';
import { PromptControl } from './PromptControl';
import type { AgentConfig, Bootstrap, Customer, ServerEvent, Session, SessionStatus, Transcript } from './types';

type Page = 'voice' | 'prompt' | 'customers' | 'sessions' | 'integrations';
const pages: { id: Page; symbol: string; label: string; note?: string }[] = [
  { id: 'voice', symbol: '◉', label: '模拟电话' },
  { id: 'prompt', symbol: '≡', label: '限制词控制' },
  { id: 'customers', symbol: '▤', label: '客户资料' },
  { id: 'sessions', symbol: '☷', label: '通话记录' },
  { id: 'integrations', symbol: '⌘', label: '系统接入', note: '预留' },
];
const statusText: Record<SessionStatus, string> = { created: '等待连接', connecting: '连接中', opening: '开场播放中', active: '对话进行中', completed: '已结束', failed: '连接失败' };
const emptyCustomer = { camp: '', name: '', phone: '', address: '', industry: '' };
const demoCustomer = { camp: '石家庄示例机械设备有限公司', name: '王先生', phone: '13800000000', address: '河北省石家庄市', industry: '机械设备' };
const activeStatus = (status?: SessionStatus) => Boolean(status && !['completed', 'failed'].includes(status));
const dateText = (date: string) => new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(date));
const pageFromHash = (): Page => pages.find(item => `#${item.id}` === location.hash)?.id ?? 'voice';

function Badge({ status }: { status: SessionStatus }) { return <span className={`badge status-${status}`}><i />{statusText[status]}</span>; }
function Empty({ title, detail }: { title: string; detail: string }) { return <div className="empty"><div className="empty-mark">◌</div><strong>{title}</strong><p>{detail}</p></div>; }
function TranscriptList({ transcripts, compact = false }: { transcripts: Transcript[]; compact?: boolean }) {
  const bottomRef = useRef<HTMLDivElement>(null);
  useEffect(() => { bottomRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }, [transcripts]);
  return <div className={`transcripts ${compact ? 'compact' : ''}`} role="log" aria-label="逐句对话记录" aria-live="polite">
    {!transcripts.length ? <Empty title="对话将从这里开始" detail="连接测试后，客户 ASR 与智能体回复会逐句显示。" /> : transcripts.map(item => <div key={item.id} className={`utterance ${item.kind === 'ChatText' ? 'agent' : 'customer'}`}>
      <div className="utterance-avatar">{item.kind === 'ChatText' ? '泓' : '客'}</div><div className="utterance-content"><div className="utterance-meta"><strong>{item.kind === 'ChatText' ? '销售智能体' : '客户'}</strong><span>{item.kind}</span><time>{dateText(item.createdAt)}</time>{!item.final && <span className="draft-tag">识别中</span>}</div><p>{item.text}</p></div>
    </div>)}<div ref={bottomRef} />
  </div>;
}

export default function App() {
  const [page, setPage] = useState<Page>(pageFromHash);
  const [data, setData] = useState<Bootstrap | null>(null);
  const [config, setConfig] = useState<AgentConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [customerId, setCustomerId] = useState('');
  const [mode, setMode] = useState<'simulation' | 'seed'>('seed');
  const [live, setLive] = useState<Session | null>(null);
  const [viewed, setViewed] = useState<Session | null>(null);
  const [openingLocked, setOpeningLocked] = useState(true);
  const [muted, setMuted] = useState(false);
  const [callSeconds, setCallSeconds] = useState(0);
  const [text, setText] = useState('');
  const [preview, setPreview] = useState<{ prompt: string; opening: string } | null>(null);
  const [customerForm, setCustomerForm] = useState(emptyCustomer);
  const [importText, setImportText] = useState('');
  const [contracts, setContracts] = useState<unknown>(null);
  const [search, setSearch] = useState('');
  const wsRef = useRef<WebSocket | null>(null);
  const audioRef = useRef<LocalAudio | null>(null);
  const liveRef = useRef<Session | null>(null);
  const openingRef = useRef(true);
  const mutedRef = useRef(false);
  const generation = useRef(0);
  const refreshGeneration = useRef(0);
  const connectionTimer = useRef<number | undefined>(undefined);

  useEffect(() => { history.replaceState(null, '', `#${page}`); window.scrollTo({ top: 0, left: 0 }); }, [page]);
  useEffect(() => {
    const navigate = () => setPage(pageFromHash());
    window.addEventListener('hashchange', navigate);
    return () => window.removeEventListener('hashchange', navigate);
  }, []);

  const saveSessionHistory = useCallback((session: Session) => {
    setData(current => current ? { ...current, sessions: [session, ...current.sessions.filter(item => item.id !== session.id)].sort((left, right) => right.createdAt.localeCompare(left.createdAt)) } : current);
  }, []);

  const updateSession = useCallback((session: Session) => {
    liveRef.current = session;
    setLive(session);
    saveSessionHistory(session);
  }, [saveSessionHistory]);

  // Async responses may outlive the connection that requested them. They can
  // refresh history, but only the matching generation may replace the live call.
  const applySnapshot = useCallback((session: Session, run: number, sessionId: string) => {
    if (session.id !== sessionId) return false;
    if (run === generation.current && sessionId === liveRef.current?.id) {
      updateSession(session);
      return true;
    }
    saveSessionHistory(session);
    return false;
  }, [saveSessionHistory, updateSession]);

  const refresh = useCallback(async (quiet = false) => {
    const request = ++refreshGeneration.current;
    const run = generation.current;
    if (!quiet) setLoading(true);
    try {
      const result = await api<Bootstrap>('/bootstrap');
      if (request !== refreshGeneration.current) return;
      setData(current => {
        const sessions = new Map(result.sessions.map(session => [session.id, session]));
        // A request begun before a new call must not erase that call's history.
        for (const session of current?.sessions ?? []) if (!sessions.has(session.id)) sessions.set(session.id, session);
        const currentLive = liveRef.current;
        if (currentLive && wsRef.current) sessions.set(currentLive.id, currentLive);
        return { ...result, sessions: [...sessions.values()].sort((left, right) => right.createdAt.localeCompare(left.createdAt)) };
      });
      const currentLive = liveRef.current;
      if (run === generation.current && !wsRef.current && currentLive) {
        const snapshot = result.sessions.find(session => session.id === currentLive.id);
        if (snapshot && !activeStatus(snapshot.status)) applySnapshot(snapshot, run, currentLive.id);
      }
      setConfig(current => current ? { ...result.config, ...current, systemPrompt: current.systemPrompt ?? result.config.systemPrompt } : result.config);
      setCustomerId(current => result.customers.some(customer => customer.id === current) ? current : result.customers[0]?.id ?? '');
    } catch (reason) { if (request === refreshGeneration.current && run === generation.current) setError(messageOf(reason)); }
    finally { if (request === refreshGeneration.current) setLoading(false); }
  }, [applySnapshot]);

  const release = useCallback(() => {
    if (connectionTimer.current) window.clearTimeout(connectionTimer.current);
    const ws = wsRef.current;
    wsRef.current = null;
    if (ws) { ws.onopen = null; ws.onmessage = null; ws.onclose = null; ws.onerror = null; ws.close(); }
    audioRef.current?.close();
    audioRef.current = null;
  }, []);

  useEffect(() => {
    void refresh();
    const onLeave = () => { const ws = wsRef.current; if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'finish' })); release(); };
    window.addEventListener('pagehide', onLeave);
    return () => { generation.current++; window.removeEventListener('pagehide', onLeave); onLeave(); };
  }, [refresh, release]);
  useEffect(() => { if (!notice) return; const timer = window.setTimeout(() => setNotice(''), 5000); return () => window.clearTimeout(timer); }, [notice]);
  useEffect(() => { if (!preview) return; const close = (event: KeyboardEvent) => { if (event.key === 'Escape') setPreview(null); }; window.addEventListener('keydown', close); return () => window.removeEventListener('keydown', close); }, [preview]);

  useEffect(() => {
    if (!live) { setCallSeconds(0); return; }
    const update = () => setCallSeconds(Math.max(0, Math.floor((new Date(live.endedAt ?? Date.now()).getTime() - new Date(live.createdAt).getTime()) / 1000)));
    update();
    if (!activeStatus(live.status)) return;
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, [live?.id, live?.status, live?.createdAt, live?.endedAt]);

  const selectedCustomer = data?.customers.find(item => item.id === customerId);
  const connected = activeStatus(live?.status) && Boolean(wsRef.current);
  const inProgress = busy || connected;
  const filterText = search.trim().toLowerCase();
  const filteredCustomers = data?.customers.filter(item => `${item.camp} ${item.name} ${item.phone} ${item.address}`.toLowerCase().includes(filterText)) ?? [];

  async function showPrompt(draft = false) {
    if (!selectedCustomer) { setError('请先添加或选择一位客户。'); return; }
    setSaving(true); setError('');
    try { setPreview(await api('/prompt/preview', { customer: selectedCustomer, ...(draft ? { config } : {}) })); }
    catch (reason) { setError(messageOf(reason)); }
    finally { setSaving(false); }
  }

  async function startSession() {
    if (!selectedCustomer || inProgress) return;
    setBusy(true); setError(''); setNotice(''); setMuted(false); mutedRef.current = false;
    openingRef.current = true; setOpeningLocked(true);
    const run = ++generation.current;
    // AudioContext is created and resumed synchronously inside this user gesture.
    let audio: LocalAudio | null = null;
    let created: Session | null = null;
    try {
      audio = mode === 'seed' ? new LocalAudio() : null;
      audioRef.current = audio;
      if (audio) await audio.prepare(frame => {
        const ws = wsRef.current;
        if (run === generation.current && !openingRef.current && !mutedRef.current && ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'audio', audio: frame }));
      });
      if (run !== generation.current) return;
      created = await api<Session>('/sessions', { customerId: selectedCustomer.id, mode });
      if (run !== generation.current) { void api<Session>(`/sessions/${created.id}/finish`, {}).then(saveSessionHistory).catch(() => undefined); return; }
      updateSession(created);
      const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/sessions/${encodeURIComponent(created.id)}`);
      wsRef.current = ws;
      const sessionId = created.id;
      const fail = (message: string) => {
        if (run !== generation.current || liveRef.current?.id !== sessionId || wsRef.current !== ws) return;
        setError(message); setBusy(false);
        const current = liveRef.current;
        if (current?.id === sessionId && activeStatus(current.status)) updateSession({ ...current, status: 'failed', error: message });
        const readFinal = () => {
          void api<Session>(`/sessions/${sessionId}`).then(session => {
            if (!activeStatus(session.status)) applySnapshot(session, run, sessionId);
            if (run === generation.current && liveRef.current?.id === sessionId) void refresh(true);
          }).catch(() => undefined);
        };
        // Closing the transport lets the server record failure. A finish request
        // here could race the provider failure and incorrectly mark it completed.
        if (ws.readyState === WebSocket.CLOSED) readFinal();
        else ws.addEventListener('close', readFinal, { once: true });
        release();
      };
      connectionTimer.current = window.setTimeout(() => fail('连接超时，请检查服务和火山引擎配置后重试。'), 20000);
      ws.onopen = () => { if (run !== generation.current || liveRef.current?.id !== sessionId || wsRef.current !== ws) return; if (connectionTimer.current) window.clearTimeout(connectionTimer.current); setBusy(false); };
      ws.onerror = () => fail('语音连接失败，请检查本地服务是否正常运行。');
      ws.onclose = event => {
        if (run !== generation.current || liveRef.current?.id !== sessionId || wsRef.current !== ws) return;
        release(); setBusy(false);
        void api<Session>(`/sessions/${sessionId}`).then(session => {
          const owned = applySnapshot(session, run, sessionId);
          if (owned && activeStatus(session.status)) setError(`连接已关闭（${event.code}），请结束此会话后重新测试。`);
        }).catch(reason => { if (run === generation.current && liveRef.current?.id === sessionId) setError(messageOf(reason)); });
      };
      ws.onmessage = event => {
        const current = liveRef.current;
        if (run !== generation.current || !current || current.id !== sessionId || wsRef.current !== ws) return;
        let message: ServerEvent;
        try { message = JSON.parse(String(event.data)) as ServerEvent; }
        catch { setError('收到无法识别的服务端消息。'); return; }
        switch (message.type) {
          case 'session': if (message.session.id !== sessionId) return; updateSession(message.session); if (!activeStatus(message.session.status)) { release(); setBusy(false); } break;
          case 'transcript': if (current) updateSession({ ...current, transcripts: [...current.transcripts.filter(item => item.id !== message.transcript.id), message.transcript] }); break;
          case 'audio': audio?.play(message.audio, message.rate); break;
          case 'audio_done': if (message.opening) {
            const unlock = () => {
              if (run !== generation.current || liveRef.current?.id !== sessionId || wsRef.current !== ws || ws.readyState !== WebSocket.OPEN) return;
              ws.send(JSON.stringify({ type: 'playback_done' }));
              openingRef.current = false; setOpeningLocked(false);
              audio?.setInputEnabled(!mutedRef.current);
            };
            if (audio) audio.afterPlayback(unlock); else unlock();
          } break;
          case 'interrupted': if (!openingRef.current) audio?.clearPlayback(); break;
          case 'input_state': mutedRef.current = message.muted; setMuted(message.muted); audio?.setInputEnabled(!openingRef.current && !message.muted); break;
          case 'error': fail(message.message); break;
          case 'state':
            if (current) updateSession({ ...current, status: message.status });
            // Simulation enters active directly; Seed enters it only after the
            // server accepts our drained-playback acknowledgement.
            if (message.status === 'active') { openingRef.current = false; setOpeningLocked(false); audio?.setInputEnabled(!mutedRef.current); }
            if (!activeStatus(message.status)) { release(); setBusy(false); void refresh(true); }
            break;
        }
      };
    } catch (reason) {
      if (run !== generation.current) return;
      setError(messageOf(reason)); release(); setBusy(false);
      if (created) {
        const sessionId = created.id;
        void api<Session>(`/sessions/${sessionId}/finish`, {}).then(session => applySnapshot(session, run, sessionId)).catch(() => undefined);
      }
    }
  }

  async function finishSession() {
    const run = ++generation.current; setBusy(false);
    const current = liveRef.current;
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'finish' }));
    release();
    if (!current || !activeStatus(current.status)) return;
    const sessionId = current.id;
    try { const session = await api<Session>(`/sessions/${sessionId}/finish`, {}); if (applySnapshot(session, run, sessionId)) void refresh(true); }
    catch (reason) { if (run === generation.current && liveRef.current?.id === sessionId) setError(messageOf(reason)); }
  }

  function sendText(value = text) {
    const ws = wsRef.current;
    if (!value.trim() || openingRef.current || ws?.readyState !== WebSocket.OPEN || liveRef.current?.mode !== 'simulation') return;
    ws.send(JSON.stringify({ type: 'text', text: value.trim() })); setText('');
  }

  function toggleMute() {
    const next = !mutedRef.current;
    mutedRef.current = next; setMuted(next);
    audioRef.current?.setInputEnabled(!openingRef.current && !next);
    if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.send(JSON.stringify({ type: 'mute', muted: next }));
  }

  async function saveConfig(goToTest = false) {
    if (!config) return;
    setSaving(true); setError('');
    try { const saved = await api<AgentConfig>('/config', config, 'PUT'); setConfig(saved); setData(current => current ? { ...current, config: saved } : current); setNotice('限制词与模型参数已保存，默认用于新通话；当前通话可在实时干预中应用。'); if (goToTest) { setMode('seed'); setPage('voice'); } }
    catch (reason) { setError(messageOf(reason)); }
    finally { setSaving(false); }
  }

  async function useDemoCustomer() {
    setSaving(true); setError('');
    try {
      const result = await api<{ customers: Customer[] }>('/customers/import', { customers: [demoCustomer] });
      setData(current => current ? { ...current, customers: result.customers } : current);
      setCustomerId(result.customers.find(customer => customer.phone === demoCustomer.phone)!.id);
      setNotice('已带入虚构示例客户，可以直接试打。');
    } catch (reason) { setError(messageOf(reason)); }
    finally { setSaving(false); }
  }

  async function importCustomers(customers: unknown[]) {
    setSaving(true); setError('');
    try {
      const result = await api<{ customers: Customer[]; imported: number }>('/customers/import', { customers });
      setData(current => current ? { ...current, customers: result.customers } : current);
      setCustomerId(current => current || result.customers[0]?.id || '');
      setNotice(`已导入 ${result.imported} 条客户资料。`); setImportText(''); setCustomerForm(emptyCustomer);
    } catch (reason) { setError(messageOf(reason)); }
    finally { setSaving(false); }
  }

  function parseImport() {
    try {
      const parsed: unknown = JSON.parse(importText);
      const rows: unknown = Array.isArray(parsed) ? parsed : parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>).customers : null;
      if (!Array.isArray(rows)) throw new Error('JSON 应为客户数组，或包含 customers 数组的对象。');
      if (!rows.length) throw new Error('客户数组为空，请添加客户资料后导入。');
      void importCustomers(rows);
    } catch (reason) { setError(messageOf(reason)); }
  }

  async function openSession(session: Session) {
    try { const result = await api<Session>(`/sessions/${session.id}`); setViewed(result); setPage('sessions'); }
    catch (reason) { setError(messageOf(reason)); }
  }
  async function exportSession(session: Session) {
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(session.id)}/export`);
      if (!response.ok) throw new Error('导出失败，请稍后重试。');
      const url = URL.createObjectURL(await response.blob());
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = `call-${session.id}.json`; anchor.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (reason) { setError(messageOf(reason)); }
  }

  return <div className="app-shell">
    <aside className="sidebar"><a className="brand" href="#voice" onClick={event => { event.preventDefault(); setPage('voice'); }}><div className="brand-mark">泓</div><div><strong>泓动引擎</strong><span>AI 销售工作台</span></div></a>
      <div className="nav-section-label">工作空间</div><nav aria-label="主导航">{pages.map(item => <button key={item.id} className={`nav-item ${page === item.id ? 'selected' : ''}`} onClick={() => { setPage(item.id); setSearch(''); }}><span className="nav-symbol" aria-hidden="true">{item.symbol}</span>{item.label}{item.note && <small>{item.note}</small>}</button>)}</nav>
      <div className="sidebar-flow"><span>项目实施进度</span><div><i className="flow-done" />语音智能体<span>当前阶段</span></div><div><i />拨号系统<span>待接入</span></div><div><i />意向分析<span>待接入</span></div></div>
      <div className="sidebar-footer"><span className="local-dot" />本地工作空间<small>数据保存在本机</small></div>
    </aside>
    <div className="main-shell"><header className="topbar"><div className="breadcrumb">工作空间<span>/</span><strong>{pages.find(item => item.id === page)?.label}</strong></div><div className="topbar-right"><span className="local-label">LOCAL</span><span>泓动引擎</span><span className="user-avatar">泓</span></div></header>
      <main className="main-content">
        <div className="page-heading"><div><h1>{page === 'voice' ? '模拟电话' : page === 'prompt' ? '限制词控制' : page === 'customers' ? '客户资料' : page === 'sessions' ? '通话记录' : '系统接入'}</h1><p>{page === 'voice' ? '您扮演客户，与销售智能体进行一通实时语音电话。' : page === 'prompt' ? '调整模型参数与限制词，连接模拟电话后可实时干预回复。' : page === 'customers' ? '导入客户列表，为每通对话生成独立的客户上下文。' : page === 'sessions' ? '逐通查看客户原话、智能体回复与提示词快照。' : '以独立会话为边界，连接拨号、语音和后续意向分析。'}</p></div><button className="button secondary" onClick={() => void refresh()} disabled={loading}>{loading ? '刷新中…' : '↻ 刷新数据'}</button></div>
        {error && <div className="alert error" role="alert"><span>!</span><p>{error}</p><button aria-label="关闭错误提示" onClick={() => setError('')}>×</button></div>}
        {notice && <div className="alert success" role="status"><span>✓</span><p>{notice}</p><button aria-label="关闭提示" onClick={() => setNotice('')}>×</button></div>}
        {loading && !data ? <div className="loading-layout" aria-label="正在加载工作台"><div /><div /><div /></div> : !data ? <div className="panel"><Empty title="暂时无法连接本地服务" detail="请确认后端已启动，然后点击刷新数据。" /></div> : <>
          {page === 'voice' && <>
            <div className="overview-strip"><div><span className="overview-icon">▤</span><div><small>可测试客户</small><strong>{data.customers.length}<em>位</em></strong></div></div><div><span className="overview-icon">☷</span><div><small>已保存会话</small><strong>{data.sessions.length}<em>通</em></strong></div></div><div className="provider-overview"><span className={`provider-light ${data.provider.configured ? 'ready' : ''}`} /><div><small>SeedDuplex 语音服务</small><strong className="provider-value">{data.provider.configured ? '已配置密钥' : '待配置 API Key'}</strong></div><span className="subtle-tag">{data.provider.model}</span></div></div>
            <div className="call-intro"><div><strong>像接电话一样，测试真实对话</strong><p>选择客户 → 点击开始模拟电话 → 允许麦克风并扮演客户。AI 会先完整说完开场白。</p></div><button className="button secondary" onClick={() => setPage('prompt')}>编辑限制词 →</button></div>
            {config && JSON.stringify(config) !== JSON.stringify(data.config) && <div className="alert prompt-draft-notice"><p>限制词或模型参数有未保存修改，试打将沿用已保存版本。</p><button className="text-button" onClick={() => setPage('prompt')}>去保存 →</button></div>}
            <div className="workbench-grid"><section className="panel test-settings"><div className="panel-heading"><h2>模拟电话设置</h2><span className="subtle-tag">单通隔离</span></div><div className="panel-body"><label className="field">客户资料<select value={customerId} onChange={event => setCustomerId(event.target.value)} disabled={inProgress}><option value="" disabled>请选择客户</option>{data.customers.map(customer => <option key={customer.id} value={customer.id}>{customer.name} · {customer.camp}</option>)}</select></label>
              {selectedCustomer ? <div className="customer-summary"><div className="customer-summary-head"><span className="company-avatar">{selectedCustomer.camp.slice(0, 1)}</span><div><strong>{selectedCustomer.camp}</strong><span>{selectedCustomer.industry || '行业未指定'}</span></div></div><dl><div><dt>客户</dt><dd>{selectedCustomer.name}</dd></div><div><dt>电话</dt><dd className="mono">{selectedCustomer.phone}</dd></div><div><dt>地区</dt><dd>{selectedCustomer.address}</dd></div></dl></div> : <div className="inline-empty">还没有客户资料。<button className="text-button" onClick={() => setPage('customers')}>添加客户 →</button></div>}
              <button className="text-button demo-call-button" disabled={inProgress || saving} onClick={() => void useDemoCustomer()}>使用虚构示例客户</button>
              <div className="field"><span>测试方式</span><div className="mode-options"><button className={mode === 'simulation' ? 'chosen' : ''} onClick={() => setMode('simulation')} disabled={inProgress}><strong>文字预演</strong><small>规则流程 · 无需密钥</small></button><button className={mode === 'seed' ? 'chosen' : ''} onClick={() => setMode('seed')} disabled={inProgress}><strong>语音试打</strong><small>SeedDuplex · 麦克风</small></button></div></div>
              <div className="test-note"><strong>{mode === 'simulation' ? '先验证流程与记录' : '使用浏览器麦克风测试'}</strong><p>{mode === 'simulation' ? '这是本地规则模拟，不代表 SeedDuplex 的音色、自然度或模型能力。' : '点击连接后授权麦克风。开场完整播放后，才会向模型发送您的语音。建议使用耳机。'}</p></div>
              {mode === 'seed' && !data.provider.configured && <p className="config-warning">请先在服务端 .env 配置火山引擎 API Key。</p>}
              {inProgress ? <button className="button danger full" onClick={() => void finishSession()}>{busy ? '取消连接' : '结束本次测试'}</button> : <button className="button primary full" onClick={() => void startSession()} disabled={!selectedCustomer || (mode === 'seed' && !data.provider.configured)}>{mode === 'seed' ? '◉ 开始模拟电话' : '开始文字预演'}</button>}
              <button className="button plain full preview-button" onClick={() => void showPrompt()} disabled={!selectedCustomer || saving}>查看本通提示词 ↗</button><div className="privacy-note">仅测试语音，不会拨打客户电话</div>
            </div></section>
              <section className="panel conversation-panel"><div className="panel-heading"><div className="heading-with-subtitle"><h2>电话对话</h2><span>{live ? `${live.customer.name} · ${live.mode === 'seed' ? 'SeedDuplex 语音' : '规则文字模拟'}` : '等待发起测试'}</span></div><div className="call-status"><time className="call-timer mono">{String(Math.floor(callSeconds / 60)).padStart(2, '0')}:{String(callSeconds % 60).padStart(2, '0')}</time>{live ? <Badge status={live.status} /> : <span className="badge idle"><i />未连接</span>}</div></div>
                <div className="conversation-note"><span className="note-dot" />{inProgress ? openingLocked ? '智能体先开场，首句播放期间客户输入已锁定。' : live?.mode === 'seed' ? muted ? '麦克风已静音，智能体仍可继续播放。' : '麦克风已开启，可以自然说话并打断后续回复。' : '开场已完成，可以输入客户回复。' : '每通会话独立保存，结束后可在通话记录中回看。'}</div>
                <TranscriptList transcripts={live?.transcripts ?? []} />
                {live?.mode === 'seed' && connected ? <div className="voice-controls"><div className={`mic-indicator ${openingLocked || muted ? 'muted' : 'listening'}`}><span />{openingLocked ? '开场期间输入锁定' : muted ? '麦克风已静音' : '正在聆听您的声音'}</div><button className="button secondary small" onClick={toggleMute}>{muted ? '开启麦克风' : '静音麦克风'}</button></div> : <div className="composer-area"><div className="quick-replies">{['您具体是做什么的？', '怎么收费？', '可以，发个案例看看。'].map(value => <button key={value} disabled={!connected || openingLocked || live?.mode !== 'simulation'} onClick={() => sendText(value)}>{value}</button>)}</div><form className="text-composer" onSubmit={event => { event.preventDefault(); sendText(); }}><input aria-label="输入客户回复" placeholder={connected && !openingLocked ? '以客户身份回复，按 Enter 发送…' : '开始文字模拟后，输入客户回复…'} value={text} onChange={event => setText(event.target.value)} disabled={!connected || openingLocked || live?.mode !== 'simulation'} /><button className="button primary" type="submit" disabled={!connected || openingLocked || !text.trim() || live?.mode !== 'simulation'}>发送 ↑</button></form></div>}
              </section></div>

            <div className="section-heading"><h2>最近会话</h2><button className="text-button" onClick={() => setPage('sessions')}>全部记录 →</button></div><section className="panel">{data.sessions.length ? <div className="table-wrap"><table><thead><tr><th>客户 / 公司</th><th>测试方式</th><th>开始时间</th><th>状态</th><th>记录</th></tr></thead><tbody>{data.sessions.slice(0, 4).map(session => <tr key={session.id}><td><strong>{session.customer.name}</strong><small>{session.customer.camp}</small></td><td>{session.mode === 'seed' ? 'SeedDuplex 语音' : '规则文字模拟'}</td><td className="mono">{dateText(session.createdAt)}</td><td><Badge status={session.status} /></td><td><button className="text-button" onClick={() => void openSession(session)}>查看 →</button></td></tr>)}</tbody></table></div> : <div className="empty-row">暂无会话记录。完成第一通测试后，会自动保存在这里。</div>}</section>
          </>}

          {page === 'prompt' && config && <PromptControl session={live} searchConfigured={Boolean(data.provider.webSearchConfigured)} config={config} savedConfig={data.config} customers={data.customers} customerId={customerId} saving={saving} onChange={setConfig} onCustomerChange={setCustomerId} onSave={saveConfig} onPreview={() => showPrompt(true)} onError={setError} />}

          {page === 'customers' && <><div className="customer-import-grid"><form className="panel" onSubmit={event => { event.preventDefault(); void importCustomers([{ ...customerForm, id: crypto.randomUUID() }]); }}><div className="panel-heading"><h2>添加客户</h2><button type="button" className="text-button" onClick={() => setCustomerForm(demoCustomer)}>填入示例</button></div><div className="panel-body"><div className="two-fields"><label className="field">公司名称 <em>*</em><input required value={customerForm.camp} onChange={event => setCustomerForm({ ...customerForm, camp: event.target.value })} placeholder="客户公司全称" /></label><label className="field">客户姓名 <em>*</em><input required value={customerForm.name} onChange={event => setCustomerForm({ ...customerForm, name: event.target.value })} placeholder="例如：王先生" /></label><label className="field">客户电话 <em>*</em><input required type="tel" value={customerForm.phone} onChange={event => setCustomerForm({ ...customerForm, phone: event.target.value })} placeholder="手机或固定电话" /></label><label className="field">客户地址 <em>*</em><input required value={customerForm.address} onChange={event => setCustomerForm({ ...customerForm, address: event.target.value })} placeholder="省 / 市 / 区域" /></label></div><label className="field">所属行业 <span className="optional">选填</span><input value={customerForm.industry} onChange={event => setCustomerForm({ ...customerForm, industry: event.target.value })} placeholder="用于更准确地讲解行业案例" /></label><button className="button primary" disabled={saving} type="submit">{saving ? '保存中…' : '添加到客户列表'}</button></div></form><section className="panel"><div className="panel-heading"><h2>批量导入 JSON</h2><label className="text-button file-picker">选择文件<input type="file" accept=".json,application/json" onChange={event => { const file = event.target.files?.[0]; if (file) void file.text().then(setImportText).catch(reason => setError(messageOf(reason))); event.target.value = ''; }} /></label></div><div className="panel-body"><label className="field"><span>客户列表</span><textarea className="mono import-text" rows={8} placeholder={'[\n  {\n    "camp": "客户公司",\n    "name": "王先生",\n    "phone": "13800000000",\n    "address": "河北省石家庄市"\n  }\n]'} value={importText} onChange={event => setImportText(event.target.value)} /></label><div className="form-actions"><button className="button secondary" disabled={saving || !importText.trim()} onClick={parseImport}>{saving ? '导入中…' : '校验并导入'}</button><small>支持数组或 {`{ customers: […] }`} 格式</small></div></div></section></div><div className="section-heading"><h2>客户列表 <span className="count">{data.customers.length}</span></h2><input className="search-input" aria-label="搜索客户" value={search} onChange={event => setSearch(event.target.value)} placeholder="搜索姓名、公司或电话" /></div><section className="panel">{filteredCustomers.length ? <div className="table-wrap"><table><thead><tr><th>公司名称</th><th>客户姓名</th><th>客户电话</th><th>地址 / 行业</th><th /></tr></thead><tbody>{filteredCustomers.map(customer => <tr key={customer.id}><td><strong>{customer.camp}</strong></td><td>{customer.name}</td><td className="mono">{customer.phone}</td><td>{customer.address}<small>{customer.industry || '行业未指定'}</small></td><td><button className="text-button" disabled={inProgress} onClick={() => { setCustomerId(customer.id); setPage('voice'); }}>带入测试 →</button></td></tr>)}</tbody></table></div> : <Empty title={search ? '没有匹配的客户' : '添加第一位客户'} detail={search ? '尝试搜索其他姓名、公司或电话。' : '手动添加一位客户，或导入 CRM 导出的 JSON 列表。'} />}</section></>}

          {page === 'sessions' && <>{viewed ? <><div className="record-toolbar"><button className="text-button" onClick={() => setViewed(null)}>← 返回全部记录</button><div><button className="button secondary small" onClick={() => setPreview({ prompt: viewed.prompt, opening: '' })}>提示词快照</button><button className="button secondary small" onClick={() => void exportSession(viewed)}>导出 JSON</button></div></div><section className="panel record-detail"><div className="panel-heading"><div className="heading-with-subtitle"><h2>{viewed.customer.name} · {viewed.customer.camp}</h2><span>{dateText(viewed.createdAt)} · {viewed.mode === 'seed' ? 'SeedDuplex 语音' : '规则文字模拟'} · {viewed.customer.phone}</span></div><Badge status={viewed.status} /></div>{viewed.error && <div className="record-error">{viewed.error}</div>}<TranscriptList transcripts={viewed.transcripts} compact /><div className="analysis-placeholder"><span>意向分析</span><p>第三板块尚未接入，当前会话未生成客户意向评分。可通过预留的分析接口消费文字记录。</p><span className="subtle-tag">待接入</span></div></section></> : <section className="panel"><div className="panel-heading"><h2>全部会话 <span className="count">{data.sessions.length}</span></h2><span className="subtle-tag">本机保存</span></div>{data.sessions.length ? <div className="table-wrap"><table><thead><tr><th>客户 / 公司</th><th>测试方式</th><th>开始时间</th><th>句数</th><th>状态</th><th>操作</th></tr></thead><tbody>{data.sessions.map(session => <tr key={session.id}><td><strong>{session.customer.name}</strong><small>{session.customer.camp}</small></td><td>{session.mode === 'seed' ? 'SeedDuplex 语音' : '规则文字模拟'}</td><td className="mono">{dateText(session.createdAt)}</td><td>{session.transcripts.length}</td><td><Badge status={session.status} /></td><td><button className="text-button" onClick={() => void openSession(session)}>查看记录 →</button></td></tr>)}</tbody></table></div> : <Empty title="还没有通话记录" detail="前往语音工作台完成一次测试，文字记录与提示词快照会自动保存。" />}</section>}</>}

          {page === 'integrations' && <><div className="integration-flow"><div><span className="integration-step">01</span><h2>拨号系统</h2><span className="badge reserved">预留接入</span><p>CRM 客户导入、任务编排、FreeSWITCH 集群与云 SIP 路线。</p></div><span className="integration-arrow">→</span><div className="current"><span className="integration-step">02</span><h2>语音智能体</h2><span className="badge status-active"><i />当前实现</span><p>SeedDuplex 实时会话、逐通客户变量、首句输入门控及文字记录。</p></div><span className="integration-arrow">→</span><div><span className="integration-step">03</span><h2>意向分析</h2><span className="badge reserved">预留接入</span><p>大语言模型分析对话、生成意向标签，交由人工继续跟进。</p></div></div><section className="panel"><div className="panel-heading"><h2>SeedDuplex 接入状态</h2><span className={`badge ${data.provider.configured ? 'status-active' : 'reserved'}`}>{data.provider.configured ? '已配置' : '待配置'}</span></div><div className="panel-body"><dl className="integration-spec"><div><dt>模型版本</dt><dd className="mono">{data.provider.model}</dd></div><div><dt>通信协议</dt><dd className="mono">{data.provider.protocol}</dd></div><div><dt>浏览器输入</dt><dd>PCM S16LE · 16 kHz · 单声道 · 20 ms / 帧</dd></div><div><dt>语音输出</dt><dd>PCM S16LE · 24 kHz · 隔离播放队列</dd></div><div><dt>会话边界</dt><dd>一位客户对应独立会话与提示词快照</dd></div></dl><a className="text-button" href="https://docs.volcengine.com/docs/doubao-voice/end-to-end-real-time-voice-full-duplex-version?lang=zh" target="_blank" rel="noreferrer">SeedDuplex 官方文档 ↗</a></div></section><section className="panel contracts-panel"><div className="panel-heading"><h2>预留接口契约</h2><button className="button secondary small" onClick={() => { void api('/integrations/contracts').then(setContracts).catch(reason => setError(messageOf(reason))); }}>读取接口契约</button></div>{contracts ? <pre className="contract-code">{JSON.stringify(contracts, null, 2)}</pre> : <div className="panel-body"><p className="body-muted">拨号侧可提供客户与通话标识，语音侧输出逐句 ASR / Chat 记录；分析侧接收已结束会话。点击读取查看后端定义的接口结构。</p></div>}</section></>}
        </>}
        <footer className="main-footer"><span>泓动引擎 · 本地 AI 电话销售系统</span><span>当前阶段：语音智能体验证</span></footer>
      </main>
    </div>
    {preview && <div className="modal-backdrop" onClick={event => { if (event.target === event.currentTarget) setPreview(null); }}><section className="prompt-modal" role="dialog" aria-modal="true" aria-labelledby="prompt-title"><div className="panel-heading"><div className="heading-with-subtitle"><h2 id="prompt-title">{preview.opening ? '本通提示词预览' : '会话提示词快照'}</h2><span>客户资料已注入，开场与对话规则随每通会话独立保存。</span></div><button className="close-button" aria-label="关闭提示词预览" autoFocus onClick={() => setPreview(null)}>×</button></div><div className="prompt-modal-body">{preview.opening && <div className="opening-preview"><strong>首句开场 · 不可打断</strong><p>{preview.opening}</p></div>}<pre>{preview.prompt}</pre></div><div className="modal-footer"><button className="button secondary" onClick={() => { void navigator.clipboard.writeText(preview.prompt).then(() => setNotice('提示词已复制。')).catch(reason => setError(messageOf(reason))); }}>复制提示词</button><button className="button primary" onClick={() => setPreview(null)}>完成</button></div></section></div>}
  </div>;
}
