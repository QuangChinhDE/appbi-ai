/**
 * Public (unauthenticated) API calls for shared dashboard links.
 * Uses a plain fetch so no auth cookies are sent.
 *
 * Password-protected links:
 *   1. Call `publicDashboardApi.auth(token, password)` → get { session_token, expires_in }
 *   2. Store with `savePublicSession(token, session_token, expires_in)`
 *   3. Pass the token when calling get() / getChartData()
 *
 * Sessions expire after 2 hours (server-enforced via JWT expiry).
 */
import axios from 'axios';
import type { Dashboard } from '@/types/api';
import type { BaseFilter } from '@/lib/filters';
import type {
  WorkboardPublicPayload,
} from '@/lib/api/workboards';

// NEXT_PUBLIC_API_URL is baked as '/api/v1' (relative) so it works on any domain.
// Next.js rewrites or nginx proxy the requests to the backend.
const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? '/api/v1';

// Axios instance without credentials so no auth cookie leaks
const publicClient = axios.create({
  baseURL: API_BASE,
  withCredentials: false,
});

export const publicDashboardApi = {
  /** Exchange a link password for a 2-hour session token. */
  auth: async (
    token: string,
    password: string,
  ): Promise<{ session_token: string; expires_in: number }> => {
    const res = await publicClient.post(`/public/dashboards/${token}/auth`, { password });
    return res.data;
  },

  get: async (token: string, sessionToken?: string): Promise<Dashboard> => {
    const headers = sessionToken ? { 'X-Public-Session': sessionToken } : {};
    const res = await publicClient.get(`/public/dashboards/${token}`, { headers });
    return res.data;
  },

  getChartData: async (
    token: string,
    chartId: number,
    sessionToken?: string,
    filters?: BaseFilter[],
  ): Promise<any> => {
    const headers = sessionToken ? { 'X-Public-Session': sessionToken } : {};
    const res = await publicClient.get(
      `/public/dashboards/${token}/charts/${chartId}/data`,
      {
        headers,
        params: filters && filters.length > 0
          ? { filters: JSON.stringify(filters) }
          : undefined,
      },
    );
    return res.data;
  },

  getFilterDistinctValues: async (
    token: string,
    datasetId: number,
    field: string,
    sessionToken?: string,
    limit = 200,
    filters?: BaseFilter[],
  ): Promise<{ field: string; values: string[] }> => {
    const headers = sessionToken ? { 'X-Public-Session': sessionToken } : {};
    const res = await publicClient.get(
      `/public/dashboards/${token}/filters/distinct-values`,
      {
        headers,
        params: {
          dataset_id: datasetId,
          field,
          limit,
          ...(filters?.length ? { filters: JSON.stringify(filters) } : {}),
        },
      },
    );
    return res.data;
  },
};

export const publicWorkboardApi = {
  auth: async (
    token: string,
    password: string,
  ): Promise<{ session_token: string; expires_in: number }> => {
    const res = await publicClient.post(`/public/workboards/${token}/auth`, { password });
    return res.data;
  },

  get: async (token: string, sessionToken?: string): Promise<WorkboardPublicPayload> => {
    const headers = sessionToken ? { 'X-Public-Session': sessionToken } : {};
    const res = await publicClient.get(`/public/workboards/${token}`, { headers });
    return res.data;
  },
};

// ── Session storage helpers ──────────────────────────────────────────────────
// Sessions are stored per-link in sessionStorage so they are scoped to the tab
// and automatically cleared when the browser tab is closed.

const SESSION_KEY_PREFIX = 'appbi_pub_session_';

interface StoredSession {
  sessionToken: string;
  expiresAt: number; // ms since epoch
}

export function savePublicSession(
  linkToken: string,
  sessionToken: string,
  expiresIn: number,
): void {
  const payload: StoredSession = {
    sessionToken,
    expiresAt: Date.now() + expiresIn * 1000,
  };
  try {
    sessionStorage.setItem(SESSION_KEY_PREFIX + linkToken, JSON.stringify(payload));
  } catch { /* sessionStorage unavailable (SSR or private mode) */ }
}

