import WebSocket from 'ws';
import { z } from 'zod';
import type { SessionEvent } from '../../shared/session.js';
import type { MediaInput, MediaPort, PlaybackSegment } from './port.js';

const clientSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string().trim().min(1).max(2000) }),
  z.object({ type: z.literal('audio'), audio: z.string().max(900) }),
  z.object({ type: z.literal('playback_done'), playbackId: z.string().max(100).optional() }),
  z.object({ type: z.literal('mute'), muted: z.boolean() }),
  z.object({ type: z.literal('finish') }),
]);

/** Keeps the existing browser JSON/Base64 protocol outside the voice core. */
export class BrowserMediaAdapter implements MediaPort {
  readonly capabilities = { canConfirmPlaybackDrain: true };
  private listeners = new Set<(event: MediaInput) => void>();
  private completedPlaybackId?: string;
  private closed = false;
  private outputFailed = false;

  constructor(private socket: WebSocket) {
    socket.on('message', this.message);
    socket.on('error', this.error);
    socket.on('close', this.disconnected);
  }

  onEvent(handler: (event: MediaInput) => void) {
    this.listeners.add(handler);
    return () => { this.listeners.delete(handler); };
  }
  private emit(event: MediaInput) { for (const listener of this.listeners) listener(event); }
  private error = () => { if (!this.closed) this.emit({ type: 'error', message: '浏览器连接异常，会话已结束' }); };
  private disconnected = () => {
    if (!this.closed) this.emit({ type: 'error', message: '浏览器已断开，会话已结束' });
    this.dispose();
  };
  private message = (data: WebSocket.RawData, binary: boolean) => {
    if (this.closed) return;
    try {
      if (binary) throw new Error('只接受 JSON 文本消息');
      const result = clientSchema.safeParse(JSON.parse(data.toString()));
      if (!result.success) throw new Error('消息格式错误');
      const event = result.data;
      if (event.type === 'audio') {
        if (!/^[A-Za-z0-9+/]+={0,2}$/.test(event.audio) || Buffer.from(event.audio, 'base64').length !== 640) {
          throw new Error('上行音频每帧需为16kHz单声道PCM16、20ms/640字节');
        }
        this.emit({ type: 'audio', audio: Buffer.from(event.audio, 'base64') });
      } else if (event.type === 'playback_done') {
        // Older local clients omit the token. Only this browser adapter maps
        // that legacy acknowledgement, and only after output generation ended.
        const playbackId = event.playbackId ?? this.completedPlaybackId;
        if (playbackId) this.emit({ type: 'playback_drained', playbackId });
      } else this.emit(event);
    } catch (error) {
      this.send({ type: 'error', message: error instanceof Error ? error.message : '无法处理消息' });
    }
  };
  private send(event: object) {
    if (this.closed || this.socket.readyState !== WebSocket.OPEN || this.socket.bufferedAmount > 2 * 1024 * 1024) return false;
    try { this.socket.send(JSON.stringify(event)); return true; } catch { return false; }
  }
  sendEvent(event: SessionEvent) {
    if (!this.send(event) && !this.closed && !this.outputFailed) {
      this.outputFailed = true;
      queueMicrotask(() => { if (!this.closed) this.emit({ type: 'error', message: '播放端连接异常或音频积压，测试已结束' }); });
    }
  }
  writeAudio(pcm: Buffer, _segment: PlaybackSegment) {
    return this.send({ type: 'audio', audio: pcm.toString('base64'), rate: 24000 });
  }
  completePlayback(segment: PlaybackSegment) {
    this.completedPlaybackId = segment.id;
    return this.send({ type: 'audio_done', opening: segment.opening, playbackId: segment.id });
  }
  clearPlayback() {
    this.completedPlaybackId = undefined;
    return this.send({ type: 'interrupted' });
  }
  private dispose() {
    this.closed = true;
    this.listeners.clear();
    this.socket.off('message', this.message);
    // Keep the error handler until the socket has closed: ws may still emit
    // an error during its close handshake.
    if (this.socket.readyState === WebSocket.CLOSED) {
      this.socket.off('error', this.error);
      this.socket.off('close', this.disconnected);
    }
  }
  close() { this.dispose(); this.socket.close(1000); }
}
