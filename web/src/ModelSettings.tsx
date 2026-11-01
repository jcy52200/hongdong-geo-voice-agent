import { useEffect, useRef, useState } from 'react';
import { api, messageOf } from './api';
import type { AgentConfig } from './types';
import type { ModelOptions } from '../../shared/model-config';

export function JsonControl({ id, label, value, kind, hint, onChange, onInvalid }: {
  id: string; label: string; value: unknown; kind: 'object' | 'array'; hint: string;
  onChange: (value: any) => void; onInvalid: (id: string, invalid: boolean) => void;
}) {
  const serialized = JSON.stringify(value, null, 2);
  const [draft, setDraft] = useState(serialized);
  const [error, setError] = useState('');
  const lastValue = useRef(serialized);
  useEffect(() => {
    if (lastValue.current !== serialized) { lastValue.current = serialized; setDraft(serialized); setError(''); onInvalid(id, false); }
  }, [serialized, id, onInvalid]);
  useEffect(() => () => onInvalid(id, false), [id, onInvalid]);
  return <label className="field json-field">{label}<textarea className="mono" rows={5} value={draft} spellCheck={false} aria-invalid={Boolean(error)} onChange={event => {
    setDraft(event.target.value);
    try {
      const parsed = JSON.parse(event.target.value);
      if (kind === 'array' ? !Array.isArray(parsed) : !parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`需要 JSON ${kind === 'array' ? '数组' : '对象'}`);
      lastValue.current = JSON.stringify(parsed, null, 2); setError(''); onInvalid(id, false); onChange(parsed);
    } catch (error) { setError(messageOf(error)); onInvalid(id, true); }
  }} /><small>{hint}</small>{error && <span className="field-error">{error}；修正后才能保存。</span>}</label>;
}
function Toggle({ label, hint, checked, onChange }: { label: string; hint: string; checked: boolean; onChange: (value: boolean) => void }) {
  return <label className="parameter-toggle"><input type="checkbox" checked={checked} onChange={event => onChange(event.target.checked)} /><span><strong>{label}</strong><small>{hint}</small></span></label>;
}
function Range({ label, value, onChange }: { label: string; value: number; onChange: (value: number) => void }) {
  return <label className="field range-field"><span>{label}<output>{value} · {(1 + value / 100).toFixed(2)} 倍</output></span><input aria-label={label} type="range" min={-50} max={100} step={1} value={value} onChange={event => onChange(Number(event.target.value))} /><small>-50 至 100，0 为原始值。</small></label>;
}

