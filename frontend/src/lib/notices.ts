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
