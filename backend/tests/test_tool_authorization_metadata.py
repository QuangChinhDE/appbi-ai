# -*- coding: utf-8 -*-
"""What a tool must DECLARE before the registry will govern it.

WHY DECLARED AND NOT INFERRED
-----------------------------
The first version of the scope test in this repository was going to parametrize
over "every tool whose schema has a `chart_id`". That test silently stops covering
the tool whose author called the argument `chart_a`, and it never covered
`doc_id` at all. Proven, not predicted: the audit that produced `resource_refs`
found `read_document` taking a `doc_id` that no source scan had ever seen, because
its schema is assembled outside the pack file.

So security semantics live in the declaration, and these tests check that the
declaration is complete — including for the tool nobody has written yet. A generic
or MCP-supplied tool has no pack author to remember the rule, which is exactly why
the rule has to be something the registry can check.
"""
from __future__ import annotations

import ast
import os
import pathlib
import re

import pytest

os.environ.setdefault("DATABASE_URL", "sqlite:///./test_tool_authz.db")
os.environ.setdefault("DATA_DIR", ".testdata")

from app.services.agent_flows.tools.registry import ToolSpec, all_tools

#: Arguments that name something the caller must be entitled to. The map is the
#: audit's output, not the rule: a tool declares its own `resource_refs`, and this
#: list only exists so the test below can notice a tool that declared NOTHING
#: while taking one of these.
KNOWN_RESOURCE_ARGS = {
    "chart_id": "chart", "chart_a": "chart", "chart_b": "chart", "chart_ids": "chart",
    "doc_id": "document", "document_id": "document", "doc_ids": "document",
    "dataset_id": "dataset", "dataset_table_id": "dataset",
    "metric": "metric", "metric_id": "metric",
}

PACKS = pathlib.Path(__file__).resolve().parents[1] / "app/services/agent_flows/tools/packs"


def _schema_args(spec: ToolSpec) -> set[str]:
    d = spec.definition or {}
    sch = d.get("input_schema") or d.get("parameters") \
        or (d.get("function") or {}).get("parameters") or {}
    return set((sch.get("properties") or {}).keys())


def _required(spec: ToolSpec) -> set[str]:
    d = spec.definition or {}
    sch = d.get("input_schema") or d.get("parameters") \
        or (d.get("function") or {}).get("parameters") or {}
    return set(sch.get("required") or [])


ALL = sorted(all_tools().items())


# ── the declaration must be complete ────────────────────────────────────────


@pytest.mark.parametrize("name,spec", ALL, ids=[n for n, _ in ALL])
def test_every_resource_argument_is_declared(name, spec):
    """THE CHECK THAT CATCHES TOOL #37.

    A tool that takes a governed resource and declares none is a tool the scope
    property test will skip in silence — which is the same as not having the test.
    """
    taken = _schema_args(spec) & set(KNOWN_RESOURCE_ARGS)
    undeclared = taken - set(spec.resource_refs)

    assert not undeclared, (
        f"{name} takes {sorted(undeclared)} but declares resource_refs="
        f"{spec.resource_refs!r}. Add them to the tool's declaration; a scope test "
        f"cannot guess what it was not told."
    )


@pytest.mark.parametrize("name,spec", ALL, ids=[n for n, _ in ALL])
def test_declared_resources_exist_in_the_schema(name, spec):
    """The other direction: a declaration naming an argument the tool does not
    take is a rule that will never fire, and reads as coverage."""
    missing = set(spec.resource_refs) - _schema_args(spec)

    assert not missing, f"{name} declares {sorted(missing)}, not in its schema"


@pytest.mark.parametrize("name,spec", ALL, ids=[n for n, _ in ALL])
def test_every_resource_type_is_one_we_govern(name, spec):
    for arg, kind in spec.resource_refs.items():
        assert kind in ("chart", "document", "dataset", "metric"), (
            f"{name}.{arg} declares resource type {kind!r}, which nothing enforces"
        )


