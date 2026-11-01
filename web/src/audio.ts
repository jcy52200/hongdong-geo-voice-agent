/** One isolated microphone and PCM playback queue for each local test. */
export class LocalAudio {
  readonly context: AudioContext;
  private stream?: MediaStream;
  private input?: MediaStreamAudioSourceNode;
  private capture?: AudioWorkletNode;
  private silent?: GainNode;
  private sources = new Set<AudioBufferSourceNode>();
  private nextStart = 0;
  private disposed = false;
  private drainTimer?: number;
  private readonly resumed: Promise<void>;

  constructor() {
    this.context = new AudioContext();
    // Called directly in the button's gesture, before awaiting any network request.
    this.resumed = this.context.resume();
  }

  async prepare(onFrame: (base64: string) => void) {
    await this.resumed;
    if (this.disposed) return;
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('当前浏览器无法访问麦克风，请使用 localhost 或 HTTPS。');
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
    if (this.disposed) { this.stream.getTracks().forEach(track => track.stop()); return; }
    await this.context.audioWorklet.addModule('/capture-worklet.js');
    if (this.disposed) return;
    this.input = this.context.createMediaStreamSource(this.stream);
    this.capture = new AudioWorkletNode(this.context, 'pcm16-capture');
    this.capture.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
      if (this.disposed) return;
      const bytes = new Uint8Array(event.data);
      let binary = '';
      for (const byte of bytes) binary += String.fromCharCode(byte);
      onFrame(btoa(binary));
    };
    this.silent = this.context.createGain();
    this.silent.gain.value = 0;
    this.input.connect(this.capture).connect(this.silent).connect(this.context.destination);
  }

  setInputEnabled(enabled: boolean) { this.capture?.port.postMessage({ enabled }); }

  play(base64: string, rate: number) {
    if (this.disposed || this.context.state === 'closed') return;
    const binary = atob(base64);
    const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
    const view = new DataView(bytes.buffer);
    const length = Math.floor(bytes.byteLength / 2);
    if (!length) return;
    const buffer = this.context.createBuffer(1, length, rate);
    const channel = buffer.getChannelData(0);
    for (let index = 0; index < length; index++) channel[index] = view.getInt16(index * 2, true) / 32768;
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.context.destination);
    source.onended = () => { source.disconnect(); this.sources.delete(source); };
    const start = Math.max(this.context.currentTime + 0.025, this.nextStart);
    this.nextStart = start + buffer.duration;
    this.sources.add(source);
    source.start(start);
  }

  afterPlayback(callback: () => void) {
    if (this.drainTimer) window.clearTimeout(this.drainTimer);
    const check = () => {
      if (this.disposed) return;
      const remaining = this.nextStart - this.context.currentTime;
      // AudioContext may be suspended by the operating system; only acknowledge actual playback.
      if (this.context.state === 'running' && remaining <= 0.01 && this.sources.size === 0) callback();
      else this.drainTimer = window.setTimeout(check, Math.min(100, Math.max(20, remaining * 1000)));
    };
    check();
  }

  clearPlayback() {
    for (const source of this.sources) { try { source.stop(); } catch { /* already ended */ } source.disconnect(); }
    this.sources.clear();
    this.nextStart = 0;
  }

  close() {
    this.disposed = true;
    if (this.drainTimer) window.clearTimeout(this.drainTimer);
    this.setInputEnabled(false);
    this.stream?.getTracks().forEach(track => track.stop());
    this.input?.disconnect();
    this.capture?.disconnect();
    this.capture?.port.close();
    this.silent?.disconnect();
    this.clearPlayback();
    if (this.context.state !== 'closed') void this.context.close();
  }
}
