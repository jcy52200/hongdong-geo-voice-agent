import type { EventFrame } from '@siphon-project/control';
import { setTimeout as delay } from 'node:timers/promises';
import { basename, join, posix } from 'node:path';
import { normalizeCccCall, type CccData } from './aliyun.js';
import type { AliyunCccConfig } from './aliyun-config.js';
import type { GatewayControl } from './siphon-control.js';
import type { TelephoneMediaServer } from './media-server.js';
import type { VoiceSessionManager } from '../voice/session.js';
import type { Store } from '../store.js';
import type { Recordings } from '../recordings.js';
import type { Session, Telephone } from '../../shared/session.js';

export interface CccControl {
  makeCall(input: { callee: string }, signal?: AbortSignal): Promise<CccData>;
  pollUserStatus(signal?: AbortSignal): Promise<CccData>;
  releaseCall(input: { jobId: string }, signal?: AbortSignal): Promise<CccData>;
  listOutboundNumbersOfUser(input?: { pageNumber?: number; pageSize?: number }, signal?: AbortSignal): Promise<CccData>;
}
export interface PilotOptions {
  ccc: Pick<AliyunCccConfig, 'instanceId' | 'userId' | 'caller'>;
  extension: string;
  testPhone: string;
  recordingRoot: string;
  gatewayRecordingRoot: string;
  pollMs?: number;
  unknownTimeoutMs?: number;
  ringTimeoutMs?: number;
  recordingTimeoutMs?: number;
  /** Exceeds the supported CCC request timeout; tests may use a shorter bound. */
  cleanupTimeoutMs?: number;
}
const phoneKey = (phone: string) => phone.replace(/^(?:\+86|0086)/, '').replace(/[\s()-]/g, '');
const object = (value: unknown): Record<string, any> => value && typeof value === 'object' ? value as Record<string, any> : {};

