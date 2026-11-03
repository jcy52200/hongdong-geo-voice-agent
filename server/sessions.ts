import WebSocket from 'ws';
import { Store } from './store.js';
import { BrowserMediaAdapter } from './media/browser.js';
import { ControlError, VoiceSessionManager } from './voice/session.js';

export { ControlError } from './voice/session.js';

/** Compatibility entry point for the local browser media protocol. */
export class SessionManager extends VoiceSessionManager {
  constructor(private browserStore: Store, private apiKey: string, seedUrl?: string, webSearchKey = '') {
    super(browserStore, apiKey, seedUrl, webSearchKey);
  }
  attach(id: string, client: WebSocket) {
    const session = this.browserStore.session(id);
    let error = '';
    if (!session || session.status !== 'created' || this.runtime(id).active) error = '该会话不存在或已经连接，请新建测试';
    else if (session.transport !== 'browser') {
      error = session.transport === 'sip' ? '真实电话不接受浏览器媒体连接，请使用只读观察入口' : '该演示接入已停用，请新建浏览器测试';
      if (session.transport === 'softphone_bridge') this.browserStore.status(id, 'failed', error);
    } else if (session.mode === 'seed' && !this.apiKey) {
      error = '请在服务端 .env 配置 SEED_API_KEY 后重启';
      this.browserStore.status(id, 'failed', '未配置 SEED_API_KEY');
    }
    if (error) {
      client.send(JSON.stringify({ type: 'error', message: error }));
      client.close(1008); return;
    }
    const media = new BrowserMediaAdapter(client);
    const unsubscribe = this.observe(id, event => media.sendEvent(event));
    client.once('close', unsubscribe);
    try { this.attachMedia(id, media); }
    catch (error) {
      unsubscribe();
      media.sendEvent({ type: 'error', message: error instanceof ControlError ? error.message : '无法建立语音会话' });
      media.close();
    }
  }
}
