/**
 * AI Analyst API. Thin wrappers over `apiClient` — the backend runs
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
  /** The applied filters as the person reads them ("Kênh bán là Online"). */
  filters_described?: string[];
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
  /** The server's reading of whether this person may save the chart draft. */
  can_save?: boolean;
  /** A clarification between datasets: each option and the Dataset it pins. */
  sources?: { label: string; dataset_id: number; token?: string }[];
  /** A clarification between metrics: each option with its server-signed choice token. */
  choices?: { label: string; token: string }[];
  /** A clarification of a filter value: the field the offered values belong to. */
  choice_field?: string | null;
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

/** Who the caller is to a session (backend services/analyst/sessions.py). */
export type AnalystSessionAccess = 'owner' | 'full' | 'edit' | 'view';

export interface AnalystSessionSummary {
  id: number;
  title: string | null;
  access: AnalystSessionAccess;
  can_ask: boolean;
  is_owner: boolean;
  created_at: string | null;
  last_active_at: string | null;
}

/** A stored turn. `redacted`: the caller may not read its sources NOW, so only the
 *  question and its status are returned (a share never grants a Dataset). */
export interface AnalystStoredTurn {
  seq: number;
  turn_id: string;
  question: string;
  status: AnalystTurn['status'];
  asked_at: string | null;
  asked_by_me: boolean;
  redacted: boolean;
  response: AnalystTurn | null;
}

export interface AnalystSessionDetail extends AnalystSessionSummary {
  turns: AnalystStoredTurn[];
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
    value_choice?: { plan: Record<string, unknown>; field: string; value: string } | null;
    choice_token?: string | null;
  }): Promise<AnalystTurn> => {
    const response = await apiClient.post('/analyst/ask', body, { timeout: 180_000 });
    return response.data;
  },
  consent: async (query_fingerprint: string, fields: string[]): Promise<string> => {
    const response = await apiClient.post('/analyst/consents', { query_fingerprint, fields });
    return response.data.drop_consent;
  },
  feedback: async (turnId: string, verdict: 'up' | 'down', comment?: string, reason?: string): Promise<void> => {
    await apiClient.post('/analyst/feedback', { turn_id: turnId, verdict, comment: comment || null, reason: reason || null });
  },
  sessions: async (): Promise<AnalystSessionSummary[]> => {
    const response = await apiClient.get('/analyst/sessions');
    return response.data.sessions;
  },
  createSession: async (title?: string): Promise<AnalystSessionSummary> => {
    const response = await apiClient.post('/analyst/sessions', { title: title || null });
    return response.data;
  },
  session: async (id: number): Promise<AnalystSessionDetail> => {
    const response = await apiClient.get(`/analyst/sessions/${id}`);
    return response.data;
  },
  renameSession: async (id: number, title: string): Promise<AnalystSessionSummary> => {
    const response = await apiClient.patch(`/analyst/sessions/${id}`, { title });
    return response.data;
  },
  deleteSession: async (id: number): Promise<void> => {
    await apiClient.delete(`/analyst/sessions/${id}`);
  },
  /** A turn inside a session. The server reads the follow-up context from the
   *  session itself; `follow_up: false` starts a new topic in it. */
  askInSession: async (id: number, body: {
    question: string;
    turn_id: string;
    follow_up: boolean;
    drop_consent?: string | null;
    consented_plan?: Record<string, unknown> | null;
    dataset_id?: number | null;
    value_choice?: { plan: Record<string, unknown>; field: string; value: string } | null;
    choice_token?: string | null;
  }): Promise<AnalystTurn> => {
    const response = await apiClient.post(`/analyst/sessions/${id}/ask`, body, { timeout: 180_000 });
    return response.data;
  },
  cancel: async (turnId: string): Promise<number> => {
    const response = await apiClient.post(`/analyst/turns/${turnId}/cancel`);
    return response.data.cancel_requested;
  },
};
