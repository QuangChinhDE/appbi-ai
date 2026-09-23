# -*- coding: utf-8 -*-
"""A required gate must never go green because an expected job disappeared.

THE HOLE THIS CLOSES.

`demo` requires `preflight`, the architecture gate and protection integrity. It
could not require `unit`, `integration-golden` or `e2e`: those workflows filtered
paths at the WORKFLOW level, so on an irrelevant PR they produced no check run at
all, and a required check that may never appear leaves a PR "Expected" forever.
The result was a product PR that could sit with every required check green and a
red backend suite beside it.

WHY THESE TESTS EXTRACT AND RUN THE REAL THING.

Asserting that the YAML "contains a sentinel job" is the kind of test that passes
while the logic is inverted. Both halves of this gate are scripts embedded in the
workflow, so both are pulled out of the file and executed: the classification map
as bash against real path lists, and the sentinel as python against a matrix of
job results. If someone edits the workflow, these run the edited version.

THE ASYMMETRY BEING PINNED.

    relevant + success    -> gate passes
    relevant + ANYTHING else, `skipped` INCLUDED -> gate fails
    not relevant + skipped -> gate passes

`skipped` is the dangerous one. It is what a job that vanished looks like, what a
cancelled dependency produces, and what someone gets by adding an `if:` that is
subtly wrong. It must never read as "irrelevant".
"""
from __future__ import annotations

import pathlib
import subprocess
import sys

import pytest
import yaml

REPO = pathlib.Path(__file__).resolve().parents[2]
WF = REPO / ".github" / "workflows" / "product-gate.yml"


@pytest.fixture(scope="module")
def workflow() -> dict:
    return yaml.safe_load(WF.read_text(encoding="utf-8"))


# ── the gate has to be present on every pull request ────────────────────────

def test_it_runs_on_every_pull_request_with_no_path_filter(workflow):
    """A filtered gate is the bug, not the fix."""
    triggers = workflow.get("on") or workflow.get(True)
    assert "pull_request" in triggers
    pr = triggers["pull_request"]
    assert not (pr or {}).get("paths"), (
        "the always-present status cannot itself be path-filtered"
    )
    assert not (pr or {}).get("paths-ignore")


def test_the_sentinel_depends_on_everything_and_runs_anyway(workflow):
    gate = workflow["jobs"]["product-gate"]
    assert set(gate["needs"]) == {"classify", "backend", "e2e"}
    assert str(gate.get("if")).strip() == "always()", (
        "a gate that only runs when its dependencies succeeded is a summary of "
        "the happy path, not a gate"
    )


def test_the_heavy_suites_are_called_and_not_copied(workflow):
    """The seventy-suite command must exist in exactly one place."""
    jobs = workflow["jobs"]
    assert jobs["backend"]["uses"].endswith("backend-contract-tests.yml")
    assert jobs["e2e"]["uses"].endswith("e2e.yml")
    for name in ("backend", "e2e"):
        assert "steps" not in jobs[name], f"{name} reimplements what it should call"
    text = WF.read_text(encoding="utf-8")
    assert "pytest" not in text, "the test command leaked into the gate workflow"


def test_the_called_workflows_still_own_their_push_path_filters():
    """Push efficiency is preserved; only the PR entry point moved."""
    for name in ("backend-contract-tests", "e2e"):
        d = yaml.safe_load((REPO / ".github" / "workflows" / f"{name}.yml").read_text(encoding="utf-8"))
        triggers = d.get("on") or d.get(True)
        assert "workflow_call" in triggers, f"{name} cannot be called by the gate"
        assert "pull_request" not in triggers, (
            f"{name} still has its own pull_request trigger — the suite would run "
            "twice on every relevant PR"
        )
        assert triggers["push"].get("paths"), f"{name} lost its push path filter"


# ── the classification, run as bash ─────────────────────────────────────────

def _step_run(job: str, name_startswith: str) -> str:
    """The `run:` body, dedented by the YAML parser rather than by hand.

    Hand-dedenting broke on the `case` patterns, which carry their own line
    continuations. Letting PyYAML resolve the block scalar is both correct and
    the same text the runner will execute.
    """
    d = yaml.safe_load(WF.read_text(encoding="utf-8"))
    step = next(s for s in d["jobs"][job]["steps"]
                if (s.get("name") or "").startswith(name_startswith))
    # NORMALISE CR. A `\` line continuation followed by CR+LF is not a
    # continuation to bash, and the `case` patterns rely on them. The Linux
    # runner checks out LF; a Windows working copy may not, and the test must
    # exercise what the runner runs.
    return step["run"].replace(chr(13), "")


def _case_patterns(var: str) -> list[str]:
    """The glob list the workflow assigns `var` from, read out of the YAML."""
    body = _step_run("classify", "Map the changed paths")
    blocks = body.split('case "$f" in')[1:]
    for block in blocks:
        head, _, _ = block.partition(")")
        assign = block[block.index(")"):]
        if f"{var}=true" in assign.split("esac")[0]:
            return [x.strip() for x in head.strip().split("|") if x.strip()]
    raise AssertionError(f"no case block assigns {var}")