export function getPublicSession(linkToken: string): string | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY_PREFIX + linkToken);
    if (!raw) return null;
    const { sessionToken, expiresAt }: StoredSession = JSON.parse(raw);
    if (Date.now() >= expiresAt) {
      sessionStorage.removeItem(SESSION_KEY_PREFIX + linkToken);
      return null;
    }
    return sessionToken;
  } catch {
    return null;
  }
}

export function clearPublicSession(linkToken: string): void {
  try {
    sessionStorage.removeItem(SESSION_KEY_PREFIX + linkToken);
  } catch { /* ignore */ }
}

/** How many seconds remain in the stored session (0 if expired/missing). */
export function publicSessionRemainingSeconds(linkToken: string): number {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY_PREFIX + linkToken);
    if (!raw) return 0;
    const { expiresAt }: StoredSession = JSON.parse(raw);
    const remaining = Math.floor((expiresAt - Date.now()) / 1000);
    return Math.max(0, remaining);
  } catch {
    return 0;
  }
}

// ── AI Bot types ──────────────────────────────────────────────────────────────

export type AiProvider = 'anthropic' | 'openai' | 'gemini';

export interface AiChartContext {
  id: number;
  name: string;
  chart_type: string;
  columns: string[];
  rows: unknown[][];
  description?: string;
}

export interface AiDashboardContext {
  dashboard_name: string;
  dashboard_description?: string;
  charts: AiChartContext[];
  chart_count: number;
}

export interface AiChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

// ── AI Bot API calls ──────────────────────────────────────────────────────────

/**
 * Fetch the dashboard context for the AI bot. Context includes chart data
 * (capped at 50 rows/chart, 10 charts max). Cached client-side for the session.
 */
export async function fetchAiContext(
  token: string,
  sessionToken?: string,
): Promise<AiDashboardContext> {
  const headers: Record<string, string> = {};
  if (sessionToken) headers['X-Public-Session'] = sessionToken;
  const res = await publicClient.get(`/public/dashboards/${token}/ai/context`, { headers });
  return res.data as AiDashboardContext;
}

// ── Agentic AI Bot v2 ──────────────────────────────────────────────────────────

export interface AiReconChartManifest {
  chart_id: number;
  chart_name: string;
  chart_type: string;
  description: string;
  columns: string[];
  total_rows: number;
  filters_applied: Record<string, unknown>[];
}

export interface AiReconInsightPack {
  chart_id: number;
  chart_name: string;
  chart_type: string;
  description: string;
  total_rows: number;
  sample_rows: number;
  truncated: boolean;
  primary_measure: string | null;
  primary_dimension: string | null;
  top_5: Record<string, unknown>[];
  bottom_5: Record<string, unknown>[];
  trend: {
    direction: 'up' | 'down' | 'flat';
    pct_change: number | null;
    first: { x: string; y: number };
    last: { x: string; y: number };
    points: number;
  } | null;
  outliers: { row: Record<string, unknown>; z_score: number }[];
  filters_applied: Record<string, unknown>[];
}

export interface AiRecon {
  manifest: {
    dashboard_name: string;
    dashboard_description: string;
    filters_applied: Record<string, unknown>[];
    charts: AiReconChartManifest[];
  };
  summaries: AiReconInsightPack[];
}

// Phase-15.71 — reading plan event. The bot emits this BEFORE answering
// so the FE can render a collapsible "AI đang đọc dashboard" panel that
// shows the analyst-style flow step-by-step.
export interface AiReadingPlanItem {
  step: number;
  chart_id: number | null;
  phase: 'triage' | 'health_check' | 'drilldown' | 'compare' | 'synthesize' | string;
  question: string;
}

export type AiPlanStepStatus = 'pending' | 'running' | 'done';

