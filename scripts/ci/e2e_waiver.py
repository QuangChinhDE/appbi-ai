#!/usr/bin/env python3
"""May this pull request skip its end-to-end shards because it was verified locally?

Owner decision 2026-10-28: a change already run end to end on the local stack need
not wait for the same journeys on GitHub. Product gate runs THIS file from the PR's
BASE commit (never the PR's own copy) and waives E2E only when ALL of these hold:

  * the PR carries the label `verified-locally` (only a maintainer can label);
  * the head commit contains `.verified/local-e2e.json`
    (scripts/ci/record_local_verification.py);
  * its `tested_sha` is a commit of this repository and an ancestor of the head;
  * the head differs from `tested_sha` by NOTHING but that evidence file - no line
    of code reaches the PR that was not the code tested;
  * at least one suite is recorded and every recorded suite passed with nothing failed.

Anything else: the waiver is refused with the reason and E2E runs as before. Backend
suites are never waived, and every push to `demo` still runs the full E2E.

Env: NEEDED_E2E ("true"/"false", the classification), LABELS (JSON list), HEAD (sha),
GITHUB_OUTPUT, GITHUB_STEP_SUMMARY. Writes `e2e=` and `waived=` outputs.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys

EVIDENCE = ".verified/local-e2e.json"
LABEL = "verified-locally"


def _git(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(["git", *args], capture_output=True, text=True)


def problems_with(evidence: dict, head: str) -> list[str]:
    """Why this evidence does not prove the head was tested; [] when it does."""
    out: list[str] = []
    tested = str(evidence.get("tested_sha") or "")
    if len(tested) != 40 or _git("cat-file", "-e", f"{tested}^{{commit}}").returncode != 0:
        return ["tested_sha is not a commit of this repository"]
    if _git("merge-base", "--is-ancestor", tested, head).returncode != 0:
        return ["tested_sha is not an ancestor of the head"]
    extra = [f for f in _git("diff", "--name-only", tested, head).stdout.split() if f != EVIDENCE]
    if extra:
        out.append(f"the head changes {len(extra)} file(s) after the tested commit: " + ", ".join(extra[:8]))
    suites = evidence.get("suites") or []
    if not suites:
        out.append("no suite is recorded")
    for s in suites:
        if int(s.get("failed") or 0) or int(s.get("passed") or 0) <= 0:
            out.append(f"suite {s.get('name')!r} did not pass (passed={s.get('passed')}, failed={s.get('failed')})")
    return out


def decide(needed: bool, labels: list[str], head: str) -> tuple[bool, bool, str]:
    """(e2e still required, waived, the reason)."""
    if not needed:
        return False, False, "E2E is not relevant for this diff; nothing to waive."
    if LABEL not in labels:
        return True, False, f"No `{LABEL}` label: E2E runs."
    shown = _git("show", f"{head}:{EVIDENCE}")
    if shown.returncode != 0:
        return True, False, f"`{LABEL}` REFUSED, E2E runs: `{EVIDENCE}` is not in the head commit"
    try:
        evidence = json.loads(shown.stdout)
    except ValueError:
        return True, False, f"`{LABEL}` REFUSED, E2E runs: `{EVIDENCE}` is not valid JSON"
    problems = problems_with(evidence, head)
    if problems:
        return True, False, f"`{LABEL}` REFUSED, E2E runs: " + "; ".join(problems)
    names = ", ".join(f"{s.get('name')} ({s.get('passed')} passed)" for s in evidence["suites"])
    return False, True, (f"E2E waived: verified locally at `{evidence['tested_sha'][:12]}` (runtime "
                         f"`{str(evidence.get('runtime_sha') or '?')[:12]}`): {names}. The full E2E still "
                         "runs on the push to demo.")


def main() -> int:
    needed = os.environ.get("NEEDED_E2E") == "true"
    labels = json.loads(os.environ.get("LABELS") or "[]") or []
    e2e, waived, why = decide(needed, labels, os.environ["HEAD"])
    with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as out:
        out.write(f"e2e={'true' if e2e else 'false'}\nwaived={'true' if waived else 'false'}\n")
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as fh:
            fh.write(f"### E2E waiver\n\n{why}\n")
    kind = "notice" if waived else ("warning" if LABEL in labels else "notice")
    print(f"::{kind} title=E2E waiver::{why}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
