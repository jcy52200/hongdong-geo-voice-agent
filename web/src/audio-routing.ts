/** Browser-only audio routing. SIP/FreeSWITCH transports do not depend on this module. */
export type LocalAudioMode = 'microphone' | 'softphone';

export interface AudioRoutingOptions {
  mode?: LocalAudioMode;
  inputDeviceId?: string;
  outputDeviceId?: string;
}

export interface AudioRouteDevice {
  deviceId: string;
  groupId: string;
  kind: MediaDeviceKind;
  label: string;
}

const aliases = new Set(['', 'default', 'communications']);
const explicit = (id: string | undefined) => Boolean(id && !aliases.has(id));

/** Both bridge directions must be explicitly pinned to different virtual cables. */
export function validateAudioRouting(options: AudioRoutingOptions, devices: readonly AudioRouteDevice[]) {
  const bridge = options.mode === 'softphone';
  if (bridge && (!explicit(options.inputDeviceId) || !explicit(options.outputDeviceId))) {
    throw new Error('软电话桥接必须分别选择明确的输入和输出设备，不能使用系统默认设备。');
  }
  const input = options.inputDeviceId && devices.find(device => device.kind === 'audioinput' && device.deviceId === options.inputDeviceId);
  const output = options.outputDeviceId && devices.find(device => device.kind === 'audiooutput' && device.deviceId === options.outputDeviceId);
  if (options.inputDeviceId && !input) throw new Error('所选输入设备已不可用，请重新选择。');
  if (options.outputDeviceId && !output) throw new Error('所选输出设备已不可用，请重新选择。');
  if (bridge && input && output) {
    // Browser IDs can differ between a cable's input and output. groupId and
    // labels catch the common case where the same virtual cable was selected.
    const sameGroup = input.groupId && input.groupId === output.groupId;
    const sameLabel = input.label.trim() && input.label.trim().toLocaleLowerCase() === output.label.trim().toLocaleLowerCase();
    if (input.deviceId === output.deviceId || sameGroup || sameLabel) {
      throw new Error('桥接输入和输出不能使用同一条音频通道，否则 AI 会听见自己的声音。请选择两条独立通道。');
    }
  }
}

export function inputAudioConstraints(options: AudioRoutingOptions): MediaTrackConstraints {
  const processing = options.mode !== 'softphone';
  return {
    channelCount: 1,
    echoCancellation: processing,
    noiseSuppression: processing,
    autoGainControl: processing,
    ...(options.inputDeviceId ? { deviceId: { exact: options.inputDeviceId } } : {}),
  };
}

/** Never silently accept an OS/default microphone fallback for a pinned route. */
export function validateActualInput(options: AudioRoutingOptions, actualDeviceId: string | undefined) {
  if (options.inputDeviceId && actualDeviceId !== options.inputDeviceId) {
    throw new Error('浏览器没有使用所选输入设备，已停止音频连接。请重新授权并选择设备。');
  }
}

export function validateInputProcessing(options: AudioRoutingOptions, settings: MediaTrackSettings) {
  if (options.mode === 'softphone' && (settings.echoCancellation === true || settings.noiseSuppression === true || settings.autoGainControl === true)) {
    throw new Error('浏览器仍在处理桥接音频，已停止连接。请关闭输入设备的回声消除、降噪及自动增益后重试。');
  }
}
