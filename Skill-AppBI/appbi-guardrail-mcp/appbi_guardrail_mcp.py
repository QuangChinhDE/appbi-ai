"""AppBI Engineering Guardrail MCP.

A READ-ONLY advisor that keeps an AI (or human) from breaking AppBI when editing
code. It does NOT create reports, generate dashboards, touch the semantic layer,
or write/commit anything. It ONLY checks: architecture/layering rules, impact
scope, required tests, business invariants, fix-plan scope, and regression risk.

Principles (enforced by construction):
  • Read-only — never edits code, never calls the AppBI API, never runs a fix.
  • No invented rules — every answer comes from guardrail_rules.yaml.
  • UNKNOWN over guessing — if a rule is absent, say UNKNOWN.
  • Bias to BLOCK wrong module / wrong dependency / wrong invariant.

Run:  python appbi_guardrail_mcp.py   (stdio). Point APPBI_REPO_ROOT at the repo
if it is not two directories above this file.
"""
from __future__ import annotations

import os
import sys
from typing import Any

from mcp.server.fastmcp import FastMCP

import guardrail_core as core

_INSTRUCTIONS = """
You are the AppBI Engineering Guardrail — a READ-ONLY reviewer. Consult these
tools BEFORE editing code and BEFORE committing a patch.

WHAT THIS IS FOR:
  - Kiểm soát AI khi sửa code: architecture rules, impact, invariants, regression risk.

WHAT THIS NEVER DOES (by design — do not ask it to):
  - Create reports, generate dashboards, or design/replace the semantic layer.
  - Write, edit, apply, or commit code. It only ANALYSES and ADVISES.

TYPICAL FLOW:
  1. validate_fix_plan(issue, proposed_files)  → is the plan in the right module/scope?
  2. (edit code yourself)
  3. validate_patch(diff)                        → block/warn/ok + reasons + tests
  4. explain_risk(diff) / get_required_tests(...) → what to run before commit

READING RESULTS: verdict is one of block | warn | ok | unknown. "unknown" means
the rule base does not cover it — treat as "needs human judgement", not "safe".
Invariant signals are heuristic (diff pattern match): a hit means RUN THE TEST;
no hit does NOT mean safe. Rules live in guardrail_rules.yaml (edit there to teach
new rules — never hardcode them).
"""

mcp = FastMCP("AppBI Engineering Guardrail", instructions=_INSTRUCTIONS)


def _safe(fn, **kw) -> dict[str, Any]:
    try:
        return fn(**kw)
    except FileNotFoundError:
        return {"error": "guardrail_rules.yaml not found", "verdict": "unknown"}
    except Exception as exc:  # noqa: BLE001
        return {"error": f"{type(exc).__name__}: {exc}", "verdict": "unknown"}


@mcp.tool()
def get_module_boundaries() -> dict[str, Any]:
    """Return the module/layer dependency rules: which layer may depend on which,
    plus the protected subsystems (semantic layer, public-link security). A file
    matching no layer glob is UNKNOWN. Source: guardrail_rules.yaml (read-only)."""
    return _safe(core.get_module_boundaries)


@mcp.tool()
def check_architecture_violation(
    changed_files: list[str],
    imports: dict[str, list[str]] | None = None,
) -> dict[str, Any]:
    """Check changed files for layering violations (e.g. models importing services,
    a public FE page importing the authed client).

    changed_files: repo-relative or absolute paths (diff a/ b/ prefixes ok).
    imports: OPTIONAL {file: [import-specifiers]}. If omitted, the guardrail reads
        each file from the repo and extracts imports itself (read-only). Returns
        verdict (block/ok/unknown), the violations, and files whose layer is UNKNOWN."""
    return _safe(core.check_architecture_violation, changed_files=changed_files, imports=imports)


@mcp.tool()
def get_impact_scope(changed_files: list[str]) -> dict[str, Any]:
    """Map changed files to the features/subsystems they own, and flag protected
    subsystems. Files owning no known feature come back in unmapped_files (impact
    UNKNOWN for them). Use this to size the blast radius before editing."""
    return _safe(core.get_impact_scope, changed_files=changed_files)


