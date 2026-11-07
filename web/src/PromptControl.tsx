import { useCallback, useState } from 'react';
import { api, messageOf } from './api';
import type { AgentConfig, Customer, Session } from './types';
import { ModelSettings } from './ModelSettings';
import { LiveControls } from './LiveControls';
import { DOCUMENT_URL, modelOptionsSchema } from '../../shared/model-config';

interface Props {
  config: AgentConfig;
  session: Session | null;
  searchConfigured: boolean;
  savedConfig: AgentConfig;
  customers: Customer[];
  customerId: string;
  saving: boolean;
  onChange: (config: AgentConfig) => void;
  onCustomerChange: (id: string) => void;
  onSave: (test: boolean) => Promise<void>;
  onPreview: () => Promise<void>;
  onError: (message: string) => void;
}

export function PromptControl(props: Props) {
  const { config, savedConfig, customers, customerId, saving, onChange, onCustomerChange, onSave, onPreview, onError } = props;
  const [restoring, setRestoring] = useState(false);
  const [tab, setTab] = useState<'prompt' | 'parameters' | 'live' | 'request'>('parameters');
  const [invalidJson, setInvalidJson] = useState<Set<string>>(new Set());
  const [requestPreview, setRequestPreview] = useState<unknown>(null);
  const onInvalid = useCallback((id: string, invalid: boolean) => setInvalidJson(previous => {
    if (previous.has(id) === invalid) return previous;
    const next = new Set(previous); if (invalid) next.add(id); else next.delete(id); return next;
  }), []);
  const validation = modelOptionsSchema.safeParse(config.modelOptions ?? {});
  const invalidQuickReply = !config.quickReplyText?.trim();
  const invalid = invalidJson.size > 0 || !validation.success || invalidQuickReply;
  const previewRequest = async () => {
    const customer = customers.find(item => item.id === customerId);
    if (!customer) return;
    try { setRequestPreview(await api('/config/preview', { config, customer })); }
    catch (error) { onError(messageOf(error)); }
  };
  const dirty = JSON.stringify(config) !== JSON.stringify(savedConfig);
  async function restore() {
    setRestoring(true);
    try {
      const defaults = await api<{ systemPrompt: string }>('/prompt/default');
      onChange({ ...config, systemPrompt: defaults.systemPrompt });
    } catch (error) { onError(messageOf(error)); }
    finally { setRestoring(false); }
  }
  return <form className="prompt-control" noValidate onSubmit={event => { event.preventDefault(); if (!invalid) void onSave(false); }}>
    <div className="prompt-toolbar">
      <div><strong>SeedDuplex 配置中心</strong><span className={`badge ${dirty ? 'reserved' : 'status-active'}`}>{dirty ? '有未保存修改' : '已保存'}</span><p>管理限制词、声音、识别和对话参数，并在试打中控制模型回复。</p></div>
      <div className="form-actions"><button className="button secondary" type="button" disabled={saving || restoring} onClick={() => void restore()}>恢复限制词草稿</button><button className="button primary" type="submit" disabled={saving || restoring || invalid}>{saving ? '保存中…' : '保存限制词与参数'}</button><button className="button secondary" type="button" disabled={saving || restoring || invalid} onClick={() => void onSave(true)}>保存并去试打 →</button></div>
    </div>
    <div className="tabs model-tabs" role="tablist" aria-label="限制词与模型控制">{([['parameters','模型参数'],['prompt','完整限制词'],['live','实时干预'],['request','请求预览']] as const).map(([value,label]) => <button type="button" key={value} role="tab" aria-selected={tab === value} className={tab === value ? 'active' : ''} onClick={() => setTab(value)}>{label}</button>)}</div>
    {invalid && <div className="alert error" role="alert"><p>{invalidQuickReply ? '请在模型参数中填写首轮拒绝快速回复文案。' : invalidJson.size ? `有 ${invalidJson.size} 个 JSON 编辑框格式有误，请到模型参数中修正。` : validation.error?.issues.slice(0,3).map(issue => `${issue.path.join('.')}: ${issue.message}`).join('；')}</p></div>}
    <section hidden={tab !== 'parameters'}>
      <section className="panel"><div className="panel-heading"><h2>首轮拒绝快速回复</h2><span className="subtle-tag">新通话生效</span></div><div className="panel-body">
        <label className="parameter-toggle"><input type="checkbox" checked={config.quickReplyEnabled !== false} onChange={event => onChange({ ...config, quickReplyEnabled: event.target.checked })} /><span><strong>启用首轮拒绝快速回复</strong><small>客户首轮简单说“不需要 / 不想了解”时，若智能体尚未开始回复，就直接播报下方介绍。首句仍完整播放；后续问题由完整限制词回答。</small></span></label>
        <label className="field">快速回复文案<textarea rows={5} maxLength={8000} value={config.quickReplyText ?? ''} onChange={event => onChange({ ...config, quickReplyText: event.target.value })} /><small>支持 &amp;industry、&amp;address、&amp;camp、&amp;name、&amp;phone。行业与地区会自然带入；完整限制词中的 FAQ 与此文案可分别编辑。</small></label>
        {invalidQuickReply && <p className="field-error" role="alert">请填写首轮拒绝快速回复文案。</p>}
      </div></section>
      <section className="panel"><div className="panel-heading"><h2>本地同行场景</h2><span className="subtle-tag">优先级：中上</span></div><div className="panel-body"><label className="parameter-toggle"><input type="checkbox" checked={config.competitorPressureEnabled !== false} onChange={event => onChange({ ...config, competitorPressureEnabled: event.target.checked })} /><span><strong>启用本地同行场景</strong><small>使用联网查询的同城同行举例，每通主动使用一次。先回答客户当前问题；报价、效果保证和号码确认期间不插入施压话术。新通话生效。</small></span></label><p className="prompt-help">变量 &amp;competitors 最多带入两家有来源的同行。未查到时只泛称当地同行，不假设对方已经做了 GEO。</p></div></section>
      <ModelSettings config={config} searchConfigured={props.searchConfigured} onChange={onChange} onInvalid={onInvalid} onError={onError} />
    </section>
    <section hidden={tab !== 'live'}><LiveControls session={props.session} enabled={tab === 'live'} savedConfig={savedConfig} dirty={dirty} /></section>
    <section hidden={tab !== 'request'} className="panel"><div className="panel-heading"><h2>实际会话请求结构</h2><button className="button secondary" type="button" disabled={!customerId || invalid} onClick={() => void previewRequest()}>生成当前草稿请求预览</button></div><div className="panel-body"><p className="prompt-help">展示 session.create 与 extension 的字段。此操作不保存、不连接云端；密钥以服务端占位符显示。草稿更改后需重新生成预览。</p>{requestPreview ? <pre className="runtime-json">{JSON.stringify(requestPreview, null, 2)}</pre> : <p className="prompt-help">选择客户后生成请求，可检查声音、开场限制词与所有扩展参数。</p>}<a className="text-button" href={DOCUMENT_URL} target="_blank" rel="noreferrer">查看本接口官方文档 ↗</a></div></section>
    <div className="prompt-layout" hidden={tab !== 'prompt'}>
      <section className="panel prompt-editor-panel"><div className="panel-heading"><h2>完整限制词编辑</h2><span className="subtle-tag">{(config.systemPrompt ?? '').length.toLocaleString()} / 24,000 字符</span></div><div className="panel-body"><label className="field">系统限制词正文<textarea className="prompt-editor" required minLength={20} maxLength={24000} spellCheck={false} rows={27} value={config.systemPrompt ?? ''} onChange={event => onChange({ ...config, systemPrompt: event.target.value })} /><small>可直接修改完整话术。客户资料和已配置首句由系统在每通电话创建时附加。</small></label><label className="field">本次调试补充要求<textarea rows={4} maxLength={8000} value={config.extraInstructions} onChange={event => onChange({ ...config, extraInstructions: event.target.value })} placeholder="例如：少用语气词，讲行业场景时控制在两句话内。" /></label></div></section>
      <aside className="prompt-settings"><section className="panel"><div className="panel-heading"><h2>声音与销售角色</h2></div><div className="panel-body"><label className="field">销售角色名称<input required maxLength={40} value={config.agentName} onChange={event => onChange({ ...config, agentName: event.target.value })} /></label><label className="field">音色 ID<input required className="mono" value={config.voice} onChange={event => onChange({ ...config, voice: event.target.value })} /><small>默认云舟 2.0；可填写已开通的 SeedDuplex 音色。</small></label><label className="field">语速参数<input type="number" min={-50} max={100} value={config.speed} onChange={event => onChange({ ...config, speed: Number(event.target.value) })} /><small>0 为标准语速，负值更慢，正值更快。</small></label></div></section>
        <section className="panel"><div className="panel-heading"><h2>带入客户预览</h2></div><div className="panel-body"><label className="field">预览客户<select value={customerId} onChange={event => onCustomerChange(event.target.value)}><option value="" disabled>请选择客户</option>{customers.map(customer => <option key={customer.id} value={customer.id}>{customer.name || '未命名'} · {customer.camp}</option>)}</select></label><button type="button" className="button secondary full" disabled={saving || !customerId} onClick={() => void onPreview()}>预览当前草稿与客户变量</button><p className="prompt-help">预览包含尚未保存的内容，不会修改已保存设置。</p><div className="variable-list">{[['&camp','客户公司'],['&name','客户姓名'],['&phone','客户电话'],['&address','客户地址'],['&industry','客户行业'],['&competitors','本地同行名称']].map(([key,value]) => <div key={key}><code>{key}</code><span>{value}</span></div>)}</div></div></section>
        <section className="panel"><div className="panel-body"><strong className="prompt-lock-label">首句与通话快照</strong><p className="prompt-help">首句可在“模型参数”中修改，仍由 AI 先说并完整播放。当前通话沿用创建时的限制词快照，新的修改从下一通开始生效。</p><p className="prompt-help">修改后的限制词通过真实 SeedDuplex 语音试打验证；规则文字模拟仅用于检查流程。</p></div></section>
      </aside>
    </div>
  </form>;
}
