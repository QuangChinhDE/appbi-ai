# -*- coding: utf-8 -*-
"""Capability discovery: the router controls VISIBILITY, the registry controls AUTHORITY.

Every granted tool used to reach the model as a full schema on every round, so a
step's context grew linearly with its grant — ~28.5k characters for the whole
catalogue, per round. These tests pin the V3 phase 4 contract:

  * a step whose grant fits within the limit is shown exactly what it always was;
  * a larger grant is shown at most `limit` capabilities (+ `find_capability`),
    chosen for the question, always including discovery and compute;
  * eligibility is the registry's own admission rule — a capability certain to be
    refused (web off, raw rows off) is never shown and never discoverable;
  * `find_capability` searches ONLY eligible grants — never an ungranted tool;
  * a granted-but-unshown capability cannot be invoked from memory
    (`capability_not_visible`) until it is discovered; an ungranted one is still
    `not_granted` from the registry;
  * the whole view is in the step's trace.
"""
from __future__ import annotations

import asyncio
import os
from types import SimpleNamespace

if not os.environ.get("DATABASE_URL"):
    os.environ["DATABASE_URL"] = "sqlite:///./test_flow_replay.db"
if not os.environ.get("DATA_DIR"):
    os.environ["DATA_DIR"] = ".testdata"

import pytest

import replay_harness as H  # noqa: E402

from app.services.agent_flows.contract import Flow, upgrade_body  # noqa: E402
from app.services.agent_flows.envelope import FlowInput  # noqa: E402
from app.services.agent_flows.runtime import capabilities as CAP  # noqa: E402
from app.services.agent_flows.runtime import executor  # noqa: E402
from app.services.agent_flows.runtime.handlers import agent as AH  # noqa: E402
from app.services.dashboard_ai_bot.events import AgentEvent  # noqa: E402
import app.services.agent_flows.tools.registry as tool_registry  # noqa: E402

ALL = sorted(tool_registry.all_tools())
NON_WEB = [n for n in ALL if not tool_registry.all_tools()[n].reaches_outside]
STARTER = ["search_business_assets", "resolve_chart_candidates", "inspect_filters",
           "describe_time_coverage", "rank_values", "total_measure", "share_of",
           "compare_periods", "get_chart_summary", "compute"]


def _ctx(**kw):
    return SimpleNamespace(**{"web_search": True, "read_rows": True, **kw})


# ── the view itself ─────────────────────────────────────────────────────────
def test_a_grant_that_fits_is_shown_whole_and_unchanged():
    view = CAP.build_view(STARTER, _ctx(), web_enabled=True)
    assert not view.shortlisted
    view.refresh("doanh thu")
    assert view.visible == view.eligible == STARTER


def test_the_default_limit_keeps_the_v1_starter_unshortlisted():
    """The certified V1 starter grants 10 tools."""
    assert CAP.default_limit() >= len(STARTER)


def test_by_default_no_grant_from_todays_catalogue_is_shortlisted():
    """Set by three live A/B runs: shortlisting a 32-capability grant at 12 cost
    answers (3/5/4 of 6 vs 6/6/5 shown in full). While the whole catalogue fits,
    it is shown whole; a node can still opt in with `visible_capabilities`."""
    assert CAP.default_limit() >= len(ALL)
    assert not CAP.build_view(ALL, _ctx(), web_enabled=True).shortlisted


def test_a_shortlisted_step_is_told_by_name_what_else_it_may_use():
    """Measured: a shortlisted step never called find_capability in three live
    runs — it cannot look for what it does not know exists."""
    grant = [n for n in NON_WEB if n != "forecast_measure"]
    view = CAP.build_view(grant, _ctx(), web_enabled=True, limit=8)
    view.refresh("doanh thu")
    index = view.hidden_index()
    hidden = [n for n in view.eligible if n not in view.visible]
    assert hidden and all(f"- {n}" in index for n in hidden)
    assert "forecast_measure" not in index, "never names an ungranted capability"
    assert not any(f"- {n}:" in index for n in view.visible)
    assert CAP.build_view(STARTER, _ctx(), web_enabled=True).hidden_index() == ""


def test_a_large_grant_is_shortlisted_to_the_limit_with_the_core_always_in():
    view = CAP.build_view(NON_WEB, _ctx(), web_enabled=True, limit=8)
    assert view.shortlisted
    view.refresh("Doanh thu tháng này tăng bao nhiêu phần trăm so với kỳ trước?")
    assert len(view.visible) <= 8
    for core in CAP.CORE:
        assert core in view.visible
    assert "compare_periods" in view.visible


