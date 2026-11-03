import { createHash, createHmac, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { isAliyunCccEndpoint, type AliyunCccConfig } from './aliyun-config.js';

export type AliyunCccErrorCode = 'configuration' | 'network' | 'timeout' | 'cancelled' | 'provider' | 'invalid_response';
export class AliyunCccError extends Error {
  constructor(message: string, readonly code: AliyunCccErrorCode, readonly outcomeUnknown = false, readonly status?: number, readonly providerCode?: string) {
    super(message); this.name = 'AliyunCccError';
  }
}

const channelSchema = z.object({
  ChannelId: z.string().max(1024).optional(),
  UserId: z.string().max(256).nullable().optional(),
  Destination: z.string().max(256).optional(),
  Originator: z.string().max(256).optional(),
  JobId: z.string().max(256).optional(),
  ChannelState: z.string().max(64).optional(),
  Timestamp: z.number().finite().optional(),
  ReleaseReason: z.string().max(1024).optional(),
  ReleaseInitiator: z.string().max(256).optional(),
});
const dataSchema = z.object({
  ContextId: z.number().optional(),
  PageNumber: z.number().int().optional(),
  PageSize: z.number().int().optional(),
  TotalCount: z.number().int().optional(),
  List: z.array(z.object({ Number: z.string().max(128), City: z.string().max(128).optional(), Province: z.string().max(128).optional() })).max(100).optional(),
  CallContext: z.object({
    InstanceId: z.string().max(256).optional(),
    JobId: z.string().max(256).optional(),
    CallType: z.string().max(64).optional(),
    ChannelContexts: z.array(channelSchema).max(128).optional(),
  }).nullable().optional(),
  UserContext: z.object({
    UserId: z.string().max(256).optional(),
    InstanceId: z.string().max(256).optional(),
    JobId: z.string().max(256).optional(),
    UserState: z.string().max(64).optional(),
    WorkMode: z.string().max(64).optional(),
    Extension: z.string().max(128).optional(),
  }).nullable().optional(),
});
export type CccData = z.infer<typeof dataSchema>;
export type CccChannel = z.infer<typeof channelSchema>;

const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');
const encode = (value: string): string => encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
const SAFE_PROVIDER_CODES = new Set([
  'UserBusy', 'InvalidOperation.ChannelState', 'InvalidOperation.UserState', 'NotExists.UserId', 'NotExists.InstanceId',
  'NotExists.Extension', 'InternalService.CTI', 'InternalError', 'ServiceUnavailable', 'Throttling', 'Throttling.User',
  'Forbidden.RAM', 'SignatureDoesNotMatch', 'InvalidAccessKeyId.NotFound', 'InvalidSecurityToken.Expired',
]);

export interface Acs3Request {
  host: string;
  action: string;
  version: string;
  accessKeyId: string;
  accessKeySecret: string;
  securityToken?: string;
  query: Record<string, string | number>;
  date: string;
  nonce: string;
}

/** POST / + query parameters, exactly as CCC's official RPC metadata declares. No request payload. */
export function signAcs3Request(input: Acs3Request): { query: string; headers: Record<string, string> } {
  const query = Object.entries(input.query).map(([key, value]) => [encode(key), encode(String(value))])
    .sort(([a, av], [b, bv]) => a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0)
    .map(([key, value]) => `${key}=${value}`).join('&');
  const headers: Record<string, string> = {
    host: input.host,
    'x-acs-action': input.action,
    'x-acs-content-sha256': sha256(''),
    'x-acs-date': input.date,
    'x-acs-signature-nonce': input.nonce,
    'x-acs-version': input.version,
  };
  if (input.securityToken) headers['x-acs-security-token'] = input.securityToken;
  const keys = Object.keys(headers).sort();
  const canonicalHeaders = keys.map((key) => `${key}:${headers[key].trim()}\n`).join('');
  const signedHeaders = keys.join(';');
  const canonical = ['POST', '/', query, canonicalHeaders, signedHeaders, headers['x-acs-content-sha256']].join('\n');
  const signature = createHmac('sha256', input.accessKeySecret).update(`ACS3-HMAC-SHA256\n${sha256(canonical)}`, 'utf8').digest('hex');
  headers.authorization = `ACS3-HMAC-SHA256 Credential=${input.accessKeyId},SignedHeaders=${signedHeaders},Signature=${signature}`;
  return { query, headers };
}

export interface AliyunCccClientOptions extends AliyunCccConfig {
  fetch?: typeof fetch;
  now?: () => Date;
  nonce?: () => string;
}

/** Manual single-call CCC control only. No media, task scheduling, or automatic retries. */
export class AliyunCccClient {
  private readonly request: typeof fetch;
  private readonly now: () => Date;
  private readonly nonce: () => string;
  private readonly config: AliyunCccConfig;
  constructor(options: AliyunCccClientOptions) {
    if (!isAliyunCccEndpoint(options.endpoint) || !options.accessKeyId || !options.accessKeySecret || !options.instanceId || !options.userId || !options.deviceId || !options.caller
      || !Number.isInteger(options.timeoutMs) || options.timeoutMs < 100 || options.timeoutMs > 60_000
      || [options.accessKeyId, options.accessKeySecret, options.securityToken ?? '', options.instanceId, options.userId, options.deviceId, options.caller].some((value) => /[\r\n\0]/.test(value))) {
      throw new AliyunCccError('阿里云 CCC API 配置不完整或格式无效。', 'configuration');
    }
    this.config = { ...options };
    this.request = options.fetch ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.nonce = options.nonce ?? randomUUID;
  }

  private async call(action: 'MakeCall' | 'ReleaseCall' | 'PollUserStatus' | 'ListOutboundNumbersOfUser', parameters: Record<string, string | number>, signal?: AbortSignal): Promise<CccData> {
    if (signal?.aborted) throw new AliyunCccError('阿里云 CCC 请求已取消。', 'cancelled');
    const timeout = AbortSignal.timeout(this.config.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const signed = signAcs3Request({
      ...this.config, host: this.config.endpoint, action, version: '2020-07-01',
      query: { InstanceId: this.config.instanceId, UserId: this.config.userId,
        ...(action === 'ListOutboundNumbersOfUser' ? {} : { DeviceId: this.config.deviceId }), ...parameters },
      date: this.now().toISOString().replace(/\.\d{3}Z$/, 'Z'), nonce: this.nonce(),
    });
    const mutating = action === 'MakeCall' || action === 'ReleaseCall';
    try {
      const response = await this.request(`https://${this.config.endpoint}/?${signed.query}`, {
        method: 'POST', headers: { ...signed.headers, accept: 'application/json' }, signal: combined, redirect: 'error',
      });
      // Provider messages may reflect phone numbers or keys. Never expose bodies or raw fetch errors.
      if (!response.ok) {
        await response.body?.cancel();
        throw new AliyunCccError(`阿里云 CCC 请求失败（HTTP ${response.status}）。`, 'provider', mutating && response.status >= 500, response.status);
      }
      const payload = await boundedJson(response);
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new AliyunCccError('阿里云 CCC 返回格式无效。', 'invalid_response', mutating);
      const envelope = payload as Record<string, unknown>;
      if (envelope.Code !== 'OK' || (typeof envelope.HttpStatusCode === 'number' && envelope.HttpStatusCode >= 400)) {
        const providerCode = typeof envelope.Code === 'string' && SAFE_PROVIDER_CODES.has(envelope.Code) ? envelope.Code : undefined;
        const outcomeUnknown = mutating && (!providerCode || (typeof envelope.HttpStatusCode === 'number' && envelope.HttpStatusCode >= 500)
          || /^(?:Internal|ServiceUnavailable)/i.test(typeof envelope.Code === 'string' ? envelope.Code : ''));
        throw new AliyunCccError('阿里云 CCC 拒绝了请求，请检查坐席状态、RAM 权限及号码授权。', 'provider', outcomeUnknown, response.status, providerCode);
      }
      const parsed = dataSchema.safeParse(envelope.Data);
      if (!parsed.success) throw new AliyunCccError('阿里云 CCC 返回数据结构无效。', 'invalid_response', mutating);
      return parsed.data;
    } catch (error) {
      if (error instanceof AliyunCccError) throw error;
      if (signal?.aborted) throw new AliyunCccError('阿里云 CCC 请求已取消；已发出的呼叫请先核实状态。', 'cancelled', mutating);
      if (timeout.aborted) throw new AliyunCccError('阿里云 CCC 请求超时；已发出的呼叫请先核实状态，勿直接重拨。', 'timeout', mutating);
      throw new AliyunCccError('无法完成阿里云 CCC 请求，请检查网络；已发出的呼叫请先核实状态。', 'network', mutating);
    }
  }

  async makeCall(input: { callee: string; caller?: string; timeoutSeconds?: number }, signal?: AbortSignal): Promise<CccData> {
    const caller = input.caller ?? this.config.caller;
    const timeoutSeconds = input.timeoutSeconds ?? 60;
    if (!/^\+?\d{5,20}$/.test(input.callee) || !/^\+?\d{5,20}$/.test(caller) || !Number.isInteger(timeoutSeconds) || timeoutSeconds < 30 || timeoutSeconds > 300) {
      throw new AliyunCccError('主被叫号码或振铃超时参数无效（30–300 秒）。', 'configuration');
    }
    const data = await this.call('MakeCall', { Callee: input.callee, Caller: caller, TimeoutSeconds: timeoutSeconds, MediaType: 'AUDIO' }, signal);
    if (!data.CallContext?.JobId || (data.CallContext.InstanceId && data.CallContext.InstanceId !== this.config.instanceId)
      || (data.UserContext?.UserId && data.UserContext.UserId !== this.config.userId)) throw new AliyunCccError('阿里云未返回可确认归属的通话 ID，请核实坐席状态后再操作。', 'invalid_response', true);
    return data;
  }

  pollUserStatus(signal?: AbortSignal): Promise<CccData> { return this.call('PollUserStatus', {}, signal); }

  /** Read-only verification of the exact platform Caller value, including 669-prefixed demo numbers. */
  listOutboundNumbersOfUser(input: { pageNumber?: number; pageSize?: number } = {}, signal?: AbortSignal): Promise<CccData> {
    const pageNumber = input.pageNumber ?? 1; const pageSize = input.pageSize ?? 100;
    if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > 100 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
      throw new AliyunCccError('阿里云外呼号码列表分页参数须为 1–100 的整数。', 'configuration');
    }
    return this.call('ListOutboundNumbersOfUser', { PageNumber: pageNumber, PageSize: pageSize }, signal);
  }

  releaseCall(input: { jobId: string; channelId?: string }, signal?: AbortSignal): Promise<CccData> {
    if (!input.jobId || input.jobId.length > 256 || /[\r\n\0]/.test(input.jobId) || (input.channelId !== undefined && (!input.channelId || input.channelId.length > 1024 || /[\r\n\0]/.test(input.channelId)))) {
      throw new AliyunCccError('阿里云通话 ID 或通道 ID 格式无效。', 'configuration');
    }
    return this.call('ReleaseCall', { JobId: input.jobId, ...(input.channelId ? { ChannelId: input.channelId } : {}) }, signal);
  }
}

async function boundedJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) return undefined;
  const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    while (true) {
      const part = await reader.read(); if (part.done) break;
      bytes += part.value.length;
      if (bytes > 1024 * 1024) { await reader.cancel(); return undefined; }
      chunks.push(part.value);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return undefined; }
  } finally { reader.releaseLock(); }
}

