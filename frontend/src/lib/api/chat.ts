/**
 * AI Chat API — the ONE chat (docs/features/unified-ai-chat/contract.md).
 *
 * Every data answer comes from the Data Core through the Governed Query Service
 * under the signed-in person's own rights; an Agent Flow bound to a conversation
 * is an optional extension that adds cited documents. Nothing here sends SQL, and
 * no Flow is needed to ask.
 */
import apiClient from '@/lib/api-client';
import { parseSseStream } from '@/lib/api/sse';

export interface ChatSource {
  explore_id: number;
  /** the Dataset this explore belongs to: what "choose a source" pins (TurnBody.dataset_id) */
  dataset_id: number;
  dataset: string;
  source_type: string;
  measures: string[];
  dimensions: string[];
}

/** A Flow this person may add to a conversation (published, shared with them). */
export interface ChatExtensionOption {
  flow_key: string;
  name: string;
  description: string;
  capability?: unknown;
}

export interface CoreStep {
  step: 'discovery' | 'plan' | 'governed_query' | 'verify' | string;
  detail: string;
  source?: string;
  query_id?: string;
}

export interface CoreColumn {
  name: string;
  ref: string | null;
  role: 'dimension' | 'measure' | 'unknown';
  label: string;
}

export interface CoreCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface CoreAnswer {
  headline: string;
  bullets: string[];
  facts: { claim: string; value: number | null }[];
  checks: CoreCheck[];
  note?: string;
}