export type AiAgentEvent =
  | { type: 'text'; text: string }
  | { type: 'status'; text: string; tool: string }
  | { type: 'tool_result'; tool: string; ok: boolean; error?: string | null }
  | { type: 'reading_plan'; items: AiReadingPlanItem[]; overall_goal?: string | null }
  | { type: 'plan_step'; step_index: number; chart_id: number | null; status: AiPlanStepStatus }
  | { type: 'state'; state: AiConversationState }
  | { type: 'cost'; usd: number; cap_usd: number; remaining_usd: number; over_cap: boolean; near_cap?: boolean; rounds?: number; prompt_tokens?: number; completion_tokens?: number }
  | { type: 'usage'; prompt_tokens: number; completion_tokens: number }
  | { type: 'error'; text: string }
  | { type: 'done' };

// ── Briefing Wizard types ────────────────────────────────────────────────────

export interface AiBriefing {
  domain: string;
  domain_label: string;
  role: 'executive' | 'manager' | 'analyst' | 'staff' | string;
  focus: 'overview' | 'issues' | 'compare' | 'deepdive' | string;
  timeframe: string;
  custom_note: string;
  key_chart_ids: number[];
  confirmed: boolean;
}

export interface AiBriefingGuessOption {
  value: string;
  label?: string;
  label_vi?: string;
  hint_vi?: string;
}

export interface AiBriefingGuess {
  domain: string;
  domain_label: string;
  confidence: number;
  alt_domains: { domain: string; label: string; score: number }[];
  key_chart_ids: number[];
  headline_facts: { text: string; chart_id: number }[];
  timeframe_hint: string;
  role_options: AiBriefingGuessOption[];
  focus_options: AiBriefingGuessOption[];
  timeframe_options: AiBriefingGuessOption[];
  domain_catalog: AiBriefingGuessOption[];
}

export interface AiFinding {
  claim: string;
  chart_ids: number[];
  confidence: 'HIGH' | 'MED' | 'LOW' | string;
  turn_index: number;
  metric_value: number | null;
}

export interface AiHypothesis {
  text: string;
  raised_in_turn: number;
  status: 'open' | 'confirmed' | 'rejected' | string;
}

export interface AiConversationState {
  briefing: AiBriefing | null;
  findings: AiFinding[];
  hypotheses: AiHypothesis[];
  turn_index: number;
  seen_chart_ids: number[];
}

/**
 * Fetch a proactive recon (manifest + Insight Packs for top charts) so the
 * bot can render a "what's notable" welcome message without an LLM call.
 */
export async function fetchAiRecon(
  token: string,
  sessionToken?: string,
): Promise<AiRecon> {
  const headers: Record<string, string> = {};
  if (sessionToken) headers['X-Public-Session'] = sessionToken;
  const res = await publicClient.get(`/public/dashboards/${token}/ai/recon`, { headers });
  return res.data as AiRecon;
}

/**
 * Build the URL of the AI-generated PDF for this dashboard. The user can
 * download it and re-feed it into any LLM (Claude, ChatGPT) — same data
 * the way they'd hand a printed report to a human analyst.
 */
export function buildAiDashboardPdfUrl(token: string, sessionToken?: string): string {
  const base = `${API_BASE}/public/dashboards/${token}/ai/dashboard.pdf`;
  if (!sessionToken) return base;
  // Session token must travel via header for security, so we expose a
  // separate fetch helper rather than a query string.
  return base;
}

export async function downloadAiDashboardPdf(
  token: string,
  sessionToken?: string,
  filename = 'dashboard.pdf',
): Promise<void> {
  const headers: Record<string, string> = {};
  if (sessionToken) headers['X-Public-Session'] = sessionToken;
  const res = await fetch(buildAiDashboardPdfUrl(token), { headers });
  if (!res.ok) throw new Error(`PDF ${res.status}`);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }
}

/**
 * Heuristic guess of dashboard domain / role / key metrics. No LLM call —
 * powers Step 1 of the briefing wizard ("AI đoán trước, user xác nhận").
 */
export async function fetchAiBriefingGuess(
  token: string,
  sessionToken?: string,
): Promise<AiBriefingGuess> {
  const headers: Record<string, string> = {};
  if (sessionToken) headers['X-Public-Session'] = sessionToken;
  const res = await publicClient.get(
    `/public/dashboards/${token}/ai/briefing/guess`,
    { headers },
  );
  return res.data as AiBriefingGuess;
}

