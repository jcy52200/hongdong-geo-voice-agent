import type { AnalysisStatus, CallAnalysis } from './analysis.js';
import type { ModelOptions } from './model-config.js';

export interface Customer {
  id: string;
  camp: string;
  name: string;
  phone: string;
  address: string;
  industry?: string;
  industryStatus?: 'pending' | 'running' | 'completed' | 'failed';
  industryError?: string;
}

export interface AgentConfig {
  agentName: string;
  voice: string;
  speed: number;
  extraInstructions: string;
  systemPrompt?: string;
  loudness?: number;
  opening?: string;
  modelOptions?: ModelOptions;
  quickReplyEnabled?: boolean;
  quickReplyText?: string;
}

export type SessionStatus = 'created' | 'connecting' | 'opening' | 'active' | 'completed' | 'failed';
/** softphone_bridge is read-only provenance for the retired demo. */
export type SessionTransport = 'browser' | 'softphone_bridge' | 'sip';
/** A telephone answer requires the matched CCC customer leg, independently of model readiness. */
export type AnswerSource = 'browser_session' | 'legacy_browser_session' | 'legacy_softphone_bridge' | 'ccc_customer' | 'sip_gateway';

export interface Telephone {
  provider: 'aliyun_ccc' | 'aliyun_udp_trunk';
  gateway: 'siphon';
  state: 'prepared' | 'dialing' | 'ringing' | 'answered' | 'ended' | 'busy' | 'no_answer' | 'rejected' | 'cancelled' | 'failed' | 'unknown';
  jobId?: string;
  channelId?: string;
  sipCallId?: string;
  customerChannelId?: string;
  endedReason?: string;
  recordingStatus?: 'pending' | 'recording' | 'ready' | 'failed';
  cleanupStatus?: 'pending' | 'confirmed' | 'unknown';
}

export interface Transcript {
  id: string;
  /** Provider correlation key for speech output, not evidence of playback. */
  responseId?: string;
  eventId?: string;
  kind: 'AsrText' | 'ChatText';
  text: string;
  final: boolean;
  createdAt: string;
}

export interface PlaybackFact {
  playbackId: string;
  responseId?: string;
  opening: boolean;
  startedAt: string;
  drainedAt?: string;
  scope: 'gateway_rtp_egress';
}

export interface Recording {
  url: string;
  mimeType: string;
  bytes: number;
  createdAt: string;
  source?: 'browser' | 'siphon';
  channels?: number;
  sampleRate?: number;
  /** Seconds of actual PCM in the archived recording. */
  duration?: number;
  incomplete?: boolean;
}

export interface Session {
  id: string;
  customer: Customer;
  configSnapshot: AgentConfig;
  mode: 'simulation' | 'seed';
  transport: SessionTransport;
  telephone?: Telephone;
  status: SessionStatus;
  createdAt: string;
  endedAt?: string;
  /** Retained API field. Interpret it together with answerSource, not as a SIP answer. */
  answeredAt?: string;
  answerSource?: AnswerSource;
  /** Model initialization is independent of customer answer / transport connection. */
  modelReadyAt?: string;
  endReason?: string;
  prompt: string;
  promptHash: string;
  transcripts: Transcript[];
  /** Telephone gateway egress evidence; absent on legacy/browser records. */
  playbacks?: PlaybackFact[];
  error?: string;
  analysisStatus: AnalysisStatus;
  analysis?: CallAnalysis;
  analysisError?: string;
  recording?: Recording;
}

export type ServerEvent =
  | { type: 'session'; session: Session }
  | { type: 'state'; status: SessionStatus }
  | { type: 'transcript'; transcript: Transcript }
  | { type: 'audio'; audio: string; rate: number }
  | { type: 'audio_done'; opening: boolean; playbackId?: string }
  | { type: 'interrupted' }
  | { type: 'input_state'; muted: boolean }
  | { type: 'error'; message: string };

/** Metadata events delivered independently of any particular media adapter. */
export type SessionEvent = Exclude<ServerEvent, { type: 'audio' | 'audio_done' | 'interrupted' }>;
