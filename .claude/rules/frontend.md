---
name: frontend
description: Next.js / TypeScript conventions for AppBI's frontend. Load when editing frontend/src.
globs:
  - "frontend/**"
---

# Frontend rules

Scope: `frontend/src/**`. Next.js App Router, TypeScript, standalone output.

## API access — the one that matters most

- Authenticated pages call the backend through `@/lib/api-client` (`apiClient`), which
  carries the httpOnly auth cookie, refreshes on 401, and redirects to login.
- **Public/embed pages must not import `apiClient` at all.** `app/d/[token]/**`,
  `app/embed/[token]/**` and anything they render use `@/lib/api/public.ts`
  (`publicClient`, a plain axios/fetch with no credentials). A single authed call from a
  public page leaks data to a logged-out viewer and is a security bug.
  Guardrail invariant: `public_client_only`, `scope_bound_no_leak`.
- Grouped endpoint modules live in `frontend/src/lib/api/*.ts` (`charts`, `dashboards`,
  `datasources`, `public`, `workboards`, `workspace`, …). Add an endpoint to the existing
  module for its resource; do not create a new client.

## Structure

| Concern | Location |
|---|---|
| Routes/pages | `src/app/**` (App Router) |
| Components | `src/components/<area>/**` |
| Shared logic, clients, formatting | `src/lib/**` |
| Types mirroring backend schemas | `src/types/**` |
| Hooks | `src/hooks/**` · React Query via `@tanstack/react-query` |
| i18n | `src/i18n/**` — EN + VI. User-visible strings go through it |

## Verifiable contracts — these are scripts, not opinions

Run `npm run qa` (or the individual check) when you touch the area it guards:

- `qa:module-routes` — every module page in `Sidebar.tsx` must be mapped in
  `lib/moduleRoutes.ts`. `moduleForPath()` fails **open** for an unmapped route, so a
  forgotten route silently shows a module shell to a user with no access. Adding a module
  page means adding its route mapping in the same change.
- `qa:theme` — dashboard theme presets / token layer must stay in sync.
- `qa:presentation` — the presentation contract v1 used by Experience Studio / AI design.

## Permissions

Hiding a nav item is not access control — the backend is the boundary. A frontend guard
(`type !== 'X'`, a hidden menu) may only *reflect* a rule the backend already enforces;
never add one as the enforcement. Conversely, do not tighten a frontend guard so far that
it hides a backend capability the user legitimately has.

## Discipline

- Loading / error / empty states: match the surrounding page's existing pattern — this
  codebase already has one for every surface. Do not invent a new one.
- A numeric limit in the UI is usually paired with a `Field(le=…)` bound in the backend
  schema. Raising one without the other produces a 422 the user cannot explain
  (guardrail invariant `fe_be_limit_pair`).
- `npm run typecheck` (`tsc --noEmit`) must be clean before you call anything done.
- A frontend source change is not proven by reading source. For behaviour changes, verify
  against a **running build** — a stale standalone build is a real and recurring failure
  mode here.
