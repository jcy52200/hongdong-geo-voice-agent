import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { SiphonMediaAdapter, SIPHON_DRAIN_PROTOCOL } from '../media/siphon.js';

interface Ticket {
  callId: string;
  resolve: (media: SiphonMediaAdapter) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  adapter?: SiphonMediaAdapter;
}

/** Private media listener. Every URL is a single-use, expiring call-bound capability. */
export class TelephoneMediaServer {
  private server = createServer((_req, res) => { res.writeHead(404); res.end(); });
  private wss = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024, perMessageDeflate: false });
  private tickets = new Map<string, Ticket>();
  private pending = new Set<Ticket>();
  private media = new Set<SiphonMediaAdapter>();
  private baseUrl?: string;
  constructor() {
    this.server.on('upgrade', (request, socket, head) => {
      const path = new URL(request.url ?? '/', 'http://localhost').pathname;
      const ticket = this.tickets.get(path);
      if (!ticket) { socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); socket.destroy(); return; }
      this.tickets.delete(path);
      this.wss.handleUpgrade(request, socket, head, ws => {
        const adapter = new SiphonMediaAdapter(ws, { expectedCallId: ticket.callId, verifiedDrainProtocol: SIPHON_DRAIN_PROTOCOL });
        ticket.adapter = adapter;
        this.media.add(adapter);
        ws.once('close', () => this.media.delete(adapter));
        void adapter.ready.then(() => {
          if (!this.pending.delete(ticket)) { adapter.close(); return; }
          clearTimeout(ticket.timer); ticket.resolve(adapter);
        }, error => { this.pending.delete(ticket); clearTimeout(ticket.timer); adapter.close(); ticket.reject(error); });
      });
    });
  }
  async listen(port: number, advertisedBaseUrl?: string) {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, '127.0.0.1', () => { this.server.off('error', reject); resolve(); });
    });
    const address = this.server.address() as { port: number };
    this.baseUrl = advertisedBaseUrl ?? `ws://127.0.0.1:${address.port}`;
    const url = new URL(this.baseUrl);
    if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.search || url.pathname !== '/') {
      await this.close(); throw new Error('媒体服务公告地址格式无效');
    }
    this.baseUrl = this.baseUrl.replace(/\/$/, '');
  }
  authorize(sessionId: string, sipCallId: string, timeoutMs = 15000) {
    if (!this.baseUrl || !sipCallId) throw new Error('电话媒体服务尚未启动或缺少关联标识');
    const path = `/media/siphon/${sessionId}/${randomBytes(32).toString('base64url')}`;
    let ticket!: Ticket;
    const ready = new Promise<SiphonMediaAdapter>((resolve, reject) => {
      const timer = setTimeout(() => { this.tickets.delete(path); this.pending.delete(ticket); ticket.adapter?.close(); reject(new Error('电话媒体未在时限内就绪')); }, timeoutMs);
      timer.unref(); ticket = { callId: sipCallId, resolve, reject, timer };
    });
    void ready.catch(() => {});
    this.tickets.set(path, ticket);
    this.pending.add(ticket);
    return { uri: `${this.baseUrl}${path}`, ready, cancel: () => {
      this.tickets.delete(path); this.pending.delete(ticket);
      clearTimeout(ticket.timer); ticket.adapter?.close(); ticket.reject(new Error('电话媒体授权已取消'));
    } };
  }
  async close() {
    for (const ticket of this.pending) { clearTimeout(ticket.timer); ticket.adapter?.close(); ticket.reject(new Error('电话媒体服务已停止')); }
    this.tickets.clear();
    this.pending.clear();
    for (const media of this.media) media.close();
    for (const socket of this.wss.clients) socket.terminate();
    this.wss.close();
    if (this.server.listening) await new Promise<void>(resolve => this.server.close(() => resolve()));
    this.baseUrl = undefined;
  }
}