@mcp.tool()
def get_required_tests(
    changed_files: list[str],
    touched_features: list[str] | None = None,
) -> dict[str, Any]:
    """Return the tests that MUST pass for this change — derived from the features
    + protected subsystems the changed files touch (and any features you pass in
    touched_features). Each entry has the exact `run` command and what it `locks`.
    A test id with run=UNKNOWN is referenced but not in the registry."""
    return _safe(core.get_required_tests, changed_files=changed_files, touched_features=touched_features)


@mcp.tool()
def check_logic_invariants(diff: str) -> dict[str, Any]:
    """Scan a unified diff for patterns that may break a documented business/
    architecture invariant (e.g. re-introducing a correlated EXISTS in the distinct
    cascade, dropping the Builder tile-fetch seed gate, hardcoding SUM, an authed
    call on a public page). Returns HEURISTIC risk_signals (a hit → run the named
    tests; no hit ≠ safe). Invariants not in the rule base are UNKNOWN."""
    return _safe(core.check_logic_invariants, diff=diff)


@mcp.tool()
def validate_fix_plan(issue_description: str, proposed_files: list[str]) -> dict[str, Any]:
    """Before editing: check the proposed files are the RIGHT place for the issue.
    Matches the issue text to feature owner files and flags: scope gaps (issue
    points at files the plan doesn't touch — fixing in the wrong place), out-of-
    scope files, protected-subsystem touches, and layer mismatch (a backend/data
    symptom being 'fixed' only in the frontend). Returns verdict + recommended
    tests. If the issue text matches no feature keyword → verdict UNKNOWN."""
    return _safe(core.validate_fix_plan, issue_description=issue_description, proposed_files=proposed_files)


@mcp.tool()
def validate_patch(diff: str) -> dict[str, Any]:
    """Review a unified diff BEFORE apply/commit. Combines architecture check (on
    the diff's new imports), invariant scan, impact, protected-subsystem + policy
    flags (non-runtime-only change, high-blast files). Returns a single verdict
    (block | warn | ok | unknown), the reasons, and the required tests. Read-only:
    it never applies the patch."""
    return _safe(core.validate_patch, diff=diff)


@mcp.tool()
def explain_risk(diff: str) -> dict[str, Any]:
    """Human-readable regression-risk explanation for a diff: affected features,
    protected subsystems, layering issues, invariant signals (with WHY), the
    BigQuery dialect-blindness caveat for semantic changes, and the tests to run."""
    return _safe(core.explain_risk, diff=diff)


@mcp.tool()
def verify_semantic_contract() -> dict[str, Any]:
    """Assert the Semantic-Layer BACKBONE still matches the contract: every
    registered file + key symbol must still exist (removed/renamed = DRIFT), and
    no NEW semantic-looking service may be unregistered. Run this after any
    semantic change (or in CI) so the contract can't silently drift. status is
    'ok' or 'DRIFT' — DRIFT lists the missing symbols/files + unregistered files."""
    return _safe(core.verify_semantic_contract)


@mcp.tool()
def check_rules_health() -> dict[str, Any]:
    """Self-audit the guardrail's own rules for BLIND spots: every removed-pattern
    marker must actually exist in its scope today (else the guard matches nothing),
    and every file a rule references must exist. Use to prove the contract is
    grounded in real code (not written blind) — and after refactors that rename
    the backbone. status 'healthy' or 'issues'."""
    return _safe(core.check_rules_health)


@mcp.tool()
def get_invariants(subsystem: str | None = None) -> dict[str, Any]:
    """List the documented invariants (optionally filtered by subsystem keyword,
    e.g. 'distinct', 'semantic', 'public', 'calendar'). Use to learn what rules
    exist before touching an area."""
    return _safe(core.get_invariants, subsystem=subsystem)


if __name__ == "__main__":
    # Fail fast with a helpful message if the repo root looks wrong.
    if not (core.REPO_ROOT / "backend" / "app").exists() and not (core.REPO_ROOT / "frontend" / "src").exists():
        print(f"[guardrail] WARNING: repo root {core.REPO_ROOT} has no backend/app or "
              f"frontend/src. Set APPBI_REPO_ROOT to the AppBI repo.", file=sys.stderr)
    mcp.run(transport="stdio")
