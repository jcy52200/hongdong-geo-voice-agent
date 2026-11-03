import type { Grade } from "./analysis.js";
import type { Session } from "./session.js";
export type CallSource = 'all' | 'sip' | 'browser' | 'softphone_bridge';

export interface DashboardCall extends Pick<Session,
  "id" | "customer" | "status" | "createdAt" | "answeredAt" | "answerSource" |
  "modelReadyAt" | "endedAt" | "analysisStatus" | "analysis" | "transport" | "telephone"> {
  hasRecording: boolean;
}
export interface DashboardData {
  range: { from: string; to: string; offsetMinutes: number; source?: CallSource };
  calls: {
    total: number;
    answered: number;
    ended: number;
    active: number;
    notConnected: number;
    analyzed: number;
    pending: number;
    failed: number;
    recorded: number;
    durationSeconds: number;
  };
  previous: {
    total: number;
    answered: number;
    analyzed: number;
    leads: number;
  };
  grades: Record<Grade, number>;
  daily: Array<{
    date: string;
    total: number;
    answered: number;
    leads: number;
  }>;
  customers: {
    total: number;
    industryReady: number;
    industryUnknown: number;
    industryMissing: number;
    examples: Array<{ id: string; camp: string; name: string }>;
  };
  recent: DashboardCall[];
  leads: DashboardCall[];
  jobs: {
    pending: number;
    running: number;
    failed: number;
    industryPending: number;
    industryRunning: number;
    industryFailed: number;
  };
  provider: {
    seedConfigured: boolean;
    analysisConfigured: boolean;
    model: string;
  };
  generatedAt: string;
}
