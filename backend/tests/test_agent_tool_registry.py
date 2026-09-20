"""The tool registry: one declaration, and the properties that depend on it.

The module this replaces held a dict of callables, a separate list of LLM schemas,
a second copy of both for its "normal" mode, and a hand-written capability table in
the frontend. Four places, and they drifted — a tool existed in one and not the
others more than once. These tests pin the single-declaration property and the two
gates that must not be bypassable.
"""
from __future__ import annotations

import os

os.environ.setdefault("DATABASE_URL", "sqlite:///./test_tool_registry.db")
os.environ.setdefault("DATA_DIR", ".testdata")

import pytest

from app.services.agent_flows.tools.registry import (
    ToolPack,
    all_tools,
    catalogue,
    definitions_for,
    execute,
    packs,
    register_pack,
)


def test_every_declared_tool_has_an_implementation_and_a_schema():
    """A pack entry with no body would show in the picker and fail when called; one
    with no schema would never be offered to the model at all. `_source.spec` raises
    on either, so simply building the registry is the assertion."""
    tools = all_tools()
    assert tools, "registry is empty"
    for name, spec in tools.items():
        assert callable(spec.fn), f"{name} has no implementation"
        schema_name = spec.definition.get("name") or spec.definition.get("function", {}).get("name")
        assert schema_name == name, f"{name} carries a schema for {schema_name!r}"


def test_no_tool_name_is_declared_twice():
    """Two tools with one name is how the old module ended up with a `get_chart_data`
    in two files that had drifted apart, and whichever imported last won."""
    seen: set[str] = set()
    for p in packs():
        for t in p.tools:
            assert t.name not in seen, f"{t.name} declared in more than one pack"
            seen.add(t.name)


def test_registering_a_clashing_pack_is_refused():
    existing = next(iter(all_tools().values()))
    with pytest.raises(ValueError):
        register_pack(ToolPack(key="clash", label_vi="x", label_en="x", tools=[existing]))


# ── the two gates ───────────────────────────────────────────────────────────

def test_the_external_pack_is_withheld_until_the_deployment_allows_it():
    off = {d.get("name") or d["function"]["name"]
           for d in definitions_for({"web_search", "fetch_url", "get_chart_data"}, web_enabled=False)}
    on = {d.get("name") or d["function"]["name"]
          for d in definitions_for({"web_search", "fetch_url", "get_chart_data"}, web_enabled=True)}
    assert off == {"get_chart_data"}
    assert {"web_search", "fetch_url"} <= on


def test_a_withheld_pack_is_shown_as_unavailable_not_hidden():
    """An author who cannot find `web_search` should learn the deployment has web
    research off, not conclude the feature does not exist."""
    ext = next(p for p in catalogue(web_enabled=False) if p["key"] == "external")
    assert ext["available"] is False
    assert ext["tools"], "the pack must still list its tools"
    assert ext["requires_setting"] == "web_search_enabled"


def test_an_unknown_gate_fails_closed():
    """A typo in a setting name must not hand out the tools it was written to
    withhold."""
    from app.services.agent_flows.tools import registry as reg

    pack = ToolPack(key="typo", label_vi="x", label_en="x", requires_setting="web_serch_enabled")
    assert reg._pack_available(pack, web_enabled=True) is False


# ASSERT THE CODE, NOT THE SENTENCE.
#
# Both of these matched on the error TEXT, and the text is the part meant to
# change: it is read by a flow author in the run inspector, so it gets reworded
# and translated. One of them had already been failing since a refactor renamed
# the message — the enforcement it was guarding still worked perfectly, and the
# red told nobody anything. `error_code` is the contract callers actually branch
# on, and it is what these tests exist to protect.
def test_the_allowlist_is_enforced_at_call_time_not_only_in_the_schemas():
    """A model can name a tool it was never offered — some do, when a prompt
    mentions one — and the only safe place to refuse is the moment before the
    call."""
    out = execute(None, "get_chart_data", {}, allowed={"list_charts"})
    assert out["ok"] is False
    assert out["error_code"] == "not_granted"
    assert "get_chart_data" in out["error"], "thông báo phải nêu tên công cụ bị chặn"


def test_an_unknown_tool_is_refused_rather_than_raising():
    out = execute(None, "no_such_tool", {}, allowed=None)
    assert out["ok"] is False
    assert out["error_code"] == "unknown_tool"
    assert "no_such_tool" in out["error"]


def test_a_raising_tool_returns_an_error_instead_of_a_traceback():
    """A traceback handed to the model wastes context and occasionally gets quoted
    into the answer."""
    from app.services.agent_flows.tools import registry as reg

    boom = next(iter(all_tools().values()))
    out = reg.execute(object(), boom.name, {"__force": "invalid"}, allowed={boom.name})
    assert isinstance(out, dict) and out.get("ok") is not True


# ── what a picker is allowed to know ───────────────────────────────────────

def test_the_catalogue_carries_no_callable_and_no_schema():
    """A picker needs to know what a tool IS. Shipping the schema would invite the
    frontend to start reasoning about arguments, which is the backend's job."""
    for p in catalogue(web_enabled=True):
        for t in p["tools"]:
            assert "fn" not in t and "definition" not in t
            assert {"name", "label_vi", "description_vi", "cost_class", "reaches_outside"} <= set(t)


def test_only_the_external_pack_reaches_outside_appbi():
    """The product property worth keeping: the knowledge a brain needs is already in
    AppBI. A second escape hatch appearing elsewhere should have to be deliberate."""
    for p in packs():
        for t in p.tools:
            if t.reaches_outside:
                assert p.key == "external", f"{t.name} reaches outside from pack {p.key}"


def test_the_first_generation_pipeline_tools_are_gone():
    """`emit_reading_plan` let the old bot announce the steps it was about to take —
    a hardcoded pipeline narrating itself. A brain's steps ARE the plan, and they are
    visible in the builder. `remember_fact` needed an approval screen that no longer
    exists."""
    names = set(all_tools())
    assert "emit_reading_plan" not in names
    assert "remember_fact" not in names
    # ...and the read side of learning survives, because reading approved knowledge
    # was never the risky half.
    assert "recall_knowledge" in names
