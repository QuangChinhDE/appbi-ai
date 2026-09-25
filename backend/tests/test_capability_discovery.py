# -*- coding: utf-8 -*-
"""Capability discovery: the router controls VISIBILITY, the registry controls AUTHORITY.

Every granted tool used to reach the model as a full schema on every round, so a
step's context grew linearly with its grant — ~28.5k characters for the whole
catalogue, per round. These tests pin the V3 phase 4 contract:

  * a step whose grant fits (the schema budget, or the author's count) is shown
    exactly what it always was;
  * a larger grant is ROUTED: the core, what the question ranks highest and what
    the step has loaded, in full; everything else one line each inside
    `find_capability`'s own definition;
  * eligibility is the registry's own admission rule — a capability certain to be
    refused (web off, raw rows off) is never shown, listed or loadable;
  * `find_capability` loads ONLY eligible grants, by need or by name, and answers
    an ungranted name exactly as it answers a nonexistent one; it is capped per step;
  * a granted-but-unshown capability is not run from memory
    (`capability_not_visible`) — it is loaded for the next round; an ungranted one
    is still `not_granted` from the registry;
  * the whole view, including every discovery, is in the step's trace.

The routing QUALITY (does the right capability load?) is measured separately, on
labelled intents: `test_capability_routing_eval.py`.
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


def test_by_default_a_small_grant_is_whole_and_the_catalogue_is_routed():
    """The policy is a schema BUDGET in characters, not a count. The V1 starter's
    ten tools fit and are shown whole; the whole non-web catalogue does not, and is
    routed. (The previous default — a count of 40, above the whole catalogue —
    avoided the quality question by never routing at all.)"""
    assert not CAP.build_view(STARTER, _ctx(), web_enabled=True).shortlisted
    view = CAP.build_view(NON_WEB, _ctx(), web_enabled=True, question="Tổng doanh thu?")
    assert view.shortlisted
    assert view.schema_budget == CAP.default_schema_budget()


def test_what_is_not_loaded_is_listed_inside_find_capabilitys_own_definition():
    """Measured: with the rest named in the SYSTEM prompt, a shortlisted step never
    called find_capability in five live runs. The catalogue now sits where a model
    looks when choosing a tool — the tool's own description — bounded in lines."""
    grant = [n for n in NON_WEB if n != "forecast_measure"]
    view = CAP.build_view(grant, _ctx(), web_enabled=True, limit=8)
    view.refresh("doanh thu")
    text = view.find_definition()["description"]
    hidden = [n for n in view.eligible if n not in view.visible]
    assert hidden and all(f"- {n} —" in text for n in hidden)
    assert "forecast_measure" not in text, "never names an ungranted capability"
    assert not any(f"- {n} —" in text for n in view.visible)
    assert CAP.FIND_CAPABILITY in view.routing_note()
    assert CAP.build_view(STARTER, _ctx(), web_enabled=True).routing_note() == ""


def test_the_catalogue_is_bounded_however_large_the_grant():
    view = CAP.build_view(NON_WEB, _ctx(), web_enabled=True, limit=2)
    view.refresh("doanh thu")
    text = view.find_definition()["description"]
    listed = [ln for ln in text.splitlines() if ln.startswith("- ")]
    assert len(listed) <= CAP.CATALOGUE_LINES
    if len(view.eligible) - len(view.visible) > CAP.CATALOGUE_LINES:
        assert "more" in text


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
    data = view.discover("tìm kiếm web internet", ["research_web", "web_search"])["data"]
    found = {f["name"] for f in data["loaded"] + data["already_loaded"]}
    assert not found & {"research_web", "web_search", "fetch_url", "browse_ai_answer"}
    assert set(data["not_available"]) == {"research_web", "web_search"}
    assert "research_web" not in view.find_definition()["description"]


def test_find_capability_never_reveals_an_ungranted_capability():
    grant = [n for n in NON_WEB if n != "forecast_measure"]
    view = CAP.build_view(grant, _ctx(), web_enabled=True, limit=8)
    view.refresh("x")
    data = view.discover("dự báo tháng sau forecast")["data"]
    found = {f["name"] for f in data["loaded"] + data["already_loaded"]}
    assert "forecast_measure" not in found
    assert found <= set(grant)