def test_the_core_is_every_way_in_to_a_chart_id_plus_compute():
    """Measured live: without `list_charts` in the core, a shortlisted step guessed
    chart ids and answered 3 of 6; with everything shown, 6 of 6."""
    from app.services.agent_flows.contract import _CHART_LOOKUP_TOOLS

    assert set(CAP.CORE) == set(_CHART_LOOKUP_TOOLS) | {"compute"}


@pytest.mark.parametrize("question,expected", [
    ("Dự báo doanh thu tháng sau", "forecast_measure"),
    ("Danh mục nào có doanh thu cao nhất?", "rank_values"),
    ("Tỷ trọng của từng bang trong tổng doanh thu", "share_of"),
    ("Vì sao doanh thu giảm?", "explain_change"),
    ("Có điểm bất thường nào không?", "detect_anomaly"),
    ("So với mục tiêu thì sao?", "compare_to_target"),
])
def test_the_shortlist_follows_the_question(question, expected):
    view = CAP.build_view(NON_WEB, _ctx(), web_enabled=True, limit=8)
    view.refresh(question)
    assert expected in view.visible, (question, view.visible)


def test_schema_size_no_longer_grows_with_the_grant():
    """Context bounded by the limit, not by the catalogue."""
    full = CAP.schema_chars(tool_registry.definitions_for(set(NON_WEB), web_enabled=True))
    sizes = []
    for grant in (NON_WEB[:16], NON_WEB[:24], NON_WEB):
        view = CAP.build_view(grant, _ctx(), web_enabled=True, limit=8)
        view.refresh("doanh thu tăng bao nhiêu so với kỳ trước")
        sizes.append(CAP.schema_chars(view.schemas(web_enabled=True)))
    assert max(sizes) <= full * 0.5, (sizes, full)
    assert max(sizes) - min(sizes) <= full * 0.25, sizes


# ── eligibility is the registry's admission rule ─────────────────────────────
def test_a_capability_certain_to_be_refused_is_never_shown_or_discoverable():
    view = CAP.build_view(ALL, _ctx(web_search=False, read_rows=False), web_enabled=False, limit=8)
    for web_tool in ("research_web", "web_search", "fetch_url"):
        assert web_tool not in view.eligible
    assert view.excluded["get_chart_data"] == "not_granted"      # raw rows off
    view.refresh("tìm trên web")
    found = {f["name"] for f in view.discover("tìm kiếm web internet")["data"]["found"]}
    assert not found & {"research_web", "web_search", "fetch_url", "browse_ai_answer"}


def test_find_capability_never_reveals_an_ungranted_capability():
    grant = [n for n in NON_WEB if n != "forecast_measure"]
    view = CAP.build_view(grant, _ctx(), web_enabled=True, limit=8)
    view.refresh("x")
    found = {f["name"] for f in view.discover("dự báo tháng sau forecast")["data"]["found"]}
    assert "forecast_measure" not in found
    assert found <= set(grant)


def test_discovery_makes_a_capability_visible_on_the_next_round():
    view = CAP.build_view(NON_WEB, _ctx(), web_enabled=True, limit=8)
    view.refresh("doanh thu")
    assert "correlate_charts" not in view.visible
    view.discover("tương quan giữa hai biểu đồ")
    view.refresh("doanh thu")
    assert "correlate_charts" in view.visible


# ── through a real Agent step ────────────────────────────────────────────────
class _Model:
    def __init__(self, script):
        self.script = script
        self.rounds = 0
        self.offered: list[list[str]] = []
        self.results: list[dict] = []

    def stream(self):
        async def fake(*, provider, api_key, model, system_prompt, messages, tools):
            self.rounds += 1
            self.offered.append([t.get("name") for t in (tools or [])])
            self.results = [m.get("result") for m in messages if m.get("role") == "tool"]
            calls = self.script[self.rounds - 1] if self.rounds <= len(self.script) else []
            for i, (name, args) in enumerate(calls):
                yield AgentEvent(type="tool_call", tool_call_id=f"r{self.rounds}c{i}",
                                 tool_name=name, tool_args=args)
            if not calls:
                yield AgentEvent(type="text", text="xong")
        return fake


def _registry(ctx, name, args, allowed=None, use_cache=True):
    if allowed is not None and name not in allowed:
        return {"ok": False, "error_code": "not_granted", "error": "not granted"}
    return {"ok": True, "kind": "value", "data": {"value": 1}}