/**
 * Stream the Executive Brief paragraph after the user has confirmed their
 * briefing. Uses BYOK like the chat endpoint.
 */
export async function* streamAiBriefingBrief(
  token: string,
  briefing: AiBriefing,
  userAiKey: string,
  provider: AiProvider,
  model: string,
  sessionToken?: string,
): AsyncGenerator<AiAgentEvent, void, unknown> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-User-Ai-Key': userAiKey,
    'X-User-Ai-Provider': provider,
  };
  const trimmedModel = model.trim();
  if (trimmedModel) headers['X-User-Ai-Model'] = trimmedModel;
  if (sessionToken) headers['X-Public-Session'] = sessionToken;

  const response = await fetch(
    `${API_BASE}/public/dashboards/${token}/ai/briefing/brief`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({ briefing }),
    },
  );

  if (!response.ok) {
    let detail = `HTTP ${response.status}`;
    try {
      const json = await response.json();
      detail = json?.detail ?? detail;
    } catch { /* ignore */ }
    throw new Error(detail);
  }

  const reader = response.body?.getReader();
  if (!reader) return;

  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split('\n\n');
    buffer = events.pop() ?? '';
    for (const evBlock of events) {
      const dataLine = evBlock.split('\n').find((l) => l.startsWith('data:'));
      if (!dataLine) continue;
      const payload = dataLine.slice(5).trim();
      if (!payload) continue;
      try {
        const parsed = JSON.parse(payload) as AiAgentEvent;
        yield parsed;
        if (parsed.type === 'done') return;
      } catch {
        /* ignore */
      }
    }
  }
}

// ── AI Chat Session persistence ────────────────────────────────────────────────

export interface AiChatSessionData {
  session_key: string;
  provider?: string | null;
  model?: string | null;
  messages: AiChatMessage[];
  briefing?: Record<string, unknown> | null;
  conv_state?: Record<string, unknown> | null;
  turn_count: number;
  prompt_tokens: number;
  completion_tokens: number;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface AiChatSessionSavePayload {
  session_key: string;
  provider?: string | null;
  model?: string | null;
  messages: AiChatMessage[];
  briefing?: Record<string, unknown> | null;
  conv_state?: Record<string, unknown> | null;
  turn_count: number;
  prompt_tokens?: number;
  completion_tokens?: number;
}

/**
 * Load a persisted chat session.  Returns null when no session exists yet (404).
 */
export async function loadAiSession(
  token: string,
  sessionKey: string,
  sessionToken?: string,
): Promise<AiChatSessionData | null> {
  const headers: Record<string, string> = {};
  if (sessionToken) headers['X-Public-Session'] = sessionToken;
  try {
    const res = await publicClient.get(
      `/public/dashboards/${token}/ai/session/${encodeURIComponent(sessionKey)}`,
      { headers },
    );
    return res.data as AiChatSessionData;
  } catch (err: unknown) {
    // 404 means no saved session — callers treat this as fresh start
    if (axios.isAxiosError(err) && err.response?.status === 404) return null;
    throw err;
  }
}

/**
 * Upsert (create or update) a chat session.  Called after each completed turn.
 */
export async function saveAiSession(
  token: string,
  sessionKey: string,
  data: AiChatSessionSavePayload,
  sessionToken?: string,
): Promise<void> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (sessionToken) headers['X-Public-Session'] = sessionToken;
  await publicClient.put(
    `/public/dashboards/${token}/ai/session/${encodeURIComponent(sessionKey)}`,
    { ...data, session_key: sessionKey },
    { headers },
  );
}

/**
 * Clear a session's messages and state (called on "Xóa lịch sử").
 */