def test_an_ungranted_name_gets_the_same_answer_as_one_that_does_not_exist():
    """Discovery must not be an oracle for what exists outside the grant."""
    grant = [n for n in NON_WEB if n != "forecast_measure"]
    view = CAP.build_view(grant, _ctx(), web_enabled=True, limit=8)
    view.refresh("x")
    a = view.discover("", ["forecast_measure"])["data"]
    b = view.discover("", ["no_such_capability"])["data"]
    assert a["not_available"] == ["forecast_measure"] and b["not_available"] == ["no_such_capability"]
    assert {k: v for k, v in a.items() if k not in ("not_available", "discoveries_left")} == \
        {k: v for k, v in b.items() if k not in ("not_available", "discoveries_left")}
    assert "forecast_measure" not in view.visible


def test_discovery_loads_by_name_from_the_catalogue():
    view = CAP.build_view(NON_WEB, _ctx(), web_enabled=True, limit=8)
    view.refresh("Danh mục nào có doanh thu cao nhất?")
    assert "detect_seasonality" not in view.visible
    data = view.discover("", ["detect_seasonality"])["data"]
    assert [r["name"] for r in data["loaded"]] == ["detect_seasonality"]
    assert data["loaded"][0]["needs"], "the result says what the capability needs"
    view.refresh()
    assert "detect_seasonality" in view.visible


def test_discovery_is_bounded_per_step():
    view = CAP.build_view(NON_WEB, _ctx(), web_enabled=True, limit=8)
    view.refresh("doanh thu")
    for _ in range(CAP.MAX_DISCOVERIES):
        assert view.discover("dự báo")["ok"] is True
    out = view.discover("dự báo")
    assert out["ok"] is False and out["error_code"] == "discovery_exhausted"
    assert out["retryable"] is False
    loaded = view.sticky
    assert len(loaded) <= CAP.MAX_DISCOVERIES * CAP.MAX_LOAD


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


def test_an_unshown_capability_is_not_run_from_memory_but_is_loaded_for_next_round(monkeypatch):
    """The model has not seen the schema it is filling in, so that call does not
    run. The capability is eligible, so it is loaded: the next round offers it and
    the same call runs — no search round, and the refusal costs no tool call."""
    model = _Model([
        [("correlate_charts", {"chart_ids": [41, 42]})],                # from memory
        [("correlate_charts", {"chart_ids": [41, 42]})],                # now shown
        [],
    ])
    env = _run(monkeypatch, model, NON_WEB)
    assert "correlate_charts" not in model.offered[0]
    assert "correlate_charts" in model.offered[1]
    calls = _step(env).get("tool_calls") or []
    assert calls[0] == "correlate_charts(capability_not_visible)"
    assert calls[1] == "correlate_charts"
    assert (env.get("usage") or {}).get("tool_calls") == 1
    cap = _step(env).get("capabilities") or {}
    assert cap["auto_loaded"] == [{"round": 1, "name": "correlate_charts"}]


def test_discovery_by_need_loads_for_the_next_round(monkeypatch):
    model = _Model([
        [(CAP.FIND_CAPABILITY, {"need": "tương quan giữa hai biểu đồ"})],
        [("correlate_charts", {"chart_ids": [41, 42]})],
        [],
    ])
    env = _run(monkeypatch, model, NON_WEB)
    assert "correlate_charts" not in model.offered[0]
    assert "correlate_charts" in model.offered[1]
    assert (_step(env).get("tool_calls") or [])[:2] == [CAP.FIND_CAPABILITY, "correlate_charts"]


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
    # WHAT WAS SEEN, WHEN, AND WHY — the debugging truth, not a summary of it.
    assert cap["initially_visible"] == cap["visible_per_round"][0]
    assert "forecast_measure" not in cap["initially_visible"]
    assert cap["discoveries"][0]["need"] == "dự báo"
    assert "forecast_measure" in cap["discoveries"][0]["loaded"]
    assert len(cap["schema_chars_per_round"]) == len(cap["visible_per_round"])


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


def test_a_step_that_cannot_compute_is_not_shown_evidence_references(monkeypatch):
    """References exist for `compute`; any other step's prompt stays exactly what
    it was before they existed (found by review: every tool result changed)."""
    seen = {}

    class M(_Model):
        pass
    model = M([[("rank_values", {"chart_id": 41})], []])

    async def fake(**kw):
        async for ev in model.stream()(**kw):
            yield ev
        seen["results"] = model.results
    _run(monkeypatch, model, ["rank_values", "total_measure"], limit=None)
    assert model.results and all("evidence_ref" not in (r or {}) for r in model.results)