const phoneKey = (value: string): string => {
  const compact = value.replace(/[\s()-]/g, '');
  return /^(?:\+86|0086)1\d{10}$/.test(compact) ? compact.replace(/^(?:\+86|0086)/, '') : compact;
};

export interface NormalizedCccCall {
  jobId: string;
  phase: 'unknown' | 'starting' | 'ringing' | 'answered' | 'ended';
  status: 'unknown' | 'starting' | 'ringing' | 'answered' | 'ended';
  answered: boolean;
  ended: boolean;
  customerChannelId?: string;
  changedAt?: string;
  /** From the customer channel Timestamp, never synthesized from local receipt time. */
  serverTime?: string;
  releaseCode?: number;
}

/** A seat's answered SIP leg never establishes customer answer. Missing poll context is unknown, not ended. */
export function normalizeCccCall(data: CccData, expected: { instanceId: string; jobId: string; callee: string }): NormalizedCccCall {
  const unknown: NormalizedCccCall = { jobId: expected.jobId, phase: 'unknown', status: 'unknown', answered: false, ended: false };
  const context = data.CallContext;
  if (!context || context.InstanceId !== expected.instanceId || context.JobId !== expected.jobId) return unknown;
  const channels = (context.ChannelContexts ?? []).filter((channel) => !channel.UserId?.trim()
    && channel.Destination && phoneKey(channel.Destination) === phoneKey(expected.callee)
    && (!channel.JobId || channel.JobId === expected.jobId));
  // Ambiguous multiple customer legs are not guessed. Single-call pilot does not perform transfers/conferences.
  const identities = new Set(channels.map((channel) => channel.ChannelId).filter(Boolean));
  if (!channels.length || identities.size > 1) return unknown;
  const channel = [...channels].sort((a, b) => (b.Timestamp ?? 0) - (a.Timestamp ?? 0))[0];
  const phase = channel.ChannelState === 'ANSWERED' ? 'answered'
    : channel.ChannelState === 'RINGING' || channel.ChannelState === 'EARLY_MEDIA' ? 'ringing'
    : channel.ChannelState === 'RELEASED' || channel.ChannelState === 'RETIRED' ? 'ended'
    : channel.ChannelState === 'CREATED' || channel.ChannelState === 'NONE' ? 'starting' : 'unknown';
  const changedAt = channel.Timestamp !== undefined && channel.Timestamp > 0 && channel.Timestamp <= 8.64e15 ? new Date(channel.Timestamp).toISOString() : undefined;
  const release = channel.ReleaseReason?.match(/^(\d{3})(?:\D|$)/);
  return { jobId: expected.jobId, phase, status: phase, answered: phase === 'answered', ended: phase === 'ended', customerChannelId: channel.ChannelId, changedAt, serverTime: changedAt, releaseCode: release ? Number(release[1]) : undefined };
}
