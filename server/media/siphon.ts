import WebSocket from 'ws';
import type { MediaInput, MediaPort, PlaybackSegment } from './port.js';
import { Pcm16Framer, StreamingPcm16Resampler } from './pcm.js';

/** Custom, patched gateway capability; this is NOT promised by upstream Siphon. */
export const SIPHON_DRAIN_PROTOCOL = 'hongdong-playout-v1';
export const SIPHON_DRAIN_SCOPE = 'successful_udp_egress_plus_ptime';

export interface SiphonMediaOptions {
  expectedCallId: string;
  expectedStreamId?: string;
  /** Deployment must verify/pin the patched binary in addition to its handshake. */
  verifiedDrainProtocol: string;
  maxOutputFrames?: number;
  maxInputFrames?: number;
  handshakeTimeoutMs?: number;
}

interface SegmentState {
  segment: PlaybackSegment;
  resampler: StreamingPcm16Resampler;
  framer: Pcm16Framer;
  completed: boolean;
  stopSent: boolean;
  started?: boolean;
  firstAudioSent?: boolean;
}
type Output = { type: 'control'; value: object } | { type: 'audio'; pcm: Buffer; playId: string };

/**
 * Siphon is the WS CLIENT; this adapter wraps its authenticated server socket.
 * Native type/data envelopes and little-endian L16 are preserved. A capability
 * handshake plus an operator-verified patched binary is mandatory for drain.
 * A successful drain is RTP UDP egress + ptime, never proof a handset heard it.
 */
export class SiphonMediaAdapter implements MediaPort {
  readonly capabilities = { canConfirmPlaybackDrain: false };
  readonly ready: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;
  private listeners = new Set<(event: MediaInput) => void>();
  private streamId?: string;
  private closed = false;
  private input: Buffer[] = [];
  private output: Output[] = [];
  private outputFrames = 0;
  private segments = new Map<string, SegmentState>();
  private retiredPlaybackIds = new Set<string>();
  private writingSegment?: string;
  private clock?: ReturnType<typeof setInterval>;
  private handshakeTimer: ReturnType<typeof setTimeout>;
  private readonly maxOutputFrames: number;
  private readonly maxInputFrames: number;