# ── data exposure ───────────────────────────────────────────────────────────


@pytest.mark.parametrize("name,spec", ALL, ids=[n for n, _ in ALL])
def test_every_tool_declares_a_known_exposure(name, spec):
    assert spec.data_exposure in ("metadata", "derived", "raw_rows")


def _pack_sources() -> str:
    return "\n".join(
        p.read_text(encoding="utf-8") for p in sorted(PACKS.glob("*.py"))
        if not p.name.startswith("_")
    )


@pytest.mark.parametrize(
    "name,spec",
    [(n, s) for n, s in ALL if s.result_kind == "table"],
    ids=[n for n, s in ALL if s.result_kind == "table"],
)
def test_a_row_shaped_tool_states_its_exposure_explicitly(name, spec):
    """A `table` result is the row-level SHAPE. Whether it is raw records or
    aggregated groups is the difference between governed and not, and inheriting
    the `derived` default is how a row-exposing tool would slip through governed
    as if it were not.

    `aggregate_chart_data` is legitimately `derived` — it returns a table of
    GROUPS — but it has to say so rather than inherit it. A dataclass cannot tell
    a passed value from a default, so this reads the source.
    """
    src = _pack_sources()
    # THE DECLARATION, NOT THE FIRST MENTION.
    #
    # This used to take the first `"<name>"` anywhere in the pack sources, so any
    # PROSE containing the tool's name won the search and the check read a block
    # that was not a declaration. It broke the moment a `use_with` sentence told
    # the model to "name it in rank_values or aggregate_chart_data" — a correct
    # piece of guidance, failing a check that was matching English.
    #
    # `spec(` is where a tool is actually declared, so that is what this anchors
    # to.
    m = re.search(r"spec\(\s*[\"']" + re.escape(name) + r"[\"']", src)
    assert m, f"{name} has no spec(...) declaration in any pack source"
    block = src[m.start():m.start() + 2600]
    assert re.search(r"data_exposure\s*=", block), (
        f"{name} returns a table and does not declare data_exposure. State it: "
        f"raw_rows if the rows ARE the result, derived if they are aggregated."
    )


def test_the_tools_that_hand_over_rows_are_the_ones_we_expect():
    """A CHANGE DETECTOR, on purpose. This set is what `read_rows=False` turns
    off; growing it silently is how a chat surface starts leaking row data."""
    raw = {n for n, s in ALL if s.data_exposure == "raw_rows"}

    assert raw == {"get_chart_data", "smart_drilldown"}, (
        "the set of row-exposing tools changed — if that is intended, update this "
        "test and check the chat surface, which runs with read_rows=False"
    )


def test_a_metadata_tool_never_claims_to_return_a_table():
    for name, spec in ALL:
        if spec.data_exposure == "metadata":
            assert spec.result_kind != "table", (
                f"{name} says it exposes metadata only but returns a table"
            )


# ── the spec refuses a nonsense declaration ─────────────────────────────────


def test_an_unknown_exposure_is_refused_at_construction():
    with pytest.raises(ValueError, match="data_exposure"):
        ToolSpec(
            name="x", fn=lambda c, a: {}, definition={"name": "x"},
            label_vi="x", label_en="x", description_vi="x",
            data_exposure="whatever",   # type: ignore[arg-type]
        )


# ── what the negative-argument suite is generated FROM ──────────────────────


def test_at_least_one_tool_requires_nothing_and_that_is_legitimate():
    """Pinned because the first draft of the test plan proposed "every tool called
    with no arguments must error", which would have broken these four on purpose.

    `inspect_filters` takes no arguments by design; `list_charts` browses the whole
    report when given no query. A tool with `required = []` must run SAFELY and
    BOUNDED with nothing passed — not fail.
    """
    free = {n for n, s in ALL if not _required(s)}

    assert "inspect_filters" in free
    assert "list_charts" in free
    assert len(free) >= 4, f"only {sorted(free)} require nothing — did a schema change?"
