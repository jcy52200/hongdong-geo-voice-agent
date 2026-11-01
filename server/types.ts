import type { AgentConfig, Customer } from './prompt.js';
import type { AnalysisStatus, CallAnalysis } from '../shared/analysis.js';
export type { AgentConfig, Customer } from './prompt.js';
export type SessionStatus = 'created' | 'connecting' | 'opening' | 'active' | 'completed' | 'failed';
export interface Transcript {
  id: string;
  eventId?: string;
  kind: 'AsrText' | 'ChatText';
  text: string;
  final: boolean;
  createdAt: string;
}
export interface Session {
  id: string;
  customer: Customer;
  configSnapshot: AgentConfig;
  mode: 'simulation' | 'seed';
  status: SessionStatus;
  createdAt: string;
  endedAt?: string;
  answeredAt?: string;
  endReason?: string;
  prompt: string;
  promptHash: string;
  transcripts: Transcript[];
  error?: string;
  analysisStatus: AnalysisStatus;
  analysis?: CallAnalysis;
  analysisError?: string;
  recording?: { url: string; mimeType: string; bytes: number; createdAt: string };
}
export type ServerEvent =
  | { type: 'session'; session: Session }
  | { type: 'state'; status: SessionStatus }
  | { type: 'transcript'; transcript: Transcript }
  | { type: 'audio'; audio: string; rate: number }
  | { type: 'audio_done'; opening: boolean }
  | { type: 'interrupted' }
  | { type: 'input_state'; muted: boolean }
  | { type: 'error'; message: string };
