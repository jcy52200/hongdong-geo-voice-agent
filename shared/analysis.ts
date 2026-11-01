export const GRADES = ['A', 'B', 'C', 'D', 'E', 'F', 'G'] as const;
export type Grade = typeof GRADES[number];
export const GRADE_LABELS: Record<Grade, string> = {
  A: '有明确意向', B: '可能有意向', C: '无意向', D: '用户在忙',
  E: '其他', F: '智能助理', G: '骂人',
};
export type AnalysisStatus = 'not_requested' | 'pending' | 'running' | 'completed' | 'failed';
export interface AnalysisEvidence { transcriptId: string; quote: string }
export interface CallAnalysis {
  grade: Grade;
  summary: string;
  reason: string;
  evidence: AnalysisEvidence[];
  wechat: { consent: boolean; phone: string | null; sameAsDialed: boolean; identifier: string | null };
  customerTurns: number;
  assistantTurns: number;
  model: string;
  evaluatedAt: string;
}
export interface IndustryResult { id: string; industry: string }
