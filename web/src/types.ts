import type { AgentConfig, Customer, Session } from '../../shared/session';
export type {
  AgentConfig, AnswerSource, Customer, Recording, ServerEvent,
  Session, SessionEvent, SessionStatus, SessionTransport, Transcript,
} from '../../shared/session';

export interface AnalysisProviderStatus { configured: boolean; model: string; pending: number; running: number; failed: number; industryPending: number }
export interface SessionPage { items: Session[]; total: number; page: number; pageSize: number }
export interface Bootstrap { config: AgentConfig; provider: { configured: boolean; webSearchConfigured?: boolean; model: string; protocol: string }; customers: Customer[]; sessions: Session[]; analysis?: AnalysisProviderStatus; sessionTotal?: number }
