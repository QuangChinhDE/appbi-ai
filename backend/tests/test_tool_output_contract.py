# -*- coding: utf-8 -*-
"""V3.1 — the machine-readable half of a tool's contract.

WHY `output_schema` AND NOT JUST `returns`
------------------------------------------
`returns` is prose, and prose is right for its readers: an author choosing between
two tools, and a person reading a failed run. It is wrong for a ToolNode, which has
to wire one step's output into the next step's input with no model in between —
and 16 of the 122 keys declared in `returns` are not identifiers at all
(`'actual / target'`, `'columns / rows'`). They were never meant to be.

So a second field, for the second reader. `returns` is not deprecated and is not
generated from this one; trying to make one field serve both is how the first one
ended up shaped like neither.

WHAT IT DESCRIBES, EXACTLY
--------------------------
`result.data`. Not the envelope. Every tool returns `{ok, kind, data, coverage?}`,
so `ok` and `kind` are the platform's contract and no tool should restate them.
A consumer wiring a variable writes `{{ranking.items}}`.

THE TEST THAT MATTERS IS THE ONE THAT CALLS THE TOOL
-----------------------------------------------------
A schema copied out of a docstring is worse than no schema: ToolNode would wire a
variable that does not exist, and the failure would land in front of a viewer. So
the schemas here are checked against a REAL result, not against the documentation
they were derived from.
"""
from __future__ import annotations

import os

import pytest

if not os.environ.get("DATABASE_URL"):
    os.environ["DATABASE_URL"] = "sqlite:///./test_tool_output.db"
if not os.environ.get("DATA_DIR"):
    os.environ["DATA_DIR"] = ".testdata"

from app.services.agent_flows.tools.registry import ToolSpec, all_tools  # noqa: E402

ALL = sorted(all_tools().items())
WITH_SCHEMA = [(n, s) for n, s in ALL if s.output_schema]


# ── risk fails closed ───────────────────────────────────────────────────────


@pytest.mark.parametrize("name,spec", ALL, ids=[n for n, _ in ALL])
def test_every_tool_classifies_its_risk(name, spec):
    """THE FAIL-CLOSED RULE.

    A default of "safe" means the tool added next year and left unclassified — the
    one that deletes a record or sends an email — is governed as harmless. The
    default is `unknown`, and `unknown` is a CI failure rather than a permission.
    """
    assert spec.risk != "unknown", (
        f"{name} has not classified its risk. Declare risk=read_only if it only "
        f"reads, side_effect if it changes something reversible, destructive if "
        f"it does not. The default is deliberately not usable."
    )


def test_todays_tools_are_all_read_only_and_that_was_checked():
    """Recorded because it is what made the migration safe: no pack body and no
    legacy source contains INSERT / UPDATE / DELETE / db.add / db.commit, and all
    five external tools read the web rather than act on it. When that stops being
    true, this test is the thing that should stop being true with it."""
    risky = {n: s.risk for n, s in ALL if s.risk != "read_only"}

    assert risky == {}, (
        f"{risky} — a tool now acts on the world. Good: that is what the field is "
        f"for. Update this test, and make sure the approval path exists before the "
        f"tool ships."
    )


def test_an_unknown_risk_value_is_refused_at_construction():
    with pytest.raises(ValueError, match="risk"):
        ToolSpec(name="x", fn=lambda c, a: {}, definition={"name": "x"},
                 label_vi="x", label_en="x", description_vi="x",
                 risk="probably_fine")  # type: ignore[arg-type]


# ── the schema is a schema ──────────────────────────────────────────────────


@pytest.mark.parametrize("name,spec", WITH_SCHEMA, ids=[n for n, _ in WITH_SCHEMA])
def test_a_declared_schema_is_well_formed(name, spec):
    schema = spec.output_schema
    assert schema.get("type") == "object", f"{name}: top level must be an object"
    props = schema.get("properties")
    assert isinstance(props, dict) and props, f"{name}: no properties"
    for key, prop in props.items():
        assert key.isidentifier(), (
            f"{name}.{key!r} is not an identifier — a consumer cannot write "
            f"{{{{var.{key}}}}}. Prose belongs in `returns`."
        )
        assert prop.get("type") in (
            "object", "array", "string", "number", "integer", "boolean"
        ), f"{name}.{key}: unknown type {prop.get('type')!r}"


@pytest.mark.parametrize("name,spec", WITH_SCHEMA, ids=[n for n, _ in WITH_SCHEMA])
def test_a_schema_never_describes_the_envelope(name, spec):
    """`ok` / `kind` / `coverage` / `error_code` belong to the platform. A tool
    restating them is a tool whose consumers will disagree about where to look."""
    props = set(spec.output_schema.get("properties") or {})
    envelope = props & {"ok", "kind", "error", "error_code", "retryable"}

    assert not envelope, (
        f"{name} declares envelope fields {sorted(envelope)} — output_schema "
        f"describes result.data only"
    )


def test_returns_is_still_there_and_still_prose():
    """`output_schema` did not replace `returns`, and the keys `returns` carries
    are exactly why: they were written for a person."""
    prose = [
        (n, k) for n, s in ALL for k in s.returns if not k.isidentifier()
    ]

    assert prose, "returns stopped carrying prose keys — was it regenerated?"
    assert all(s.returns for _, s in ALL), "a tool lost its human-readable returns"


