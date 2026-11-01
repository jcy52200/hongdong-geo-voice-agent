import type { CallAnalysis, Grade } from "./analysis.js";

export interface DashboardCall {
  id: string;
  customer: {
    id: string;
    camp: string;
    name: string;
    phone: string;
    address: string;
    industry?: string;
  };
  status:
    "created" | "connecting" | "opening" | "active" | "completed" | "failed";
  createdAt: string;
  answeredAt?: string;
  endedAt?: string;
  analysisStatus:
    "not_requested" | "pending" | "running" | "completed" | "failed";
  analysis?: CallAnalysis;
  hasRecording: boolean;
}
export interface DashboardData {
  range: { from: string; to: string; offsetMinutes: number };
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