  constructor(private socket: WebSocket, private options: SiphonMediaOptions) {
    this.maxOutputFrames = this.bound(options.maxOutputFrames, 500, 1, 3000);
    this.maxInputFrames = this.bound(options.maxInputFrames, 32, 1, 100);
    this.ready = new Promise<void>((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
    // A caller may subscribe after construction; rejected handshakes remain
    // observable through ready without an unhandled rejection in the meantime.
    void this.ready.catch(() => {});
    this.handshakeTimer = setTimeout(() => this.fail('电话媒体握手超时'), options.handshakeTimeoutMs ?? 5000);
    this.handshakeTimer.unref();
    socket.on('message', this.message);
    socket.on('error', this.socketError);
    socket.on('close', this.socketClose);
  }

  private bound(value: number | undefined, fallback: number, min: number, max: number) {
    const result = value ?? fallback;
    if (!Number.isInteger(result) || result < min || result > max) throw new Error('Invalid bounded media queue size');
    return result;
  }

  onEvent(handler: (event: MediaInput) => void) {
    this.listeners.add(handler);
    return () => { this.listeners.delete(handler); };
  }

  private emit(event: MediaInput) {
    for (const listener of [...this.listeners]) {
      try { listener(event); } catch { /* Consumer failure cannot strand the gateway transport. */ }
    }
  }
  private socketError = () => { this.fail('电话媒体连接异常'); };
  private socketClose = () => {
    if (this.closed) return;
    this.rejectReady(new Error('电话媒体连接已关闭'));
    this.emit({ type: 'close' });
    this.dispose();
  };

  private message = (raw: WebSocket.RawData, binary: boolean) => {
    if (this.closed) return;
    try {
      if (binary) {
        if (!this.streamId) throw new Error('电话媒体尚未完成握手');
        const audio = Buffer.isBuffer(raw) ? raw : raw instanceof ArrayBuffer ? Buffer.from(raw) : Buffer.concat(raw);
        if (audio.length !== 640) throw new Error('电话上行必须为16kHz单声道PCM16、20ms/640字节');
        if (this.input.length >= this.maxInputFrames) throw new Error('电话上行音频积压，已结束会话');
        this.input.push(Buffer.from(audio));
        return;
      }
      if (raw.toString().length > 16 * 1024) throw new Error('电话媒体控制消息过大');
      const message = JSON.parse(raw.toString()) as { type?: string; data?: Record<string, unknown> };
      if (typeof message !== 'object' || !message || typeof message.type !== 'string' || !message.data || typeof message.data !== 'object') throw new Error('电话媒体控制消息格式错误');
      const data = message.data;
      if (!this.streamId) {
        if (message.type !== 'start') throw new Error('电话媒体首条消息必须是start');
        this.start(data);
        return;
      }
      if (data.streamId !== this.streamId) throw new Error('电话媒体streamId不匹配');
      if (message.type === 'mark') {
        const playId = typeof data.playId === 'string' ? data.playId : '';
        const segment = this.segments.get(playId);
        if (data.name === 'playing' && segment?.firstAudioSent && !segment.started) {
          segment.started = true;
          this.emit({ type: 'playback_started', playbackId: playId });
        }
        // cleared is cancellation, not playback. Ignore stale, guessed,
        // duplicate and premature marks even from an authenticated gateway.
        if (data.name === 'played' && segment?.completed && segment.stopSent) {
          this.segments.delete(playId);
          this.retiredPlaybackIds.add(playId);
          // Uplink captured during the protected greeting must not be replayed
          // into Seed just after unmute due to a network/event-loop backlog.
          if (segment.segment.opening) this.input = [];
          this.emit({ type: 'playback_drained', playbackId: playId });
        }
      } else if (message.type === 'media_renegotiate' || message.type === 'start') {
        throw new Error('测试通话不支持中途重协商媒体格式');
      } else if (message.type === 'stop') {
        // A bridge stopping is not evidence the customer hung up the SIP leg.
        this.fail('电话媒体桥已结束，需核对SIP电话状态');
      } else if (message.type === 'error') {
        // Upstream also labels lost PCM / rejected playback boundaries as
        // nonfatal. A single-call pilot cannot silently accept a damaged turn.
        throw new Error('电话网关报告媒体错误');
      }
      // DTMF/local VAD are informational. Seed controls post-greeting barge-in;
      // gateway auto-barge-in must remain disabled for the fixed opening.
    } catch (error) { this.fail(error instanceof Error ? error.message : '电话媒体消息处理失败'); }
  };

  private start(data: Record<string, unknown>) {
    const media = data.media as Record<string, unknown> | undefined;
    const metadata = data.metadata as Record<string, unknown> | undefined;
    if (typeof data.streamId !== 'string' || !data.streamId || data.streamId.length > 200 || data.callId !== this.options.expectedCallId ||
      (this.options.expectedStreamId && data.streamId !== this.options.expectedStreamId) || data.direction !== 'duplex') {
      throw new Error('电话媒体会话关联校验失败');
    }
    if (!media || media.encoding !== 'L16' || media.endianness !== 'little' || media.bitDepth !== 16 ||
      media.sampleRate !== 16000 || media.channels !== 1 || media.ptime !== 20) {
      throw new Error('电话媒体需协商为L16/little/16bit/16kHz/mono/20ms');
    }
    if (this.options.verifiedDrainProtocol !== SIPHON_DRAIN_PROTOCOL || metadata?.playbackDrainProtocol !== SIPHON_DRAIN_PROTOCOL || metadata?.playbackDrainScope !== SIPHON_DRAIN_SCOPE) {
      throw new Error('电话网关缺少已验证的首句播放排空能力，拒绝启动');
    }
    this.streamId = data.streamId;
    this.capabilities.canConfirmPlaybackDrain = true;
    clearTimeout(this.handshakeTimer);
    this.clock = setInterval(this.tick, 20);
    this.clock.unref();
    this.resolveReady();
  }

  private control(type: string, data: object) { return { type, data: { streamId: this.streamId, ...data } }; }
  private available() { return !this.closed && !!this.streamId && this.socket.readyState === WebSocket.OPEN; }
  private send(value: object | Buffer) {
    if (!this.available() || this.socket.bufferedAmount > 64 * 1024) return false;
    try {
      this.socket.send(Buffer.isBuffer(value) ? value : JSON.stringify(value), error => { if (error && !this.closed) this.fail('电话媒体发送失败'); });
      return true;
    } catch { return false; }
  }

  private tick = () => {
    if (!this.available()) { this.fail('电话媒体连接已不可用'); return; }
    const inbound = this.input.shift();
    if (inbound) this.emit({ type: 'audio', audio: inbound });
    if (this.closed) return;
    let audioSent = false;
    while (this.output.length) {
      const next = this.output[0];
      if (next.type === 'audio' && audioSent) break;
      this.output.shift();
      if (next.type === 'audio') { this.outputFrames--; audioSent = true; }
      if (!this.send(next.type === 'audio' ? next.pcm : next.value)) { this.fail('电话下行连接异常或音频积压'); return; }
      if (next.type === 'audio') {
        const segment = this.segments.get(next.playId);
        if (segment) segment.firstAudioSent = true;
      }
      if (next.type === 'control') {
        const control = next.value as { type: string; data: { playId?: string } };
        if (control.type === 'play_stop' && control.data.playId) {
          const segment = this.segments.get(control.data.playId);
          if (segment) segment.stopSent = true;
        }
      }
    }
  };

  private enqueue(frames: Buffer[], playId: string) {
    if (this.outputFrames + frames.length > this.maxOutputFrames) return false;
    for (const pcm of frames) this.output.push({ type: 'audio', pcm, playId });
    this.outputFrames += frames.length;
    return true;
  }

  writeAudio(pcm: Buffer, segment: PlaybackSegment) {
    if (!this.available() || !segment.id || segment.id.length > 200 || pcm.length % 2 || pcm.length > this.maxOutputFrames * 960) return false;
    let state = this.segments.get(segment.id);
    if (!state) {
      // Late chunks from a cancelled/finished generation must not resurrect it.
      // Bound the tombstones too; a very long call fails closed at this limit.
      if (this.writingSegment || this.segments.size >= 8 || this.retiredPlaybackIds.has(segment.id) || this.retiredPlaybackIds.size >= 4096) return false;
      state = { segment: { ...segment }, resampler: new StreamingPcm16Resampler(), framer: new Pcm16Framer(), completed: false, stopSent: false };
      this.segments.set(segment.id, state);
      this.writingSegment = segment.id;
      this.output.push({ type: 'control', value: this.control('play_start', { playId: segment.id, source: 'binary', interruptible: !segment.opening, markName: 'played' }) });
    }
    if (state.completed || this.writingSegment !== segment.id) return false;
    return this.enqueue(state.framer.push(state.resampler.push(pcm)), segment.id);
  }

  completePlayback(segment: PlaybackSegment) {
    if (!this.available()) return false;
    let state = this.segments.get(segment.id);
    // A zero-audio response still needs an explicit ordered playback boundary.
    if (!state) {
      if (!this.writeAudio(Buffer.alloc(0), segment)) return false;
      state = this.segments.get(segment.id)!;
    }
    if (state.completed || this.writingSegment !== segment.id) return false;
    if (!this.enqueue([...state.framer.push(state.resampler.flush()), ...state.framer.finish()], segment.id)) return false;
    state.completed = true;
    this.writingSegment = undefined;
    this.output.push({ type: 'control', value: this.control('play_stop', { playId: segment.id }) });
    return true;
  }

  clearPlayback() {
    if (!this.available() || [...this.segments.values()].some(state => state.segment.opening)) return false;
    this.output = [];
    this.outputFrames = 0;
    for (const id of this.segments.keys()) this.retiredPlaybackIds.add(id);
    this.segments.clear();
    this.writingSegment = undefined;
    return this.send(this.control('clear', { reason: 'barge_in' }));
  }

  private fail(message: string) {
    if (this.closed) return;
    this.rejectReady(new Error(message));
    this.emit({ type: 'error', message });
    this.dispose();
    this.socket.close(1008, 'Invalid or unavailable media');
  }

  private dispose() {
    this.closed = true;
    this.capabilities.canConfirmPlaybackDrain = false;
    clearTimeout(this.handshakeTimer);
    if (this.clock) clearInterval(this.clock);
    this.input = [];
    this.output = [];
    this.segments.clear();
    this.retiredPlaybackIds.clear();
    this.listeners.clear();
    this.socket.off('message', this.message);
    // Retain the error listener through the WS close handshake.
  }

  close() {
    if (this.closed) return;
    this.rejectReady(new Error('电话媒体会话已结束'));
    if (this.available()) this.send(this.control('stop', { reason: 'call_ended' }));
    this.dispose();
    this.socket.close(1000);
  }
}
