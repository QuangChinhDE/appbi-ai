#!/usr/bin/env python3
"""Drive the AppBI Engineering Guardrail from the command line.

WHY THIS EXISTS
---------------
`scripts/guardrail` already encodes the architecture rules, the
protected subsystems, the impact map and the test registry — but it only speaks
MCP, so it can only help when an AI assistant happens to call it. That makes the
repo's best-encoded knowledge *advisory*.

`guardrail_core.py` is plain Python + PyYAML with no MCP dependency, so the same
rule base can be run by a hook, a script, or CI. This wrapper does that. It adds
no rules of its own: every answer comes from `guardrail_rules.yaml`.

USAGE
-----
    python scripts/ci/guardrail_check.py --diff                 # validate the working diff
    python scripts/ci/guardrail_check.py --diff --staged        # validate the staged diff
    python scripts/ci/guardrail_check.py --files a.py b.tsx     # impact + required tests
    python scripts/ci/guardrail_check.py --plan "fix X" --files a.py
    python scripts/ci/guardrail_check.py --health               # rules health + contract drift

EXIT CODES
----------
    0  ok / warn / healthy      (warn prints the tests you must run)
    1  block / drift / issues   (must be resolved)
    2  unknown                  (no rule covers this — NOT the same as safe)
    3  usage or environment error
"""
from __future__ import annotations

import argparse
import json
import re
import os
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
GUARDRAIL_DIR = REPO_ROOT / "scripts" / "guardrail"
STRICT = False


def _load_core():
    if not GUARDRAIL_DIR.is_dir():
        print(f"guardrail: not found at {GUARDRAIL_DIR} — skipping", file=sys.stderr)
        raise SystemExit(0)
    sys.path.insert(0, str(GUARDRAIL_DIR))
    os.environ.setdefault("APPBI_REPO_ROOT", str(REPO_ROOT))
    try:
        import guardrail_core  # type: ignore
    except ModuleNotFoundError as exc:
        # PyYAML absent on this machine: degrade like preflight does rather than
        # blocking a developer who has no reason to install it.
        print(f"guardrail: skipped ({exc}) — install PyYAML to enable", file=sys.stderr)
        raise SystemExit(0)
    return guardrail_core


def _git(*args: str) -> str:
    # errors="replace": git output carries file content, which in this repo is
    # not always decodable under the Windows default codepage. A crash here
    # would silently turn the guardrail off on half the team's machines.
    out = subprocess.run(["git", "-C", str(REPO_ROOT), *args], capture_output=True,
                         text=True, encoding="utf-8", errors="replace")
    return out.stdout or ""


def _git_diff(staged: bool) -> str:
    """The change under review.

    A brand-new file is the most common way to introduce a wrong-layer import,
    and `git diff` cannot see one — so untracked source files are diffed against
    /dev/null and appended. Without this the guardrail would quietly rate a whole
    new service as "no changes to validate".
    """
    diff = _git("diff", "--cached") if staged else _git("diff")
    if staged:
        return diff
    for path in _git("ls-files", "--others", "--exclude-standard").splitlines():
        if not path.startswith(("backend/", "frontend/", "scripts/", "e2e/")):
            continue
        if not path.endswith((".py", ".ts", ".tsx", ".js", ".mjs", ".sql", ".yaml", ".yml")):
            continue
        diff += _git("diff", "--no-index", "--", "/dev/null", path)
    return diff


def _bullets(title: str, items) -> None:
    if not items:
        return
    print(f"\n{title}")
    for item in items:
        if isinstance(item, dict):
            label = item.get("label") or item.get("id") or item.get("reason") or ""
            detail = item.get("run") or item.get("detail") or item.get("note") or ""
            print(f"  - {label}{(': ' + str(detail)) if detail else ''}")
        else:
            print(f"  - {item}")


def _verdict_exit(verdict: str) -> int:
    return {"block": 1, "unknown": 2}.get((verdict or "").lower(), 0)


def cmd_diff(core, staged: bool, as_json: bool) -> int:
    diff = _git_diff(staged)
    if not diff.strip():
        print("guardrail: no changes to validate.")
        return 0
    result = core.validate_patch(diff)
    if as_json:
        print(json.dumps(result, indent=2))
        return _verdict_exit(result.get("verdict", ""))

    verdict = result.get("verdict", "unknown")
    print(f"guardrail verdict: {verdict.upper()}")
    _bullets("reasons:", result.get("reasons") or result.get("issues"))
    _bullets("protected subsystems touched:", result.get("protected"))
    _bullets("run these tests:", result.get("required_tests") or result.get("tests"))
    if verdict == "unknown":
        print("\nUNKNOWN is not SAFE — no rule covers this change. Say so in your report.")
    return _verdict_exit(verdict)


