# -*- coding: utf-8 -*-
"""V3.0 — the harness that makes "this refactor changed nothing" checkable.

WHAT THIS SUITE IS FOR
----------------------
V3.3 moves the wrapper around every node and V3.4 moves the reasoning loop inside
every agent. Both are the kind of change whose damage surfaces weeks later in a
flow nobody was watching. This suite replays tracked fixtures through the real
executor and compares a canonical reduction of the result against a committed
snapshot.

TWO HALVES, AND THE SECOND ONE IS THE POINT
-------------------------------------------
Replaying fixtures proves nothing unless the canonicaliser is itself trustworthy.
A canonicaliser that drops too much is a suite that passes through any refactor; one
that drops too little is a suite that fails when a clock moves and gets an
`--update` flag bolted on within a week. So half the tests below check the
canonicaliser: volatile in, identical out — semantic in, difference out.

THIS IS NOT THE AGENT EVAL
--------------------------
Replay answers "did the runtime's behaviour change". Whether the agent ANSWERS well
is a different question, needs a real model, and belongs in a nightly eval. A green
replay says a refactor was faithful, not that the product is correct.
"""
from __future__ import annotations

import copy
import json
import os

import pytest

if not os.environ.get("DATABASE_URL"):
    os.environ["DATABASE_URL"] = "sqlite:///./test_flow_replay.db"
if not os.environ.get("DATA_DIR"):
    os.environ["DATA_DIR"] = ".testdata"

import replay_harness as H  # noqa: E402

FIXTURES = H.load_fixtures()
IDS = [f["name"] for f in FIXTURES]


# ── the fixture set itself ──────────────────────────────────────────────────


def test_there_are_fixtures_and_they_are_tracked():
    """A suite that silently finds zero fixtures is green and worthless — the
    failure mode this whole V3 phase exists to prevent elsewhere."""
    assert len(FIXTURES) >= 12, f"only {len(FIXTURES)} fixtures found"
    for fx in FIXTURES:
        assert fx.get("flow", {}).get("nodes"), f"{fx['name']} has no nodes"


def test_the_fixtures_cover_the_shapes_that_matter():
    """Coverage is by SHAPE, not by count. Twenty-five copies of one linear flow
    would look like coverage and protect one code path."""
    covered = {c for fx in FIXTURES for c in (fx.get("covers") or [])}
    blob = " ".join(covered).lower()

    for shape in ("agent", "report_read", "tool", "if", "switch", "loop",
                  "coordinate", "knowledge", "reuse", "error", "retry",
                  "budget", "capability", "scope"):
        assert shape in blob, f"no fixture covers {shape!r}"


@pytest.mark.parametrize("fixture", FIXTURES, ids=IDS)
def test_every_fixture_runs(fixture, monkeypatch):
    """Before comparing anything: each fixture must actually execute. A fixture
    the contract rejects would otherwise show up as a snapshot mismatch and send
    the reader looking for a runtime regression that is not there."""
    snap = H.replay(fixture, monkeypatch)

    assert snap["status"] in ("ok", "partial", "failed", "blocked")
    assert snap["execution_path"], f"{fixture['name']} ran no steps"


# ── the snapshots ───────────────────────────────────────────────────────────


@pytest.mark.parametrize("fixture", FIXTURES, ids=IDS)
def test_replay_matches_the_committed_snapshot(fixture, monkeypatch):
    """THE REGRESSION GATE.

    No `--update` path exists on purpose. When this fails, either the change was
    unintended — fix the code — or it was intended, in which case the snapshot is
    updated in the SAME commit as the change, and the diff below is what the
    reviewer reads to decide.
    """
    expected = H.read_snapshot(fixture["name"])
    assert expected is not None, (
        f"no snapshot for {fixture['name']}. Generate with "
        f"`python scripts/agent_flow_replay.py --snapshot` and commit it."
    )

    actual = H.replay(fixture, monkeypatch)
    differences = H.diff(expected, actual)

    assert not differences, (
        f"{fixture['name']} drifted:\n  " + "\n  ".join(differences[:20])
    )


