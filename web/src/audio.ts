export interface CallRecording { blob: Blob; mimeType: string }

/** One isolated microphone, PCM playback queue, and mixed recording per local test. */
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
  private recordingDestination?: MediaStreamAudioDestinationNode;
  private recordingInputGain?: GainNode;
  private recorder?: MediaRecorder;
  private recordingChunks: Blob[] = [];
  private recordingDone?: Promise<CallRecording | null>;
  private resolveRecording?: (recording: CallRecording | null) => void;
  private recordingProblem?: string;
  private recordingStopTimer?: number;

  get recordingError() { return this.recordingProblem; }

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
    this.prepareRecording();
  }

  private prepareRecording() {
    // Recording failure must not prevent the voice test. Do not manufacture an
    // audio file from transcripts when a browser does not support MediaRecorder.
    if (typeof MediaRecorder === 'undefined') {
      this.recordingProblem = '当前浏览器不支持通话录音。';
      return;
    }
    const mimeType = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/webm']
      .find(type => MediaRecorder.isTypeSupported(type));
    if (!mimeType) { this.recordingProblem = '当前浏览器没有可用的通话录音格式。'; return; }
    try {
      this.recordingDestination = this.context.createMediaStreamDestination();
      this.recordingDestination.channelCount = 1;
      // Record only microphone audio that this call permits sending upstream.
      // The initial locked greeting and an operator mute keep this branch silent.
      this.recordingInputGain = this.context.createGain();
      this.recordingInputGain.gain.value = 0;
      this.input!.connect(this.recordingInputGain).connect(this.recordingDestination);
      // Assistant audio enters this graph at its actual playback time, so queued
      // or interrupted speech is not falsely added to the file.
      this.recorder = new MediaRecorder(this.recordingDestination.stream, { mimeType, audioBitsPerSecond: 64_000 });
      this.recordingDone = new Promise(resolve => { this.resolveRecording = resolve; });
      this.recorder.ondataavailable = event => { if (event.data.size) this.recordingChunks.push(event.data); };
      this.recorder.onerror = () => { this.recordingProblem = '浏览器录音失败，本次通话可能没有完整录音。'; };
      this.recorder.onstop = () => this.finishRecording();
      this.recorder.start(1000);
    } catch {
      this.recordingProblem = '浏览器无法启动通话录音。';
      this.finishRecording();
    }
  }

  private finishRecording() {
    if (this.recordingStopTimer) window.clearTimeout(this.recordingStopTimer);
    this.recordingStopTimer = undefined;
    const mimeType = this.recorder?.mimeType;
    const blob = mimeType && this.recordingChunks.length ? new Blob(this.recordingChunks, { type: mimeType }) : null;
    this.recordingChunks = [];
    this.resolveRecording?.(blob?.size && mimeType ? { blob, mimeType } : null);
    this.resolveRecording = undefined;
    this.recordingDestination?.stream.getTracks().forEach(track => track.stop());
    this.recordingDestination?.disconnect();
    this.recordingInputGain?.disconnect();
  }

  /** Stops MediaRecorder and waits for its final dataavailable event. Idempotent. */
  stopRecording(): Promise<CallRecording | null> {
    if (!this.recorder || !this.recordingDone) return Promise.resolve(null);
    if (this.recorder.state !== 'inactive') {
      try { this.recorder.stop(); }
      catch { this.recordingProblem = '浏览器无法完成通话录音。'; this.finishRecording(); }
    }
    // Browsers normally dispatch stop promptly, but navigation or an interrupted
    // media device must not hold cleanup or the upload promise indefinitely.
    if (this.resolveRecording && !this.recordingStopTimer) {
      this.recordingStopTimer = window.setTimeout(() => {
        this.recordingProblem = '录音未能正常结束，保存了已收到的音频片段。';
        this.finishRecording();
      }, 5000);
    }
    return this.recordingDone;
  }

  setInputEnabled(enabled: boolean) {
    this.capture?.port.postMessage({ enabled });
    if (this.recordingInputGain) this.recordingInputGain.gain.value = enabled && !this.disposed ? 1 : 0;
  }

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
    if (this.recordingDestination && this.recorder?.state === 'recording') source.connect(this.recordingDestination);
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
    if (this.disposed) return;
    this.disposed = true;
    const recording = this.stopRecording();
    if (this.drainTimer) window.clearTimeout(this.drainTimer);
    this.setInputEnabled(false);
    this.stream?.getTracks().forEach(track => track.stop());
    this.input?.disconnect();
    this.capture?.disconnect();
    this.capture?.port.close();
    this.silent?.disconnect();
    this.clearPlayback();
    // Release the real microphone immediately. Keep only the isolated mix graph
    // alive until MediaRecorder has emitted its final buffered audio.
    void recording.finally(() => {
      if (this.context.state !== 'closed') void this.context.close().catch(() => {});
    });
  }
}
