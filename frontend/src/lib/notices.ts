// Notice audience — deliberately DEPENDENCY-FREE.
//
// This lives apart from `agentFlows.ts` for one reason, and it is a security one.
// `agentFlows.ts` imports `apiClient`. `DashboardAiBot` is rendered by
// `PublicDashboardView`, which is rendered by the PUBLIC page `app/d/[token]`,
// where the authed client must never be reachable. Its existing import from
// `agentFlows` was `import type` — erased at compile time and therefore harmless.
// A value import of these helpers from there is NOT erased, and would pull the
// authed client into the public bundle. Guardrail invariant `public_client_only`
// is file-scoped and would not have caught it, because the offending file is not
// under `app/d/**`.
//
// Nothing here may import anything.

export type NoticeAudience = 'reader' | 'author';

export interface FlowNotice {
  code: string;
  text: string;
  /** Absent on anything stored before the field existed. The backend default is
   *  `reader`, and this mirrors it — treating "missing" as `author` would hide
   *  working reader notices. */
  audience?: NoticeAudience;
  severity?: 'info' | 'warning' | 'error';
  node_key?: string;
  facts?: Record<string, unknown>;
  remedies?: string[];
}

/** Author maintenance diagnostics — never shown on a reader surface. */
export const isAuthorNotice = (n: FlowNotice): boolean => n.audience === 'author';

/** What a READER may see. Defensive: the server drops these at its own boundary. */
export const readerNotices = (ns: FlowNotice[] | undefined): FlowNotice[] =>
  (ns || []).filter((n) => !isAuthorNotice(n));

/** What an AUTHOR is told about their flow, as opposed to about the answer. */
export const authorNotices = (ns: FlowNotice[] | undefined): FlowNotice[] =>
  (ns || []).filter(isAuthorNotice);

/** A candidate the resolver weighed, as carried in `facts.candidates`. */
export interface NoticeCandidate {
  chart_id?: number;
  chart_name?: string;
  why?: string;
  concept?: string;
}

/**
 * The candidates behind an ambiguous selection.
 *
 * A remedy tells the author to look at what the resolver was torn between. That
 * advice was false until this existed: the notice carried the list and no surface
 * read `facts`, so the author was sent to look at something nothing displayed.
 */
export const CANDIDATE_LIMIT = 6;

export const noticeCandidates = (n: FlowNotice): NoticeCandidate[] => {
  const raw = (n.facts || {}).candidates;
  return Array.isArray(raw) ? (raw as NoticeCandidate[]).slice(0, CANDIDATE_LIMIT) : [];
};

/**
 * How many candidates were NOT rendered.
 *
 * The cap was silent: eight candidates, six shown, two gone. An author told to
 * look at what the resolver was torn between was shown 75% of it and had no way
 * to know.
 */
export const noticeCandidatesHidden = (n: FlowNotice): number => {
  const raw = (n.facts || {}).candidates;
  return Array.isArray(raw) ? Math.max(0, raw.length - CANDIDATE_LIMIT) : 0;
};

// ── Tool outcomes, as a READER should read them ─────────────────────────────
//
// Lives here for the same reason the notice helpers do: this is shared reader
// vocabulary, and the public bundle may not reach the authed client. Nothing in
// this file imports anything.

/** Mirrors `reader_diagnostics.reader_outcome` on the backend.
 *
 *  `notice` — the system behaved correctly and there is nothing to fix (the data
 *  is out of scope, absent, or the calculation does not apply).
 *  `limitation` — the answer is available but narrower than asked for.
 *  `error` — something actually broke. */
export type ReaderOutcome = 'ok' | 'notice' | 'limitation' | 'error';

export interface ToolStatusEntry {
  tool: string;
  text: string;
  ok?: boolean;
  /** Absent on a stream from a backend that predates the field. Falling back to
   *  `ok` reproduces the OLD behaviour for those, which is the honest default:
   *  it over-reports rather than silently downgrading a real failure. */
  outcome?: ReaderOutcome;
  error?: string | null;
}

export const outcomeOf = (e: ToolStatusEntry): ReaderOutcome =>
  e.outcome ?? (e.ok === false || e.error ? 'error' : 'ok');

/**
 * What the collapsed status line should say, counted by MEANING.
 *
 * THE BUG THIS REPLACES. The summary counted `ok === false || error` and called
 * the total "errors". `ok` is a transport fact — it says a call returned no
 * payload — so a link correctly withholding an out-of-scope chart, a tool
 * correctly declining a chart with no date axis, and a warehouse that actually
 * fell over were counted the same. A viewer who had just been given a correct,
 * honest answer read `Đã đọc 3 bước · 3 lỗi` above it.
 *
 * DEDUPLICATED BY MEANING, NOT BY STRING. Three refusals of three different
 * charts for the same reason are ONE thing to a reader: part of what they asked
 * for is outside what this link shares. The reader sentence is built by the
 * backend from `error_code`, never free text, so `outcome + sentence` is a
 * structural identity rather than a string coincidence. The author's trace keeps
 * every entry.
 */
export function tallyStatus(log: ToolStatusEntry[]): {
  steps: number; errors: number; limitations: number;
} {
  let errors = 0;
  let limitations = 0;
  const seen = new Set<string>();
  for (const e of log) {
    const outcome = outcomeOf(e);
    if (outcome === 'ok') continue;
    const key = `${outcome}:${e.error || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (outcome === 'error') errors += 1;
    else limitations += 1;
  }
  return { steps: log.length, errors, limitations };
}
