/**
 * AppBI Analyst API (M2 MVP). Thin wrappers over `apiClient` — the backend runs
 * every read through the Governed Query Service; nothing here sends SQL.
 */
import apiClient from '@/lib/api-client';

export interface AnalystSource {
  explore_id: number;
  dataset: string;
  source_type: string;
  measures: string[];
  dimensions: string[];
}

export interface AnalystStep {
  step: 'discovery' | 'plan' | 'governed_query' | 'verify' | string;
  detail: string;
  source?: string;
  query_id?: string;
}

export interface AnalystColumn {
  name: string;
  ref: string | null;
  role: 'dimension' | 'measure' | 'unknown';
  label: string;
}

export interface AnalystCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface AnalystAnswer {
  headline: string;
  bullets: string[];
  facts: { claim: string; value: number | null }[];
  checks: AnalystCheck[];
  note?: string;
}

export interface AnalystEvidence {
  query_id: string;
  source: string;
  source_type: string;
  explore_id: number;
  datasets: number[];
  dialect: string;
  sql_fingerprint: string;
  policy_fingerprint: string;
  semantic_epoch: string;
  filters_applied: string[];
  filters_dropped: { field: string; reason: string; accepted_by_user: boolean }[];
  bounds: { max_rows: number; timeout_seconds: number; bq_max_bytes: number };
  rows_returned: number;
  duration_ms: number;
  freshness: string;
  measures: string[];
}

export interface ChartDraft {
  name: string;
  chart_type: string;
  dataset_table_id: number | null;
  config: Record<string, unknown>;
}

export interface AnalystTurn {
  status: 'answered' | 'refused' | 'clarify' | 'unsupported';
  turn_id?: string;
  steps?: AnalystStep[];
  message?: string;
  options?: string[];
  code?: string;
  /** The server allows accepting this dropped filter (ANALYST_DROP_CONSENT_ENABLED). */
  consent_available?: boolean;
  /** A clarification between datasets: each option and the Dataset it pins. */
  sources?: { label: string; dataset_id: number }[];
  detail?: { dropped?: { field: string; reason: string }[]; query_fingerprint?: string; [k: string]: unknown };
  plan?: Record<string, unknown>;
  answer?: AnalystAnswer;
  columns?: AnalystColumn[];
  rows?: Record<string, unknown>[];
  truncated?: boolean;
  evidence?: AnalystEvidence;
  chart_draft?: ChartDraft | null;
  chart_draft_unavailable?: string | null;
}

export function newTurnId(): string {
  const raw = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`.padEnd(32, '0');
  return raw.replace(/-/g, '').toLowerCase().slice(0, 32);
}

export const analystApi = {
  catalog: async (): Promise<AnalystSource[]> => {
    const response = await apiClient.get('/analyst/catalog');
    return response.data.sources;
  },
  ask: async (body: {
    question: string;
    turn_id: string;
    previous_plan?: Record<string, unknown> | null;
    drop_consent?: string | null;
    consented_plan?: Record<string, unknown> | null;
    dataset_id?: number | null;
  }): Promise<AnalystTurn> => {
    const response = await apiClient.post('/analyst/ask', body, { timeout: 180_000 });
    return response.data;
  },
  consent: async (query_fingerprint: string, fields: string[]): Promise<string> => {
    const response = await apiClient.post('/analyst/consents', { query_fingerprint, fields });
    return response.data.drop_consent;
  },
  cancel: async (turnId: string): Promise<number> => {
    const response = await apiClient.post(`/analyst/turns/${turnId}/cancel`);
    return response.data.cancel_requested;
  },
};