export async function clearAiSession(
  token: string,
  sessionKey: string,
  sessionToken?: string,
): Promise<void> {
  const headers: Record<string, string> = {};
  if (sessionToken) headers['X-Public-Session'] = sessionToken;
  await publicClient.post(
    `/public/dashboards/${token}/ai/session/${encodeURIComponent(sessionKey)}/clear`,
    {},
    { headers },
  );
}

/**
 * Stream typed events from the agentic chat endpoint.
 *
 * The user's API key is sent in `X-User-Ai-Key` and is NEVER stored.
 * The dashboard's public filters are applied automatically server-side —
 * what the dashboard shows is what the agent sees.
 */
export async function* streamAiAgentChat(
  token: string,
  messages: AiChatMessage[],
  userAiKey: string,
  provider: AiProvider,
  model: string,
  sessionToken?: string,
  briefing?: AiBriefing | null,
  state?: AiConversationState | null,
  costCapUsd?: number,
  mode?: 'normal' | 'thinking',
  viewerFilters?: unknown[],
): AsyncGenerator<AiAgentEvent, void, unknown> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-User-Ai-Key': userAiKey,
    'X-User-Ai-Provider': provider,
  };
  const trimmedModel = model.trim();
  if (trimmedModel) {
    headers['X-User-Ai-Model'] = trimmedModel;
  }
  if (typeof costCapUsd === 'number' && Number.isFinite(costCapUsd)) {
    const capped = Math.max(0.01, Math.min(5.0, costCapUsd));
    headers['X-User-Ai-Cost-Cap-Usd'] = capped.toFixed(3);
  }
  if (mode === 'normal' || mode === 'thinking') {
    headers['X-User-Ai-Mode'] = mode;
  }
  if (sessionToken) headers['X-Public-Session'] = sessionToken;

  const body: Record<string, unknown> = { messages };
  if (briefing) body.briefing = briefing;
  if (state) body.state = state;
  if (Array.isArray(viewerFilters) && viewerFilters.length > 0) {
    body.viewer_filters = viewerFilters;
  }

  const response = await fetch(`${API_BASE}/public/dashboards/${token}/ai/agent/chat`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    let detail = `HTTP ${response.status}`;
    try {
      const json = await response.json();
      detail = json?.detail ?? detail;
    } catch { /* ignore */ }
    throw new Error(detail);
  }

  const reader = response.body?.getReader();
  if (!reader) return;

  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    // SSE event boundaries are blank lines (\n\n)
    const events = buffer.split('\n\n');
    buffer = events.pop() ?? '';

    for (const evBlock of events) {
      const dataLine = evBlock
        .split('\n')
        .find((l) => l.startsWith('data:'));
      if (!dataLine) continue;
      const payload = dataLine.slice(5).trim();
      if (!payload) continue;
      try {
        const parsed = JSON.parse(payload) as AiAgentEvent;
        yield parsed;
        if (parsed.type === 'done') return;
      } catch {
        // Ignore malformed lines
      }
    }
  }
}

/**
 * Stream a chat response from the LLM using the user's BYOK API key.
 * Returns an async generator that yields text chunks as they arrive (SSE).
 *
 * The user's API key is sent in `X-User-Ai-Key` and is NEVER stored.
 */
export async function* streamAiChat(
  token: string,
  messages: AiChatMessage[],
  contextSnapshot: AiDashboardContext,
  userAiKey: string,
  provider: AiProvider,
  sessionToken?: string,
): AsyncGenerator<string, void, unknown> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-User-Ai-Key': userAiKey,
    'X-User-Ai-Provider': provider,
  };
  if (sessionToken) headers['X-Public-Session'] = sessionToken;

  const response = await fetch(`${API_BASE}/public/dashboards/${token}/ai/chat`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ messages, context_snapshot: contextSnapshot }),
  });

  if (!response.ok) {
    let detail = `HTTP ${response.status}`;
    try {
      const json = await response.json();
      detail = json?.detail ?? detail;
    } catch { /* ignore */ }
    throw new Error(detail);
  }

  const reader = response.body?.getReader();
  if (!reader) return;

  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      // Unescape newlines encoded by the backend
      yield payload.replace(/\\n/g, '\n');
    }
  }
}