# ── the canonicaliser: drops volatile ───────────────────────────────────────


def _result(**over):
    base = {
        "status": "ok",
        "run_id": "run-abc",
        "trace": {"steps": [
            {"key": "read", "type": "report_read", "status": "ok", "ms": 12,
             "output_preview": "bao_cao = {...}", "tool_calls": ["list_charts"]},
            {"key": "answer", "type": "agent", "status": "ok", "ms": 340,
             "output_preview": "tra loi", "tool_calls": ["rank_values"]},
        ]},
        "answer": {"blocks": [{"text": "x"}]},
        "citations": [{"kind": "chart", "ref": "41"}],
        "notices": [{"code": "charts_unreadable", "text": "bất kỳ chữ nào"}],
        "usage": {"llm_calls": 1, "prompt_tokens": 100, "completion_tokens": 20},
        "memory_delta": {"set": {"ky": 1}},
    }
    base.update(over)
    return base


@pytest.mark.parametrize("field,value", [
    ("run_id", "run-zzz"),
    ("usage", {"llm_calls": 1, "prompt_tokens": 999999, "completion_tokens": 7}),
])
def test_volatile_fields_do_not_move_the_snapshot(field, value):
    """A clock, an id and a token estimate must never fail a build."""
    a = H.canonicalise(_result(), name="t")
    b = H.canonicalise(_result(**{field: value}), name="t")

    assert H.diff(a, b) == [], f"{field} leaked into the snapshot"


def test_durations_do_not_move_the_snapshot():
    slow = _result()
    for step in slow["trace"]["steps"]:
        step["ms"] = step["ms"] * 100

    assert H.diff(H.canonicalise(_result(), name="t"),
                  H.canonicalise(slow, name="t")) == []


def test_notice_TEXT_does_not_move_the_snapshot_but_the_code_does():
    """Notice prose is written for people and gets reworded. The CODE is the
    contract, and a code disappearing means the run stopped admitting something."""
    reworded = _result()
    reworded["notices"] = [{"code": "charts_unreadable", "text": "chữ khác hẳn"}]
    assert H.diff(H.canonicalise(_result(), name="t"),
                  H.canonicalise(reworded, name="t")) == []

    dropped = _result()
    dropped["notices"] = []
    assert H.diff(H.canonicalise(_result(), name="t"),
                  H.canonicalise(dropped, name="t")) != []


def test_citation_ORDER_does_not_move_the_snapshot():
    """Read order is already pinned by `tool_calls`; the citation list flapping
    would make the suite noisy for no extra protection."""
    a = _result()
    a["citations"] = [{"kind": "chart", "ref": "41"}, {"kind": "chart", "ref": "7"}]
    b = _result()
    b["citations"] = [{"kind": "chart", "ref": "7"}, {"kind": "chart", "ref": "41"}]

    assert H.diff(H.canonicalise(a, name="t"), H.canonicalise(b, name="t")) == []


# ── the canonicaliser: catches semantics ────────────────────────────────────


def test_a_changed_tool_argument_fails():
    """`top_n` quietly becoming 50 is the drift that produces a plausible wrong
    number — the class behind the 17x ranking error already in this repository."""
    a = H.canonicalise(_result(), name="t")
    moved = _result()
    moved["trace"]["steps"][1]["tool_calls"] = ["rank_values(bad_argument)"]

    assert H.diff(a, H.canonicalise(moved, name="t")) != []


def test_a_changed_tool_ORDER_fails():
    """Reading a chart before listing charts is a different flow, even when the
    answer is identical."""
    swapped = _result()
    swapped["trace"]["steps"][0]["tool_calls"] = ["rank_values"]
    swapped["trace"]["steps"][1]["tool_calls"] = ["list_charts"]

    assert H.diff(H.canonicalise(_result(), name="t"),
                  H.canonicalise(swapped, name="t")) != []


