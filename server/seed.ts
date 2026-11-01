import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import type { Session } from './types.js';

export const SEED_URL = 'wss://openspeech.bytedance.com/api/v3/duplex/realtime/dialogue';
export const SEED_MODEL = '1.2.6.1';
export interface SeedEvent { type: string; [key: string]: any }
export function createSeedSession(session: Pick<Session, 'id' | 'prompt' | 'configSnapshot'>, webSearchKey = '', update = false) {
  const options = session.configSnapshot.modelOptions ?? {};
  const asr = { ...options.asr };
  const tts = { ...options.tts };
  if (!tts.explicit_dialect) delete tts.explicit_dialect;
  const dialog = { ...options.dialog, extra: {
    ...(update ? { strict_audit: true, enable_volc_websearch: false, enable_user_query_exit: false } : {}),
    enable_loudness_norm: true, enable_music: false, ...options.dialog?.extra,
    ...(options.dialog?.extra?.enable_volc_websearch && webSearchKey ? { volc_websearch_api_key: webSearchKey } : {}),
  } };
  if (update) {
    asr.enable_asr_twopass ??= false;
    tts.max_length_to_filter_parenthesis ??= 0;
    // Initial QA belongs to session.create. Runtime context has explicit CRUD controls.
    delete dialog.dialog_context;
  }
  return {
    type: update ? 'session.update' : 'session.create', event_id: randomUUID(),
    session: {
      id: session.id, model: SEED_MODEL, instructions: session.prompt,
      audio: {
        input: { format: { type: 'pcm', rate: 16000 } },
        output: { format: { type: 'pcm_s16le', rate: 24000 }, voice: session.configSnapshot.voice,
          speed: session.configSnapshot.speed, loudness: session.configSnapshot.loudness ?? 0 },
      },
      ...(options.tools !== undefined ? { tools: options.tools } : {}),
    },
    extension: {
      asr: { extra: asr }, tts: { extra: tts }, dialog,
    },
  };
}

// Transport only. Each call owns one peer; domain state lives in SessionManager.
export class SeedPeer {
  private socket: WebSocket;
  private closing = false;
  private timer?: ReturnType<typeof setTimeout>;
  constructor(session: Session, key: string, onEvent: (event: SeedEvent) => void,
    onFailure: (message: string) => void, url = SEED_URL, webSearchKey = '') {
    this.socket = new WebSocket(url, {
      headers: { 'X-Api-Key': key }, handshakeTimeout: 15000, maxPayload: 4 * 1024 * 1024,
      perMessageDeflate: false,
    });
    this.socket.on('open', () => this.send(createSeedSession(session, webSearchKey)));
    this.socket.on('message', (data, binary) => {
      if (this.closing) {
        if (!binary) {
          try { if (JSON.parse(data.toString()).type === 'session.closed') this.socket.close(); } catch { /* close timer owns teardown */ }
        }
        return;
      }
      try {
        if (binary) throw new Error('新版 SeedDuplex 应返回 JSON 文本帧');
        const event = JSON.parse(data.toString());
        if (typeof event.type !== 'string') throw new Error('缺少事件类型');
        onEvent(event);
      } catch { onFailure('SeedDuplex 返回了无法解析的协议消息'); }
    });
    this.socket.on('error', error => {
      if (this.closing) return;
      const status = error.message.match(/Unexpected server response: (\d{3})/)?.[1];
      const hints: Record<string, string> = {
        '401': 'API Key 鉴权失败，请核对服务端 .env 中的密钥并重启服务',
        '403': '服务拒绝访问，请核对 API Key 与 SeedDuplex 服务开通状态',
        '429': '请求或并发额度受限，请稍后重试并检查账号配额',
      };
      let detail = status && hints[status] ? `${hints[status]}（HTTP ${status}）` : error.message.split(key).join('[redacted]').slice(0, 240);
      if (webSearchKey) detail = detail.split(webSearchKey).join('[redacted]');
      onFailure(`SeedDuplex 连接失败：${detail}`);
    });
    this.socket.on('close', code => {
      clearTimeout(this.timer);
      if (!this.closing) onFailure(`SeedDuplex 连接已关闭（${code}），请新建测试`);
    });
  }
  send(event: Record<string, unknown>) {
    if (this.closing || this.socket.readyState !== WebSocket.OPEN) return;
    if (this.socket.bufferedAmount > 1024 * 1024) {
      this.socket.terminate();
      return;
    }
    this.socket.send(JSON.stringify({ event_id: randomUUID(), ...event }));
  }
  close() {
    if (this.closing) return;
    if (this.socket.readyState === WebSocket.OPEN) {
      this.send({ type: 'session.close' });
      this.closing = true;
      this.timer = setTimeout(() => this.socket.terminate(), 1500);
      this.timer.unref();
    } else {
      this.closing = true;
      this.socket.terminate();
    }
  }
}
