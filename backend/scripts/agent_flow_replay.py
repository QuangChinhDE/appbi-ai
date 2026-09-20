#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Replay the tracked Agent Flow fixtures and compare against committed snapshots.

    python scripts/agent_flow_replay.py --snapshot    # record current behaviour
    python scripts/agent_flow_replay.py --verify      # fail on semantic drift
    python scripts/agent_flow_replay.py --show NAME   # print one canonical result

The suite `tests/test_agent_flow_replay.py` runs the same comparison in CI. This
CLI exists for the loop a developer actually works in: change something, see which
fixture moved and in what field, before pushing.

THERE IS NO `--update`. `--snapshot` overwrites everything, which is a deliberate
blunt instrument: it is for establishing a baseline, not for making a red build
green. A snapshot that changes must change in the same commit as the code that
changed it, with the diff in the commit message.
"""
from __future__ import annotations

import argparse
import json
import pathlib
import sys

HERE = pathlib.Path(__file__).resolve().parent
BACKEND = HERE.parent
sys.path.insert(0, str(BACKEND))
sys.path.insert(0, str(BACKEND / "tests"))

import replay_harness as H  # noqa: E402


class _Patch:
    """The two-method subset of pytest's monkeypatch that the harness uses.

    The harness is written against monkeypatch so the test suite can use it
    directly; this gives the CLI the same seam without importing pytest.
    """

    def __init__(self) -> None:
        self._undo: list[tuple] = []

    def setattr(self, target, name, value):
        self._undo.append((target, name, getattr(target, name)))
        setattr(target, name, value)

    def undo(self) -> None:
        for target, name, old in reversed(self._undo):
            setattr(target, name, old)
        self._undo = []


def _replay_one(fixture: dict) -> dict:
    patch = _Patch()
    try:
        return H.replay(fixture, patch)
    finally:
        patch.undo()


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    group = ap.add_mutually_exclusive_group(required=True)
    group.add_argument("--snapshot", action="store_true",
                       help="record current behaviour as the baseline")
    group.add_argument("--verify", action="store_true",
                       help="compare against committed snapshots")
    group.add_argument("--show", metavar="NAME",
                       help="print one fixture's canonical result")
    args = ap.parse_args()

    fixtures = H.load_fixtures()
    if not fixtures:
        print("no fixtures found in %s" % H.FIXTURE_DIR)
        return 2

    if args.show:
        match = [f for f in fixtures if args.show in f["name"]]
        if not match:
            print("no fixture matching %r" % args.show)
            return 2
        for fixture in match:
            print(json.dumps(_replay_one(fixture), ensure_ascii=False, indent=2,
                             sort_keys=True))
        return 0

    if args.snapshot:
        for fixture in fixtures:
            H.write_snapshot(fixture["name"], _replay_one(fixture))
            print("snapshot  %s" % fixture["name"])
        print("\n%d snapshots written to %s" % (len(fixtures), H.SNAPSHOT_DIR))
        return 0

    drifted = 0
    for fixture in fixtures:
        name = fixture["name"]
        expected = H.read_snapshot(name)
        if expected is None:
            print("MISSING   %s  (run --snapshot and commit)" % name)
            drifted += 1
            continue
        differences = H.diff(expected, _replay_one(fixture))
        if differences:
            drifted += 1
            print("DRIFT     %s" % name)
            for line in differences[:20]:
                print("            %s" % line)
        else:
            print("ok        %s" % name)

    print()
    if drifted:
        print("%d/%d fixtures drifted." % (drifted, len(fixtures)))
        print("If the change was intended, update the snapshots IN THE SAME COMMIT")
        print("as the code, and put the diff in the commit message.")
        return 1
    print("%d fixtures, no semantic drift." % len(fixtures))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