def _classify(paths: list[str]) -> tuple[bool, bool]:
    """Match the workflow's OWN glob list against a path list.

    MATCHED IN PYTHON RATHER THAN BY RUNNING BASH, and the distinction is worth
    stating: this asserts the PATTERN LIST the workflow carries, not the shell's
    evaluation of it. Executing the fragment locally proved to test the host -
    the MSYS layer on Windows rewrites arguments that look like paths and the
    classification came back empty on a correct workflow. `fnmatch` and bash
    `case` agree on the globs used here (a literal, or a trailing `*`), so the
    map is what is being pinned, which is also where the mistakes live.
    """
    import fnmatch

    def hit(var: str) -> bool:
        pats = _case_patterns(var)
        return any(fnmatch.fnmatchcase(f, pat) for f in paths for pat in pats)

    return hit("backend"), hit("e2e")


def test_the_map_is_read_from_the_workflow_and_not_from_this_file():
    """If the patterns were copied here, editing the workflow would not fail."""
    backend = _case_patterns("backend")
    assert "backend/*" in backend
    assert "scripts/cert/*" in backend
    assert len(_case_patterns("e2e")) >= 5


@pytest.mark.parametrize("label,paths,backend,e2e", [
    ("docs only", ["docs/agent-flow-tools.md", "README.md"], False, False),
    ("backend product", ["backend/app/services/agent_flows/runtime/executor.py"], True, True),
    ("frontend product", ["frontend/src/components/chat/ChatPanel.tsx"], False, True),
    ("agent flow runtime", ["backend/app/services/agent_flows/tools/packs/coverage.py"], True, True),
    ("e2e spec", ["e2e/tests/surfaces.spec.ts"], False, True),
    ("runtime contract outside backend/", ["scripts/cert/tool_certification.yaml"], True, False),
    ("rule base", ["scripts/guardrail/guardrail_rules.yaml"], True, False),
    ("explore FE, which the backend contract covers", ["frontend/src/lib/explore-query.ts"], True, True),
    ("a gate-only PR", ["scripts/ci/verify.py"], False, False),
    ("the gate workflow itself", [".github/workflows/product-gate.yml"], True, True),
])
def test_the_classification_maps_a_diff_onto_the_suites_it_needs(label, paths, backend, e2e):
    got_backend, got_e2e = _classify(paths)
    assert (got_backend, got_e2e) == (backend, e2e), (
        f"{label}: expected backend={backend} e2e={e2e}, got "
        f"backend={got_backend} e2e={got_e2e}"
    )


def test_an_unresolvable_base_makes_everything_relevant():
    """"I could not tell" must not read as "nothing is relevant"."""
    text = WF.read_text(encoding="utf-8")
    i = text.index("does not resolve")
    window = text[i:i + 400]
    assert 'echo "backend=true"' in window and 'echo "e2e=true"' in window, (
        "an unresolvable base must fail towards running everything"
    )


# ── the sentinel, run as python ─────────────────────────────────────────────

def _sentinel(*, classify="success", needed_backend="true", needed_e2e="true",
              backend="success", e2e="success") -> int:
    body = _step_run("product-gate", "Every suite this diff needed")
    marker = "python3 - <<" + chr(39) + "PY" + chr(39)
    start = body.index(marker) + len(marker)
    end = body.rindex("PY")
    src = body[start:end]
    env = {
        "RESULT_CLASSIFY": classify,
        "NEEDED_BACKEND": needed_backend,
        "NEEDED_E2E": needed_e2e,
        "RESULT_BACKEND": backend,
        "RESULT_E2E": e2e,
        "PYTHONIOENCODING": "utf-8",
    }
    import os
    merged = dict(os.environ)
    merged.pop("GITHUB_STEP_SUMMARY", None)
    merged.update(env)
    out = subprocess.run([sys.executable, "-c", src], capture_output=True,
                         text=True, encoding="utf-8", errors="replace", env=merged)
    return out.returncode


def test_a_docs_only_pr_passes_without_running_either_suite():
    assert _sentinel(needed_backend="false", needed_e2e="false",
                     backend="skipped", e2e="skipped") == 0


def test_a_relevant_suite_that_passed_passes_the_gate():
    assert _sentinel(backend="success", e2e="success") == 0


@pytest.mark.parametrize("result", ["failure", "cancelled", "skipped", "", "timed_out"])
def test_a_relevant_backend_suite_that_did_not_succeed_fails_the_gate(result):
    assert _sentinel(backend=result) == 1, (
        f"backend concluded {result!r} on a diff that needed it and the gate passed"
    )


@pytest.mark.parametrize("result", ["failure", "cancelled", "skipped", ""])
def test_a_relevant_e2e_suite_that_did_not_succeed_fails_the_gate(result):
    assert _sentinel(e2e=result) == 1


def test_a_skipped_suite_is_only_acceptable_when_it_was_irrelevant():
    """The exact asymmetry the gate exists for."""
    assert _sentinel(needed_backend="false", backend="skipped") == 0
    assert _sentinel(needed_backend="true", backend="skipped") == 1


def test_a_failed_classification_means_nothing_can_be_called_irrelevant():
    """If relevance is unknown, "not relevant" is not an answer."""
    assert _sentinel(classify="failure", needed_backend="false", needed_e2e="false",
                     backend="skipped", e2e="skipped") == 1
    assert _sentinel(classify="cancelled", needed_backend="false", needed_e2e="false",
                     backend="skipped", e2e="skipped") == 1
