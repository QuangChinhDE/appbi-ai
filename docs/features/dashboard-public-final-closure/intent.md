# Dashboard Public / Embed final closure — intent

**Status:** in progress
**Owner:** de-internal@base.vn
**Date:** 2026-10-05
**Audit baseline:** `e0623fb5` (origin/demo)

## Problem

An independent audit of the surfaces that take a dashboard outside AppBI (public page
`/d/<token>`, stable embed `/embed/<token>`, integration embed `/embed/emb_…`, and their
data APIs) found, on the audited head:

- **Revocation did not revoke.** Migration 0019 copied every legacy `Dashboard.share_token`
  into a "Default" public link but left the column, and the resolver fell back to it:
  disabling or deleting that link left the same URL serving the report with no password,
  expiry or active flag.
- **User filter values could break out of SQL literals** on BigQuery and MySQL (backslash
  escapes; builders only doubled quotes). On BigQuery `'O''Brien'` also silently matched
  "OBrien".
- **Per-IP rate limits could be bypassed** by rotating `X-Forwarded-For` (uvicorn trusted
  every forwarder and took the client-written leftmost entry) — including the public link
  password limit.
- **Any logged-in viewer could mint an integration embed URL** for a whole report: the
  "PAT" endpoint accepted browser sessions and only needed view access.
- **The embed origin allowlist failed open** whenever its policy lookup failed, and an
  unknown/expired grant looked the same as an unrestricted one; `/d/emb_…` skipped it.
- **Password sessions survived** a password change, and came back after disable/re-enable.
- **Published reports showed different numbers than the Builder** whenever parameter
  switchers, what-if bindings or tile parameters were used.
- **"Preview before publish" was a mock**; several link fields (`allowed_ips`,
  `max_access_count`, most appearance fields) looked enforced but were not; the embed
  integration doc was not in the repository.

## Goal

One token authority with deterministic revocation; no user value can change a query's
structure; integration embedding is an explicit, PAT-only, edit-level capability with a
fail-closed origin policy; and a published report computes the same business result as the
Builder on every surface — proven by tracked tests that run in CI.

## Out of scope

- The AI assistant on public links (only its log lines and its use of the shared filter
  authority were touched).
- Rewriting the dashboard renderer or merging `ChartTile` and `ReadonlyChartTile`.
- An immutable published-revision table (the draft overlay stays the publish boundary).
- Workboard internals beyond the token-authority change (manual-mode token validation).
- Literal escaping in author-only SQL paths (data-quality rules, type overrides,
  transformation compiler) — listed as residual risk.
- Fixing stale references to `docs/filter-semantics.md` across the semantic layer.
