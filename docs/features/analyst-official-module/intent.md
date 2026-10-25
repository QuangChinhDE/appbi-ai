# AI Analyst as an official module — intent

## Problem

The PO directive (2026-10-26) makes AI Analyst ("Phân tích dữ liệu") an official AppBI
module. The Phase 0 audit of `demo` `cc439a7d` found these issues in the code:

| # | User complaint | Root cause in code |
|---|---|---|
| F1 | Analyst looks different from the rest of AppBI | `app/(main)/analyst/page.tsx` has 91 hardcoded hex colours (25 distinct, Google Material). It uses no shared component (`Button`, `Badge`, `EmptyState`, `Select`) and no type scale, so dark mode does not apply |
| F2 | "Why are AI Chat and Analyst separate?" | The sidebar lists Analyst and AI Chat as two unrelated items in "Intelligence", with no explanation of the difference |
| F3 | A refresh loses the analysis | Exchanges live only in React state (`history`). Nothing is persisted and there is no URL |
| F4 | An analysis cannot be shared | There is no Analyst resource. `analyst` has only `none/view` levels, while `require_full_access` gives an owner sharing rights only at `edit` or above |
| F5 | It looks like an experiment | `ANALYST_PILOT_ALLOWLIST` (empty means nobody), the "(pilot)/(thí điểm)" labels, the preview badge and the pilot error strings |
| F6 | Follow-ups trust the browser | `previous_plan` is echoed by the client. The server re-validates it, but has no record of its own |

The complaints come from the PO directive. The QA team has not supplied screenshots or
recordings, so the root causes above are found in the code, not observed from users. The
before/after browser evidence for each complaint is in `closure.md`.

## Outcome

1. One AI area with two clearly explained modes: "Trợ lý AI" (Chat) and "Phân tích dữ
   liệu" (Analyst). The engines stay separate, and `/chat` and `/analyst` URLs are kept.
2. Analyst sessions are persisted, reopenable at `/analyst/s/{id}`, renamable and
   deletable.
3. Sessions can be shared with users and teams through the existing `ResourceShare`,
   `/shares` and `ShareDialog`, at view or edit, and revoked.
   **A share never grants a Dataset:** stored answers are redacted for anyone who
   currently cannot read their sources.
4. `analyst` gets the standard none/view/edit/full levels. The allowlist becomes an
   optional extra restriction. `ANALYST_ENABLED` stays as the operator kill switch.
5. The Analyst UI uses AppBI tokens and shared components.

## Out of scope

- Merging the Chat and Analyst engines.
- Redesigning AppBI navigation.
- Certifying business accuracy: no "verified" badge.
- Editing the Chat components that open PRs #16/#17 touch.
