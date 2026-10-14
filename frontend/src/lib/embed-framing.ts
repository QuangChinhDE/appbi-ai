/**
 * Embed framing decision — pure, no imports, so the contract script
 * (scripts/check-embed-framing-contract.mjs) runs the exact code the
 * middleware runs.
 *
 * The browser is the only party that knows which site frames a page, so the
 * guard lives on the page response: `Content-Security-Policy: frame-ancestors`
 * (cannot be spoofed by the embedding page) plus a refusal when an
 * origin-restricted integration link is opened outside an iframe.
 *
 * Contract (docs/embed-integration-api.md):
 *  - An `emb_` integration grant is served on `/embed/` ONLY. `/d/emb_…` is
 *    refused: the per-grant origin policy exists on the embed surface alone.
 *  - The backend answers a policy STATE: `unrestricted` | `restricted` |
 *    `invalid`. Matching the framing origin against the allowlist is decided
 *    by the backend (one canonical matcher) and returned as `origin_allowed`.
 *  - FAIL CLOSED: if no trustworthy policy can be had for an `emb_` token — the
 *    lookup failed and there is no known-good cached answer — the page is
 *    refused. An unknown, expired or revoked grant is `invalid`, never
 *    "unrestricted".
 *  - The deployment-wide floor (`EMBED_FRAME_ANCESTORS`) is ALWAYS emitted on
 *    `/d` and `/embed` when set, as its own CSP header: a browser enforces
 *    every CSP it receives, so a grant allowlist can narrow the floor but never
 *    widen it.
 */

export type EmbedPolicyState = 'unrestricted' | 'restricted' | 'invalid';

export interface EmbedPolicy {
  state: EmbedPolicyState;
  allowedOrigins: string[];
  /** Backend's verdict for the framing origin it was asked about (null = not asked / no origin). */
  originAllowed: boolean | null;
}

export type FramingRefusal = 'wrong-surface' | 'unavailable' | 'invalid' | 'not-framed' | 'origin';

export type FramingDecision =
  | { kind: 'refuse'; reason: FramingRefusal; status: number; csp: string[] }
  | { kind: 'serve'; csp: string[] };

export const EMBED_GRANT_PREFIX = 'emb_';
export const POLICY_FRESH_MS = 60_000;
/** A grant lives at most 1h, so a known-good policy older than that is worthless. */
export const POLICY_STALE_MAX_MS = 60 * 60 * 1000;

/** Parse the backend response. Anything malformed is `null` (= no trustworthy answer). */
export function parsePolicyResponse(data: unknown): EmbedPolicy | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  const state = d.state;
  if (state !== 'unrestricted' && state !== 'restricted' && state !== 'invalid') return null;
  const origins = Array.isArray(d.allowed_origins) ? d.allowed_origins.filter((v): v is string => typeof v === 'string') : [];
  if (state === 'restricted' && origins.length === 0) return null; // contradictory → untrusted
  const oa = d.origin_allowed;
  return { state, allowedOrigins: origins, originAllowed: typeof oa === 'boolean' ? oa : null };
}

/** Reduce a Referer URL to its origin, lowercased. */
export function originOf(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return `${url.protocol}//${url.host}`.toLowerCase();
  } catch {
    return null;
  }
}

function floorCsp(floor: string): string[] {
  const fa = (floor || '').trim();
  return fa ? [`frame-ancestors 'self' ${fa};`] : [];
}

export interface FramingInput {
  /** 'd' | 'embed' — which public surface the path is on. */
  surface: 'd' | 'embed';
  token: string;
  /** Sec-Fetch-Dest (browser-set). null when absent (old browser, curl). */
  dest: string | null;
  /** Origin of the Referer, if any. */
  origin: string | null;
  /** Fresh policy from the backend, or a known-good cached one; null when none is available. */
  policy: EmbedPolicy | null;
  /** EMBED_FRAME_ANCESTORS (space-separated), '' when unset. */
  floor: string;
}

export function decideEmbedFraming(input: FramingInput): FramingDecision {
  const floor = floorCsp(input.floor);
  const isGrant = input.token.startsWith(EMBED_GRANT_PREFIX);

  if (!isGrant) return { kind: 'serve', csp: floor };

  if (input.surface !== 'embed') {
    return { kind: 'refuse', reason: 'wrong-surface', status: 404, csp: ["frame-ancestors 'none';"] };
  }
  const policy = input.policy;
  if (!policy) {
    return { kind: 'refuse', reason: 'unavailable', status: 503, csp: ["frame-ancestors 'none';"] };
  }
  if (policy.state === 'invalid') {
    return { kind: 'refuse', reason: 'invalid', status: 410, csp: floor };
  }
  if (policy.state === 'unrestricted') return { kind: 'serve', csp: floor };

  // restricted
  const grantCsp = [`frame-ancestors ${policy.allowedOrigins.join(' ')};`, ...floor];
  const dest = input.dest;
  if (dest && dest !== 'iframe' && dest !== 'embed' && dest !== 'frame') {
    return { kind: 'refuse', reason: 'not-framed', status: 403, csp: grantCsp };
  }
  // The backend's canonical matcher decided; frame-ancestors still binds the
  // browser when no Referer was sent (`referrer: no-referrer` hosts) or when a
  // cached policy is used without a per-origin verdict.
  if (input.origin && policy.originAllowed === false) {
    return { kind: 'refuse', reason: 'origin', status: 403, csp: grantCsp };
  }
  return { kind: 'serve', csp: grantCsp };
}

export interface CachedPolicy { policy: EmbedPolicy; at: number }

/**
 * Pick the policy to decide with: a fresh lookup wins; if the lookup failed,
 * a known-good cached policy no older than a grant can live is used; otherwise
 * null (→ refuse). A cached answer never stands in for a failed lookup beyond
 * that bound.
 */
export function choosePolicy(fresh: EmbedPolicy | null, cached: CachedPolicy | undefined, now: number): EmbedPolicy | null {
  if (fresh) return fresh;
  if (cached && now - cached.at <= POLICY_STALE_MAX_MS) {
    // Without a fresh per-origin verdict, rely on frame-ancestors (browser-enforced).
    return { ...cached.policy, originAllowed: null };
  }
  return null;
}
