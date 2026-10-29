"""Sealed evaluation harness for AppBI Intelligence (ADR-008, spec §6).

WHAT "SEALED" MEANS HERE
------------------------
An evaluation case is a question with an answer computed INDEPENDENTLY of the
system under test: an oracle query over a small, version-controlled fixture,
cross-checked against hand-computed values in the harness tests.

Three properties keep a score honest, and each one has a test:

* **Runtime cannot read it.** This package lives outside `backend/app`. No
  runtime module may import it or read its files. The AI cannot retrieve a
  holdout answer it was never given.
* **No trusted asset doubles as a holdout case.** `leakage.find_leaks` compares
  every holdout question against the trusted knowledge (VerifiedQA questions and
  triggers, SQL examples) of the snapshot the eval runs on. A leaking case is
  excluded and reported, not scored.
* **The eval runs on an isolated knowledge snapshot with memory capture off.**
  `runner.evaluate` refuses to run without both. Otherwise repeated eval runs
  would teach the system the answers.

Historical reports are baselines, never certification of a new system.
"""
