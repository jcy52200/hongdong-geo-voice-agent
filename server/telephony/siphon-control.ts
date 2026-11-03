import { ControlClient, type EventFrame } from '@siphon-project/control';

export interface GatewayControl {
  onEvent(listener: (event: EventFrame) => void): () => void;
  command(channel: string, verb: string, args?: Record<string, unknown>): Promise<Record<string, unknown>>;
  registrations(): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}

/** Official SDK handles handshake, correlation and reconnection; no raw SIP in Node. */
export class SiphonControl implements GatewayControl {
  private listeners = new Set<(event: EventFrame) => void>();
  private running?: Promise<void>;
  private healthTimer?: ReturnType<typeof setTimeout>;
  private healthTask?: Promise<void>;
  private closed = false;
  private constructor(private client: ControlClient) {
    client.onEvent(event => {
      if (event.type === 'event') this.emit(event.frame);
      // Reattachment is deliberately not automatic call recovery in this pilot.
      else this.emit({ type: 'event', event: 'PilotControlReattached', channel: event.snapshot.channel });
    });
    this.running = client.run().catch(() => this.emit({ type: 'event', event: 'PilotControlFailed' }));
    this.checkHealth();
  }
  private checkHealth() {
    if (this.closed) return;
    this.healthTimer = setTimeout(() => {
      this.healthTask = this.client.describe().then(() => {}, () => {
        if (!this.closed) this.emit({ type: 'event', event: 'PilotControlFailed' });
      }).finally(() => { this.healthTask = undefined; this.checkHealth(); });
    }, 2000);
    this.healthTimer.unref();
  }
  static async connect(options: { url: string; token: string; app?: string }): Promise<SiphonControl> {
    const url = new URL(options.url);
    if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.search || !options.token) throw new Error('电话网关控制配置无效');
    try {
      return new SiphonControl(await ControlClient.connect({ ...options, app: options.app ?? 'hongdong-pilot', replyTimeoutMs: 5000 }));
    } catch { throw new Error('无法连接或鉴权电话网关控制服务'); }
  }
  private emit(event: EventFrame) { for (const listener of [...this.listeners]) { try { listener(event); } catch { /* A consumer cannot crash the SDK reader. */ } } }
  onEvent(listener: (event: EventFrame) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  async command(channel: string, verb: string, args: Record<string, unknown> = {}) {
    try {
      const result = await this.client.command('sip', verb, { channel }, args);
      return result && typeof result === 'object' ? result as Record<string, unknown> : {};
    } catch { throw new Error(`电话网关 ${verb} 未确认；请核对资源状态`); }
  }
  async registrations() {
    try {
      // This is a substrate verb (no module/target), as in SipClient.everyPage.
      const whole = await this.client.command(null, 'outbound_registrations', null, null) as Record<string, unknown>;
      if (!Array.isArray(whole.registrations)) throw new Error('Invalid registrations');
      let after = whole.next ?? null;
      for (let pageIndex = 0; after !== null; pageIndex++) {
        if (typeof after !== 'string' || pageIndex >= 100) throw new Error('Invalid pagination');
        const page = await this.client.command(null, 'outbound_registrations', null, { after }) as Record<string, unknown>;
        if (!Array.isArray(page.registrations)) throw new Error('Invalid registrations');
        whole.registrations.push(...page.registrations);
        const next = page.next ?? null;
        if (next !== null && (typeof next !== 'string' || next <= after)) throw new Error('Invalid pagination');
        after = next;
      }
      whole.next = null; return whole;
    }
    catch { throw new Error('无法读取电话网关注册状态'); }
  }
  async close() {
    this.closed = true; clearTimeout(this.healthTimer);
    this.client.shutdown();
    await Promise.allSettled([this.running, this.healthTask]); this.listeners.clear();
  }
}
