import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { api, messageOf } from './api';
import { LocalAudio } from './audio';
const PromptControl = lazy(() => import('./PromptControl').then(module => ({ default: module.PromptControl })));
const CallRecords = lazy(() => import('./CallRecords').then(module => ({ default: module.CallRecords })));
const Dashboard = lazy(() => import('./Dashboard').then(module => ({ default: module.Dashboard })));
const pageFallback = <div className="panel route-loading" role="status">正在准备工作空间…</div>;
import { motion } from 'motion/react';
import { SquaresFour, PhoneCall, SlidersHorizontal, UsersThree, ListChecks, PlugsConnected, ArrowClockwise, ArrowUpRight, Waveform, X, Microphone, MicrophoneSlash, PhoneDisconnect, Play, type Icon } from '@phosphor-icons/react';
import type { Grade } from '../../shared/analysis';
import type { AgentConfig, Bootstrap, Customer, ServerEvent, Session, SessionStatus, Transcript } from './types';

type Page = 'dashboard' | 'voice' | 'prompt' | 'customers' | 'sessions' | 'integrations';
const pages: { id: Page; icon: Icon; label: string; description: string }[] = [
  { id: 'dashboard', icon: SquaresFour, label: '工作台', description: '把精力，留给值得继续的对话。' },
  { id: 'voice', icon: PhoneCall, label: '模拟电话', description: '戴上耳机，听听下一通对话的可能。' },
  { id: 'prompt', icon: SlidersHorizontal, label: '智能体配置', description: '从声音到表达，打磨您的销售智能体。' },
  { id: 'customers', icon: UsersThree, label: '客户资料', description: '为每一次对话，准备更准确的客户上下文。' },
  { id: 'sessions', icon: ListChecks, label: '通话记录', description: '回听对话，读懂意向，让跟进有据可依。' },
  { id: 'integrations', icon: PlugsConnected, label: '系统接入', description: '连接客户、语音和意向分析的每一个环节。' },
];
const statusText: Record<SessionStatus, string> = { created: '等待连接', connecting: '连接中', opening: '开场播放中', active: '对话进行中', completed: '已结束', failed: '连接失败' };
const emptyCustomer = { camp: '', name: '', phone: '', address: '', industry: '' };
const demoCustomer = { camp: '石家庄示例机械设备有限公司', name: '王先生', phone: '13800000000', address: '河北省石家庄市', industry: '机械设备' };
const activeStatus = (status?: SessionStatus) => Boolean(status && !['completed', 'failed'].includes(status));
const dateText = (date: string) => new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(date));
type PendingRecording = { sessionId: string; blob: Blob; mimeType: string; error: string };
async function uploadCallRecording(sessionId: string, result: { blob: Blob; mimeType: string }): Promise<Session | undefined> {
  let snapshot = await api<Session>(`/sessions/${sessionId}`);
  for (let attempt = 0; activeStatus(snapshot.status) && attempt < 12; attempt++) {
    await new Promise(resolve => window.setTimeout(resolve, 150));
    snapshot = await api<Session>(`/sessions/${sessionId}`);
  }
  if (!snapshot.answeredAt) return undefined;
  if (activeStatus(snapshot.status)) throw new Error('通话结束状态尚未保存，请重试保存录音。');
  const response = await fetch(`/api/sessions/${sessionId}/recording`, { method: 'POST', headers: { 'Content-Type': result.mimeType }, body: result.blob });
  if (!response.ok) { const data = await response.json().catch(() => ({})); throw new Error(data.error || '录音保存失败'); }
  return api<Session>(`/sessions/${sessionId}`);
}
const pageFromHash = (): Page => pages.find(item => `#${item.id}` === location.hash)?.id ?? 'dashboard';