/** Single, explicitly started engineering test. No queue, scheduling or automatic redial. */
export class TelephonePilot {
  private active?: { sessionId: string; channel?: string; sipCallId?: string; jobId?: string; recordingId?: string;
    sipEnded: boolean; ending: boolean; localClosed?: boolean; cleanupRequestsSucceeded?: boolean; earlyRecording?: EventFrame; unknownSince?: number; timer?: ReturnType<typeof setTimeout>; ticket?: ReturnType<TelephoneMediaServer['authorize']>;
    stop?: Promise<Session>; dialing?: Promise<CccData>; release?: Promise<CccData>; unsubscribe: () => void; controller: AbortController;
    recordingDone: Promise<void>; resolveRecording: () => void; recordingReceived: boolean; eventTasks: Set<Promise<void>> };
  private unsubscribeGateway: () => void;
  private disposed = false;
  private closing?: Promise<void>;
  private resolveFinished!: (session: Session) => void;
  private rejectFinished!: (error: unknown) => void;
  readonly finished = new Promise<Session>((resolve, reject) => { this.resolveFinished = resolve; this.rejectFinished = reject; });
  constructor(private store: Store, private voice: VoiceSessionManager, private api: CccControl,
    private gateway: GatewayControl, private media: Pick<TelephoneMediaServer, 'authorize'>,
    private recordings: Recordings, private options: PilotOptions) {
    void this.finished.catch(() => {});
    this.unsubscribeGateway = gateway.onEvent(event => {
      const active = this.active;
      const task = this.gatewayEvent(event).catch(() => { if (this.active) void this.stop('gateway_error', true).catch(() => {}); });
      active?.eventTasks.add(task); void task.finally(() => active?.eventTasks.delete(task));
    });
  }
  async start(customerId: string): Promise<Session> {
    if (this.disposed || this.active) throw new Error('单通测试已占用或已关闭，请先完成资源核对');
    const customer = this.store.customer(customerId);
    if (!customer || phoneKey(customer.phone) !== phoneKey(this.options.testPhone)) throw new Error('仅允许客户资料中与指定测试手机相同的号码');
    const orphan = this.store.db.prepare(`SELECT id FROM sessions WHERE transport='sip' AND (json_extract(telephone,'$.state')='unknown' OR json_extract(telephone,'$.cleanupStatus')='unknown') LIMIT 1`).get();
    if (orphan) throw new Error('存在资源状态未知的历史电话，请先在CCC与网关核实结束');
    const seat = await this.api.pollUserStatus();
    if (seat.CallContext?.JobId || seat.UserContext?.JobId) throw new Error('坐席当前存在通话，不能开始本次测试');
    if (seat.UserContext?.UserId !== this.options.ccc.userId || seat.UserContext?.InstanceId !== this.options.ccc.instanceId) throw new Error('坐席状态响应缺少可确认的归属');
    let authorized = false;
    for (let pageNumber = 1; pageNumber <= 10; pageNumber++) {
      const page = await this.api.listOutboundNumbersOfUser({ pageNumber, pageSize: 100 });
      if (page.List?.some(number => number.Number === this.options.ccc.caller)) { authorized = true; break; }
      if (!page.List?.length || page.List.length < 100) break;
    }
    if (!authorized) throw new Error('配置主叫未在该坐席可外呼号码列表中精确匹配，未发起呼叫');
    // This guard is a fixed single-test limit, not a business resource scheduler.
    if (this.disposed || this.active) throw new Error('单通测试已占用或已关闭');
    const session = this.store.createTelephoneSession(customer);
    let resolveRecording!: () => void;
    const recordingDone = new Promise<void>(resolve => { resolveRecording = resolve; });
    const active: NonNullable<TelephonePilot['active']> = this.active = { sessionId: session.id, sipEnded: false, ending: false, unsubscribe: () => {}, controller: new AbortController(),
      recordingDone, resolveRecording, recordingReceived: false, eventTasks: new Set() };
    active.unsubscribe = this.voice.observe(session.id, event => {
      if (event.type === 'state' && ['completed', 'failed'].includes(event.status) && !active.ending) {
        queueMicrotask(() => { if (this.active === active && !active.ending) void this.stop(event.status === 'failed' ? 'voice_error' : 'operator_end', event.status === 'failed').catch(() => {}); });
      }
    });
    this.store.updateTelephone(session.id, { state: 'dialing' });
    try {
      active.dialing = this.api.makeCall({ callee: phoneKey(customer.phone) });
      const result = await active.dialing;
      const jobId = result.CallContext?.JobId;
      if (!jobId) throw new Error('未确认CCC通话ID，禁止重试');
      active.jobId = jobId;
      // A bounded shutdown must never be followed by a late write into the
      // already-closed SQLite store. A late confirmed external job still gets
      // one independent release attempt, without resuming model/media work.
      if (active.localClosed) {
        await this.bounded(this.release(active), '迟到CCC通话释放超时');
        throw new Error('迟到拨号结果已尝试释放，请人工核对');
      }
      this.store.updateTelephone(session.id, { jobId });
      this.store.event(session.id, 'telephone.dial_requested', { jobId, receivedAt: new Date().toISOString() });
      if (active.ending) {
        return await active.stop!;
      }
      void this.poll(active);
      active.timer = setTimeout(() => { void this.stop('ring_timeout', false, 'no_answer').catch(() => {}); }, this.options.ringTimeoutMs ?? 90000);
      active.timer.unref();
      return this.store.session(session.id)!;
    } catch {
      // An unknown MakeCall result is never retried or disguised as no answer.
      if (!active.localClosed) {
        try { this.store.updateTelephone(session.id, { state: 'unknown', endedReason: 'make_call_unconfirmed' }); } catch { /* Remote cleanup must still run when SQLite is unavailable. */ }
        await this.stop('make_call_unconfirmed', true).catch(() => {});
      }
      throw new Error('拨号结果未确认，已停止本地会话；请在CCC核对，禁止直接重拨');
    }
  }
  private async poll(active: NonNullable<TelephonePilot['active']>) {
    while (this.active === active && !active.ending) {
      try {
        const data = await this.api.pollUserStatus(active.controller.signal);
        if (active.ending) return;
        const state = normalizeCccCall(data, { ...this.options.ccc, jobId: active.jobId!, callee: this.options.testPhone });
        if (state.phase === 'unknown') {
          active.unknownSince ??= Date.now();
          if (Date.now() - active.unknownSince > (this.options.unknownTimeoutMs ?? 12000)) { await this.stop('customer_status_unknown', true); return; }
        } else active.unknownSince = undefined;
        if (state.phase === 'ringing') this.store.updateTelephone(active.sessionId, { state: 'ringing' });
        if (state.answered && state.customerChannelId) {
          const before = this.store.session(active.sessionId)?.answeredAt;
          const evidence = this.store.telephoneAnswered(active.sessionId, { jobId: active.jobId!, customerChannelId: state.customerChannelId, at: state.serverTime });
          if (!evidence?.answeredAt) { await this.stop('invalid_answer_evidence', true); return; }
          if (!before) {
            clearTimeout(active.timer);
            active.timer = setTimeout(() => {
              try { if (this.voice.runtime(active.sessionId).active) return; } catch { /* A local read failure must still release the external call. */ }
              void this.stop('media_startup_timeout', true).catch(() => {});
            }, 15000);
            active.timer.unref();
            this.store.event(active.sessionId, 'telephone.customer_answered', { jobId: active.jobId, customerChannelId: state.customerChannelId,
              serverTime: state.serverTime, receivedAt: new Date().toISOString() });
            this.voice.notifyTelephoneAnswered(active.sessionId);
          }
        }
        if (state.ended) {
          const result = state.releaseCode === 486 ? 'busy' : state.releaseCode === 408 ? 'no_answer' : 'ended';
          await this.stop('customer_hangup', false, result); return;
        }
      } catch {
        if (!active.ending) await this.stop('ccc_poll_error', true).catch(() => {});
        return;
      }
      await delay(this.options.pollMs ?? 500, undefined, { signal: active.controller.signal }).catch(() => {});
    }
  }
  private async gatewayEvent(event: EventFrame) {
    const active = this.active;
    if (event.event === 'StasisStart') {
      if (!event.channel) return;
      const payload = object(event.payload);
      const ruri = object(payload.invite).ruri;
      const user = typeof ruri === 'string' ? ruri.match(/^sips?:([^@;>]+)@/i)?.[1] : undefined;
      if (!active || active.ending || active.channel || !event.sip_call_id || event.app !== 'hongdong-pilot' || user !== this.options.extension
        || object(payload.vars).pilot_source !== 'aliyun_ccc' || object(payload.vars).pilot_seat !== this.options.extension) {
        await this.gateway.command(event.channel, 'reject', { code: 486, reason: 'No armed pilot' }); return;
      }
      active.channel = event.channel; active.sipCallId = event.sip_call_id;
      this.store.updateTelephone(active.sessionId, { channelId: event.channel, sipCallId: event.sip_call_id });
      const ticket = active.ticket = this.media.authorize(active.sessionId, event.sip_call_id);
      await this.gateway.command(event.channel, 'answer', { anchor: true, profile: 'hongdong_voice', ws_uri: ticket.uri,
        media_flags: { ws_barge_in: false, ws_sample_rate: 16000 } });
      const media = await ticket.ready;
      if (active.stop || this.active !== active) { media.close(); return; }
      // Recording starts on the SIP seat leg, before any model-input muting.
      const recording = await this.gateway.command(event.channel, 'record_start', { direction: 'both', channels: 'stereo', format: 'wav',
        path: posix.join(this.options.gatewayRecordingRoot, `${active.sessionId}.wav`), max_duration_ms: 10 * 60 * 1000 });
      if (active.localClosed) { media.close(); return; }
      if (typeof recording.recording_id !== 'string' || !recording.recording_id) throw new Error('线路录音未确认');
      active.recordingId = recording.recording_id;
      if (active.earlyRecording) { const early = active.earlyRecording; active.earlyRecording = undefined; await this.gatewayEvent(early); }
      this.store.updateTelephone(active.sessionId, { recordingStatus: 'recording' });
      if (active.ending) { media.close(); return; }
      this.voice.attachMedia(active.sessionId, media);
      return;
    }
    if (!active) return;
    if (event.event === 'PilotControlFailed' || event.event === 'PilotControlReattached') {
      if (event.channel && event.channel !== active.channel) return;
      await this.stop('gateway_control_error', true); return;
    }
    if (!active.channel || event.channel !== active.channel) return;
    if (event.event === 'RecordingFinished') {
      const data = object(event.payload);
      if (!active.recordingId) { if (typeof data.path === 'string' && basename(data.path) === `${active.sessionId}.wav`) active.earlyRecording = event; return; }
      if (data.recording_id !== active.recordingId || active.recordingReceived) return;
      active.recordingReceived = true;
      const expected = `${active.sessionId}.wav`;
      try {
        if (typeof data.path !== 'string' || basename(data.path) !== expected) throw new Error('录音路径未匹配');
        const recording = await this.recordings.importGatewayWav(active.sessionId, join(this.options.recordingRoot, expected), this.options.recordingRoot,
          { incomplete: !['stopped', 'call_ended', 'max_duration'].includes(String(data.reason)) });
        if (active.localClosed) return;
        this.store.saveRecording(active.sessionId, recording);
        this.store.updateTelephone(active.sessionId, { recordingStatus: 'ready' });
      } catch { if (!active.localClosed) this.store.updateTelephone(active.sessionId, { recordingStatus: 'failed' }); }
      active.resolveRecording();
    } else if (event.event === 'StasisEnd') {
      active.sipEnded = true;
      if (active.ending && active.cleanupRequestsSucceeded) this.store.updateTelephone(active.sessionId, { cleanupStatus: 'confirmed' });
      if (!active.ending) {
        const payload = object(event.payload);
        const failed = /error|failed|timeout|transport/i.test(String(payload.reason ?? '')) || Number(payload.code) >= 500;
        await this.stop(failed ? 'sip_error' : 'sip_hangup', failed);
      }
    } else if (event.event === 'WsBridgeEnded' && !active.ending) {
      await this.stop('media_bridge_ended', true);
    }
  }
  stop(reason = 'operator_end', failed = false, state?: Telephone['state']): Promise<Session> {
    const active = this.active;
    if (!active) return Promise.reject(new Error('当前没有本次测试电话'));
    if (active.stop) return active.stop;
    active.ending = true;
    active.stop = (async () => {
      const errors: unknown[] = [];
      const attempt = (operation: () => unknown) => { try { return operation(); } catch (error) { errors.push(error); return undefined; } };
      attempt(() => active.controller.abort()); clearTimeout(active.timer); attempt(() => active.ticket?.cancel());
      // A dispatched MakeCall cannot be cancelled by aborting the HTTP socket.
      // Wait its bounded reply so a late known JobId can be released exactly once.
      if (active.dialing && !active.jobId) {
        try { await this.bounded(active.dialing, 'CCC拨号结果等待超时'); }
        catch (error) { errors.push(error); /* Outcome remains unknown; never redial. */ }
      }
      const safeReason = /^[a-z_]{1,60}$/.test(reason) ? reason : 'telephone_error';
      attempt(() => this.store.updateTelephone(active.sessionId, { state: state ?? (failed ? 'failed' : 'ended'), endedReason: safeReason }));
      attempt(() => {
        if (this.voice.runtime(active.sessionId).active) {
          if (failed) this.voice.fail(active.sessionId, '电话信令或媒体异常，测试已结束', safeReason);
          else this.voice.finish(active.sessionId, safeReason);
        } else this.store.status(active.sessionId, failed ? 'failed' : 'completed', failed ? '电话测试失败' : undefined, safeReason);
      });
      const actions: Promise<unknown>[] = [];
      if (active.channel) {
        if (active.recordingId && !active.recordingReceived) actions.push(Promise.resolve().then(() => this.gateway.command(active.channel!, 'record_stop', { recording_id: active.recordingId })));
        if (!active.sipEnded) actions.push(Promise.resolve().then(() => this.gateway.command(active.channel!, 'hangup', { reason: safeReason })));
      }
      if (active.jobId) actions.push(this.release(active));
      const result = await Promise.allSettled(actions.map(action => this.bounded(action, '电话远端资源释放超时')));
      for (const item of result) if (item.status === 'rejected') errors.push(item.reason);
      active.cleanupRequestsSucceeded = result.every(item => item.status === 'fulfilled');
      if (errors.length) {
        attempt(() => this.store.updateTelephone(active.sessionId, { cleanupStatus: 'unknown' }));
        attempt(() => this.store.event(active.sessionId, 'telephone.cleanup_unconfirmed', { reason: safeReason }));
      } else attempt(() => this.store.updateTelephone(active.sessionId, { cleanupStatus: active.sipEnded || !active.channel ? 'confirmed' : 'unknown' }));
      if (active.recordingId && !active.recordingReceived) {
        await Promise.race([active.recordingDone, new Promise<void>(resolve => {
          const timer = setTimeout(resolve, this.options.recordingTimeoutMs ?? 5000); timer.unref();
        })]);
      }
      if (!active.recordingReceived) attempt(() => this.store.updateTelephone(active.sessionId, { recordingStatus: 'failed' }));
      attempt(() => active.unsubscribe());
      const session = attempt(() => this.store.session(active.sessionId)) as Session | undefined;
      if (errors.length || !session) throw new AggregateError(errors, '电话已尝试结束，但记录或资源清理未全部确认；请核对CCC与网关');
      return session;
    })();
    void active.stop.then(this.resolveFinished, this.rejectFinished);
    return active.stop;
  }
  private release(active: NonNullable<TelephonePilot['active']>): Promise<CccData> {
    if (!active.release) active.release = Promise.resolve().then(() => this.api.releaseCall({ jobId: active.jobId! }));
    return active.release;
  }
  private bounded<T>(task: Promise<T>, message: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(message)), this.options.cleanupTimeoutMs ?? 65000);
      timer.unref();
      void task.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
    });
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.disposed = true;
    this.closing = (async () => {
      const errors: unknown[] = [];
      try {
        if (this.active) {
          try { await this.stop('service_shutdown'); } catch (error) { errors.push(error); }
          try {
            await this.bounded((async () => { while (this.active?.eventTasks.size) await Promise.allSettled([...this.active.eventTasks]); })(), '电话事件收尾超时');
          } catch (error) { errors.push(error); }
        }
      } finally {
        if (this.active) this.active.localClosed = true;
        this.unsubscribeGateway();
      }
      if (errors.length) throw new AggregateError(errors, '电话资源关闭未全部确认；请核对CCC与网关');
    })();
    return this.closing;
  }
}
