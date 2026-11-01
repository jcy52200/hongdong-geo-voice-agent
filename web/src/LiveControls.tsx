import { useCallback, useEffect, useRef, useState } from 'react';
import { api, messageOf } from './api';
import type { AgentConfig, Session } from './types';
import { controlSchema, type ControlRequest, type ControlResult } from '../../shared/model-config';

interface Runtime {
  active: boolean; status: string; muted: boolean; replacementChars?: number;
  controls: { createdAt: string; action: string; result: string }[];
  pendingTools: { call_id: string; name: string; arguments: string }[];
}
export function LiveControls({ session, enabled, savedConfig, dirty }: { session: Session | null; enabled: boolean; savedConfig: AgentConfig; dirty: boolean }) {
  const [runtime, setRuntime] = useState<Runtime | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [result, setResult] = useState<ControlResult | null>(null);
  const [text, setText] = useState('');
  const [contextAction, setContextAction] = useState('conversation.item.retrieve');
  const [items, setItems] = useState('[]');
  const [callId, setCallId] = useState('');
  const [toolText, setToolText] = useState('');
  const id = session?.id;
  const activeId = useRef(id); activeId.current = id;
  const available = session?.mode === 'seed' && session.status === 'active' && runtime?.active;
  const load = useCallback(async () => {
    if (!id) return;
    try { const data = await api<Runtime>(`/sessions/${id}/runtime`); if (activeId.current === id) setRuntime(data); }
    catch (error) { if (activeId.current === id) setMessage(messageOf(error)); }
  }, [id]);
  useEffect(() => {
    setRuntime(null); setMessage(''); setResult(null); setBusy(false); setCallId('');
  }, [id]);
  useEffect(() => {
    if (!enabled || !id || session?.mode !== 'seed' || !['opening', 'active'].includes(session.status)) return;
    void load(); const timer = window.setInterval(() => void load(), 2500);
    return () => window.clearInterval(timer);
  }, [enabled, id, session?.mode, session?.status, load]);
  async function run(command: ControlRequest) {
    if (!available || busy || !id) return;
    setBusy(true); setMessage(''); setResult(null);
    try {
      const parsed = controlSchema.parse(command);
      const response = await api<ControlResult>(`/sessions/${id}/control`, parsed);
      if (activeId.current !== id) return;
      setResult(response); await load(); return response;
    } catch (error) { if (activeId.current === id) setMessage(messageOf(error)); }
    finally { if (activeId.current === id) setBusy(false); }
  }
  const disabled = !available || busy;
  return <div className="live-control-panel">
    <section className="panel"><div className="panel-heading"><h2>当前通话控制</h2><span className={`badge ${available ? 'status-active' : 'reserved'}`}>{available ? '已连接，可控制' : session?.status === 'opening' ? '首句播放锁定中' : '等待语音试打'}</span></div><div className="panel-body">
      <p className="prompt-help">先在“模拟电话”连接 SeedDuplex，再回到本页操作。控制作用于当前通话 {session ? `（${session.customer.name || session.customer.camp}）` : ''}，不会修改其他通话。</p>
      <div className="form-actions"><button type="button" className="button primary" disabled={disabled || dirty} onClick={() => void run({ action: 'apply_config' })}>将已保存参数应用到当前通话</button><button type="button" className="button secondary" disabled={disabled} onClick={() => void run({ action: 'cancel' })}>取消当前播报</button><button type="button" className="button secondary" disabled={disabled} onClick={() => void run({ action: 'commit_input' })}>强制判停</button><button type="button" className="button secondary" disabled={disabled} onClick={() => void run({ action: 'mute', muted: !runtime?.muted })}>{runtime?.muted ? '恢复客户输入' : '暂停客户输入'}</button></div>
      <p className="prompt-help">{dirty ? '请先保存限制词和参数，再应用到当前通话。' : '应用会发送 session.update 并等待 session.updated；初始历史不重复注入，开场修改从下一通生效。'} 服务端接收更新不代表每个创建参数均支持热切换，需要重建的设置请用新电话验证。要立即停下已排队的声音，请先取消当前播报，再发送新内容。</p>
      {busy && <p className="control-pending" role="status">控制请求处理中，正在等待服务端回包…</p>}
      {message && <div className="alert error" role="alert"><p>{message}</p></div>}
      {result && <div className="control-result" role="status"><strong>{result.status === 'confirmed' ? '服务端已确认' : '已发送，等待实际效果'}</strong><p>{result.message}</p>{result.event && <details><summary>查看服务端返回内容</summary><pre>{JSON.stringify(result.event, null, 2)}</pre></details>}</div>}
    </div></section>
    <div className="parameter-grid live-control-grid">
      <section className="panel"><div className="panel-heading"><h2>主动播报与回复干预</h2></div><div className="panel-body"><label className="field">指定播报文本<textarea rows={5} value={text} maxLength={8000} onChange={event => setText(event.target.value)} placeholder="输入希望智能体说出的内容；分片模式可逐段发送。" /></label><div className="form-actions"><button type="button" className="button secondary" disabled={disabled || !text.trim()} onClick={() => void run({ action: 'greet', text })}>指定文本打招呼</button><button type="button" className="button primary" disabled={disabled || !text.trim()} onClick={() => void run({ action: 'replace', text })}>指定 / 干预模型回复</button><button type="button" className="text-button" onClick={() => setText(savedConfig.opening ?? '')}>填入已保存开场</button></div><p className="prompt-help">分别发送 speech_text_buffer.commit 与 speech_text_buffer.replacement.commit；此类请求无独立确认，需实际试听。手动指定内容会记录在本通事件和 AI 文本中，不代表音频已完整播放。</p>
        <details className="stream-controls"><summary>流式干预 · append / commit</summary><p className="prompt-help">先上传一个或多个片段，再提交结束包。已缓冲 {runtime?.replacementChars ?? 0} 字符；当前输入可作为结束包附带文本，空输入则仅结束流。</p><div className="form-actions"><button type="button" className="button secondary" disabled={disabled || !text} onClick={() => void run({ action: 'replacement_append', text }).then(response => { if (response) setText(''); })}>上传片段 append</button><button type="button" className="button secondary" disabled={disabled} onClick={() => void run({ action: 'replacement_commit', text }).then(response => { if (response) setText(''); })}>提交结束包 commit</button></div><p className="prompt-help">片段发送成功后自动清空输入，避免重复提交。累计最多8000字符。</p></details>
      </div></section>
      <section className="panel"><div className="panel-heading"><h2>上下文管理</h2></div><div className="panel-body"><label className="field">操作<select value={contextAction} onChange={event => {
        const action = event.target.value; setContextAction(action);
        setItems(action === 'conversation.item.create' ? '[\n  {"id":"test_user_1","type":"message","role":"user","content":[{"type":"input_text","text":"你好"}]},\n  {"id":"test_assistant_1","type":"message","role":"assistant","content":[{"type":"input_text","text":"您好"}]}\n]' : action === 'conversation.item.update' ? '[{"id":"需修改的item_id","content":[{"type":"input_text","text":"新的内容"}]}]' : action === 'conversation.item.delete' ? '[{"id":"需删除的item_id"}]' : '[]');
      }}><option value="conversation.item.retrieve">查询上下文 retrieve</option><option value="conversation.item.create">新增成对 QA create</option><option value="conversation.item.update">更新指定文本 update</option><option value="conversation.item.delete">删除指定对话轮 delete</option></select></label><label className="field">items · JSON 数组<textarea className="mono" rows={6} value={items} onChange={event => setItems(event.target.value)} /></label><button type="button" className="button secondary" disabled={disabled} onClick={() => {
        try { void run(controlSchema.parse({ action: 'context', event: { type: contextAction, items: JSON.parse(items) } })); }
        catch (error) { setMessage(messageOf(error)); }
      }}>发送上下文操作</button><p className="prompt-help">查询 [] 返回最近上下文；新增必须完整 QA 成对。删除一侧会连同对应一轮删除。此操作修改模型上下文，本地历史记录会保留操作轨迹。</p></div></section>
    </div>
    <section className="panel"><div className="panel-heading"><h2>函数调用与手动结果回传</h2><span className="subtle-tag">{runtime?.pendingTools.length ?? 0} 个待回传</span></div><div className="panel-body parameter-grid"><div><p className="prompt-help">在会话参数中定义 tools 后，模型请求会显示于此；系统不会执行任意函数代码。</p>{runtime?.pendingTools.length ? <pre className="runtime-json">{JSON.stringify(runtime.pendingTools, null, 2)}</pre> : <p className="prompt-help">当前没有待处理的函数调用。</p>}</div><div><label className="field">选择 call_id<select value={callId} onChange={event => setCallId(event.target.value)}><option value="">请选择模型发起的调用</option>{runtime?.pendingTools.map(item => <option key={item.call_id} value={item.call_id}>{item.name} · {item.call_id}</option>)}</select></label><label className="field">工具结果文本<textarea rows={3} value={toolText} maxLength={16000} onChange={event => setToolText(event.target.value)} /></label><button type="button" className="button secondary" disabled={disabled || !callId || !toolText.trim()} onClick={() => void run({ action: 'tool_result', callId, text: toolText })}>回传工具结果</button></div></div></section>
    <section className="panel"><div className="panel-heading"><h2>最近控制操作</h2></div><div className="panel-body">{runtime?.controls.length ? <ol className="control-history">{runtime.controls.map((item, index) => <li key={`${item.createdAt}-${index}`}><time>{new Date(item.createdAt).toLocaleTimeString('zh-CN')}</time><code>{item.action}</code><span>{item.result}</span></li>)}</ol> : <p className="prompt-help">尚无控制操作。每次请求与结果会记录到本通导出事件中。</p>}</div></section>
  </div>;
}