function Badge({ status }: { status: SessionStatus }) { return <span className={`badge status-${status}`}><i />{statusText[status]}</span>; }
function Empty({ title, detail }: { title: string; detail: string }) { return <div className="empty"><div className="empty-mark"><Waveform size={29} /></div><strong>{title}</strong><p>{detail}</p></div>; }
function TranscriptList({ transcripts, compact = false }: { transcripts: Transcript[]; compact?: boolean }) {
  const logRef = useRef<HTMLDivElement>(null);
  useEffect(() => { const log = logRef.current; if (log) log.scrollTo({ top: log.scrollHeight, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }); }, [transcripts]);
  return <div ref={logRef} className={`transcripts ${compact ? 'compact' : ''}`} role="log" aria-label="逐句对话记录" aria-live="polite">
    {!transcripts.length ? <Empty title="对话将从这里开始" detail="连接测试后，客户 ASR 与智能体回复会逐句显示。" /> : transcripts.map(item => <div key={item.id} className={`utterance ${item.kind === 'ChatText' ? 'agent' : 'customer'}`}>
      <div className="utterance-avatar">{item.kind === 'ChatText' ? '泓' : '客'}</div><div className="utterance-content"><div className="utterance-meta"><strong>{item.kind === 'ChatText' ? '销售智能体' : '客户'}</strong><span>{item.kind}</span><time>{dateText(item.createdAt)}</time>{!item.final && <span className="draft-tag">识别中</span>}</div><p>{item.text}</p></div>
    </div>)}<div />
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
  const [recordsGrade, setRecordsGrade] = useState<Grade | undefined>();
  const [recordsRange, setRecordsRange] = useState<{ from: string; to: string; source?: import('../../shared/dashboard').CallSource } | undefined>();
  const [dashboardRevision, setDashboardRevision] = useState(0);
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
  const recordingOwnerRef = useRef<string | null>(null);
  const [recordingsSaving, setRecordingsSaving] = useState(0);
  const [failedRecordings, setFailedRecordings] = useState<PendingRecording[]>([]);
  const liveRef = useRef<Session | null>(null);
  const openingRef = useRef(true);
  const mutedRef = useRef(false);
  const generation = useRef(0);
  const refreshGeneration = useRef(0);
  const connectionTimer = useRef<number | undefined>(undefined);

  useEffect(() => { history.replaceState(null, '', `#${page}`); window.scrollTo({ top: 0, left: 0 }); document.querySelector('.workspace-navigation [aria-current="page"]')?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }); }, [page]);
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
      setDashboardRevision(value => value + 1);
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

  useEffect(() => {
    if (page !== 'customers' || !data?.customers.some(customer => ['pending', 'running'].includes(customer.industryStatus ?? ''))) return;
    const timer = window.setInterval(() => { void refresh(true); }, 3000);
    return () => window.clearInterval(timer);
  }, [page, refresh, data?.customers]);

  const release = useCallback(() => {
    if (connectionTimer.current) window.clearTimeout(connectionTimer.current);
    const ws = wsRef.current;
    wsRef.current = null;
    if (ws) { ws.onopen = null; ws.onmessage = null; ws.onclose = null; ws.onerror = null; ws.close(); }
    const audio = audioRef.current;
    const sessionId = recordingOwnerRef.current;
    audioRef.current = null;
    recordingOwnerRef.current = null;
    if (audio) {
      const recording = audio.stopRecording();
      audio.close();
      if (sessionId) {
        setRecordingsSaving(count => count + 1);
        void recording.then(async result => {
          if (!result) {
            if (audio.recordingError && liveRef.current?.id === sessionId) setNotice(audio.recordingError);
            return;
          }
          try {
            const saved = await uploadCallRecording(sessionId, result);
            if (saved) saveSessionHistory(saved);
          } catch (reason) {
            const error = messageOf(reason);
            setFailedRecordings(items => [...items.filter(item => item.sessionId !== sessionId), { sessionId, ...result, error }]);
          }
        }).catch(reason => setError(`录音未保存：${messageOf(reason)}`))
          .finally(() => setRecordingsSaving(count => count - 1));
      }
    }
  }, [saveSessionHistory]);

  useEffect(() => {
    void refresh();
    const onLeave = () => { generation.current++; setBusy(false); const ws = wsRef.current; if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'finish' })); release(); };
    window.addEventListener('pagehide', onLeave);
    return () => { window.removeEventListener('pagehide', onLeave); onLeave(); };
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

  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => {
      if (recordingsSaving || failedRecordings.length || (audioRef.current && activeStatus(liveRef.current?.status))) { event.preventDefault(); event.returnValue = ''; }
    };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, [recordingsSaving, failedRecordings.length]);

  async function retryRecording(item: PendingRecording) {
    setFailedRecordings(items => items.filter(row => row.sessionId !== item.sessionId));
    setRecordingsSaving(count => count + 1);
    try { const saved = await uploadCallRecording(item.sessionId, item); if (saved) saveSessionHistory(saved); }
    catch (reason) { setFailedRecordings(items => [...items.filter(row => row.sessionId !== item.sessionId), { ...item, error: messageOf(reason) }]); }
    finally { setRecordingsSaving(count => count - 1); }
  }
  function downloadPendingRecording(item: PendingRecording) {
    const url = URL.createObjectURL(item.blob); const anchor = document.createElement('a');
    const extension = item.mimeType.includes('mp4') ? 'm4a' : item.mimeType.includes('ogg') ? 'ogg' : 'webm';
    anchor.href = url; anchor.download = `call-${item.sessionId}.${extension}`; anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

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
      recordingOwnerRef.current = audio ? created.id : null;
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
              ws.send(JSON.stringify({ type: 'playback_done', playbackId: message.playbackId }));
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
      setNotice(`已导入 ${result.imported} 条客户资料，缺失行业将由 DeepSeek 自动补全。`); setImportText(''); setCustomerForm(emptyCustomer);
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


  return <div className={`app-shell page-${page}`}>
    <a className="skip-link" href="#workspace-content" onClick={event => { event.preventDefault(); document.getElementById('workspace-content')?.focus(); }}>跳到主要内容</a>
    <header className="workspace-header">
      <a className="workspace-brand" href="#dashboard" onClick={event => { event.preventDefault(); setPage('dashboard'); }} aria-label="泓动引擎工作台"><span className="workspace-logo"><Waveform size={25} weight="bold" /></span><span><strong>泓动引擎<span className="brand-period">.</span></strong><small>GEO SALES WORKSPACE</small></span></a>
      <nav className="workspace-navigation" aria-label="主导航">{pages.map(item => <button key={item.id} aria-current={page === item.id ? 'page' : undefined} className={page === item.id ? 'selected' : ''} onClick={() => { setPage(item.id); setSearch(''); if (item.id === 'sessions') { setViewed(null); setRecordsGrade(undefined); setRecordsRange(undefined); } }}>{page === item.id && <motion.span className="navigation-slider" layoutId="main-navigation" transition={{ type: 'spring', stiffness: 420, damping: 36 }} />}<item.icon size={18} weight={page === item.id ? 'fill' : 'regular'} /><span>{item.label}</span></button>)}</nav>
      <div className="workspace-identity"><span className="local-workspace"><span className="semantic-dot" />本地空间</span><span className="workspace-owner" title="泓动引擎">泓</span></div>
    </header>
    <div className="main-shell"><main className="main-content" id="workspace-content" tabIndex={-1}>
        <div className="page-heading"><div><div className="page-eyebrow">泓动引擎<span>/</span>{page === 'dashboard' ? '运营概览' : '销售工作空间'}</div><h1>{pages.find(item => item.id === page)?.label}</h1><p>{pages.find(item => item.id === page)?.description}</p></div><div className="page-actions"><button className="button secondary refresh-button" aria-label="刷新数据" onClick={() => void refresh(true)} disabled={loading}><ArrowClockwise size={17} className={loading ? 'is-spinning' : ''} /><span>刷新数据</span></button>{page === 'dashboard' && <button className="button primary" onClick={() => setPage('voice')}><PhoneCall size={18} />发起模拟电话<ArrowUpRight size={17} /></button>}</div></div>
        {error && <div className="alert error" role="alert"><span>!</span><p>{error}</p><button aria-label="关闭错误提示" onClick={() => setError('')}><X size={17} /></button></div>}
        {failedRecordings.map(item => <div className="alert error" role="alert" key={item.sessionId}><p>录音保存失败（{item.sessionId.slice(0, 8)}）：{item.error}。音频仍保留在本页，请重试保存或先下载备份。</p><button className="text-button" onClick={() => void retryRecording(item)}>重试保存</button><button className="text-button" onClick={() => downloadPendingRecording(item)}>下载备份</button></div>)}
        {recordingsSaving > 0 && <div className="alert" role="status"><p>正在保存 {recordingsSaving} 通录音，请保持页面打开。</p></div>}
        {notice && <div className="alert success" role="status"><span>✓</span><p>{notice}</p><button aria-label="关闭提示" onClick={() => setNotice('')}><X size={17} /></button></div>}
        {loading && !data ? <div className="loading-layout" aria-label="正在加载工作台"><div /><div /><div /></div> : !data ? <div className="panel"><Empty title="暂时无法连接本地服务" detail="请确认后端已启动，然后点击刷新数据。" /></div> : <>
          {page === 'dashboard' && <Suspense fallback={pageFallback}><Dashboard refreshKey={dashboardRevision} onNavigate={setPage} onOpenSession={id => { setViewed({ id } as Session); setRecordsGrade(undefined); setPage('sessions'); }} onGrade={(grade, range) => { setViewed(null); setRecordsGrade(grade); setRecordsRange(range); setPage('sessions'); }} /></Suspense>}

          {page === 'voice' && <>
            <div className="overview-strip"><div><span className="overview-icon"><UsersThree size={24} /></span><div><small>可测试客户</small><strong>{data.customers.length}<em>位</em></strong></div></div><div><span className="overview-icon"><ListChecks size={24} /></span><div><small>已保存会话</small><strong>{data.sessionTotal ?? data.sessions.length}<em>通</em></strong></div></div><div className="provider-overview"><span className={`provider-light ${data.provider.configured ? 'ready' : ''}`} /><div><small>SeedDuplex 语音服务</small><strong className="provider-value">{data.provider.configured ? '已配置密钥' : '待配置 API Key'}</strong></div><span className="subtle-tag">{data.provider.model}</span></div></div>
            {config && JSON.stringify(config) !== JSON.stringify(data.config) && <div className="alert prompt-draft-notice"><p>限制词或模型参数有未保存修改，试打将沿用已保存版本。</p><button className="text-button" onClick={() => setPage('prompt')}>去保存 →</button></div>}
            <div className="workbench-grid"><section className="panel test-settings"><div className="panel-heading"><h2>模拟电话设置</h2><span className="subtle-tag">单通隔离</span></div><div className="panel-body"><label className="field">客户资料<select value={customerId} onChange={event => setCustomerId(event.target.value)} disabled={inProgress}><option value="" disabled>请选择客户</option>{data.customers.map(customer => <option key={customer.id} value={customer.id}>{customer.name} · {customer.camp}</option>)}</select></label>
              {selectedCustomer ? <div className="customer-summary"><div className="customer-summary-head"><span className="company-avatar">{selectedCustomer.camp.slice(0, 1)}</span><div><strong>{selectedCustomer.camp}</strong><span>{selectedCustomer.industry || '行业未指定'}</span></div></div><dl><div><dt>客户</dt><dd>{selectedCustomer.name}</dd></div><div><dt>电话</dt><dd className="mono">{selectedCustomer.phone}</dd></div><div><dt>地区</dt><dd>{selectedCustomer.address}</dd></div></dl></div> : <div className="inline-empty">还没有客户资料。<button className="text-button" onClick={() => setPage('customers')}>添加客户 →</button></div>}
              <button className="text-button demo-call-button" disabled={inProgress || saving} onClick={() => void useDemoCustomer()}>使用虚构示例客户</button>
              <div className="field"><span>测试方式</span><div className="mode-options"><button className={mode === 'simulation' ? 'chosen' : ''} onClick={() => setMode('simulation')} disabled={inProgress}><strong>文字预演</strong><small>规则流程 · 无需密钥</small></button><button className={mode === 'seed' ? 'chosen' : ''} onClick={() => setMode('seed')} disabled={inProgress}><strong>浏览器语音测试</strong><small>SeedDuplex · 麦克风</small></button></div></div>
              <details className="test-note voice-help"><summary>{mode === 'simulation' ? '先验证流程与记录' : '使用浏览器麦克风测试'}</summary><p>{mode === 'simulation' ? '这是本地规则模拟，不代表 SeedDuplex 的音色、自然度或模型能力。' : '此入口直接测试当前限制词和 SeedDuplex，无需配置 SIP 或拨打真实电话。点击连接后授权麦克风，开场完整播放后即可对话。建议使用耳机。'}</p></details>
              {mode === 'seed' && !data.provider.configured && <p className="config-warning">请先在服务端 .env 配置火山引擎 API Key。</p>}
              {inProgress ? <button className="button danger full" onClick={() => void finishSession()}><PhoneDisconnect size={18} />{busy ? '取消连接' : '结束本次测试'}</button> : <button className="button primary full" onClick={() => void startSession()} disabled={!selectedCustomer || (mode === 'seed' && !data.provider.configured)}>{mode === 'seed' ? <><PhoneCall size={18} />开始语音测试<ArrowUpRight size={16} /></> : <><Play size={17} />开始文字预演</>}</button>}
              <button className="button plain full preview-button" onClick={() => void showPrompt()} disabled={!selectedCustomer || saving}>查看本通提示词 ↗</button><div className="privacy-note">仅测试语音，不会拨打客户电话</div>
            </div></section>
              <section className="panel conversation-panel"><div className="panel-heading"><div className="heading-with-subtitle"><h2>电话对话</h2><span>{live ? `${live.customer.name} · ${live.mode === 'seed' ? 'SeedDuplex 语音' : '规则文字模拟'}` : '等待发起测试'}</span></div><div className="call-status"><time className="call-timer mono">{String(Math.floor(callSeconds / 60)).padStart(2, '0')}:{String(callSeconds % 60).padStart(2, '0')}</time>{live ? <Badge status={live.status} /> : <span className="badge idle"><i />未连接</span>}</div></div>
                <div className="conversation-note"><span className="note-dot" />{inProgress ? openingLocked ? '智能体先开场，首句播放期间客户输入已锁定。' : live?.mode === 'seed' ? muted ? '麦克风已静音，智能体仍可继续播放。' : '麦克风已开启，可以自然说话并打断后续回复。' : '开场已完成，可以输入客户回复。' : '每通会话独立保存，结束后可在通话记录中回看。'}</div>
                <TranscriptList transcripts={live?.transcripts ?? []} />
                {live?.mode === 'seed' && connected ? <div className="voice-controls"><div className={`mic-indicator ${openingLocked || muted ? 'muted' : 'listening'}`}><span />{openingLocked ? '开场期间输入锁定' : muted ? '麦克风已静音' : '正在聆听您的声音'}</div><button className="button secondary small" onClick={toggleMute}>{muted ? <MicrophoneSlash size={17} /> : <Microphone size={17} />}{muted ? '开启麦克风' : '静音麦克风'}</button></div> : <div className="composer-area"><div className="quick-replies">{['您具体是做什么的？', '怎么收费？', '可以，发个案例看看。'].map(value => <button key={value} disabled={!connected || openingLocked || live?.mode !== 'simulation'} onClick={() => sendText(value)}>{value}</button>)}</div><form className="text-composer" onSubmit={event => { event.preventDefault(); sendText(); }}><input aria-label="输入客户回复" placeholder={connected && !openingLocked ? '以客户身份回复，按 Enter 发送…' : '开始文字模拟后，输入客户回复…'} value={text} onChange={event => setText(event.target.value)} disabled={!connected || openingLocked || live?.mode !== 'simulation'} /><button className="button primary" type="submit" disabled={!connected || openingLocked || !text.trim() || live?.mode !== 'simulation'}>发送 ↑</button></form></div>}
              </section></div>

            <div className="section-heading"><h2>最近会话</h2><button className="text-button" onClick={() => setPage('sessions')}>全部记录 →</button></div><section className="panel">{data.sessions.length ? <div className="table-wrap"><table><thead><tr><th>客户 / 公司</th><th>测试方式</th><th>开始时间</th><th>状态</th><th>记录</th></tr></thead><tbody>{data.sessions.slice(0, 4).map(session => <tr key={session.id}><td><strong>{session.customer.name}</strong><small>{session.customer.camp}</small></td><td>{session.mode === 'seed' ? 'SeedDuplex 语音' : '规则文字模拟'}</td><td className="mono">{dateText(session.createdAt)}</td><td><Badge status={session.status} /></td><td><button className="text-button" onClick={() => void openSession(session)}>查看 →</button></td></tr>)}</tbody></table></div> : <div className="empty-row">暂无会话记录。完成第一通测试后，会自动保存在这里。</div>}</section>
          </>}

          {page === 'prompt' && config && <Suspense fallback={pageFallback}><PromptControl session={live} searchConfigured={Boolean(data.provider.webSearchConfigured)} config={config} savedConfig={data.config} customers={data.customers} customerId={customerId} saving={saving} onChange={setConfig} onCustomerChange={setCustomerId} onSave={saveConfig} onPreview={() => showPrompt(true)} onError={setError} /></Suspense>}

          {page === 'customers' && <><div className="customer-import-grid"><form className="panel" onSubmit={event => { event.preventDefault(); void importCustomers([{ ...customerForm, id: crypto.randomUUID() }]); }}><div className="panel-heading"><h2>添加客户</h2><button type="button" className="text-button" onClick={() => setCustomerForm(demoCustomer)}>填入示例</button></div><div className="panel-body"><div className="two-fields"><label className="field">公司名称 <em>*</em><input required value={customerForm.camp} onChange={event => setCustomerForm({ ...customerForm, camp: event.target.value })} placeholder="客户公司全称" /></label><label className="field">客户姓名 <em>*</em><input required value={customerForm.name} onChange={event => setCustomerForm({ ...customerForm, name: event.target.value })} placeholder="例如：王先生" /></label><label className="field">客户电话 <em>*</em><input required type="tel" value={customerForm.phone} onChange={event => setCustomerForm({ ...customerForm, phone: event.target.value })} placeholder="手机或固定电话" /></label><label className="field">客户地址 <em>*</em><input required value={customerForm.address} onChange={event => setCustomerForm({ ...customerForm, address: event.target.value })} placeholder="省 / 市 / 区域" /></label></div><label className="field">所属行业 <span className="optional">选填</span><input value={customerForm.industry} onChange={event => setCustomerForm({ ...customerForm, industry: event.target.value })} placeholder="用于更准确地讲解行业案例" /></label><button className="button primary" disabled={saving} type="submit">{saving ? '保存中…' : '添加到客户列表'}</button></div></form><section className="panel"><div className="panel-heading"><h2>批量导入 JSON</h2><label className="text-button file-picker">选择文件<input type="file" accept=".json,application/json" onChange={event => { const file = event.target.files?.[0]; if (file) void file.text().then(setImportText).catch(reason => setError(messageOf(reason))); event.target.value = ''; }} /></label></div><div className="panel-body"><label className="field"><span>客户列表</span><textarea className="mono import-text" rows={8} placeholder={'[\n  {\n    "camp": "客户公司",\n    "name": "王先生",\n    "phone": "13800000000",\n    "address": "河北省石家庄市"\n  }\n]'} value={importText} onChange={event => setImportText(event.target.value)} /></label><div className="form-actions"><button className="button secondary" disabled={saving || !importText.trim()} onClick={parseImport}>{saving ? '导入中…' : '校验并导入'}</button><small>支持数组或 {`{ customers: […] }`} 格式</small></div></div></section></div><div className="section-heading"><h2>客户列表 <span className="count">{data.customers.length}</span></h2><input className="search-input" aria-label="搜索客户" value={search} onChange={event => setSearch(event.target.value)} placeholder="搜索姓名、公司或电话" /></div><section className="panel customer-directory business-surface">{filteredCustomers.length ? <div className="table-wrap"><table><thead><tr><th>公司名称</th><th>客户姓名</th><th>客户电话</th><th>地址 / 行业</th><th /></tr></thead><tbody>{filteredCustomers.map(customer => <tr key={customer.id}><td><strong>{customer.camp}</strong></td><td>{customer.name}</td><td className="mono">{customer.phone}</td><td>{customer.address}<small>{customer.industry || (customer.industryStatus === 'failed' ? '补全失败，可重试' : customer.industryStatus === 'running' ? '正在分析行业…' : '待补全行业')}{customer.industryError && <span title={customer.industryError}> · !</span>}</small></td><td><button className="text-button" disabled={inProgress} onClick={() => { setCustomerId(customer.id); setPage('voice'); }}>带入测试 →</button></td></tr>)}</tbody></table></div> : <Empty title={search ? '没有匹配的客户' : '添加第一位客户'} detail={search ? '尝试搜索其他姓名、公司或电话。' : '手动添加一位客户，或导入 CRM 导出的 JSON 列表。'} />}</section></>}

          {page === 'sessions' && <Suspense fallback={pageFallback}><CallRecords initialRange={recordsRange} initialGrade={recordsGrade} initialSessionId={viewed?.id} onCloseDetail={() => setViewed(null)} /></Suspense>}

          {page === 'integrations' && <><div className="integration-flow"><div><span className="integration-step">01</span><h2>拨号系统</h2><span className="badge reserved">预留接入</span><p>CRM 客户导入、任务编排、FreeSWITCH 集群与云 SIP 路线。</p></div><span className="integration-arrow">→</span><div className="current"><span className="integration-step">02</span><h2>语音智能体</h2><span className="badge status-active"><i />当前实现</span><p>SeedDuplex 实时会话、逐通客户变量、首句输入门控及文字记录。</p></div><span className="integration-arrow">→</span><div><span className="integration-step">03</span><h2>意向分析</h2><span className="badge status-active">已实现</span><p>DeepSeek 4.1 Flash 自动补全行业、评估 A–G 意向等级，提取微信联系方式。</p></div></div><section className="panel"><div className="panel-heading"><h2>SeedDuplex 接入状态</h2><span className={`badge ${data.provider.configured ? 'status-active' : 'reserved'}`}>{data.provider.configured ? '已配置' : '待配置'}</span></div><div className="panel-body"><dl className="integration-spec"><div><dt>模型版本</dt><dd className="mono">{data.provider.model}</dd></div><div><dt>通信协议</dt><dd className="mono">{data.provider.protocol}</dd></div><div><dt>浏览器输入</dt><dd>PCM S16LE · 16 kHz · 单声道 · 20 ms / 帧</dd></div><div><dt>语音输出</dt><dd>PCM S16LE · 24 kHz · 隔离播放队列</dd></div><div><dt>会话边界</dt><dd>一位客户对应独立会话与提示词快照</dd></div></dl><a className="text-button" href="https://docs.volcengine.com/docs/doubao-voice/end-to-end-real-time-voice-full-duplex-version?lang=zh" target="_blank" rel="noreferrer">SeedDuplex 官方文档 ↗</a></div></section><section className="panel contracts-panel"><div className="panel-heading"><h2>预留接口契约</h2><button className="button secondary small" onClick={() => { void api('/integrations/contracts').then(setContracts).catch(reason => setError(messageOf(reason))); }}>读取接口契约</button></div>{contracts ? <pre className="contract-code">{JSON.stringify(contracts, null, 2)}</pre> : <div className="panel-body"><p className="body-muted">拨号侧可提供客户与通话标识，语音侧输出逐句 ASR / Chat 记录；分析侧接收已结束会话。点击读取查看后端定义的接口结构。</p></div>}</section></>}
        </>}
        <footer className="main-footer"><span>泓动引擎 · 本地 AI 电话销售系统</span><span><span className="semantic-dot" />客户、通话与录音保存在本机</span></footer>
      </main>
    </div>
    {preview && <div className="modal-backdrop" onClick={event => { if (event.target === event.currentTarget) setPreview(null); }}><section className="prompt-modal" role="dialog" aria-modal="true" aria-labelledby="prompt-title"><div className="panel-heading"><div className="heading-with-subtitle"><h2 id="prompt-title">{preview.opening ? '本通提示词预览' : '会话提示词快照'}</h2><span>客户资料已注入，开场与对话规则随每通会话独立保存。</span></div><button className="close-button" aria-label="关闭提示词预览" autoFocus onClick={() => setPreview(null)}><X size={17} /></button></div><div className="prompt-modal-body">{preview.opening && <div className="opening-preview"><strong>首句开场 · 不可打断</strong><p>{preview.opening}</p></div>}<pre>{preview.prompt}</pre></div><div className="modal-footer"><button className="button secondary" onClick={() => { void navigator.clipboard.writeText(preview.prompt).then(() => setNotice('提示词已复制。')).catch(reason => setError(messageOf(reason))); }}>复制提示词</button><button className="button primary" onClick={() => setPreview(null)}>完成</button></div></section></div>}
  </div>;
}