def cmd_files(core, files, plan, as_json: bool) -> int:
    if plan:
        result = core.validate_fix_plan(plan, files)
        key = "fix plan"
    else:
        result = core.get_impact_scope(files)
        result["required_tests"] = core.get_required_tests(files).get("required_tests")
        key = "impact scope"
    if as_json:
        print(json.dumps(result, indent=2))
    else:
        print(f"guardrail {key}: {result.get('verdict', result.get('status', 'ok'))}")
        _bullets("features touched:", result.get("features"))
        _bullets("protected:", result.get("protected"))
        _bullets("issues:", result.get("issues") or result.get("reasons"))
        _bullets("run these tests:", result.get("required_tests") or result.get("tests"))
    return _verdict_exit(result.get("verdict", ""))


def audit_test_registry(core) -> dict:
    """Do the tests the guardrail demands actually exist, and survive a clone?

    `check_rules_health()` validates invariant markers and the semantic-contract
    inventory, but NOT the `tests:` registry — so an entry can name a file that
    was deleted or was never committed and everything still reports healthy. That
    matters most exactly where it is least visible: `distinct_cascade_bq`,
    `galaxy_golden` and `golden_sql` are the required gates for the PROTECTED
    semantic layer, so a missing one turns "run the golden gates" into advice
    nobody can follow.

    Untracked is its own failure: the file works on the machine that wrote it and
    is absent on a fresh clone, which is the same trap `backend/tests/README.md`
    documents for the allow-list.
    """
    rules = core.load_rules()
    tracked = set(_git("ls-files").split())
    missing, untracked, ok, known = [], [], [], []
    for test_id, spec in (rules.get("tests") or {}).items():
        spec = spec or {}
        run = spec.get("run", "")
        match = re.search(r"([\w/.\-]+\.py)", run)
        if not match:
            continue  # not a python path (tsc, manual browser/import verification)
        path = match.group(1)
        declared = spec.get("status")  # 'missing' / 'untracked' = audited, known gap
        broken = not (REPO_ROOT / path).exists() or path not in tracked
        if declared and broken:
            known.append((test_id, path, declared))
        elif not (REPO_ROOT / path).exists():
            missing.append((test_id, path))
        elif path not in tracked:
            untracked.append((test_id, path))
        else:
            ok.append((test_id, path))
    return {"ok": ok, "missing": missing, "untracked": untracked, "known_gaps": known}


def cmd_health(core, as_json: bool) -> int:
    health = core.check_rules_health()
    contract = core.verify_semantic_contract()
    registry = audit_test_registry(core)
    if as_json:
        print(json.dumps({"health": health, "contract": contract, "test_registry": registry}, indent=2))
    else:
        print(f"rules health     : {health.get('status')}")
        _bullets("issues:", health.get("issues"))
        print(f"semantic contract: {contract.get('status')}")
        _bullets("missing files:", contract.get("missing_files"))
        _bullets("missing symbols:", contract.get("missing_symbols"))
        _bullets("unregistered semantic files:", contract.get("unregistered_semantic_files"))
        n_ok, n_miss, n_untr = (len(registry[k]) for k in ("ok", "missing", "untracked"))
        n_known = len(registry["known_gaps"])
        print(f"test registry    : {n_ok} runnable, {n_known} known gaps, "
              f"{n_miss} missing, {n_untr} untracked")
        _bullets("known gaps (declared in guardrail_rules.yaml, not coverage):",
                 [f"{t}: {p} [{d}]" for t, p, d in registry["known_gaps"]])
        _bullets("MISSING - the guardrail demands a test that is not on disk:",
                 [f"{t}: {p}" for t, p in registry["missing"]])
        _bullets("UNTRACKED - present here, absent on a fresh clone:",
                 [f"{t}: {p}" for t, p in registry["untracked"]])
        if registry["missing"] or registry["untracked"]:
            print("\n  A required gate that cannot be run is not a gate. Restore the file,")
            print("  commit it, or correct the `tests:` entry in guardrail_rules.yaml.")
            print("  (Reported, not fatal - pass --strict to fail on it.)")

    bad = health.get("status") not in ("healthy", "ok") or contract.get("status") not in ("ok", "healthy")
    if STRICT and (registry["missing"] or registry["untracked"]):
        bad = True
    return 1 if bad else 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--diff", action="store_true", help="validate the git diff")
    ap.add_argument("--staged", action="store_true", help="with --diff: use the staged diff")
    ap.add_argument("--files", nargs="+", metavar="PATH", help="impact scope + required tests")
    ap.add_argument("--plan", metavar="TEXT", help="with --files: validate a fix plan")
    ap.add_argument("--health", action="store_true", help="rules health + semantic contract drift")
    ap.add_argument("--strict", action="store_true",
                    help="with --health: also fail when a registered test is missing/untracked")
    ap.add_argument("--json", action="store_true", help="machine-readable output")
    args = ap.parse_args()

    if not (args.diff or args.files or args.health):
        ap.print_help()
        return 3

    global STRICT
    STRICT = args.strict

    core = _load_core()
    rc = 0
    if args.health:
        rc = max(rc, cmd_health(core, args.json))
    if args.files:
        rc = max(rc, cmd_files(core, args.files, args.plan, args.json))
    if args.diff:
        rc = max(rc, cmd_diff(core, args.staged, args.json))
    return rc


if __name__ == "__main__":
    sys.exit(main())
