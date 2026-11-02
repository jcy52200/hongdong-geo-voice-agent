import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { LocalAudio, type AudioLevels } from './audio';
import { validateAudioRouting } from './audio-routing';
import { messageOf } from './api';
import './softphone-bridge.css';

export interface BridgeRoute { inputDeviceId: string; outputDeviceId: string }
export interface BridgeHandle { stopPreview(): void }
const storageKey = 'geo.softphone.audio-route.v1';
export function loadBridgeRoute(): BridgeRoute {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) ?? '{}') as Partial<BridgeRoute>;
    return { inputDeviceId: typeof saved.inputDeviceId === 'string' ? saved.inputDeviceId : '', outputDeviceId: typeof saved.outputDeviceId === 'string' ? saved.outputDeviceId : '' };
  } catch { return { inputDeviceId: '', outputDeviceId: '' }; }
}
const zeroLevels: AudioLevels = { input: 0, output: 0 };
function Level({ label, value }: { label: string; value: number }) {
  const shown = Math.min(100, Math.round(Math.sqrt(value) * 100));
  return <div className="bridge-level"><span>{label}</span><meter aria-label={label} min={0} max={1} value={value} /><span aria-hidden="true">{shown > 0 ? '有信号' : '等待声音'}</span></div>;
}

interface Props {
  value: BridgeRoute; onChange: (value: BridgeRoute) => void;
  ready: boolean; onReady: (value: boolean) => void;
  confirmed: boolean; onConfirm: (value: boolean) => void;
  disabled: boolean; levels: AudioLevels;
}