export function ModelSettings({ config, searchConfigured, onChange, onInvalid, onError }: {
  config: AgentConfig; searchConfigured: boolean; onChange: (config: AgentConfig) => void;
  onInvalid: (id: string, invalid: boolean) => void; onError: (message: string) => void;
}) {
  const [resetVersion, setResetVersion] = useState(0);
  const options = config.modelOptions ?? {};
  const asr = options.asr ?? {}, tts = options.tts ?? {}, dialog = options.dialog ?? {}, extra = dialog.extra ?? {};
  const changeOptions = (patch: Partial<ModelOptions>) => onChange({ ...config, modelOptions: { ...options, ...patch } });
  const changeAsr = (patch: Partial<NonNullable<ModelOptions['asr']>>) => changeOptions({ asr: { ...asr, ...patch } });
  const changeTts = (patch: Partial<NonNullable<ModelOptions['tts']>>) => changeOptions({ tts: { ...tts, ...patch } });
  const changeExtra = (patch: Partial<NonNullable<NonNullable<ModelOptions['dialog']>['extra']>>) => changeOptions({ dialog: { ...dialog, extra: { ...extra, ...patch } } });
  const metadata = tts.aigc_metadata ?? { enable: false };
  return <div className="model-parameters" key={resetVersion}>
    <div className="parameter-summary"><div><strong>会话参数</strong><p>保存后用于新电话。试打中可到“实时干预”发送会话更新；初始化历史只在新会话加载。</p></div><button className="button secondary" type="button" onClick={() => {
      void api<{ config: AgentConfig }>('/prompt/default').then(({ config: defaults }) => { onChange({ ...config, voice: defaults.voice, speed: defaults.speed, loudness: defaults.loudness, opening: defaults.opening, modelOptions: {} }); setResetVersion(version => version + 1); }).catch(error => onError(messageOf(error)));
    }}>恢复默认模型参数</button></div>
    <section className="panel"><div className="panel-heading"><h2>声音与开场</h2><span className="subtle-tag">session.audio.output</span></div><div className="panel-body parameter-grid">
      <label className="field">音色 ID · voice<input value={config.voice} required onChange={event => onChange({ ...config, voice: event.target.value })} list="seed-voices" /><datalist id="seed-voices"><option value="zh_male_m191_uranus_bigtts">云舟 2.0</option><option value="zh_male_taocheng_uranus_bigtts">小天 2.0</option><option value="zh_female_vv_uranus_bigtts">Vivi 2.0</option><option value="zh_female_xiaohe_uranus_bigtts">小何 2.0</option></datalist><small>可输入已开通的预置或复刻音色。</small></label>
      <label className="field">方言 · explicit_dialect<select value={tts.explicit_dialect ?? ''} onChange={event => changeTts({ explicit_dialect: event.target.value as typeof tts.explicit_dialect })}>{[['','跟随音色 / 提示词'],['beijing','北京'],['tianjin','天津'],['dongbei','东北'],['sichuan','四川'],['shaanxi','陕西'],['henan','河南'],['shanghai','上海'],['yue','粤语']].map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select><small>方言需音色支持。文档没有河北独立枚举，河北表达仍由限制词引导。</small></label>
      <Range label="语速 · speed" value={config.speed} onChange={speed => onChange({ ...config, speed })} />
      <Range label="音量 · loudness" value={config.loudness ?? 0} onChange={loudness => onChange({ ...config, loudness })} />
      <div className="parameter-note"><strong>音调 / pitch</strong><p>当前 SeedDuplex 3.0 文档没有独立音调字段。可更换音色，或在限制词中描述“低沉、明亮”等声音风格；不混用其他 TTS 接口的 pitch 参数。</p></div>
      <Toggle label="响度均衡 · enable_loudness_norm" checked={extra.enable_loudness_norm ?? true} onChange={value => changeExtra({ enable_loudness_norm: value })} hint="项目默认开启；这是模型输出处理，与本机扬声器音量不同。" />
      <label className="field span-all">打招呼语句 / 首句 · speech_text_buffer.commit<textarea rows={4} maxLength={2000} required value={config.opening ?? ''} onChange={event => onChange({ ...config, opening: event.target.value })} /><small>可以修改首句，支持 &amp;camp、&amp;name、&amp;phone、&amp;address、&amp;industry。AI 仍先开口，首句实际播完后才接收客户输入。</small></label>
      <label className="field">括号内容过滤上限 · max_length_to_filter_parenthesis<input type="number" min={0} max={100} value={tts.max_length_to_filter_parenthesis ?? 0} onChange={event => changeTts({ max_length_to_filter_parenthesis: Number(event.target.value) })} /><small>0 不过滤；1 至 100 按官方建议范围设置，超长括号内容不会被过滤。</small></label>
    </div></section>
    <details className="panel parameter-section" open><summary>语音识别与行业热词 <code>extension.asr.extra</code></summary><div className="panel-body parameter-grid">
      <Toggle label="开启二遍识别 · enable_asr_twopass" checked={asr.enable_asr_twopass ?? false} onChange={value => changeAsr({ enable_asr_twopass: value })} hint="使用热词表和自定义热词时需开启。" />
      <div className="parameter-note"><p>“泓动引擎”、GEO、行业术语和号码相关用词可作为热词。识别替换规则不等于修改客户原意。</p></div>
      {(['boosting_table_id','boosting_table_name','regex_correct_table_id','regex_correct_table_name'] as const).map((key, index) => <label className="field" key={key}>{['热词词表 ID','热词词表名称','正则替换词表 ID','正则替换词表名称'][index]} · {key}<input value={asr[key] ?? ''} onChange={event => changeAsr({ [key]: event.target.value })} /><small>{index < 2 ? '需先在控制台创建词表，并开启二遍识别。' : '需先在控制台创建替换词表。'}</small></label>)}
      <JsonControl id="hotwords" label="自定义热词 · context.hotwords" value={asr.context?.hotwords ?? []} kind="array" hint={'格式：[ {"word":"泓动引擎"}, {"word":"GEO"} ]；需开启二遍识别。'} onInvalid={onInvalid} onChange={value => changeAsr({ context: { ...asr.context, hotwords: value } })} />
      <JsonControl id="correctWords" label="识别替换 · context.correct_words" value={asr.context?.correct_words ?? {}} kind="object" hint={'格式：{"宏动引擎":"泓动引擎"}，键为原词/正则，值为替换后文本。'} onInvalid={onInvalid} onChange={value => changeAsr({ context: { ...asr.context, correct_words: value } })} />
    </div></details>
    <details className="panel parameter-section"><summary>对话行为、审核与联网 <code>extension.dialog</code></summary><div className="panel-body parameter-grid">
      <Toggle label="严格审核 · strict_audit" checked={extra.strict_audit ?? true} onChange={value => changeExtra({ strict_audit: value })} hint="开启为严格审核，关闭为普通审核。不是关闭服务端审核。" />
      <Toggle label="退出意图识别 · enable_user_query_exit" checked={extra.enable_user_query_exit ?? false} onChange={value => changeExtra({ enable_user_query_exit: value })} hint="服务端在音频完成事件中提供退出信号；本项目记录信号，仍由您结束测试。" />
      <label className="field span-all">审核命中回复 · audit_response<textarea rows={2} value={extra.audit_response ?? ''} onChange={event => changeExtra({ audit_response: event.target.value })} /><small>留空沿用服务端默认回复。</small></label>
      <Toggle label="内置联网 · enable_volc_websearch" checked={extra.enable_volc_websearch ?? false} onChange={value => changeExtra({ enable_volc_websearch: value, ...(value && !extra.volc_websearch_type ? { volc_websearch_type: 'web_custom_api' as const } : {}) })} hint="需单独开通搜索服务，可能产生相应调用用量。" />
      <label className="field">搜索版本 · volc_websearch_type<select value={extra.volc_websearch_type ?? 'web_custom_api'} onChange={event => changeExtra({ volc_websearch_type: event.target.value as 'web_custom_api' | 'web_global_api' })}><option value="web_custom_api">Custom · 行业定制</option><option value="web_global_api">Global · 通用搜索</option></select><small>搜索密钥：{searchConfigured ? '服务端已配置' : '未配置'}。在 .env 设置 SEED_WEBSEARCH_API_KEY，不进入浏览器或快照。</small></label>
      <JsonControl id="location" label="会话位置 · location" value={dialog.location ?? {}} kind="object" hint={'可用 city、province、district、country、town、country_code、address、longitude、latitude。留空 {} 则不统一指定位置，客户地址仍随提示词注入。'} onInvalid={onInvalid} onChange={value => changeOptions({ dialog: { ...dialog, location: value } })} />
      <div className="parameter-note"><strong>唱歌 · enable_music</strong><p>与电话意向筛选无关，本项目保持关闭。</p></div>
    </div></details>
    <details className="panel parameter-section"><summary>初始化历史与函数调用 <code>dialog_context / session.tools</code></summary><div className="panel-body parameter-grid">
      <JsonControl id="initialContext" label="初始历史问答 · dialog_context" value={dialog.dialog_context ?? []} kind="array" hint={'按 user、assistant 成对排列，例如 [{"role":"user","text":"你好"},{"role":"assistant","text":"您好"}]；可附 timestamp 整数。最多20轮，避免带入其他客户对话。'} onInvalid={onInvalid} onChange={value => changeOptions({ dialog: { ...dialog, dialog_context: value } })} />
      <JsonControl id="tools" label="函数定义 · tools" value={options.tools ?? []} kind="array" hint={'标准格式 [{"type":"function","name":"collect_contact","description":"记录联系方式","parameters":{"type":"object","properties":{"phone":{"type":"string"}}}}]。默认不启用；调用会在实时控制中展示，需人工回传结果，不执行任意本地代码。'} onInvalid={onInvalid} onChange={value => changeOptions({ tools: value })} />
    </div></details>
    <details className="panel parameter-section"><summary>AIGC 溯源元信息 <code>extension.tts.extra.aigc_metadata</code></summary><div className="panel-body parameter-grid">
      <Toggle label="隐式水印 · enable" checked={metadata.enable} onChange={value => changeTts({ aigc_metadata: { ...metadata, enable: value } })} hint="文档列出的溯源配置；当前为原始 PCM 播放链路，不展示文件头水印验证结果。" />
      {(['content_producer','produce_id','content_propagator','propagate_id'] as const).map((key, index) => <label className="field" key={key}>{['内容生产者','制作编号','内容传播者','传播编号'][index]} · {key}<input value={metadata[key] ?? ''} onChange={event => changeTts({ aigc_metadata: { ...metadata, [key]: event.target.value } })} /></label>)}
    </div></details>
    <div className="parameter-note"><strong>传输规格由本项目固定</strong><p>模型 1.2.6.1；上行 PCM16 单声道 16kHz、20ms；下行 PCM16 24kHz。文档中的其他编码需新增编解码适配，当前不开放切换。temperature、top_p 和独立 pitch 均未出现在本接口参数表中。</p></div>
  </div>;
}
