# -*- coding: utf-8 -*-
"""The certification declaration must describe the tools that actually exist.

WHAT WAS WRONG WITH THE OLD CERTIFICATION. It lived in `.artifacts/cert/`, which
is gitignored. The durable record was a Markdown report, so the only thing a
reviewer could check was the conclusion — not the method, not the coverage, and
not whether the set of tools it described was still the set of tools the product
registers. A tool added afterwards would have been certified by omission.

WHAT THIS ENFORCES, on every push:

    set(declared) == set(all_tools())     no tool certified by omission,
                                          no entry for a tool that no longer exists
    every state is one of three           VERIFIED / MANUAL_REQUIRED / FAILED
    MANUAL_REQUIRED carries a reason      "not tested" is not a state
    VERIFIED names real test files        a citation that does not resolve is worse
                                          than no citation
    every TIER 1 tool is VERIFIED         a tool that produces a number a reader
                                          acts on may not be manual

The declaration is `scripts/cert/tool_certification.yaml`. Raw live-model output
stays gitignored: it is evidence of one run, not a contract.
"""
from __future__ import annotations

import os
import pathlib

import pytest

if not os.environ.get("DATABASE_URL"):
    os.environ["DATABASE_URL"] = "sqlite:///./test_flow_replay.db"
if not os.environ.get("DATA_DIR"):
    os.environ["DATA_DIR"] = ".testdata"

def _find(relative: str) -> pathlib.Path | None:
    """Walk up until the path appears.

    The repository puts tests at `backend/tests/`, and the prod-style container
    puts them at `/app/tests/` — a flatter tree by one level. A hardcoded
    `parents[2]` is correct in exactly one of those and silently wrong in the
    other, which is how a contract test becomes a path test.
    """
    here = pathlib.Path(__file__).resolve()
    for base in [here.parent, *here.parents]:
        candidate = base / relative
        if candidate.exists():
            return candidate
    return None


DECL = _find("scripts/cert/tool_certification.yaml")
TESTS = pathlib.Path(__file__).resolve().parent

STATES = {"VERIFIED", "MANUAL_REQUIRED", "FAILED"}


@pytest.fixture(scope="module")
def declared():
    yaml = pytest.importorskip("yaml")
    assert DECL is not None and DECL.exists(), (
        "scripts/cert/tool_certification.yaml was not found from "
        f"{pathlib.Path(__file__).resolve()}"
    )
    data = yaml.safe_load(DECL.read_text(encoding="utf-8")) or {}
    tools = data.get("tools") or {}
    assert tools, "the declaration lists no tools"
    return tools


@pytest.fixture(scope="module")
def registered():
    from app.services.agent_flows.tools.registry import all_tools

    return set(all_tools())


# ── the set identity ────────────────────────────────────────────────────────

def test_every_registered_tool_is_declared(declared, registered):
    missing = sorted(registered - set(declared))
    assert not missing, (
        "these tools are registered and the certification says nothing about "
        f"them — they would ship certified by omission: {missing}"
    )


def test_every_declaration_describes_a_real_tool(declared, registered):
    stale = sorted(set(declared) - registered)
    assert not stale, (
        f"the certification describes tools that no longer exist: {stale}"
    )


def test_the_counts_are_what_the_report_claims(declared, registered):
    """A report quoting 'x of 36' has to be quoting this."""
    assert len(declared) == len(registered)
    states = [str(v.get("semantic_oracle")) for v in declared.values()]
    assert len(states) == len(registered)
    assert states.count("FAILED") == 0, (
        "a tool has a semantic oracle it does not satisfy; that is a release "
        "blocker, not a matrix entry"
    )


# ── no silent untested state ────────────────────────────────────────────────

def test_every_tool_has_a_known_state(declared):
    bad = {n: v.get("semantic_oracle") for n, v in declared.items()
           if v.get("semantic_oracle") not in STATES}
    assert not bad, f"unknown or missing semantic_oracle state: {bad}"


def test_every_tool_declares_a_tier(declared):
    bad = {n: v.get("tier") for n, v in declared.items()
           if v.get("tier") not in (1, 2, 3)}
    assert not bad, f"missing or invalid tier: {bad}"


def test_manual_required_always_says_why(declared):
    """'Not tested' is not a state. A manual tool has to explain why it cannot
    silently misstate a number."""
    silent = [n for n, v in declared.items()
              if v.get("semantic_oracle") == "MANUAL_REQUIRED"
              and len(str(v.get("reason") or "").strip()) < 40]
    assert not silent, f"MANUAL_REQUIRED with no real reason: {silent}"