export interface CoreEvidence {
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

/** The Data Core's response — the only place a business number comes from. */
export interface CoreResponse {
  status: 'answered' | 'refused' | 'clarify' | 'unsupported';
  turn_id?: string;
  steps?: CoreStep[];
  message?: string;
  options?: string[];
  code?: string;
  /** The server allows accepting this dropped filter. */
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
  answer?: CoreAnswer;
  columns?: CoreColumn[];
  rows?: Record<string, unknown>[];
  truncated?: boolean;
  evidence?: CoreEvidence;
  chart_draft?: ChartDraft | null;
  chart_draft_unavailable?: string | null;
}

export interface SupportingDocument {
  doc_id: number;
  title: string;
  quote: string;
  version?: number | null;
}

/** What an Agent Flow extension returned, validated by the server (ext.v1). */
export interface Supporting {
  invocation_id: string;
  flow_key: string;
  flow_name: string;
  reason: 'explicit' | 'document_need' | 'core_unsupported' | string;
  status: 'ok' | 'failed' | 'timeout' | 'cancelled' | 'unavailable' | string;
  code: string | null;
  documents: SupportingDocument[];
  /** The flow's words, kept verbatim, with the figures the data core did NOT verify listed. */
  findings: { text: string; unverified_figures: string[] }[];
  warnings: { code: string; [k: string]: unknown }[];
}

export type TurnStatus = 'running' | 'answered' | 'clarification_required' | 'refused' | 'failed' | 'cancelled';

/** The ONE answer envelope of a turn (`chat.v1`). */
export interface ChatEnvelope {
  v: 'chat.v1';
  status: Exclude<TurnStatus, 'running'>;
  code: string | null;
  message: string | null;
  data: CoreResponse | null;
  supporting: Supporting | null;
  notices: { code: string; text: string }[];
  /** An imported pre-unification turn, shown as it was (read-only). */
  legacy?: {
    origin: 'analyst_v1' | 'flow_v0';
    answer?: string;
    citations?: { kind: string; ref: string; label?: string }[];
    content_pruned?: boolean;
  };
}

export type ConversationAccess = 'owner' | 'full' | 'edit' | 'view';

export interface ConversationSummary {
  id: number;
  title: string | null;
  access: ConversationAccess;
  can_ask: boolean;
  is_owner: boolean;
  extension_flow_key: string | null;
  created_at: string | null;
  last_active_at: string | null;
}

/** A stored turn. `redacted`: the caller may not read its sources NOW (a share never
 *  grants a Dataset or a document), so only the question and its status are returned. */
export interface StoredTurn {
  seq: number;
  turn_id: string;
  question: string;
  status: TurnStatus;
  origin: 'core' | 'analyst_v1' | 'flow_v0';
  asked_at: string | null;
  asked_by_me: boolean;
  redacted: boolean;
  /** source_access: no rights on its sources now; asker_only: it read no source and is private to whoever asked */
  redacted_reason: 'source_access' | 'asker_only' | null;
  envelope: ChatEnvelope | null;
}

export interface ConversationDetail extends ConversationSummary {
  turns: StoredTurn[];
}

export type TurnEvent =
  | { type: 'accepted'; conversation_id: number; turn_id: string; seq: number; replayed: boolean }
  | { type: 'status'; step: string; detail: string }
  | { type: 'extension'; state: string; flow_key: string; reason?: string }
  | { type: 'final'; turn_id: string; seq: number; envelope: ChatEnvelope }
  | { type: 'done' };

export interface TurnBody {
  question: string;
  idempotency_key: string;
  follow_up: boolean;
  extension?: 'auto' | 'always' | 'never';
  drop_consent?: string | null;
  consented_plan?: Record<string, unknown> | null;
  dataset_id?: number | null;
  value_choice?: { plan: Record<string, unknown>; field: string; value: string } | null;
  choice_token?: string | null;
}

/** An HTTP refusal before the turn started (403/404/409/429/503). */
export class TurnRejected extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export function newIdempotencyKey(): string {
  const raw = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`.padEnd(32, '0');
  return raw.replace(/-/g, '').toLowerCase().slice(0, 32);
}

export const chatApi = {
  catalog: async (lang = 'vi'): Promise<{ sources: ChatSource[]; extensions: ChatExtensionOption[] }> => {
    const response = await apiClient.get('/chat/catalog', { params: { lang } });
    return response.data;
  },
  conversations: async (): Promise<ConversationSummary[]> => {
    const response = await apiClient.get('/chat/conversations');
    return response.data.conversations;
  },
  create: async (body: { title?: string | null; extension_flow_key?: string | null } = {}):
    Promise<ConversationSummary> => {
    const response = await apiClient.post('/chat/conversations', body);
    return response.data;
  },
  conversation: async (id: number): Promise<ConversationDetail> => {
    const response = await apiClient.get(`/chat/conversations/${id}`);
    return response.data;
  },
  update: async (id: number, body: { title?: string; extension_flow_key?: string }): Promise<ConversationSummary> => {
    const response = await apiClient.patch(`/chat/conversations/${id}`, body);
    return response.data;
  },
  remove: async (id: number): Promise<void> => {
    await apiClient.delete(`/chat/conversations/${id}`);
  },
  cancel: async (turnId: string): Promise<{ cancelled: boolean; status: string }> => {
    const response = await apiClient.post(`/chat/turns/${turnId}/cancel`);
    return response.data;
  },
  feedback: async (turnId: string, verdict: 'up' | 'down', comment?: string, reason?: string): Promise<void> => {
    await apiClient.post(`/chat/turns/${turnId}/feedback`, { verdict, comment: comment || null, reason: reason || null });
  },
  consent: async (query_fingerprint: string, fields: string[]): Promise<string> => {
    const response = await apiClient.post('/chat/consents', { query_fingerprint, fields });
    return response.data.drop_consent;
  },
  /** Where an old /analyst/s/{id} or /chat?thread={id} link now lives. */
  resolveLegacy: async (kind: 'analyst_session' | 'flow_thread', id: number): Promise<number> => {
    const response = await apiClient.get(`/chat/legacy/${kind}/${id}`);
    return response.data.conversation_id;
  },
  /**
   * One turn, streamed: `accepted`, progress, then exactly one `final` envelope.
   * `fetch`, not axios: axios buffers the body. The turn runs on the server either
   * way - leaving the page does not lose it; only `cancel` stops it.
   */
  ask: async function* ask(conversationId: number, body: TurnBody, signal?: AbortSignal):
    AsyncGenerator<TurnEvent, void, unknown> {
    const base = process.env.NEXT_PUBLIC_API_URL || '/api/v1';
    const response = await fetch(`${base}/chat/conversations/${conversationId}/turns`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ extension: 'auto', ...body }),
      signal,
    });
    if (!response.ok) {
      let detail = `HTTP ${response.status}`;
      try {
        const json = await response.json();
        detail = typeof json?.detail === 'string' ? json.detail : json?.detail?.code ?? detail;
      } catch {
        /* a non-JSON error body is still an error */
      }
      throw new TurnRejected(response.status, detail);
    }
    yield* parseSseStream<TurnEvent>(response, { idleMs: 200_000 });
  },
};
