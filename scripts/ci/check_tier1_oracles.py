#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""A Tier-1 tool is VERIFIED only if its oracle actually RAN and PASSED.

THE LOOPHOLE THIS CLOSES. `test_tool_certification_matrix.py` checks that every
VERIFIED tool names a test FILE and that the file exists. A file existing is not
an oracle executing. A test that begins

    if res.get("ok") is not True:
        pytest.skip("the tool declined")

turns a product regression into a green suite: the call starts being refused, the
case skips, nothing fails, and the matrix goes on reporting the tool VERIFIED
because the file is still there.

So the declaration names NODE IDS, not files, and this runs them. A node that is
missing, skipped, errored or failed is reported by name, and the exit code is
non-zero. `-p no:randomly` because a node id must resolve to the same test every
time for this to mean anything.

    python scripts/ci/check_tier1_oracles.py [--json]

Exit codes:  0 every Tier-1 oracle ran and passed
             1 one or more did not
             3 the declaration or pytest could not be read
"""
from __future__ import annotations

import argparse
import json
import pathlib
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET

REPO = pathlib.Path(__file__).resolve().parents[2]
DECL = REPO / "scripts" / "cert" / "tool_certification.yaml"
BACKEND = REPO / "backend"


def _load() -> dict:
    try:
        import yaml
    except ImportError:                                         # pragma: no cover
        print("PyYAML is required to read the certification declaration")
        raise SystemExit(3)
    if not DECL.exists():
        print(f"certification declaration not found: {DECL}")
        raise SystemExit(3)
    return (yaml.safe_load(DECL.read_text(encoding="utf-8")) or {}).get("tools") or {}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    tools = _load()
    tier1 = {n: e for n, e in tools.items() if e.get("tier") == 1}
    if not tier1:
        print("no tier-1 tools declared — that is itself wrong")
        return 3

    # node id -> the tools that depend on it
    wanted: dict[str, list[str]] = {}
    undeclared: list[str] = []
    for name, entry in sorted(tier1.items()):
        nodes = entry.get("oracle_nodes") or []
        if not nodes:
            undeclared.append(name)
            continue
        for node in nodes:
            wanted.setdefault(node, []).append(name)

    if undeclared:
        print("TIER-1 tools declaring no oracle_nodes:")
        for name in undeclared:
            print(f"  {name}")
        print("\nA Tier-1 tool must name the test NODES that prove it, not only a file.")
        return 1

    # A MACHINE-READABLE REPORT, NOT SCRAPED TEXT.
    #
    # The first version parsed pytest's `-rs` lines with a regex, and its own
    # mutation control caught it: a `pytest.skip` put back into a declared oracle
    # produced "every tier-1 oracle ran and passed". Pytest exits 0 on a skip and
    # the regex did not match, so the gate built to stop a silent skip reported
    # success while one was happening. JUnit XML says per test case, in a schema,
    # whether it ran.
    with tempfile.TemporaryDirectory() as tmp:
        report = pathlib.Path(tmp) / "oracles.xml"
        proc = subprocess.run(
            [sys.executable, "-m", "pytest", "-q", "-p", "no:randomly",
             f"--junitxml={report}", *sorted(wanted)],
            cwd=BACKEND, capture_output=True, text=True,
        )
        out = proc.stdout + proc.stderr
        if not report.exists():
            print("pytest produced no report — a declared node id may not exist")
            print(out[-1500:])
            return 1
        tree = ET.parse(report)

    seen: dict[str, str] = {}
    for case in tree.iter("testcase"):
        # `file` IS NOT ALWAYS THERE. This pytest emits `file=None` and puts the
        # dotted module in `classname`, so reading `file` made every node look
        # MISSING — a gate that fails closed, which is the right direction, but
        # for the wrong reason and with a message that sends the reader hunting
        # for a test that exists. Derive the path from `classname`, dropping a
        # trailing class segment if the test lives in one.
        path = (case.get("file") or "").replace("\\", "/")
        if not path:
            parts = (case.get("classname") or "").split(".")
            while parts and parts[-1][:1].isupper():
                parts.pop()
            path = "/".join(parts) + ".py" if parts else ""
        node = f"{path}::{case.get('name')}"
        state = "PASS"
        if case.find("skipped") is not None:
            state = "SKIPPED"
        elif case.find("failure") is not None:
            state = "FAILED"
        elif case.find("error") is not None:
            state = "ERROR"
        seen[node] = state

    bad: dict[str, str] = {}
    for node in sorted(wanted):
        state = seen.get(node)
        if state is None:
            bad[node] = "MISSING"
        elif state != "PASS":
            bad[node] = state

    summary = {
        "tier1_tools": len(tier1),
        "oracle_nodes": len(wanted),
        "passed": not bad and proc.returncode == 0,
        "bad": bad,
        "pytest_returncode": proc.returncode,
    }

    if args.json:
        print(json.dumps(summary, indent=2))
    else:
        print(f"tier-1 tools      : {len(tier1)}")
        print(f"oracle nodes      : {len(wanted)}")
        for node in sorted(wanted):
            state = bad.get(node, "PASS")
            print(f"  {state:<8} {node}   ({', '.join(wanted[node])})")
        if bad:
            print("\nA Tier-1 oracle that skips is not coverage. Either the "
                  "fixture is not valid (fix the test) or the tool now refuses a "
                  "valid call (fix the tool).")
    if summary["passed"]:
        print("\nevery tier-1 oracle ran and passed")
        return 0
    if not bad and proc.returncode != 0:
        print(out[-1500:])
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