def test_verified_always_names_a_test_that_exists(declared):
    """A citation that does not resolve is worse than no citation: it reads as
    coverage and is not."""
    broken = {}
    for name, entry in declared.items():
        if entry.get("semantic_oracle") != "VERIFIED":
            continue
        files = entry.get("by") or []
        assert files, f"{name} is VERIFIED and names no test"
        gone = [f for f in files if not (TESTS / f).exists()]
        if gone:
            broken[name] = gone
    assert not broken, f"VERIFIED entries naming tests that do not exist: {broken}"


# ── the release rule ────────────────────────────────────────────────────────

def test_no_correctness_sensitive_tool_is_manual(declared):
    """TIER 1 is defined as 'produces or transforms a number a reader will act
    on'. Those may not be certified by a human having once looked."""
    manual = sorted(n for n, v in declared.items()
                    if v.get("tier") == 1
                    and v.get("semantic_oracle") != "VERIFIED")
    assert not manual, (
        "correctness-sensitive tools without a deterministic semantic oracle: "
        f"{manual}"
    )


def test_the_tier_one_set_is_not_quietly_shrinking(declared):
    """The cheap way to pass the rule above is to demote a tool to tier 2. This
    pins the floor: the analytical surface is what it is."""
    tier1 = {n for n, v in declared.items() if v.get("tier") == 1}
    must_be_analytical = {
        "rank_values", "share_of", "total_measure", "aggregate_chart_data",
        "compute", "compare_periods", "compare_segments", "segment_compare",
        "compare_to_target", "analyze_trend", "detect_anomaly",
        "detect_seasonality", "describe_distribution", "correlate_charts",
        "explain_change", "forecast_measure", "project_to_period_end",
        "smart_drilldown", "describe_time_coverage", "get_chart_data",
    }
    demoted = sorted(must_be_analytical - tier1)
    assert not demoted, (
        f"these produce numbers a reader acts on and are no longer tier 1: {demoted}"
    )


# ── a file existing is not an oracle executing ──────────────────────────────
#
# THE LOOPHOLE THE RULES ABOVE LEAVE OPEN. They check that a VERIFIED tool names
# a test FILE and that the file is there. A case guarded by
#
#     if res.get("ok") is not True:
#         pytest.skip("the tool declined")
#
# turns a product regression into a green suite: the call starts being refused,
# the case skips, pytest still exits 0, and the matrix goes on calling the tool
# VERIFIED. So every tier-1 entry must name the NODE that proves it, and
# `scripts/ci/check_tier1_oracles.py` runs exactly those nodes and fails on a
# missing, skipped, errored or failed one.

def test_every_tier_one_tool_names_the_nodes_that_prove_it(declared):
    bare = sorted(n for n, v in declared.items()
                  if v.get("tier") == 1 and not (v.get("oracle_nodes") or []))
    assert not bare, (
        "tier-1 tools naming a test FILE but no test NODE. A file existing is "
        f"not an oracle executing: {bare}"
    )


def test_declared_oracle_nodes_look_like_node_ids(declared):
    """A path with no `::` is a file, and a file is what this rule replaced."""
    wrong = {}
    for name, entry in declared.items():
        for node in entry.get("oracle_nodes") or []:
            if "::" not in str(node) or not str(node).startswith("tests/"):
                wrong.setdefault(name, []).append(node)
    assert not wrong, f"not pytest node ids under tests/: {wrong}"


def test_every_declared_oracle_node_exists_in_its_file(declared):
    """A node id that does not resolve reads as coverage and is not. The runner
    catches it too, but catching it here names the tool rather than the id."""
    missing = {}
    for name, entry in declared.items():
        for node in entry.get("oracle_nodes") or []:
            path, _, func = str(node).partition("::")
            fname = path.split("/")[-1]
            target = TESTS / fname
            if not target.exists():
                missing.setdefault(name, []).append(f"{node} (no such file)")
                continue
            if f"def {func}(" not in target.read_text(encoding="utf-8"):
                missing.setdefault(name, []).append(f"{node} (no such test)")
    assert not missing, f"declared oracle nodes that do not resolve: {missing}"


def test_a_tier_one_oracle_carries_no_skip_guard(declared):
    """The specific shape that produced this rule. A tier-1 oracle may not
    contain `pytest.skip` at all: its fixtures are valid by construction, so a
    refusal is a failure and a missing field is a failure."""
    guarded = {}
    for name, entry in declared.items():
        if entry.get("tier") != 1:
            continue
        for node in entry.get("oracle_nodes") or []:
            path, _, func = str(node).partition("::")
            target = TESTS / path.split("/")[-1]
            if not target.exists():
                continue
            text = target.read_text(encoding="utf-8")
            start = text.find(f"def {func}(")
            if start < 0:
                continue
            nxt = text.find("\ndef ", start + 1)
            body = text[start: nxt if nxt > 0 else len(text)]
            if "pytest.skip" in body:
                guarded.setdefault(name, []).append(node)
    assert not guarded, (
        "tier-1 oracles containing a skip guard — a refused valid fixture would "
        f"go green instead of red: {guarded}"
    )
