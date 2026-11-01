export interface Customer { id: string; camp: string; name: string; phone: string; address: string; industry?: string }
import type { ModelOptions } from '../../shared/model-config';
export interface AgentConfig { agentName: string; voice: string; speed: number; extraInstructions: string; systemPrompt?: string; loudness?: number; opening?: string; modelOptions?: ModelOptions }
export type SessionStatus = 'created' | 'connecting' | 'opening' | 'active' | 'completed' | 'failed';
export interface Transcript { id: string; eventId?: string; kind: 'AsrText' | 'ChatText'; text: string; final: boolean; createdAt: string }
export interface Session { id: string; customer: Customer; mode: 'simulation' | 'seed'; status: SessionStatus; createdAt: string; endedAt?: string; prompt: string; transcripts: Transcript[]; error?: string; analysisStatus: 'pending' | 'not_requested' }
export interface Bootstrap { config: AgentConfig; provider: { configured: boolean; webSearchConfigured?: boolean; model: string; protocol: string }; customers: Customer[]; sessions: Session[] }
export type ServerEvent = { type: 'session'; session: Session } | { type: 'transcript'; transcript: Transcript } | { type: 'audio'; audio: string; rate: number } | { type: 'audio_done'; opening: boolean } | { type: 'interrupted' } | { type: 'input_state'; muted: boolean } | { type: 'error'; message: string } | { type: 'state'; status: SessionStatus };
