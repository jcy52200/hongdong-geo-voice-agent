import type { AnalysisStatus, CallAnalysis } from '../../shared/analysis';
export interface Customer { id: string; camp: string; name: string; phone: string; address: string; industry?: string; industryStatus?: 'pending' | 'running' | 'completed' | 'failed'; industryError?: string }
import type { ModelOptions } from '../../shared/model-config';
export interface AgentConfig { agentName: string; voice: string; speed: number; extraInstructions: string; systemPrompt?: string; loudness?: number; opening?: string; modelOptions?: ModelOptions; quickReplyEnabled?: boolean; quickReplyText?: string }
export type SessionStatus = 'created' | 'connecting' | 'opening' | 'active' | 'completed' | 'failed';
export type SessionTransport = 'browser' | 'softphone_bridge';
export interface Transcript { id: string; eventId?: string; kind: 'AsrText' | 'ChatText'; text: string; final: boolean; createdAt: string }
export interface Recording { url: string; mimeType: string; bytes: number; createdAt: string }
export interface Session { id: string; customer: Customer; mode: 'simulation' | 'seed'; transport: SessionTransport; status: SessionStatus; createdAt: string; answeredAt?: string; endedAt?: string; endReason?: string; prompt: string; transcripts: Transcript[]; error?: string; analysisStatus: AnalysisStatus; analysis?: CallAnalysis; analysisError?: string; recording?: Recording }
export interface AnalysisProviderStatus { configured: boolean; model: string; pending: number; running: number; failed: number; industryPending: number }
export interface SessionPage { items: Session[]; total: number; page: number; pageSize: number }
export interface Bootstrap { config: AgentConfig; provider: { configured: boolean; webSearchConfigured?: boolean; model: string; protocol: string }; customers: Customer[]; sessions: Session[]; analysis?: AnalysisProviderStatus; sessionTotal?: number }
export type ServerEvent = { type: 'session'; session: Session } | { type: 'transcript'; transcript: Transcript } | { type: 'audio'; audio: string; rate: number } | { type: 'audio_done'; opening: boolean } | { type: 'interrupted' } | { type: 'input_state'; muted: boolean } | { type: 'error'; message: string } | { type: 'state'; status: SessionStatus };
