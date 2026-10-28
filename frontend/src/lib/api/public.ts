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
import { reportAnchor } from '@/lib/report-anchor';
import type { Dashboard } from '@/types/api';
import type { BaseFilter } from '@/lib/filters';

/** One server-side render job as the polling endpoint returns it. */
export interface PublicExportJob {
  id: string;
  status: 'queued' | 'running' | 'succeeded' | 'partial' | 'failed' | 'cancelled';
  progress: number;
  message: string | null;
  warnings: Array<{ page: string; chart: string; reason: string }>;
  page_count: number | null;
  file_size: number | null;
  error: string | null;
  download_token?: string;
}

// NEXT_PUBLIC_API_URL is baked as '/api/v1' (relative) so it works on any domain.
// Next.js rewrites or nginx proxy the requests to the backend.
const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? '/api/v1';

// Axios instance without credentials so no auth cookie leaks
const publicClient = axios.create({
  baseURL: API_BASE,
  withCredentials: false,
});

// One relative-date anchor for all tiles of the current public report read, so a
// load across midnight cannot mix windows. Non-credential header; the server
// resolves relative presets against it (falls back to now() when absent).
publicClient.interceptors.request.use((config) => {
  try {
    const a = reportAnchor();
    if (a) { config.headers = config.headers || {} as any; (config.headers as any)['X-AppBI-As-Of'] = a; }
  } catch { /* best-effort */ }
  return config;
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

  /** Report-level "data as of" + staleness so the public viewer sees when the
   *  snapshot numbers were last refreshed (perf #5). */
  getSnapshotInfo: async (
    token: string,
    sessionToken?: string,
  ): Promise<{ as_of: string | null; mode: string; stale: boolean }> => {
    const headers = sessionToken ? { 'X-Public-Session': sessionToken } : {};
    const res = await publicClient.get(`/public/dashboards/${token}/snapshots/info`, { headers });
    return res.data;
  },

  getChartData: async (
    token: string,
    chartId: number,
    sessionToken?: string,
    filters?: BaseFilter[],
    granularity?: string,
    pageId?: string,
    tileId?: number,
    overrides?: Record<string, string> | null,
  ): Promise<any> => {
    const headers = sessionToken ? { 'X-Public-Session': sessionToken } : {};
    // #2 — viewer date-hierarchy: re-bucket the time axis at the grain the
    // public end-user picked (BE re-queries). Stays on publicClient.
    const params: Record<string, string> = {};
    if (filters && filters.length > 0) params.filters = JSON.stringify(filters);
    if (granularity) params.granularity = granularity;
    // The page being shown: the server applies that page's scope itself.
    if (pageId) params.page_id = pageId;
    // The tile (its own parameter values apply) and its what-if selection.
    if (tileId != null) params.tile_id = String(tileId);
    if (overrides && Object.keys(overrides).length > 0) params.overrides = JSON.stringify(overrides);
    const res = await publicClient.get(
      `/public/dashboards/${token}/charts/${chartId}/data`,
      {
        headers,
        params: Object.keys(params).length > 0 ? params : undefined,
      },
    );
    return res.data;
  },

  // "1 request = 1 page": fetch data for MANY charts in ONE round-trip. Each
  // item carries its own already-computed viewer filters (scope-bounded +
  // cross-filter-merged by the caller), so the server result is byte-identical
  // to N getChartData() calls — this is purely a transport + server-side
  // concurrency win (kills N round-trips + the browser's per-host socket queue).
  getChartsDataBatch: async (
    token: string,
    sessionToken: string | undefined,
    items: Array<{
      chart_id: number;
      /** The tile: a chart may sit on the report twice with its own parameters. */
      tile_id?: number;
      filters?: BaseFilter[];
      granularity?: string;
      /** What-if selection bound to this tile ({dimension?, metric?}). */
      overrides?: Record<string, string>;
    }>,
    pageId?: string,
  ): Promise<{ results: Array<{ chart_id: number; tile_id?: number; data?: any; error?: string; status?: number; category?: string | null }> }> => {
    const headers = sessionToken ? { 'X-Public-Session': sessionToken } : {};
    const res = await publicClient.post(
      `/public/dashboards/${token}/charts/data`,
      // page_id: the server applies that page's scope itself (the filters the
      // page sends are only the viewer's own choices, bounded client-side too).
      { items, ...(pageId ? { page_id: pageId } : {}) },
      { headers },
    );
    return res.data;
  },

  // ── Server-side PDF export (job API) ──────────────────────────────────
  // The browser asks the server to render the report, then polls. Falls back to
  // the in-browser exporter when `server_engine` is false (no worker deployed).

  getExportCapabilities: async (
    token: string,
    sessionToken?: string,
  ): Promise<{ server_engine: boolean; max_pages_per_hour: number }> => {
    const headers = sessionToken ? { 'X-Public-Session': sessionToken } : {};
    const res = await publicClient.get(`/public/dashboards/${token}/exports/capabilities`, { headers });
    return res.data;
  },

  /** Editable PowerPoint of what this reader sees (see report_pptx_service). */
  exportPptx: async (
    token: string,
    sessionToken: string | undefined,
    payload: unknown,
  ): Promise<Blob> => {
    const headers = sessionToken ? { 'X-Public-Session': sessionToken } : {};
    const res = await publicClient.post(`/public/dashboards/${token}/exports/pptx`, payload, {
      headers,
      responseType: 'blob',
    });
    return res.data as Blob;
  },

  createExportJob: async (
    token: string,
    sessionToken: string | undefined,
    body: {
      pages?: string[];
      orientation?: string;
      page_format?: string;
      layout?: string;
      filters?: BaseFilter[];
      /** Report parameter values at export time, so the file shows the same slice. */
      params?: Record<string, string>;
      session?: string;
    },
  ): Promise<PublicExportJob> => {
    const headers = sessionToken ? { 'X-Public-Session': sessionToken } : {};
    const res = await publicClient.post(`/public/dashboards/${token}/exports`, body, { headers });
    return res.data;
  },

  getExportJob: async (
    token: string,
    jobId: string,
    sessionToken?: string,
  ): Promise<PublicExportJob> => {
    const headers = sessionToken ? { 'X-Public-Session': sessionToken } : {};
    const res = await publicClient.get(`/public/dashboards/${token}/exports/${jobId}`, { headers });
    return res.data;
  },

  cancelExportJob: async (
    token: string,
    jobId: string,
    sessionToken?: string,
  ): Promise<PublicExportJob> => {
    const headers = sessionToken ? { 'X-Public-Session': sessionToken } : {};
    const res = await publicClient.post(
      `/public/dashboards/${token}/exports/${jobId}/cancel`, {}, { headers },
    );
    return res.data;
  },

  /** Absolute URL of the finished file (secret-bearing, expires with the job). */
  exportDownloadUrl: (token: string, jobId: string, downloadToken: string): string =>
    `${API_BASE}/public/dashboards/${token}/exports/${jobId}/download?dl=${encodeURIComponent(downloadToken)}`,

  getFilterDistinctValues: async (
    token: string,
    datasetId: number,
    field: string,
    sessionToken?: string,
    limit = 200,
    filters?: BaseFilter[],
    search?: string,
    offset?: number,
    pageId?: string,
  ): Promise<{ field: string; values: string[]; total?: number; has_more?: boolean; unavailable?: boolean; restricted?: boolean }> => {
    const headers = sessionToken ? { 'X-Public-Session': sessionToken } : {};
    const res = await publicClient.get(
      `/public/dashboards/${token}/filters/distinct-values`,
      {
        headers,
        params: {
          dataset_id: datasetId,
          field,
          limit,
          ...(offset ? { offset } : {}),
          ...(search && search.trim() ? { search: search.trim() } : {}),
          ...(filters?.length ? { filters: JSON.stringify(filters) } : {}),
          ...(pageId ? { page_id: pageId } : {}),
        },
      },
    );
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

// ── THE public Dashboard AI Bot: a client of the Answer Core ─────────────────
//
// One endpoint answers a viewer: POST /public/dashboards/{token}/ai/answer. The
// server's Answer Core reads the link's PUBLISHED report and writes the one final
// answer (`chat.v1`). No provider key, model or mode is ever sent from here: the
// server resolves the credential and enforces the link's budget.

export type PublicAnswerStatus = 'answered' | 'clarification_required' | 'refused' | 'failed' | 'cancelled';

export interface PublicAnswerColumn {
  name: string;
  ref?: string | null;
  role: string;
  label?: string;
}

export interface PublicAnswerEvidence {
  source?: string;
  source_type?: string;
  chart_id?: number;
  pages?: string[];
  filters_applied?: string[];
  filters_withheld?: number;
  filters_described?: string[];
  filters_dropped?: string[];
  rows_returned?: number;
  freshness?: string;
  measures?: string[];
  regrouped?: boolean;
}

export interface PublicAnswerData {
  status?: string;
  message?: string | null;
  code?: string | null;
  answer?: { headline?: string; bullets?: string[]; note?: string; incomplete?: boolean } | null;
  columns?: PublicAnswerColumn[];
  rows?: Record<string, unknown>[];
  truncated?: boolean;
  evidence?: PublicAnswerEvidence | null;
  /** The guided analysis of the published charts and the publisher's prompt: in place
   *  of a could-not-plan refusal (code `ai_analysis`), or beside an answer it evaluates.
   *  Labelled; its unread figures listed; `used_notes` when it used the prompt. */
  analysis?: { text: string; charts?: string[]; unverified_figures?: string[]; used_notes?: boolean } | null;
  options?: string[];
  choices?: { label: string; token?: string }[];
}

export interface PublicAnswerSupporting {
  status?: string;
  flow_name?: string;
  documents?: { doc_id: number; title?: string }[];
  findings?: { text: string; unverified_figures?: string[] }[];
}

export interface PublicAnswerEnvelope {
  v: string;
  status: PublicAnswerStatus;
  code?: string | null;
  message?: string | null;
  data?: PublicAnswerData | null;
  supporting?: PublicAnswerSupporting | null;
  notices?: { code: string; text: string }[];
}

export type PublicAnswerEvent =
  | { type: 'accepted'; turn_id: string; replayed?: boolean }
  | { type: 'status'; step?: string; detail?: string }
  | { type: 'extension'; state: string }
  | { type: 'final'; turn_id: string; envelope: PublicAnswerEnvelope | null }
  | { type: 'done' };

export interface PublicAnswerRequest {
  question: string;
  conversation_key: string;
  idempotency_key: string;
  page_id?: string | null;
  viewer_filters?: unknown[];
  follow_up?: boolean;
  choice_token?: string | null;
}

/** A refused/failed request before the turn exists (429 budget, 409 running, 410…). */
export class PublicAnswerRejected extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function publicHeaders(sessionToken?: string | null): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (sessionToken) headers['X-Public-Session'] = sessionToken;
  return headers;
}

async function detailOf(response: Response): Promise<string> {
  try {
    const json = await response.json();
    return typeof json?.detail === 'string' ? json.detail : `HTTP ${response.status}`;
  } catch {
    return `HTTP ${response.status}`;
  }
}

/** Stream one turn's events. Ends after `done`. */
export async function* askPublicAnswer(
  token: string,
  body: PublicAnswerRequest,
  sessionToken?: string | null,
  signal?: AbortSignal,
): AsyncGenerator<PublicAnswerEvent, void, unknown> {
  const response = await fetch(`${API_BASE}/public/dashboards/${token}/ai/answer`, {
    method: 'POST',
    headers: publicHeaders(sessionToken),
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) throw new PublicAnswerRejected(response.status, await detailOf(response));
  const reader = response.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split('\n\n');
    buffer = blocks.pop() ?? '';
    for (const block of blocks) {
      const line = block.split('\n').find((l) => l.startsWith('data:'));
      if (!line) continue;
      try {
        const ev = JSON.parse(line.slice(5).trim()) as PublicAnswerEvent;
        yield ev;
        if (ev.type === 'done') return;
      } catch {
        /* a malformed frame is skipped */
      }
    }
  }
}

export async function cancelPublicAnswer(
  token: string, turnId: string, conversationKey: string, sessionToken?: string | null,
): Promise<{ cancelled: boolean; status: string }> {
  const response = await fetch(`${API_BASE}/public/dashboards/${token}/ai/answer/${turnId}/cancel`, {
    method: 'POST',
    headers: publicHeaders(sessionToken),
    body: JSON.stringify({ conversation_key: conversationKey }),
  });
  if (!response.ok) throw new PublicAnswerRejected(response.status, await detailOf(response));
  return response.json();
}

export async function getPublicAnswerTurn(
  token: string, turnId: string, conversationKey: string, sessionToken?: string | null,
): Promise<{ turn_id: string; status: string; question: string; envelope: PublicAnswerEnvelope | null }> {
  const url = `${API_BASE}/public/dashboards/${token}/ai/answer/${turnId}`
    + `?conversation_key=${encodeURIComponent(conversationKey)}`;
  const response = await fetch(url, { headers: publicHeaders(sessionToken) });
  if (!response.ok) throw new PublicAnswerRejected(response.status, await detailOf(response));
  return response.json();
}

/** The viewer's thumb on one answer of their conversation (one current verdict). */
export async function ratePublicAnswer(
  token: string, turnId: string, conversationKey: string, rating: 'up' | 'down', sessionToken?: string | null,
): Promise<{ turn_id: string; rating: 'up' | 'down' }> {
  const response = await fetch(`${API_BASE}/public/dashboards/${token}/ai/answer/${turnId}/rating`, {
    method: 'POST',
    headers: publicHeaders(sessionToken),
    body: JSON.stringify({ conversation_key: conversationKey, rating }),
  });
  if (!response.ok) throw new PublicAnswerRejected(response.status, await detailOf(response));
  return response.json();
}

export async function getPublicAiStatus(
  token: string, sessionToken?: string | null,
): Promise<{ enabled: boolean; ready: boolean }> {
  const response = await fetch(`${API_BASE}/public/dashboards/${token}/ai/status`, {
    headers: publicHeaders(sessionToken),
  });
  if (!response.ok) throw new PublicAnswerRejected(response.status, await detailOf(response));
  return response.json();
}
