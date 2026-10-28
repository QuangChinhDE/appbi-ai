#!/usr/bin/env python3
"""Record that THIS commit passed end-to-end on the local stack, for a fast PR.

    python scripts/ci/record_local_verification.py \
        --suite "public bot=../.artifacts/ai-bot-public-appbi/results.json" \
        --suite "AI Chat replay=../.artifacts/ai-chat-appbi-replay/results.json"

Writes `.verified/local-e2e.json`; commit it ALONE on top of the tested commit and
label the PR `verified-locally` - Product gate (scripts/ci/e2e_waiver.py, run from the
base) then skips the PR's E2E shards. It refuses to record when:

  * the working tree has changes (other than the evidence file): the evidence must
    describe a commit, not a working copy;
  * the local stack does not run this commit (APPBI build sha from
    http://127.0.0.1:8000/api/v1/health), unless --runtime-sha names what ran;
  * any suite's Playwright JSON report has a failed/flaky test, or ran nothing.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
EVIDENCE = ROOT / ".verified" / "local-e2e.json"


def _git(*args: str) -> str:
    return subprocess.run(["git", *args], cwd=ROOT, capture_output=True, text=True, check=True).stdout.strip()


def suite_counts(report: Path) -> dict:
    stats = json.loads(report.read_text(encoding="utf-8")).get("stats") or {}
    return {"passed": int(stats.get("expected") or 0), "failed": int(stats.get("unexpected") or 0),
            "flaky": int(stats.get("flaky") or 0), "skipped": int(stats.get("skipped") or 0)}


def runtime_sha(url: str) -> str:
    with urllib.request.urlopen(url, timeout=10) as r:
        return str(json.load(r).get("git_sha") or "")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--suite", action="append", required=True, metavar="NAME=REPORT_JSON")
    ap.add_argument("--runtime-sha", help="the build sha the local stack ran (default: ask the stack)")
    ap.add_argument("--health-url", default="http://127.0.0.1:8000/api/v1/health")
    args = ap.parse_args(argv)

    head = _git("rev-parse", "HEAD")
    dirty = [line for line in _git("status", "--porcelain").splitlines() if ".verified/" not in line]
    if dirty:
        print(f"refused: the working tree has {len(dirty)} change(s); record a committed state", file=sys.stderr)
        return 2
    ran = args.runtime_sha or runtime_sha(args.health_url)
    if ran != head:
        print(f"refused: the local stack runs {ran[:12] or '?'}, not the tested commit {head[:12]}; "
              "rebuild it from this commit", file=sys.stderr)
        return 2
    suites = []
    for item in args.suite:
        name, _, path = item.partition("=")
        counts = suite_counts(Path(path))
        if counts["failed"] or counts["flaky"] or counts["passed"] <= 0:
            print(f"refused: suite {name!r} did not pass cleanly: {counts}", file=sys.stderr)
            return 2
        suites.append({"name": name.strip(), **counts})
    EVIDENCE.parent.mkdir(exist_ok=True)
    EVIDENCE.write_text(json.dumps({
        "tested_sha": head, "runtime_sha": ran, "suites": suites,
        "recorded_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "recorded_by": _git("config", "user.email") or _git("config", "user.name"),
    }, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"recorded {EVIDENCE.relative_to(ROOT)} for {head[:12]}: "
          + ", ".join(f"{s['name']} {s['passed']} passed" for s in suites))
    print("next: commit ONLY that file, push, and label the PR `verified-locally`")
    return 0


if __name__ == "__main__":
    sys.exit(main())
