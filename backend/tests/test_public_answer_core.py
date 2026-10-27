"""The public Dashboard AI Bot is a consumer of THE Answer Core, and its spend is
governed by the same server policy as every other paid model call.

PO decision (2026-10-28, supersedes ADR-3 of the unified-chat contract): AppBI has
one Answer Core. AI Chat and the public Dashboard AI Bot are its two consumers; an
Agent Flow is an optional add-on the Core may call, never the engine that answers
a viewer. Found on PR #77 (dfb06e09):

  * `POST /public/dashboards/{token}/ai/agent/chat` answered ONLY through the
    link's Agent Flow (`agent_flows.dispatch.run_for_link`): no flow, no answer;
    and the flow wrote the final answer.
  * `X-User-Ai-Key` - a header any viewer can add - set the link's USD ceiling to
    0 ("unlimited") while the turn could still run on the organisation's key.
  * the link's usage store being unreadable ALLOWED the paid turn (fail-open).

These checks are fail-first: each failed on dfb06e09.
"""
from __future__ import annotations

import ast
import inspect
import pathlib

import pytest

APP = pathlib.Path(__file__).resolve().parents[1] / "app"
PUBLIC = APP / "api" / "public.py"


def _routes() -> dict[str, ast.AsyncFunctionDef | ast.FunctionDef]:
    """{route path: handler} of api/public.py."""
    tree = ast.parse(PUBLIC.read_text(encoding="utf-8"))
    out = {}
    for node in tree.body:
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        for dec in node.decorator_list:
            if (isinstance(dec, ast.Call) and isinstance(dec.func, ast.Attribute)
                    and dec.func.attr in ("get", "post") and dec.args
                    and isinstance(dec.args[0], ast.Constant)):
                out[str(dec.args[0].value)] = node
    return out


def _names(node: ast.AST) -> set[str]:
    return {n.id for n in ast.walk(node) if isinstance(n, ast.Name)} | {
        n.attr for n in ast.walk(node) if isinstance(n, ast.Attribute)} | {
        a.name for n in ast.walk(node) if isinstance(n, ast.ImportFrom) for a in n.names}


# ── one Answer Core ──────────────────────────────────────────────────────────

def test_the_public_bot_has_an_answer_route_served_by_the_core():
    routes = _routes()
    handler = routes.get("/dashboards/{token}/ai/answer")
    assert handler is not None, "the public Dashboard AI Bot must answer at /dashboards/{token}/ai/answer"
    used = _names(handler)
    assert "public_turn" in used and "begin" in used, "the public answer route must run the Answer Core turn"
    turn = (APP / "services" / "answer_core" / "public_turn.py").read_text(encoding="utf-8")
    assert "from app.services.data_core.service import TurnStopped, ask" in turn and "scope=scope" in turn, (
        "the public turn must be answered by THE Answer Core (data_core.service.ask) over its published scope")


def test_the_published_scope_reads_only_through_the_governed_public_chart_path():
    """No SQL, no dataset-wide read, no ChartService call of its own: every read is
    `_fetch_chart_data` on the link's tool context (filters, locks, page bounds,
    exposed fields, AI-scope exclusions - what the viewer's tile renders through)."""
    src = (APP / "services" / "answer_core" / "published_report.py").read_text(encoding="utf-8")
    tree = ast.parse(src)
    imported = {f"{n.module}.{a.name}" for n in ast.walk(tree) if isinstance(n, ast.ImportFrom) and n.module
                for a in n.names}
    forbidden = ("app.services.chart_service", "app.services.query_execution", "app.services.semantic_query",
                 "app.services.datasource_service", "app.services.governed_query.service", "sqlalchemy.text")
    assert not [i for i in imported if i.startswith(forbidden)], imported
    assert "app.services.agent_flows.tools.context._fetch_chart_data" in imported


def test_no_public_viewer_route_answers_through_an_agent_flow():
    """Studio's author preview may still run a flow (an internal diagnostic); a
    VIEWER's question never does."""
    offenders = sorted(path for path, fn in _routes().items() if "run_for_link" in _names(fn))
    assert offenders == [], f"public routes answering through an Agent Flow: {offenders}"


def test_public_routes_never_read_a_viewer_supplied_provider_key():
    """A header is not a billing identity: no public route reads X-User-Ai-Key."""
    offenders = sorted(path for path, fn in _routes().items()
                       if any(a.arg == "x_user_ai_key" for a in fn.args.args + fn.args.kwonlyargs))
    assert offenders == [], f"public routes still reading X-User-Ai-Key: {offenders}"


# ── the link ceiling is the link's, whoever calls ───────────────────────────

class _Row:
    def __init__(self, spent: float, turns: int):
        self._v = (spent, turns)

    def one(self):
        return self._v


class _Query:
    def __init__(self, result):
        self._r = result

    def filter(self, *a, **k):
        return self

    def one(self):
        if isinstance(self._r, Exception):
            raise self._r
        return self._r


class _Db:
    def __init__(self, result):
        self._r = result

    def query(self, *a, **k):
        return _Query(self._r)


def test_the_budget_takes_no_viewer_key_argument():
    from app.services.dashboard_ai_bot.budget import check_budget

    assert "viewer_supplied_key" not in inspect.signature(check_budget).parameters, (
        "a viewer-controlled flag must not choose which ceiling applies")


def test_a_spent_link_is_refused_whatever_headers_the_viewer_sends():
    from app.services.dashboard_ai_bot.budget import check_budget

    verdict = check_budget(_Db((5.0, 0)), token="tok", appearance_config={"ai_bot_budget_usd_per_day": 1})
    assert verdict.allowed is False and verdict.reason == "usd_per_day"


def test_an_unreadable_usage_store_refuses_the_paid_turn():
    """Fail CLOSED: when spend cannot be read, no paid model call starts."""
    from app.services.dashboard_ai_bot.budget import check_budget

    verdict = check_budget(_Db(RuntimeError("db down")), token="tok",
                           appearance_config={"ai_bot_budget_usd_per_day": 1})
    assert verdict.allowed is False and verdict.reason == "budget_unavailable"


@pytest.mark.parametrize("limit", [None, 0])
def test_an_unlimited_link_still_reads_its_spend_is_never_free_by_default(limit):
    """A link with no ceiling of its own (unset, or 0) takes the server default - it
    is never "unlimited" - so its spend is always read, and a failed read refuses."""
    from app.services.dashboard_ai_bot.budget import check_budget

    cfg = {} if limit is None else {"ai_bot_budget_usd_per_day": limit}
    verdict = check_budget(_Db(RuntimeError("db down")), token="tok", appearance_config=cfg)
    assert verdict.allowed is False