# ── and the one that calls the tool ─────────────────────────────────────────


class _Ctx:
    """The smallest context the METADATA tools actually read.

    Derived from the bodies rather than guessed: `inspect_filters` reads
    `public_filters`; `list_charts` reads `allowed_chart_ids`, `chart_meta`,
    `dashboard`, `pages` and `public_filters`. Nothing here touches a warehouse,
    which is why these two can be checked on any machine including a CI runner
    with no database.

    The computing tools need a real report and are checked in the ToolNode phase
    against one. Declaring a schema for them without that check would be the
    docstring-copy failure this file exists to prevent.
    """

    dashboard = None
    read_rows = True
    web_search = True
    allowed_chart_ids = {41}
    knowledge_scope: dict = {}
    max_result_tokens = 4000
    max_rows_per_call = 50
    public_filters: list = []
    pages: list = []
    chart_meta = {41: {"name": "Doanh thu theo danh mục", "chart_type": "BAR",
                       "measures": [{"field": "revenue"}],
                       "dimensions": [{"field": "category"}]}}


def test_a_declared_schema_matches_what_the_tool_actually_returns():
    """THE TEST THE OTHERS EXIST TO SUPPORT.

    Checked against a live call rather than against the docstring the schema was
    derived from. A tool that cannot run on this bare context is skipped rather
    than guessed at — silence is better than a false green, and the ToolNode phase
    will exercise the rest against a real report.
    """
    from app.services.agent_flows.tools.registry import execute

    checked = 0
    for name, spec in WITH_SCHEMA:
        out = execute(_Ctx(), name, {"chart_id": 41}, use_cache=False)
        if not out.get("ok"):
            continue
        data = out.get("data")
        assert isinstance(data, dict), f"{name}: data is not an object"
        declared = set(spec.output_schema.get("properties") or {})
        missing = declared - set(data)
        assert not missing, (
            f"{name} declares {sorted(missing)} which the real result does not "
            f"contain — a ToolNode would wire a variable that never arrives"
        )
        checked += 1

    assert checked >= 1, (
        "no declared schema could be checked against a real call on this context — "
        "the assertion above never ran, which is a green test that proves nothing"
    )


#: EVERY declared schema, checked against report 67 before it was allowed to ship.
#: CI cannot repeat this — the computing tools need a warehouse — so the evidence
#: is recorded here instead of being implied.
#:
#:   describe_time_coverage   chart 686   no missing keys
#:   inspect_filters          —           no missing keys
#:   list_charts              —           no missing keys
#:   rank_values              chart 686   no missing keys
#:   share_of                 chart 686   no missing keys  (item="health_beauty")
#:   total_measure            chart 686   no missing keys
#:
#: That pass also corrected a declaration: `rank_values.items` was documented as
#: "key + value" and really carries `rank, label, value, formatted, share_pct`. A
#: ToolNode wiring `{{r.items[0].key}}` from the docstring would have found
#: nothing there — which is the whole argument for checking schemas against
#: payloads rather than against prose.
VERIFIED_AGAINST_REPORT_67 = frozenset({
    "describe_time_coverage", "inspect_filters", "list_charts",
    "rank_values", "share_of", "total_measure",
})


#: Schemas CI verifies on EVERY run against real results — possible when a tool
#: needs no warehouse. Each names the test file that does it; the check below
#: makes sure that file exists, runs in CI, and actually exercises the tool.
VERIFIED_IN_CI = {
    # Pure: every result shape (certified, tainted, literal-only, step-referenced)
    # is produced and validated against the declared schema, key by key and type
    # by type, with `tools.schema_check`.
    "compute": "tests/test_compute_typed_contract.py",
}


def test_a_ci_verifier_exists_runs_and_exercises_its_tool():
    import pathlib

    root = pathlib.Path(__file__).resolve().parent.parent
    workflow = (root.parent / ".github" / "workflows" / "backend-contract-tests.yml").read_text(encoding="utf-8")
    for tool, path in VERIFIED_IN_CI.items():
        src = (root / path).read_text(encoding="utf-8")
        assert tool in src and "schema_check" in src, f"{path} does not validate {tool}"
        assert path in workflow, f"{path} verifies {tool} but CI never runs it"


def test_no_schema_ships_without_having_been_verified_somewhere():
    """A schema nobody checked is worse than no schema: ToolNode would wire a
    variable that never arrives and the failure would land in front of a viewer.

    CI verifies what it can reach; the rest is listed above with the report and
    chart it was checked on. Declaring a seventh schema without adding it here is
    the failure this test exists to make loud.
    """
    declared = {n for n, _ in WITH_SCHEMA}
    unverified = declared - VERIFIED_AGAINST_REPORT_67 - set(VERIFIED_IN_CI)

    assert not unverified, (
        f"{sorted(unverified)} declare an output_schema that was never checked "
        f"against a real result. Run scripts against a real report, confirm the "
        f"keys, then add them to VERIFIED_AGAINST_REPORT_67 with what you ran."
    )