/** Optional browser-only demo adapter. It owns neither SIP credentials nor call control. */
export const SoftphoneBridge = forwardRef<BridgeHandle, Props>(function SoftphoneBridge({ value, onChange, ready, onReady, confirmed, onConfirm, disabled, levels }, ref) {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [checking, setChecking] = useState(false);
  const [observing, setObserving] = useState(false);
  const [previewLevels, setPreviewLevels] = useState(zeroLevels);
  const [problem, setProblem] = useState('');
  const preview = useRef<LocalAudio | null>(null);
  const generation = useRef(0);
  const mounted = useRef(false);
  const permissionRequest = useRef(0);
  const supportsOutput = typeof AudioContext !== 'undefined' && typeof (AudioContext.prototype as { setSinkId?: unknown }).setSinkId === 'function';

  const stopPreview = useCallback(() => {
    generation.current++;
    const audio = preview.current; preview.current = null;
    audio?.close();
    setChecking(false); setObserving(false); setPreviewLevels(zeroLevels);
  }, []);
  useImperativeHandle(ref, () => ({ stopPreview }), [stopPreview]);
  const enumerate = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) throw new Error('无法读取音频设备，请使用 localhost 或 HTTPS 的桌面浏览器。');
    const list = await navigator.mediaDevices.enumerateDevices();
    if (mounted.current) setDevices(list.filter(device => device.deviceId && !['default', 'communications'].includes(device.deviceId) && ['audioinput', 'audiooutput'].includes(device.kind)));
  }, []);
  useEffect(() => {
    mounted.current = true;
    void enumerate().catch(error => { if (mounted.current) setProblem(messageOf(error)); });
    const changed = () => { stopPreview(); onReady(false); onConfirm(false); void enumerate().catch(error => { if (mounted.current) setProblem(messageOf(error)); }); };
    const leave = () => { permissionRequest.current++; setLoading(false); stopPreview(); onReady(false); onConfirm(false); };
    navigator.mediaDevices?.addEventListener('devicechange', changed);
    window.addEventListener('pagehide', leave);
    return () => { mounted.current = false; leave(); navigator.mediaDevices?.removeEventListener('devicechange', changed); window.removeEventListener('pagehide', leave); };
  }, [enumerate, onReady, onConfirm, stopPreview]);
  useEffect(() => { try { localStorage.setItem(storageKey, JSON.stringify(value)); } catch { /* selection still works without storage */ } }, [value]);

  async function authorize() {
    stopPreview(); onReady(false); onConfirm(false); setProblem(''); setLoading(true);
    const run = ++permissionRequest.current;
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('当前浏览器无法授权音频输入。');
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      stream.getTracks().forEach(track => track.stop());
      if (mounted.current && run === permissionRequest.current) await enumerate();
    } catch (error) { if (mounted.current && run === permissionRequest.current) setProblem(messageOf(error)); }
    finally { if (mounted.current && run === permissionRequest.current) setLoading(false); }
  }
  function choose(next: BridgeRoute) {
    stopPreview(); onReady(false); onConfirm(false); setProblem(''); onChange(next);
  }
  async function checkRoute() {
    stopPreview(); onReady(false); onConfirm(false); setProblem('');
    const run = generation.current;
    try {
      validateAudioRouting({ mode: 'softphone', ...value }, devices);
      // Construct in this click gesture. No model, recording or test tone is started.
      const audio = new LocalAudio({ mode: 'softphone', ...value, record: false,
        onLevels: next => { if (mounted.current && run === generation.current) setPreviewLevels(next); },
        onFault: message => { if (mounted.current && run === generation.current) { stopPreview(); onReady(false); onConfirm(false); setProblem(message); } },
      });
      preview.current = audio; setChecking(true);
      await audio.prepare();
      if (!mounted.current || run !== generation.current) { audio.close(); return; }
      onReady(true); setObserving(true); setChecking(false);
    } catch (error) {
      if (mounted.current && run === generation.current) { stopPreview(); onReady(false); setProblem(messageOf(error)); }
    }
  }
  const inputs = devices.filter(device => device.kind === 'audioinput');
  const outputs = devices.filter(device => device.kind === 'audiooutput');
  return <div className="softphone-bridge">
    <div className="bridge-heading"><strong>软电话桥接</strong><span className="subtle-tag">仅测试 / 展示</span></div>
    <p className="bridge-help">Linphone 负责拨号；本页只连接语音。请选择两条独立虚拟音频通道。</p>
    <div className="bridge-wiring"><span><b>A</b> 客户 → AI</span><span><b>B</b> AI → 客户</span><small>Linphone：扬声器选 A，麦克风选 B</small></div>
    <label className="field">客户声音输入 · A<select value={value.inputDeviceId} disabled={disabled || loading || checking} onChange={event => choose({ ...value, inputDeviceId: event.target.value })}><option value="">选择客户 → AI 通道</option>{inputs.map((device, index) => <option key={device.deviceId} value={device.deviceId}>{device.label || `输入设备 ${index + 1}（请先授权）`}</option>)}</select></label>
    <label className="field">AI 声音输出 · B<select value={value.outputDeviceId} disabled={disabled || loading || checking} onChange={event => choose({ ...value, outputDeviceId: event.target.value })}><option value="">选择 AI → 客户通道</option>{outputs.map((device, index) => <option key={device.deviceId} value={device.deviceId}>{device.label || `输出设备 ${index + 1}（请先授权）`}</option>)}</select></label>
    <div className="bridge-actions"><button type="button" className="button secondary small" disabled={disabled || loading || checking} onClick={() => void authorize()}>{loading ? '正在读取…' : '授权并刷新设备'}</button><button type="button" className="button secondary small" disabled={disabled || loading || checking || !supportsOutput || !value.inputDeviceId || !value.outputDeviceId} onClick={() => observing ? stopPreview() : void checkRoute()}>{checking ? '检查中…' : observing ? '停止观察' : '检查音频路由'}</button></div>
    {!supportsOutput && <p className="bridge-problem" role="alert">当前浏览器无法指定输出，请改用支持音频输出选择的桌面版 Chrome / Edge。</p>}
    {problem && <p className="bridge-problem" role="alert">{problem}</p>}
    {(observing || disabled) && <div className="bridge-meters" aria-label="本地音频电平"><Level label="客户输入" value={(disabled ? levels : previewLevels).input} />{disabled && <Level label="AI 输出" value={levels.output} />}</div>}
    <p className="bridge-check-state" role="status">{disabled ? 'AI 会话进行中 · 电话仍由 Linphone 控制' : ready ? '本地设备检查通过；请人工确认电话接通。' : '先授权并检查音频路由，再启动 AI。'}</p>
    <p className="bridge-help">检查不连接模型、不录音、不播放测试音；输入有信号和设备检查通过不代表电话已接通。</p>
    <label className="bridge-confirm"><input type="checkbox" checked={confirmed} disabled={disabled || !ready || checking || loading} onChange={event => onConfirm(event.target.checked)} /><span>我已在 Linphone 接通测试手机，并核对 A / B 接线。</span></label>
    <details className="bridge-guide"><summary>接线与结束通话</summary><p>准备 BlackHole 的两个独立设备，或 Loopback 的两个 Pass-Thru 设备。页面输入选 A、输出选 B；Linphone 输入选 B、输出选 A。不要把扬声器或物理麦克风接入这两条通道。</p><p>启动 AI 后，先确认手机能听到开场。结束 AI 后还要在 Linphone 挂机；对方先挂机时也请及时结束本页。</p><a href="https://help.aliyun.com/zh/ccs/cccai/use-cases/connect-an-sip-softphone" target="_blank" rel="noreferrer">阿里云 Linphone 配置说明 ↗</a></details>
  </div>;
});