def test_a_permission_decision_that_stops_firing_fails():
    """THE I5 TRIPWIRE, at snapshot level. If a gate is deleted the refusal
    vanishes from `tool_calls`, and this is what notices."""
    refused = _result()
    refused["trace"]["steps"][1]["tool_calls"] = ["get_chart_data(not_granted)"]
    allowed = _result()
    allowed["trace"]["steps"][1]["tool_calls"] = ["get_chart_data"]

    assert H.diff(H.canonicalise(refused, name="t"),
                  H.canonicalise(allowed, name="t")) != []


def test_a_node_that_stops_being_reused_fails():
    """`reused` → `ok` costs money even when the answer is identical."""
    ran = _result()
    ran["trace"]["steps"][0]["status"] = "reused"

    assert H.diff(H.canonicalise(_result(), name="t"),
                  H.canonicalise(ran, name="t")) != []


def test_a_step_that_disappears_fails():
    fewer = _result()
    fewer["trace"]["steps"] = fewer["trace"]["steps"][:1]

    assert H.diff(H.canonicalise(_result(), name="t"),
                  H.canonicalise(fewer, name="t")) != []


def test_a_changed_step_output_fails():
    """What a step publishes is what the next step reads."""
    changed = _result()
    changed["trace"]["steps"][0]["output_preview"] = "bao_cao = {khac han}"

    assert H.diff(H.canonicalise(_result(), name="t"),
                  H.canonicalise(changed, name="t")) != []


def test_a_changed_status_fails():
    assert H.diff(H.canonicalise(_result(), name="t"),
                  H.canonicalise(_result(status="partial"), name="t")) != []


def test_the_diff_names_where_it_changed():
    """A diff that prints two JSON blobs makes a reader hunt. This one says
    `tool_calls[1].refused`, which is the whole value of having it."""
    changed = _result()
    changed["trace"]["steps"][1]["tool_calls"] = ["rank_values(not_granted)"]

    lines = H.diff(H.canonicalise(_result(), name="t"),
                   H.canonicalise(changed, name="t"))

    assert any("tool_calls" in line for line in lines), lines


def test_canonicalising_twice_gives_the_same_thing():
    """Non-determinism in the canonicaliser would show up as random CI failures
    blamed on whatever was refactored that week."""
    one = H.canonicalise(_result(), name="t")
    two = H.canonicalise(copy.deepcopy(_result()), name="t")

    assert json.dumps(one, sort_keys=True) == json.dumps(two, sort_keys=True)


# ── the known defect this phase found and deliberately did not fix ──────────


def test_the_chart_scope_taxonomy_defect_is_recorded_not_hidden():
    """FOUND WHILE BUILDING THE HARNESS, AND LEFT IN ON PURPOSE.

    `assert_chart_in_scope` refuses a chart outside the binding correctly, but
    `result.classify()` maps its message to `query_failed` — because `_CODE_HINTS`
    matches "not in scope" while the guard emits "is not part of this dashboard".
    A model reading `query_failed` is told to retry a call that can never succeed,
    and never sees the `chart_out_of_scope` recovery hint.

    V3.0's contract is that it changes no runtime behaviour, so the snapshot
    records today's answer. This test exists so the wrong value is NAMED rather
    than silently frozen — and when the taxonomy is fixed, the replay diff will
    show exactly this one field moving and nothing else.
    """
    fixture = next(f for f in FIXTURES if f["name"] == "12_chart_out_of_scope")

    assert fixture.get("known_defect"), "the defect label was removed"
    snap = H.read_snapshot(fixture["name"])
    assert snap is not None
    refusals = [c.get("refused") for c in snap["tool_calls"] if c.get("refused")]
    assert "query_failed" in refusals, (
        "the taxonomy defect appears to be fixed — good. Update this test and the "
        "snapshot together, and say so in the commit."
    )
