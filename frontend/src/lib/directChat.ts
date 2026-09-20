/**
 * The Chat module's API: assistants you may open, threads, and one turn.
 *
 * Separate from `agentFlows.ts` (the Studio's client) because the two serve
 * different people — that file is for authoring a flow, this one is for talking to
 * one — and separate from `api/public.ts` because every call here is authenticated
 * by the session cookie rather than by a link token.
 */
import { apiClient } from './api-client';
import { parseSseStream } from './api/sse';
import type { AnswerBlock, FlowOutputEnvelope } from './agentFlows';

const BASE = '/agent-flows/chat';

export interface ChatBrain {
  brain_key: string;
  name: string;
  description: string;
  version: number;
  flow_id: number | null;
  knowledge_count: number;
}

export interface ChatThread {
  id: number;
  brain_key: string;
  title: string;
  created_at: string | null;
  last_active_at: string | null;
}

export interface ChatCitation {
  kind: string;
  ref: string;
  label?: string;
  url?: string;
  quote?: string;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  status?: string;
  notices?: { code: string; text: string }[];
  citations?: ChatCitation[];
  run_id?: number;
  rating?: string | null;
  /** Typed blocks from the terminal `result` envelope. Only ever set on a live
   *  turn — a restored transcript keeps the prose, which is what was recorded. */
  blocks?: AnswerBlock[];
}

/** How this person stands to a conversation.
 *
 *  owner  they started it — rename, delete and share are theirs
 *  edit   it was shared with them and they may ask the next question in it
 *  view   it was shared with them to read
 *  full   they hold `chat: full` and are reading somebody else's, for oversight
 */
export type ThreadAccess = 'owner' | 'edit' | 'view' | 'full';

export interface ChatThreadDetail extends ChatThread {
  brain_name: string;
  /** Drives the input box, the rename field and the Share button from ONE value
   *  rather than three guesses about what the server would allow. */
  access: ThreadAccess;
  /** Non-empty when the flow can no longer answer: unpublished, unshared, or it has
   *  since grown a step that needs a report. The thread stays readable. */
  readonly_reason: string;
  readonly_message: string;
  messages: ChatMessage[];
}

/** The events a flow run actually emits. Nine of the public bot's types never
 *  appear on this path (route, sources, reading_plan, plan_step, insight,
 *  exploration_step, cost, state, preview_done) and are deliberately absent. */
export type ChatEvent =
  | { type: 'text'; text: string }
  | { type: 'status'; text: string; tool?: string }
  | { type: 'tool_result'; tool: string; ok: boolean; error?: string | null }
  | { type: 'usage'; [k: string]: unknown }
  | { type: 'error'; text: string }
  | { type: 'node_started'; step?: string; name?: string }
  | { type: 'node_completed'; step?: string; name?: string; status?: string; ms?: number }
  | { type: 'branch_taken'; step?: string; path?: string; label?: string }
  | { type: 'loop_iteration'; step?: string; index?: number; total?: number }
  | { type: 'verification'; coverage?: number; checked?: boolean; unknown_labels?: string[] }
  | { type: 'result'; envelope: FlowOutputEnvelope }
  | { type: 'done' };

export async function listChatBrains(): Promise<ChatBrain[]> {
  const { data } = await apiClient.get<{ brains: ChatBrain[] }>(`${BASE}/brains`);
  return data.brains || [];
}

export async function listThreads(brainKey?: string): Promise<ChatThread[]> {
  const { data } = await apiClient.get<{ threads: ChatThread[] }>(`${BASE}/threads`, {
    params: brainKey ? { brain_key: brainKey } : undefined,
  });
  return data.threads || [];
}

export async function createThread(brainKey: string): Promise<ChatThread> {
  const { data } = await apiClient.post(`${BASE}/threads`, { brain_key: brainKey });
  return data;
}

export async function readThread(threadId: number): Promise<ChatThreadDetail> {
  const { data } = await apiClient.get(`${BASE}/threads/${threadId}`);
  return data;
}

export async function renameThread(threadId: number, title: string): Promise<ChatThread> {
  const { data } = await apiClient.patch(`${BASE}/threads/${threadId}`, { title });
  return data;
}

export async function deleteThread(threadId: number): Promise<void> {
  await apiClient.delete(`${BASE}/threads/${threadId}`);
}

/**
 * One turn, streamed.
 *
 * `fetch` rather than `apiClient`: axios buffers a response body, and a chat that
 * only appears once the model has finished is not a stream. Credentials are sent
 * explicitly because this is the session cookie's whole job here — `apiClient` sets
 * `withCredentials` for the same reason.
 *
 * A refusal the server decided BEFORE the stream opened (quota, no key, a thread
 * that is not yours) arrives as a normal HTTP error and is thrown. A refusal the
 * ENGINE decided arrives inside the stream as a `result` envelope with
 * `status: 'blocked'` — HTTP 200 — because that is the only channel carrying a
 * machine-readable code.
 */
export async function* streamChatTurn(
  threadId: number,
  question: string,
  signal?: AbortSignal,
): AsyncGenerator<ChatEvent, void, unknown> {
  const base = process.env.NEXT_PUBLIC_API_URL || '/api/v1';
  const response = await fetch(`${base}${BASE}/threads/${threadId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ question }),
    signal,
  });

  if (!response.ok) {
    let detail = `HTTP ${response.status}`;
    try {
      const json = await response.json();
      detail = json?.detail ?? detail;
    } catch {
      /* a non-JSON error body is still an error */
    }
    throw new Error(detail);
  }

  // 180s: the server's own idle watchdog is 180s and its keepalive is every 8s, so
  // this only fires when something between here and it swallowed the frames.
  yield* parseSseStream<ChatEvent>(response, { idleMs: 200_000 });
}