def _run(monkeypatch, model, grant, *, limit=8):
    monkeypatch.setattr(AH, "_stream", model.stream())
    monkeypatch.setattr(tool_registry, "execute", _registry)
    body = {"answer_node": "a", "nodes": [{
        "key": "a", "name": "a", "type": "agent", "prompt": "Phân tích doanh thu",
        "max_tool_calls": 10, "visible_capabilities": limit,
        "tools": [{"tool": t} for t in grant]}]}
    flow = Flow.model_validate({**upgrade_body(body, key="fx_d", name="d"), "key": "fx_d", "name": "d"})
    env = H._envelope({"envelope": {"runtime": {"provider": "openai", "model": "m",
                       "budget": {"max_llm_calls": 12, "max_tool_calls": 40, "max_seconds": 60}}}})

    async def go():
        out = None
        async for ev in executor.run_flow(FlowInput.model_validate(env), flow=flow, ctx=H._Ctx([41]),
                                          api_key="k", base_system_prompt="BASE"):
            if ev.type == "result":
                out = ev.extra.get("envelope")
        return out or {}

    return asyncio.run(go())


def _step(env):
    return ((env.get("trace") or {}).get("steps") or [{}])[0]


def test_a_shortlisted_step_offers_at_most_the_limit_plus_discovery(monkeypatch):
    model = _Model([[]])
    _run(monkeypatch, model, NON_WEB)
    offered = model.offered[0]
    assert CAP.FIND_CAPABILITY in offered
    assert len(offered) <= 8 + 1
    assert set(offered) - {CAP.FIND_CAPABILITY} <= set(NON_WEB)


def test_an_unshown_capability_must_be_discovered_before_it_runs(monkeypatch):
    model = _Model([
        [("correlate_charts", {"chart_ids": [41, 42]})],                # from memory
        [(CAP.FIND_CAPABILITY, {"query": "tương quan giữa hai biểu đồ"})],  # discover
        [("correlate_charts", {"chart_ids": [41, 42]})],                # now shown
        [],
    ])
    env = _run(monkeypatch, model, NON_WEB)
    assert "correlate_charts" not in model.offered[0]
    assert "correlate_charts" in model.offered[2]
    calls = _step(env).get("tool_calls") or []
    assert calls[0] == "correlate_charts(capability_not_visible)"
    assert calls[1] == CAP.FIND_CAPABILITY
    assert calls[2] == "correlate_charts"


def test_an_ungranted_capability_is_still_refused_by_the_registry(monkeypatch):
    model = _Model([[("forecast_measure", {"chart_id": 41})], []])
    grant = [n for n in NON_WEB if n != "forecast_measure"]
    env = _run(monkeypatch, model, grant)
    assert (_step(env).get("tool_calls") or [])[0] == "forecast_measure(not_granted)"


def test_the_step_trace_carries_the_whole_view(monkeypatch):
    model = _Model([[(CAP.FIND_CAPABILITY, {"query": "dự báo"})], [("forecast_measure", {"chart_id": 41})], []])
    env = _run(monkeypatch, model, NON_WEB)
    cap = _step(env).get("capabilities") or {}
    assert cap["shortlisted"] is True and cap["limit"] == 8
    assert cap["granted"] == NON_WEB
    assert "forecast_measure" in cap["discovered"]
    assert "forecast_measure" in cap["invoked"]
    assert len(cap["visible_per_round"]) >= 2
    assert all(len(r) <= 9 for r in cap["visible_per_round"])


def test_an_unshortlisted_step_records_its_view_too_and_behaves_as_before(monkeypatch):
    model = _Model([[("rank_values", {"chart_id": 41})], []])
    env = _run(monkeypatch, model, STARTER, limit=None)
    assert CAP.FIND_CAPABILITY not in model.offered[0]
    assert sorted(model.offered[0]) == sorted(STARTER)
    cap = _step(env).get("capabilities") or {}
    assert cap["shortlisted"] is False and cap["invoked"] == ["rank_values"]


def test_no_registry_tool_can_shadow_discovery():
    """The runtime answers `find_capability` itself; a registry tool of that name
    would be unreachable in a shortlisted step and reachable in any other."""
    assert CAP.FIND_CAPABILITY not in tool_registry.all_tools()


def test_the_catalogue_serves_the_text_discovery_ranks_on():
    spec = tool_registry.all_tools()["forecast_measure"]
    served = spec.to_dict()["search_text"]
    assert served == spec.search_text() and spec.label_vi in served
