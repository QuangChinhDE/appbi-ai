# AI Chat product hardening — intent

## Problem

The Chat module (`/chat`, Direct Chat on the Agent Flow engine) worked on its happy
path but broke on the paths a real reader takes: switching conversations mid-answer,
reloading a typed answer, being given a conversation to read, using a phone, being
outside the reader pilot, or holding the `chat` permission without builder access.
An audit on 2026-10-12 (base `360aeaea`) confirmed ten hypotheses at runtime and found
more (see `spec.md`).

## Goal

Chat behaves as a trustworthy conversational workspace on top of Agent Flow:

- one turn belongs to one thread; nothing leaks between threads;
- what is on screen is what reload shows, typed answers included;
- read-only means read-only on every path, including oversight;
- a reader is told *before* typing when an assistant cannot answer them;
- the conversation list, sources, follow-ups and rating work on desktop and mobile;
- system text follows the UI language.

Agent Flow stays the only execution engine. No parallel runtime, no second
transcript store.

## Out of scope

Live-model answer quality, server-side localisation of every engine notice, Agent
Flow Studio, the dashboard bot beyond the shared `AnswerBlocks` change, file
upload, regenerate/edit-message, export, a message table separate from run content.

## Constraints

Shared code changes only where Chat cannot be fixed alone (`permissions.py`
scope, `runs.prune`, `AnswerBlocks`), each with a regression test. Additive API
fields only. No migration. Reader rollout policy unchanged.

## Acceptance criteria

See `plan.md` — Tests. Release additionally needs the live-model gate, which is
blocked in this environment (no provider credentials).

## Open questions

- Should a turn keep running server-side after the reader leaves its thread
  (background continuation) instead of stopping? Chosen: stop, recorded as
  abandoned — simple and honest. Background continuation is a future enhancement.
- Retention of deleted threads' content follows the run-content window (180 days).
