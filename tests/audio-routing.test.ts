import assert from 'node:assert/strict';
import test from 'node:test';
import { inputAudioConstraints, validateActualInput, validateAudioRouting, validateInputProcessing, type AudioRouteDevice } from '../web/src/audio-routing';
import { LocalAudio } from '../web/src/audio';

const devices: AudioRouteDevice[] = [
  { kind: 'audioinput', deviceId: 'from-phone', groupId: 'cable-a', label: 'Phone → AI' },
  { kind: 'audiooutput', deviceId: 'to-phone', groupId: 'cable-b', label: 'AI → Phone' },
  { kind: 'audiooutput', deviceId: 'same-cable', groupId: 'cable-a', label: 'Phone → AI' },
];
const bridge = { mode: 'softphone' as const, inputDeviceId: 'from-phone', outputDeviceId: 'to-phone' };

test('browser microphone processing remains enabled while bridge bypasses voice processing', () => {
  assert.deepEqual(inputAudioConstraints({}), { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true });
  assert.deepEqual(inputAudioConstraints(bridge), { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false, deviceId: { exact: 'from-phone' } });
});

test('bridge requires two available, explicit and distinct audio routes', () => {
  assert.doesNotThrow(() => validateAudioRouting(bridge, devices));
  for (const alias of ['', 'default', 'communications']) {
    assert.throws(() => validateAudioRouting({ ...bridge, inputDeviceId: alias }, devices), /系统默认/);
    assert.throws(() => validateAudioRouting({ ...bridge, outputDeviceId: alias }, devices), /系统默认/);
  }
  assert.throws(() => validateAudioRouting({ ...bridge, inputDeviceId: 'missing' }, devices), /输入设备已不可用/);
  assert.throws(() => validateAudioRouting({ ...bridge, outputDeviceId: 'missing' }, devices), /输出设备已不可用/);
  assert.throws(() => validateAudioRouting({ ...bridge, outputDeviceId: 'same-cable' }, devices), /同一条音频通道/);
  const labelOnly = devices.map(device => ({ ...device, groupId: '' }));
  assert.throws(() => validateAudioRouting({ ...bridge, outputDeviceId: 'same-cable' }, labelOnly), /同一条音频通道/);
});

test('pinned input may not silently fall back to another microphone', () => {
  assert.doesNotThrow(() => validateActualInput(bridge, 'from-phone'));
  assert.doesNotThrow(() => validateActualInput({}, undefined));
  assert.throws(() => validateActualInput(bridge, 'built-in-mic'), /没有使用所选输入/);
  assert.throws(() => validateActualInput(bridge, undefined), /没有使用所选输入/);
});

test('bridge rejects voice processing that remains enabled instead of changing call audio', () => {
  assert.doesNotThrow(() => validateInputProcessing(bridge, {}));
  assert.doesNotThrow(() => validateInputProcessing(bridge, { echoCancellation: false, noiseSuppression: false, autoGainControl: false }));
  for (const key of ['echoCancellation', 'noiseSuppression', 'autoGainControl']) {
    assert.throws(() => validateInputProcessing(bridge, { [key]: true }), /仍在处理桥接音频/);
  }
  assert.doesNotThrow(() => validateInputProcessing({}, { echoCancellation: true }));
});

/** Exercise browser orchestration without requesting real devices or generating audio. */
function fakeBrowser({ sinkSupported = true, sinkFailure = false, actualInput = 'from-phone' } = {}) {
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  };
  let stopped = false;
  let closed = false;
  let requested = 0;
  let listed = devices;
  let worklets = 0;
  const track = Object.assign(new EventTarget(), {
    readyState: 'live',
    getSettings: () => ({ deviceId: actualInput }),
    stop: () => { stopped = true; },
  });
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  const node = () => ({ connect(target: unknown) { return target; }, disconnect() {} });
  const mediaDevices = Object.assign(new EventTarget(), {
    getUserMedia: async () => { requested++; return stream; },
    enumerateDevices: async () => listed,
  });
  class Context extends EventTarget {
    state = 'running';
    sinkId = '';
    destination = node();
    audioWorklet = { addModule: async () => { worklets++; } };
    setSinkId = sinkSupported ? async (id: string) => {
      if (sinkFailure) throw new Error('Output denied');
      this.sinkId = id;
    } : undefined;
    resume = async () => {};
    close = async () => { closed = true; this.state = 'closed'; };
    createMediaStreamSource = () => node();
    createGain = () => ({ ...node(), gain: { value: 0 } });
  }
  class Worklet {
    port = { onmessage: null, postMessage() {}, close() {} };
    connect(target: unknown) { return target; }
    disconnect() {}
  }
  install('navigator', { mediaDevices });
  install('window', globalThis);
  install('AudioContext', Context);
  install('AudioWorkletNode', Worklet);
  return {
    track, mediaDevices,
    setDevices: (next: AudioRouteDevice[]) => { listed = next; },
    stats: () => ({ stopped, closed, requested, worklets }),
    restore: () => { for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } },
  };
}

test('unsupported output routing fails before opening microphone; permission failures release devices', async () => {
  for (const flags of [{ sinkSupported: false }, { sinkFailure: true }, { actualInput: 'built-in-mic' }]) {
    const browser = fakeBrowser(flags);
    try {
      const audio = new LocalAudio({ ...bridge, record: false });
      await assert.rejects(audio.prepare());
      await Promise.resolve();
      assert.equal(browser.stats().closed, true);
      assert.equal(browser.stats().worklets, 0);
      assert.equal(browser.stats().requested, flags.sinkSupported === false ? 0 : 1);
      assert.equal(browser.stats().stopped, flags.sinkSupported === false ? false : true);
    } finally { browser.restore(); }
  }
});

test('routing check pins output without recording or model traffic and device removal stops it', async () => {
  const browser = fakeBrowser();
  try {
    let fault = '';
    const audio = new LocalAudio({ ...bridge, record: false, onFault: message => { fault = message; } });
    await audio.prepare();
    assert.equal((audio.context as unknown as { sinkId: string }).sinkId, 'to-phone');
    assert.equal(browser.stats().worklets, 1);
    browser.setDevices(devices.filter(device => device.deviceId !== 'to-phone'));
    browser.mediaDevices.dispatchEvent(new Event('devicechange'));
    await Promise.resolve();
    await Promise.resolve();
    assert.match(fault, /输出设备已不可用/);
    assert.equal(browser.stats().stopped, true);
    assert.equal(browser.stats().closed, true);
    audio.close();
  } finally { browser.restore(); }
});

test('selected input ending and output fallback each stop bridge instead of using system speakers', async () => {
  for (const event of ['ended', 'sinkchange']) {
    const browser = fakeBrowser();
    try {
      let faults = 0;
      const audio = new LocalAudio({ ...bridge, record: false, onFault: () => { faults++; } });
      await audio.prepare();
      if (event === 'ended') browser.track.dispatchEvent(new Event('ended'));
      else {
        (audio.context as unknown as { sinkId: string }).sinkId = '';
        audio.context.dispatchEvent(new Event('sinkchange'));
      }
      await Promise.resolve();
      assert.equal(faults, 1);
      assert.equal(browser.stats().closed, true);
    } finally { browser.restore(); }
  }
});
