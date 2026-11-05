import { randomUUID } from 'node:crypto';
import { basename, join, posix } from 'node:path';
import type { EventFrame } from '@siphon-project/control';
import type { GatewayControl } from './siphon-control.js';
import type { TelephoneMediaServer } from './media-server.js';
import type { VoiceSessionManager } from '../voice/session.js';
import type { Store } from '../store.js';
import type { Recordings } from '../recordings.js';
import type { Session } from '../../shared/session.js';
import type { TrunkConfig } from './trunk-config.js';
import { readRecordingClosure } from './recording-closure.js';

type TrunkGateway = GatewayControl & { originate(args: Record<string, unknown>): Promise<Record<string, unknown>> };
/** Engineering single-call driver, IP-authenticated UDP, late offer only. No CCC API or batch scheduling. */
export class TrunkPilot {
  private channel = randomUUID();
  private active?: { id: string; sipId?: string; answered: boolean; ended: boolean; recordingId?: string; recordingReceived: boolean; recordingFinalized?: boolean; earlyRecording?: EventFrame };
  private disposed = false;
  private stopping = false;
  private ending?: Promise<Session>;
  private originating?: Promise<Record<string, unknown>>;
  private ticket?: ReturnType<TelephoneMediaServer['authorize']>;
  private timer?: ReturnType<typeof setTimeout>;
  private offVoice?: () => void;
  private offGateway: () => void;
  private tasks = new Set<Promise<void>>();
  private resolveFinished!: (session: Session) => void;
  private rejectFinished!: (error: unknown) => void;
  readonly finished = new Promise<Session>((resolve, reject) => { this.resolveFinished = resolve; this.rejectFinished = reject; });
  constructor(private store: Store, private voice: VoiceSessionManager, private gateway: TrunkGateway,
    private media: Pick<TelephoneMediaServer, 'authorize'>, private recordings: Recordings, private config: TrunkConfig) {
    void this.finished.catch(() => {});
    this.offGateway = gateway.onEvent(event => {
      const task = this.event(event).catch(() => { void this.stop('gateway_error', true).catch(() => {}); });
      this.tasks.add(task); void task.finally(() => this.tasks.delete(task));
    });
  }
  async start(customerId: string) {
    if (this.disposed || this.active) throw new Error('本工程测试已使用，不能重复拨号');
    const customer = this.store.customer(customerId);
    const national = (value: string) => value.replace(/^(?:\+86|0086)/, '').replace(/[\s()-]/g, '');
    if (!customer || national(customer.phone) !== national(this.config.testPhone)) throw new Error('只允许固定测试手机');
    const unresolved = this.store.db.prepare("SELECT id FROM sessions WHERE transport='sip' AND (status IN ('created','connecting','opening','active') OR json_extract(telephone,'$.state')='unknown' OR json_extract(telephone,'$.cleanupStatus') IN ('pending','unknown')) LIMIT 1").get();
    if (unresolved) throw new Error('有活动或未知电话资源，先核对再拨号');
    const session = this.store.createTrunkSession(customer);
    this.active = { id: session.id, answered: false, ended: false, recordingReceived: false };
    this.offVoice = this.voice.observe(session.id, event => {
      if (event.type === 'state' && ['completed', 'failed'].includes(event.status) && !this.stopping) void this.stop('voice_ended', event.status === 'failed').catch(() => {});
    });
    try {
      this.store.updateTelephone(session.id, { channelId: this.channel, state: 'dialing', cleanupStatus: 'pending' });
      // Siphon returns as soon as INVITE is sent, never waits for the phone to answer.
      this.originating = this.gateway.originate({ channel: this.channel, to: this.config.to, from: this.config.from,
        next_hop: `sip:${this.config.host}:${this.config.port};transport=udp`, headers: this.config.headers,
        media: true, profile: 'hongdong_voice', timeout: 60, on_lost: 'hangup',
        media_flags: { ws_barge_in: false, ws_sample_rate: 16000 } });
      const result = await this.originating;
      if (result.channel !== this.channel || typeof result.sip_call_id !== 'string' || !result.sip_call_id) throw new Error('missing correlation');
      this.active.sipId = result.sip_call_id;
      this.store.updateTelephone(session.id, { sipCallId: result.sip_call_id });
      if (this.stopping) return await this.ending!;
      this.timer = setTimeout(() => { void this.stop('call_timeout', true).catch(() => {}); }, 10 * 60 * 1000);
      this.timer.unref();
      return this.store.session(session.id)!;
    } catch {
      try { this.store.updateTelephone(session.id, { state: 'unknown', endedReason: 'originate_unconfirmed' }); } catch { /* Cleanup remains independent. */ }
      await this.stop('originate_unconfirmed', true).catch(() => {});
      throw new Error('SIP外呼结果未确认，已尝试按预分配通道挂断；核对前禁止重拨');
    }
  }
  private async event(event: EventFrame) {
    const active = this.active;
    if (!active || this.disposed) return;
    if (['PilotControlFailed', 'PilotControlReattached'].includes(event.event)) { await this.stop('control_lost', true); return; }
    if (event.channel !== this.channel) return;
    // Very fast SIP answers can overtake the originate acknowledgement.
    if (!active.sipId && this.originating) await this.originating;
    if (!active.sipId || (event.sip_call_id && event.sip_call_id !== active.sipId)) return;
    const data = event.payload as Record<string, unknown> | undefined;
    if (event.event === 'StasisEnd') {
      active.ended = true;
      const code = Number(data?.code);
      if (!active.answered && [408, 480, 486, 603].includes(code)) this.store.updateTelephone(active.id, { state: code === 486 ? 'busy' : code === 603 ? 'rejected' : 'no_answer' });
      if (this.stopping) this.store.updateTelephone(active.id, { cleanupStatus: 'confirmed' });
      else await this.stop('sip_hangup', Number(data?.code ?? 200) >= 500);
      return;
    }
    if (event.event === 'RecordingFinished' && data && !active.recordingId && typeof data.path === 'string' && basename(data.path) === `${active.id}.wav`) { active.earlyRecording = event; return; }
    if (event.event === 'RecordingFinished' && data && active.recordingId && data.recording_id === active.recordingId && !active.recordingReceived) {
      active.recordingReceived = true;
      try {
        if (typeof data.path !== 'string' || basename(data.path) !== `${active.id}.wav`) throw new Error('wrong recording');
        const recording = await this.recordings.importGatewayWav(active.id, join(this.config.recordingRoot, `${active.id}.wav`), this.config.recordingRoot,
          { incomplete: !['stopped', 'call_ended', 'max_duration'].includes(String(data.reason)) });
        if (!this.disposed) { this.store.saveRecording(active.id, recording); this.store.updateTelephone(active.id, { recordingStatus: 'ready' }); }
      } catch { if (!this.disposed) this.store.updateTelephone(active.id, { recordingStatus: 'failed' }); }
      finally { active.recordingFinalized = true; }
      return;
    }
    if (this.stopping) return;
    if (event.event === 'WsBridgeEnded') { await this.stop('media_bridge_lost', true); return; }
    if (event.event !== 'ChannelStateChange') return;
    if (data?.state === 'ringing' || data?.state === 'progress') this.store.updateTelephone(active.id, { state: 'ringing' });
    if (data?.state !== 'answered' || event.sip_call_id !== active.sipId || active.answered) return;
    active.answered = true;
    if (!this.store.trunkAnswered(active.id, { channelId: this.channel, sipCallId: active.sipId })) throw new Error('unmatched answer');
    this.ticket = this.media.authorize(active.id, active.sipId);
    const recorded = await this.gateway.command(this.channel, 'record_start', { direction: 'both', channels: 'stereo', format: 'wav',
      path: posix.join(this.config.gatewayRecordingRoot, `${active.id}.wav`), max_duration_ms: 600000 });
    if (typeof recorded.recording_id !== 'string') throw new Error('recording not confirmed');
    active.recordingId = recorded.recording_id;
    if (active.earlyRecording) { const early = active.earlyRecording; active.earlyRecording = undefined; await this.event(early); }
    this.store.updateTelephone(active.id, { recordingStatus: 'recording' });
    if (this.stopping) return;
    await this.gateway.command(this.channel, 'stream_start', { ws_uri: this.ticket.uri, mode: 'bridge', profile: 'hongdong_voice',
      media_flags: { ws_barge_in: false, ws_sample_rate: 16000 } });
    const media = await this.ticket.ready;
    if (this.stopping) { media.close(); return; }
    this.voice.attachMedia(active.id, media);
    this.voice.notifyTelephoneAnswered(active.id);
  }
  stop(reason = 'operator_end', failed = false): Promise<Session> {
    if (this.ending) return this.ending;
    const active = this.active;
    if (!active) return Promise.reject(new Error('没有本次工程测试电话'));
    this.stopping = true;
    this.ending = (async () => {
      clearTimeout(this.timer); this.ticket?.cancel();
      const errors: unknown[] = [];
      const attempt = (fn: () => unknown) => { try { return fn(); } catch (e) { errors.push(e); } };
      if (this.originating && !active.sipId) await this.originating.catch(() => {});
      attempt(() => this.store.updateTelephone(active.id, { state: failed ? 'failed' : 'ended', endedReason: reason }));
      attempt(() => {
        if (this.voice.runtime(active.id).active) {
          if (failed) this.voice.fail(active.id, 'SIP直连异常，工程测试结束', reason); else this.voice.finish(active.id, reason);
        } else this.store.status(active.id, failed ? 'failed' : 'completed', failed ? 'SIP直连测试失败' : undefined, reason);
      });
      const actions = [];
      if (!active.ended && active.recordingId && !active.recordingReceived) actions.push(this.gateway.command(this.channel, 'record_stop', { recording_id: active.recordingId }));
      if (!active.ended) actions.push(this.gateway.command(this.channel, 'hangup', { reason }));
      const results = await Promise.allSettled(actions);
      // A command acknowledgement is not a BYE completion. Wait briefly for the terminal event/file close.
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && (!active.ended || (active.recordingId && !active.recordingFinalized))) {
        if (active.recordingId && active.sipId && !active.recordingReceived) {
          const receipt = await readRecordingClosure(this.config.recordingRoot, active.id, active.sipId, active.recordingId);
          if (receipt) await this.event({ type: 'event', event: 'RecordingFinished', channel: this.channel, sip_call_id: active.sipId, payload: receipt });
        }
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      // A correlated terminal SIP event resolves a racing 'channel gone'
      // reply; without that evidence, rejected cleanup remains an error.
      if (!active.ended) for (const result of results) if (result.status === 'rejected') errors.push(result.reason);
      attempt(() => this.store.updateTelephone(active.id, { cleanupStatus: active.ended && !errors.length ? 'confirmed' : 'unknown',
        ...(!active.recordingReceived ? { recordingStatus: 'failed' as const } : {}) }));
      this.offVoice?.();
      if (errors.length) throw new AggregateError(errors, '已尝试挂断，部分资源未确认，请核对SIP通道');
      return this.store.session(active.id)!;
    })();
    void this.ending.then(this.resolveFinished, this.rejectFinished);
    return this.ending;
  }
  async close() {
    try { if (this.active) await this.stop('service_shutdown'); }
    finally { this.offGateway(); await Promise.allSettled([...this.tasks]); this.disposed = true; }
  }
}
