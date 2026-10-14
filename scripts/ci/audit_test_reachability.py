#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Which committed backend tests can actually run in CI, and which cannot.

WHY THIS EXISTS
---------------
`verify.py task` reports

    Backend tests reach CI — ok: every allow-listed suite exists and is run by CI

and that sentence is true and misleading at the same time. It compares the
`.gitignore` allow-list against the workflow's pytest list — two sets that happen
to be identical — and never looks at a test that is in NEITHER. A file committed
with `git add -f`, skipping the allow-list and the workflow, is tracked, survives
a fresh clone, looks like coverage in the tree, and never executes.

READ-ONLY, AND NOT WIRED INTO CI. This is audit infrastructure for the Agent Flow
rework (docs/features/agent-flow-chat-rework/). It changes nothing, fixes nothing
and gates nothing; it prints an inventory so a claim about coverage can be checked
rather than believed.

    python scripts/ci/audit_test_reachability.py [--json]
"""
from __future__ import annotations

import argparse
import io
import json
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

#: WHAT THE TEST IMPORTS, not what it is called.
#:
#: A filename regex put `test_govern_knowledge_tools.py` outside the feature and
#: `test_what_the_ai_sees.py` inside it, on the strength of the characters in the
#: name. Imports are the real dependency: a test that imports
#: `app.services.agent_flows` or `app.modules.agent_flows` exercises this subsystem
#: whatever it is called, and one that does not, does not.
AREA_IMPORT = re.compile(r"app\.(?:services|modules)\.agent_flows")
#: Adjacent, not the same thing. The knowledge/RAG side is shared WITH Agent Flow but
#: is its own subsystem (Knowledge Hub); sweeping it in would quietly triple this
#: rework's scope, which is the opposite of what an inventory is for.
ADJACENT_IMPORT = re.compile(r"app\.services\.dashboard_ai_bot")


def _read(path: str) -> str:
    try:
        return io.open(os.path.join(ROOT, path), encoding="utf-8").read()
    except OSError:
        return ""


def _tracked_tests() -> set[str]:
    out = subprocess.run(
        ["git", "ls-files", "backend/tests"],
        cwd=ROOT, capture_output=True, text=True,
    ).stdout.split()
    return {
        os.path.basename(p) for p in out
        if os.path.basename(p).startswith("test_") and p.endswith(".py")
    }


def _referenced_anywhere() -> dict[str, set[str]]:
    """Every runner that names a test file, not just the contract workflow.

    Checking one workflow would repeat the bug this script exists to find.
    """
    sources = {
        ".github/workflows/backend-contract-tests.yml": "backend-contract-tests",
        ".github/workflows/e2e.yml": "e2e",
        ".github/workflows/preflight.yml": "preflight",
        "scripts/ci/preflight.sh": "preflight.sh",
        "scripts/ci/verify.py": "verify.py",
        "scripts/guardrail/guardrail_rules.yaml": "guardrail_rules",
    }
    hits: dict[str, set[str]] = {}
    for path, label in sources.items():
        text = _read(path)
        for name in re.findall(r"(test_\w+\.py)", text):
            hits.setdefault(name, set()).add(label)
    return hits


def _allow_listed() -> set[str]:
    return set(re.findall(r"!backend/tests/(test_\w+\.py)", _read(".gitignore")))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    tracked = _tracked_tests()
    refs = _referenced_anywhere()
    allow = _allow_listed()

    runnable = {t for t in tracked if t in refs}
    ghosts = sorted(tracked - runnable)

    def in_area(name: str) -> bool:
        return bool(AREA_IMPORT.search(_read(f"backend/tests/{name}")))

    def adjacent(name: str) -> bool:
        return bool(ADJACENT_IMPORT.search(_read(f"backend/tests/{name}")))

    area_ghosts = [t for t in ghosts if in_area(t)]
    adj_ghosts = [t for t in ghosts if not in_area(t) and adjacent(t)]
    other_ghosts = [t for t in ghosts if not in_area(t) and not adjacent(t)]

    report = {
        "tracked_backend_tests": len(tracked),
        "referenced_by_a_runner": len(runnable),
        "never_referenced": len(ghosts),
        "allow_listed": len(allow),
        "agent_flow_area_ghosts": area_ghosts,
        "adjacent_knowledge_ghosts": adj_ghosts,
        "unrelated_ghosts": other_ghosts,
        # A file in the allow-list that no runner names: the allow-list says "commit
        # this" and nothing says "run it".
        "allow_listed_but_unreferenced": sorted(allow - set(refs)),
    }

    if args.json:
        print(json.dumps(report, indent=2))
        return 0

    print(f"tracked backend test files : {report['tracked_backend_tests']}")
    print(f"referenced by some runner  : {report['referenced_by_a_runner']}")
    print(f"NEVER referenced           : {report['never_referenced']}")
    print(f"  of which Agent Flow area : {len(area_ghosts)}")
    print(f"  of which adjacent (knowledge/RAG) : {len(adj_ghosts)}")
    print(f"  of which unrelated       : {len(other_ghosts)}")
    print("\nAGENT FLOW / DIRECT CHAT — committed, never run:")
    for t in area_ghosts:
        print(f"    {t}")
    print("\nADJACENT (Knowledge Hub / RAG — shared with flows, its own subsystem):")
    for t in adj_ghosts:
        print(f"    {t}")
    print("\nUNRELATED — committed, never run (separate follow-up, NOT this rework):")
    for t in other_ghosts:
        print(f"    {t}")
    if report["allow_listed_but_unreferenced"]:
        print("\nallow-listed but no runner names them:")
        for t in report["allow_listed_but_unreferenced"]:
            print(f"    {t}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
