#!/usr/bin/env python3
"""Detect a change that weakens the protection system — from the TRUSTED base copy.

THE THREAT THIS EXISTS FOR
--------------------------
Every other gate in this repository is code that lives in the repository. An agent that
wants its change to pass can therefore edit the gate. Delete an invariant, mark a runnable
test `missing`, drop a CI step, make the Stop hook fail open — and every remaining check
happily reports green, because the thing that would have objected is the thing that was
edited.

WHY IT MUST RUN FROM THE MERGE BASE
-----------------------------------
Running this script from the PR head would be theatre: a PR that rewrites it to
`sys.exit(0)` would pass its own audit. So CI checks out the BASE revision, runs the BASE
copy of this file, and hands it the head revision as DATA — read through `git show`, never
imported, never executed. A PR cannot weaken a checker it is not allowed to run.

That is also why this file parses YAML itself instead of importing `guardrail_core`:
importing would load the rule base from whichever tree is checked out, and the whole point
is to compare two revisions of it.

WHAT IS MECHANICALLY PROVABLE (and nothing beyond it)
-----------------------------------------------------
  * a protected subsystem, invariant or registry entry that disappeared
  * a runnable gate downgraded to missing / untracked / manual
  * required_tests removed from a protected subsystem
  * a protection-critical file deleted
  * a named CI verification step removed
  * the Stop hook removed or pointed somewhere else

Semantic equivalence is NOT provable by diffing, and this does not pretend otherwise. A
rewritten-but-equivalent gate is a judgement call for review.

DECLARING A DELIBERATE CHANGE
-----------------------------
Weakening is sometimes correct — a gate can be genuinely obsolete. Two escape hatches,
both visible:

  * downgrading a gate's status requires a `status_reason:` on that entry, so the reason
    travels in the same diff a reviewer is reading;
  * removals require APPBI_ALLOW_PROTECTION_REMOVAL_SHA to equal the exact head commit
    being checked. A repository variable only the owner can set, and scoped to ONE
    commit: approving a protection change does not open a window that the next push to
    the same PR, or a different PR entirely, can walk through. Amend the commit and the
    approval no longer applies — which is the point.

    python scripts/ci/check_protection_integrity.py --base <ref> --head <ref>
    0 = no weakening detected · 1 = weakening · 2 = usage/environment error
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

NEWLINE = chr(10)

REPO_ROOT = Path(__file__).resolve().parents[2]
RULES_PATH = "scripts/guardrail/guardrail_rules.yaml"
SETTINGS_PATH = ".claude/settings.json"

# Files whose disappearance means a gate stopped existing.
PROTECTION_CRITICAL_FILES = [
    "scripts/ci/verify.py",
    "scripts/ci/guardrail_check.py",
    "scripts/ci/check_claude_config.py",
    "scripts/ci/check_agent_config.py",
    "scripts/ci/check_protection_integrity.py",
    "scripts/ci/preflight.sh",
    "scripts/ci/alembic_chain.py",
    "scripts/guardrail/guardrail_core.py",
    "scripts/guardrail/guardrail_rules.yaml",
    ".githooks/pre-push",
    ".claude/settings.json",
    ".claude/hooks/stop_gate.py",
    "AGENTS.md",
    ".claude/CLAUDE.md",
]

# A workflow that disappears takes its gate with it.
PROTECTION_CRITICAL_WORKFLOWS = [
    ".github/workflows/preflight.yml",
    ".github/workflows/backend-contract-tests.yml",
    ".github/workflows/change-guardrail.yml",
    # The status branch protection requires on `demo`. Without it here, a PR could
    # weaken the gate AND the head-side tests that check the gate in one change,
    # and the only thing left to object would be the thing being edited.
    ".github/workflows/product-gate.yml",
]

#: The Product Gate's structural contract, checked from the BASE copy against the
#: HEAD workflow READ AS DATA — never imported, never executed.
#:
#: WHAT IS PINNED AND WHAT IS NOT. Invariants, not formatting: a renamed display
#: string, a reordered job or a new comment must pass, because a checker that
#: fails on cosmetics gets routed around within a week. What must not pass is the
#: gate losing its always-run path, dropping a suite it depends on, or learning to
#: treat `skipped` as success for a suite the classifier called relevant.
PRODUCT_GATE_PATH = ".github/workflows/product-gate.yml"

# Commands a CI workflow must keep invoking. Matched as substrings of the whole
# workflow text, so reordering or renaming a step is fine and deleting the call is not.
REQUIRED_CI_INVOCATIONS = [
    "check_agent_config.py",
    "guardrail_check.py",
    "test_stop_gate.py",
]

BLOCKING_STATUSES = {"missing", "untracked", "manual"}

findings: list[str] = []
notes: list[str] = []


def finding(msg: str) -> None:
    findings.append(msg)


def git(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(["git", "-C", str(REPO_ROOT), *args], capture_output=True,
                          text=True, encoding="utf-8", errors="replace")


def show(ref: str, path: str) -> str | None:
    """Read a path at a revision. Returns None when it does not exist there.

    This is the only way head content enters this process: as text.
    """
    result = git("show", f"{ref}:{path}")
    return result.stdout if result.returncode == 0 else None


def load_yaml(text: str | None):
    if text is None:
        return None
    try:
        import yaml  # type: ignore
    except ModuleNotFoundError:
        print("check_protection_integrity: PyYAML is required", file=sys.stderr)
        raise SystemExit(2)
    try:
        return yaml.safe_load(text)
    except Exception as exc:  # a rule base that will not parse is itself a failure
        finding(f"guardrail_rules.yaml does not parse: {exc}")
        return None


def ids(items, key="id") -> dict:
    return {item[key]: item for item in (items or []) if isinstance(item, dict) and key in item}


def compare_rule_base(base_rules: dict, head_rules: dict, allow_removal: bool) -> None:
    if not base_rules or not head_rules:
        return

    def removal(kind: str, name: str) -> None:
        if allow_removal:
            notes.append(f"REMOVED {kind} `{name}` - allowed for this exact commit")
        else:
            finding(f"{kind} `{name}` was REMOVED from guardrail_rules.yaml. If this is "
                    "deliberate, the repository owner sets "
                    "APPBI_ALLOW_PROTECTION_REMOVAL_SHA to this exact head commit; a pull "
                    "request cannot grant itself that, and the approval expires the moment "
                    "the commit changes.")

    base_protected, head_protected = ids(base_rules.get("protected")), ids(head_rules.get("protected"))
    for name in sorted(set(base_protected) - set(head_protected)):
        removal("protected subsystem", name)

    # required_tests thinned out on a subsystem that still exists
    for name, base_entry in base_protected.items():
        head_entry = head_protected.get(name)
        if not head_entry:
            continue
        lost = set(base_entry.get("required_tests") or []) - set(head_entry.get("required_tests") or [])
        if lost:
            finding(f"protected subsystem `{name}` lost required gate(s): "
                    f"{', '.join(sorted(lost))}")

    base_inv, head_inv = ids(base_rules.get("invariants")), ids(head_rules.get("invariants"))
    for name in sorted(set(base_inv) - set(head_inv)):
        removal("invariant", name)

    base_tests = base_rules.get("tests") or {}
    head_tests = head_rules.get("tests") or {}
    for name in sorted(set(base_tests) - set(head_tests)):
        removal("test registry entry", name)

    for name, base_entry in base_tests.items():
        head_entry = head_tests.get(name)
        if not isinstance(head_entry, dict) or not isinstance(base_entry, dict):
            continue
        base_status = (base_entry.get("status") or "").lower()
        head_status = (head_entry.get("status") or "").lower()
        if head_status in BLOCKING_STATUSES and base_status != head_status:
            # A downgrade is allowed, but it has to be stated where the reviewer reads it.
            if not head_entry.get("status_reason"):
                finding(f"gate `{name}` was downgraded to `{head_status}` without a "
                        "`status_reason:`. Downgrading is allowed; doing it silently is "
                        "not - state why in the entry.")
            else:
                notes.append(f"gate `{name}` downgraded to `{head_status}` - declared: "
                             f"{head_entry['status_reason']}")
        if base_status in BLOCKING_STATUSES and not head_status:
            notes.append(f"gate `{name}` was RESTORED to runnable (was `{base_status}`)")


def check_product_gate_contract(head: str) -> None:
    """Read the head's Product Gate and verify it is still a gate.

    Structural, because the alternative is either a byte comparison — which fails
    on a comment — or running the head's own logic to decide whether the head
    weakened it, which is the seam this exists to close.
    """
    text = show(head, PRODUCT_GATE_PATH)
    if text is None:
        return  # a deleted workflow is already reported by compare_files
    data = load_yaml(text)
    if not isinstance(data, dict):
        finding(f"`{PRODUCT_GATE_PATH}` does not parse - the required status "
                "cannot be produced by a workflow that will not load")
        return

    triggers = data.get("on") or data.get(True) or {}
    if "pull_request" not in triggers:
        finding("product-gate no longer runs on `pull_request` - the required "
                "status would never appear and every PR would hang on it")
    pr = triggers.get("pull_request") or {}
    if isinstance(pr, dict) and (pr.get("paths") or pr.get("paths-ignore")):
        finding("product-gate is now path-filtered - the always-present status "
                "is the whole point, and a filtered one leaves PRs Expected")

    jobs = data.get("jobs")
    if not isinstance(jobs, dict):
        finding("product-gate has no jobs")
        return

    # The sentinel is whichever job depends on the others and runs regardless.
    sentinel_name, sentinel = None, None
    for name, job in jobs.items():
        if not isinstance(job, dict):
            continue
        needs = job.get("needs") or []
        needs = [needs] if isinstance(needs, str) else list(needs)
        if len(needs) >= 3 and "steps" in job:
            sentinel_name, sentinel = name, job
            break
    if sentinel is None:
        finding("product-gate has no final job depending on the classifier and "
                "the suites - nothing aggregates the result")
        return

    needs = sentinel.get("needs") or []
    needs = [needs] if isinstance(needs, str) else list(needs)
    callers = {name: str((job or {}).get("uses") or "")
               for name, job in jobs.items() if isinstance(job, dict)}
    backend_jobs = [n for n, u in callers.items() if "backend-contract-tests" in u]
    e2e_jobs = [n for n, u in callers.items() if u.endswith("e2e.yml")]
    if not backend_jobs:
        finding("product-gate no longer calls the backend contract workflow")
    elif not any(n in needs for n in backend_jobs):
        finding("the product-gate sentinel no longer depends on the backend suite")
    if not e2e_jobs:
        finding("product-gate no longer calls the E2E workflow")
    elif not any(n in needs for n in e2e_jobs):
        finding("the product-gate sentinel no longer depends on the E2E suite")

    classifiers = [n for n, job in jobs.items()
                   if isinstance(job, dict) and "steps" in job and n != sentinel_name
                   and (job.get("outputs") or {})]
    if not classifiers:
        finding("product-gate has no job producing a changed-surface "
                "classification - relevance would be decided nowhere")
    elif not any(n in needs for n in classifiers):
        finding("the product-gate sentinel no longer depends on the classifier")

    if "always()" not in str(sentinel.get("if") or ""):
        finding("the product-gate sentinel is no longer always-run - it would be "
                "skipped by a failing dependency and report nothing")

    body = NEWLINE.join(str((step or {}).get("run") or "")
                        for step in sentinel.get("steps") or [])
    if "success" not in body:
        finding("the product-gate sentinel no longer requires a relevant suite "
                "to have concluded `success`")
    if "skipped" not in body:
        finding("the product-gate sentinel no longer distinguishes `skipped` - a "
                "job that disappeared would read as an irrelevant one")
    if "RESULT_CLASSIFY" not in body and "classify" not in body:
        finding("the product-gate sentinel no longer checks that the "
                "classification itself succeeded - a failed classifier could "
                "become `nothing is relevant`")

def compare_files(base: str, head: str, allow_removal: bool) -> None:
    for path in PROTECTION_CRITICAL_FILES:
        existed = show(base, path) is not None
        exists = show(head, path) is not None
        if existed and not exists:
            if allow_removal:
                notes.append(f"REMOVED `{path}` - allowed for this exact commit")
            else:
                finding(f"protection-critical file `{path}` was DELETED")

    for path in PROTECTION_CRITICAL_WORKFLOWS:
        existed = show(base, path) is not None
        exists = show(head, path) is not None
        if existed and not exists:
            if allow_removal:
                notes.append(f"REMOVED workflow `{path}` - allowed for this exact commit")
            else:
                finding(f"CI workflow `{path}` was DELETED - its gate no longer runs")

    # A step can also be removed while the workflow file survives.
    base_ci = "\n".join(filter(None, (show(base, p) for p in PROTECTION_CRITICAL_WORKFLOWS)))
    head_ci = "\n".join(filter(None, (show(head, p) for p in PROTECTION_CRITICAL_WORKFLOWS)))
    for invocation in REQUIRED_CI_INVOCATIONS:
        if invocation in base_ci and invocation not in head_ci:
            finding(f"CI no longer invokes `{invocation}` - a verification step was removed")


def compare_stop_hook(base: str, head: str) -> None:
    base_settings, head_settings = show(base, SETTINGS_PATH), show(head, SETTINGS_PATH)
    if base_settings is None:
        return
    if head_settings is None:
        return  # already reported as a deleted critical file

    def stop_hooks(text: str) -> list:
        try:
            return ((json.loads(text).get("hooks") or {}).get("Stop") or [])
        except json.JSONDecodeError:
            finding(f"`{SETTINGS_PATH}` does not parse as JSON - hooks would not load")
            return []

    if stop_hooks(base_settings) and not stop_hooks(head_settings):
        finding("the Stop hook was removed from .claude/settings.json - the "
                "Definition-of-Done gate no longer runs in a Claude session")

    # Fail-open is the subtle one: the hook still exists but can no longer block.
    hook_src = show(head, ".claude/hooks/stop_gate.py")
    if hook_src is not None:
        if "BLOCK" not in hook_src or "return BLOCK" not in hook_src:
            finding("stop_gate.py no longer returns BLOCK anywhere - the Stop gate is "
                    "fail-open and can never stop a turn")
        base_hook = show(base, ".claude/hooks/stop_gate.py") or ""
        if "stop_hook_active" in base_hook and "stop_hook_active" not in hook_src:
            finding("stop_gate.py no longer consults `stop_hook_active` - its loop/failure "
                    "semantics changed in a way the decision tests pin")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--base", required=True, metavar="REF", help="merge base / PR base ref")
    ap.add_argument("--head", required=True, metavar="REF", help="PR head ref")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    for ref in (args.base, args.head):
        if git("rev-parse", "--verify", f"{ref}^{{commit}}").returncode != 0:
            print(f"check_protection_integrity: cannot resolve ref {ref!r}", file=sys.stderr)
            return 2

    # Resolve head to a full SHA so an approval pinned to `abc123` cannot be
    # satisfied by a branch name that later points somewhere else.
    head_sha = git("rev-parse", args.head).stdout.strip()
    approved_sha = (os.environ.get("APPBI_ALLOW_PROTECTION_REMOVAL_SHA") or "").strip()
    allow_removal = bool(approved_sha) and approved_sha.lower() == head_sha.lower()
    if approved_sha and not allow_removal:
        notes.append(f"APPBI_ALLOW_PROTECTION_REMOVAL_SHA is set to {approved_sha[:12]} "
                     f"but the commit under review is {head_sha[:12]} - the approval does "
                     "NOT apply to this commit")

    base_rules = load_yaml(show(args.base, RULES_PATH))
    head_rules = load_yaml(show(args.head, RULES_PATH))
    if base_rules and head_rules is None:
        finding(f"`{RULES_PATH}` is gone or unparseable at head - the rule base is the "
                "source of truth for every other gate")

    compare_rule_base(base_rules or {}, head_rules or {}, allow_removal)
    compare_files(args.base, args.head, allow_removal)
    check_product_gate_contract(args.head)
    compare_stop_hook(args.base, args.head)

    if args.json:
        print(json.dumps({"base": args.base, "head": args.head,
                          "findings": findings, "notes": notes}, indent=2))
    else:
        print(f"protection integrity: {args.base[:12]}..{args.head[:12]} "
              "(checked by the BASE copy; head read as data only)")
        for note in notes:
            print(f"  - {note}")
        if findings:
            print("\nThis change WEAKENS the protection system:")
            for item in findings:
                print(f"  x {item}")
            print("\nA gate may only be weakened deliberately and visibly. If that is what "
                  "this change is, say so in the description and declare it as above.")
        else:
            print("  - no mechanically detectable weakening")
            print("\n  Mechanical checks only. A rewritten-but-equivalent gate, or a gate "
                  "weakened in a way\n  that is not structural, is a judgement call for "
                  "review - not proven safe here.")
    return 1 if findings else 0


if __name__ == "__main__":
    sys.exit(main())
