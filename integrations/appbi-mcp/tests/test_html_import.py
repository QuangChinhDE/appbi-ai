"""HTML report -> draft dashboard (W4): client guards, plan tool, idempotent runner.

The scripted AppBI implements only the import routes' contract (form fields in,
analysis / per-block validation / dry-run / build out, idempotency by key). It is
not a model of AppBI's importer; tests/live and the Core suite cover that.
"""

from __future__ import annotations

import ast
import json
import time
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs

import httpx2
import pytest
from cryptography.fernet import Fernet

from appbi_mcp import appbi_client as ac
from appbi_mcp.appbi_client import AmbiguousWrite, AppbiError, GuardViolation
from appbi_mcp.approvals import render_summary
from appbi_mcp.context import Principal
from appbi_mcp.operations import OperationError, PlanStore, Run
from appbi_mcp.state import StateStore
from appbi_mcp.tools.html_import import get_import_skill, plan_dashboard_from_html, run_dashboard_html_plan
from appbi_mcp.tools.publish import RUNNERS
from appbi_mcp.tools.runtime import Env

from .backend_routes import BACKEND_APP

FIXTURES = Path(__file__).parent / "fixtures" / "html"
V1_HTML = (FIXTURES / "c_v1_plan_report.html").read_text(encoding="utf-8")

ANALYZE = "/dashboards/import-html/analyze"
VALIDATE = "/dashboards/import-html/validate-plans"
DRY = "/dashboards/import-html/dry-run-build"
BUILD = "/dashboards/import-html/build"


def _build_form(**over: Any) -> dict[str, Any]:
    form = {"analysis_json": "{}", "source_mode": "existing_dataset", "target_mode": "new_dashboard",
            "dashboard_name": "D", "dataset_id": 7, "included_block_ids_json": "[]", "strict_fields": True,
            "draft_only": True, "idempotency_key": "plan_abc"}
    form.update(over)
    return {k: v for k, v in form.items() if v is not None}


def _guard(path: str, form: Any) -> None:
    ac.BODY_GUARDS[("POST", ac.match_route("POST", path))](form)


# ── guards ──────────────────────────────────────────────────────────────────────


def test_build_shape_that_passes():
    _guard(BUILD, _build_form())


@pytest.mark.parametrize("over,msg", [
    ({"draft_only": None}, "draft_only"),
    ({"draft_only": False}, "draft_only"),
    ({"draft_only": "false"}, "draft_only"),
    ({"idempotency_key": None}, "idempotency_key"),
    ({"idempotency_key": ""}, "idempotency_key"),
    ({"idempotency_key": "bad key with spaces"}, "idempotency_key"),
    ({"strict_fields": None}, "strict_fields"),
    ({"strict_fields": False}, "strict_fields"),
    ({"target_mode": "append_to_dashboard"}, "new dashboard"),
    ({"target_dashboard_id": 3}, "target_dashboard_id"),
    ({"prepared_dataset_id": 3}, "prepared_dataset_id"),
    ({"source_mode": "upload_excel"}, "existing_dataset"),
    ({"excel_file": b"PK.."}, "excel_file"),
    ({"html_summary_json": "{}"}, "html_summary_json"),
    ({"dataset_table_id": 1}, "dataset_table_id"),
])
def test_build_guard_refuses(over, msg):
    with pytest.raises(GuardViolation, match=msg):
        _guard(BUILD, _build_form(**over))


@pytest.mark.parametrize("over", [{"target_mode": "append_to_dashboard"}, {"strict_fields": False},
                                  {"target_dashboard_id": 1}, {"excel_files": "x"}, {"source_mode": "upload_excel"}])
def test_dry_run_guard_refuses(over):
    form = _build_form(**over)
    form.pop("draft_only"), form.pop("idempotency_key")
    with pytest.raises(GuardViolation):
        _guard(DRY, form)


def test_dry_run_never_takes_build_only_fields():
    with pytest.raises(GuardViolation, match="draft_only|idempotency_key"):
        _guard(DRY, _build_form())


def _analyze_form(html: str = V1_HTML, **over: Any) -> dict[str, Any]:
    form = {"html_content": html, "source_mode": "existing_dataset", "dataset_id": 7, **over}
    return {k: v for k, v in form.items() if v is not None}


def test_analyze_guard():
    _guard(ANALYZE, _analyze_form())
    with pytest.raises(GuardViolation, match="appbi-import/v1"):
        _guard(ANALYZE, _analyze_form((FIXTURES / "a_simple_report.html").read_text(encoding="utf-8")))
    with pytest.raises(GuardViolation, match="appbi-import/v1"):
        _guard(ANALYZE, _analyze_form((FIXTURES / "d_adversarial.html").read_text(encoding="utf-8")))
    with pytest.raises(GuardViolation, match="2 MB"):
        _guard(ANALYZE, _analyze_form(V1_HTML + " " * (2 * 1024 * 1024)))
    for over in ({"html_summary_json": "{}"}, {"excel_file": "x"}, {"source_mode": "upload_excel"}, {"dataset_table_id": 2}):
        with pytest.raises(GuardViolation):
            _guard(ANALYZE, _analyze_form(**over))
    with pytest.raises(GuardViolation):
        _guard(ANALYZE, _analyze_form(dataset_id=None))


def test_validate_guard():
    _guard(VALIDATE, {"analysis_json": "{}", "dataset_id": 7})
    with pytest.raises(GuardViolation):
        _guard(VALIDATE, {"analysis_json": "{}", "dataset_id": 7, "excel_file": "x"})


def test_only_the_five_import_routes_are_allowed():
    import_routes = {t for _, t in ac.ALLOWED_ROUTES if "import" in t}
    assert import_routes == {"/datasets/{id}/import-skill", ANALYZE, VALIDATE, DRY, BUILD}
    for path in ("/dashboards/import-html/build-batch", "/dashboards/import-html/prepare-draft",
                 "/dashboards/import-html/fix-chart-plan", "/dashboards/import-html/source-preview",
                 "/dashboards/import-html/analyze-batch", "/dashboards/import-html/preview-calculated"):
        assert ac.match_route("POST", path) is None


async def test_client_sends_form_fields_and_reads_markdown():
    seen: list[httpx2.Request] = []

    def handler(request: httpx2.Request) -> httpx2.Response:
        seen.append(request)
        if request.url.path.endswith("/import-skill"):
            return httpx2.Response(200, text="# Import skill\nuse `price`", headers={"content-type": "text/markdown; charset=utf-8"})
        return httpx2.Response(200, json={"results": []})

    client = ac.AppbiClient(base_url="http://appbi.test/api/v1", pat="p", request_id="r", transport=httpx2.MockTransport(handler))
    assert (await client.get("/datasets/7/import-skill")).startswith("# Import skill")
    await client.post_form(VALIDATE, {"analysis_json": "{}", "dataset_id": 7})
    body = parse_qs(seen[-1].content.decode())
    assert body == {"analysis_json": ["{}"], "dataset_id": ["7"]}
    assert seen[-1].headers["content-type"].startswith("application/x-www-form-urlencoded")
    # A form route never takes JSON, and a JSON route never takes a form.
    with pytest.raises(GuardViolation):
        await client.post(VALIDATE, {"analysis_json": "{}", "dataset_id": 7})
    with pytest.raises(GuardViolation):
        await client.request("POST", "/dashboards/", form={"name": "x"})
    # Guarded before anything is sent.
    n = len(seen)
    with pytest.raises(GuardViolation):
        await client.post_form(BUILD, _build_form(draft_only=False))
    assert len(seen) == n


def test_backend_build_route_supports_the_draft_first_contract():
    """The runner relies on AppBI's build honouring draft_only / idempotency_key /
    strict_fields. An AppBI without them silently ignores unknown form fields and
    would create a LIVE dashboard, so the MCP's CI must fail on such a backend."""
    tree = ast.parse((BACKEND_APP / "api" / "dashboards.py").read_text(encoding="utf-8"))
    params: dict[str, set[str]] = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.AsyncFunctionDef | ast.FunctionDef):
            for dec in node.decorator_list:
                if isinstance(dec, ast.Call) and dec.args and isinstance(dec.args[0], ast.Constant) and \
                        str(dec.args[0].value).startswith("/import-html/"):
                    params[dec.args[0].value] = {a.arg for a in node.args.args + node.args.kwonlyargs}
    assert {"draft_only", "idempotency_key", "strict_fields"} <= params["/import-html/build"]
    assert "strict_fields" in params["/import-html/dry-run-build"]


# ── scripted AppBI ──────────────────────────────────────────────────────────────


MODEL = {"views": [{"id": 1, "name": "dataset_table_1", "dataset_table_id": 1,
                    "dimensions": [{"name": "order_status", "type": "string"}], "measures": []}], "explores": []}

ANALYSIS = {
    "suggested_dashboard_name": "Olist Sales Overview",
    "chart_plans": [
        {"block_id": "kpi-revenue", "title": "Revenue", "final_chart_type": "KPI", "warnings": [],
         "role_config": {"metrics": [{"field": "price", "agg": "sum"}]}},
        {"block_id": "orders-by-status", "title": "Orders by status", "final_chart_type": "BAR", "warnings": [],
         "conversion_note": None, "role_config": {"dimension": "order_status", "metrics": [{"field": "order_id", "agg": "count"}]}},
    ],
    "widgets": [{"widget_type": "section_header", "title": "Sales overview"}],
    "slicers": [{"field": "order_status", "label": "order_status"}],
    "theme_config": {"templateId": "console", "colorwayId": "indigo"},
    "ignored_blocks": [{"block_id": "block-9", "reason": "Narrative block not converted in chart-first import"}],
    "warnings": ["1 inline script was ignored"],
}


class ScriptedImport:
    def __init__(self) -> None:
        self.calls: list[tuple[str, str, Any]] = []
        self.model = json.loads(json.dumps(MODEL))
        self.validate_error: str | None = None
        self.dry_unresolved: list[str] | None = None
        self.analyze_conflict = False
        self.ambiguous_builds = 0      # the next N builds land in AppBI but the answer is lost
        self.dashboards: dict[str, int] = {}  # idempotency key -> dashboard id
        self.created = 0

    async def _call(self, method: str, path: str, body: Any = None, form: Any = None) -> Any:
        template = ac.match_route(method, path)
        assert template, f"{method} {path} not allowlisted"
        if (method, template) in ac.FORM_ROUTES:
            assert body is None
            ac.BODY_GUARDS[(method, template)](form)
        self.calls.append((method, path, form if form is not None else body))
        if template == "/datasets/{id}/model":
            return self.model
        if template == "/dashboards/":
            return [{"id": 1, "name": "Existing"}]
        if template == "/datasets/{id}/import-skill":
            return "# Skill\n" + "x" * 30_000
        if path == ANALYZE:
            if self.analyze_conflict:
                raise AppbiError(409, "conflict", "source_contract_mismatch", {"reason": "source_contract_mismatch", "findings": ["column price missing"]})
            return json.loads(json.dumps(ANALYSIS))
        if path == VALIDATE:
            plans = json.loads(form["analysis_json"])["chart_plans"]
            return {"results": [{"block_id": p["block_id"], "status": "error" if self.validate_error and i == 1 else "ok",
                                 "error": self.validate_error if i == 1 else None} for i, p in enumerate(plans)]}
        if path == DRY:
            if self.dry_unresolved:
                raise AppbiError(422, "invalid", "unresolved", {"reason": "unresolved_fields", "unresolved": self.dry_unresolved})
            return {"dry_run": True, "would_create": {"created_chart_count": len(json.loads(form["included_block_ids_json"]))}}
        if path == BUILD:
            key = form["idempotency_key"]
            replay = key in self.dashboards
            if not replay:
                self.created += 1
                self.dashboards[key] = 500 + self.created
            if self.ambiguous_builds:
                self.ambiguous_builds -= 1
                raise AmbiguousWrite("POST build: ReadTimeout")
            return {"dashboard_id": self.dashboards[key], "created_chart_count": 2, "created_widget_count": 1,
                    "draft_only": True, "idempotent_replay": replay}
        raise AssertionError(f"unexpected {method} {path}")

    async def get(self, path: str, **params: Any) -> Any:
        return await self._call("GET", path)

    async def post(self, path: str, body: Any = None, **params: Any) -> Any:
        return await self._call("POST", path, body)

    async def post_form(self, path: str, form: dict[str, Any]) -> Any:
        return await self._call("POST", path, form=form)


@pytest.fixture
def env_for(tmp_path):
    plans = PlanStore(StateStore(str(tmp_path / "s"), Fernet.generate_key()))

    def make(appbi: ScriptedImport) -> Env:
        class App:
            class settings:
                appbi_public_url = "http://appbi"
                public_url = "http://mcp"
                operation_budget_seconds = 60

        return Env(app=App(), principal=Principal("u1", "a@x", "g", "c", ["appbi.read", "appbi.author"], "r"),  # type: ignore[arg-type]
                   appbi=appbi, plans=plans)  # type: ignore[arg-type]

    return make


async def test_import_skill_is_bounded(env_for):
    out = await get_import_skill(env_for(ScriptedImport()), 7)
    assert out["status"] == "ok" and out["markdown"].startswith("# Skill") and out["truncated"]
    assert len(out["markdown"]) <= 20_000


async def test_plan_happy_path_stores_the_analysis_and_a_full_summary(env_for):
    appbi = ScriptedImport()
    env = env_for(appbi)
    out = await plan_dashboard_from_html(env, 7, "Olist Sales", V1_HTML)
    assert out["status"] == "awaiting_approval", out
    assert [c[1] for c in appbi.calls if c[0] == "POST"] == [ANALYZE, VALIDATE, DRY]
    dry_form = appbi.calls[-1][2]
    assert dry_form["strict_fields"] is True and dry_form["target_mode"] == "new_dashboard"
    plan = env.plans.get(out["plan_id"], "u1")
    assert plan.kind == "dashboard_html" and plan.kind in RUNNERS
    assert plan.body["analysis"]["chart_plans"][0]["block_id"] == "kpi-revenue"
    assert plan.body["included_block_ids"] == ["kpi-revenue", "orders-by-status"]
    assert plan.fingerprint["model"]
    html = render_summary(plan.summary)
    for text in ("Revenue", "sum(price)", "dimension=order_status", "count(order_id)", "order_status",
                 "Sales overview", "indigo", "NOT converted", "block-9", "1 inline script was ignored"):
        assert text in html, text
    # Nothing was written.
    assert BUILD not in [c[1] for c in appbi.calls]


async def test_plan_refuses_html_without_an_embedded_plan(env_for):
    appbi = ScriptedImport()
    for name in ("a_simple_report.html", "b_business_report.html", "d_adversarial.html"):
        out = await plan_dashboard_from_html(env_for(appbi), 7, "X", (FIXTURES / name).read_text(encoding="utf-8"))
        assert out["status"] == "invalid" and "get_import_skill" in out["errors"][0]
    assert appbi.calls == []  # refused before AppBI is called


@pytest.mark.parametrize("setup,needle", [
    (lambda a: setattr(a, "validate_error", "Unrecognized name: order_id"), "rejected_charts"),
    (lambda a: setattr(a, "dry_unresolved", ["orders.nope"]), "unresolved_fields"),
    (lambda a: setattr(a, "analyze_conflict", True), "appbi_error"),
])
async def test_plan_is_invalid_when_appbi_rejects(env_for, setup, needle):
    appbi = ScriptedImport()
    setup(appbi)
    env = env_for(appbi)
    out = await plan_dashboard_from_html(env, 7, "Olist Sales", V1_HTML)
    assert out["status"] == "invalid" and out.get(needle), out
    assert "plan_id" not in out


async def test_plan_refuses_an_existing_dashboard_name(env_for):
    out = await plan_dashboard_from_html(env_for(ScriptedImport()), 7, "existing", V1_HTML)
    assert out["status"] == "invalid" and "already exists" in out["errors"][0]


# ── runner ──────────────────────────────────────────────────────────────────────


async def _planned(env_for, appbi: ScriptedImport):
    env = env_for(appbi)
    out = await plan_dashboard_from_html(env, 7, "Olist Sales", V1_HTML)
    plan = env.plans.get(out["plan_id"], "u1")
    return env, plan


def _run(env: Env, plan) -> Run:
    return Run(plans=env.plans, plan=plan, deadline=time.time() + 60)


async def test_runner_builds_a_draft_with_the_plan_id_as_idempotency_key(env_for):
    appbi = ScriptedImport()
    env, plan = await _planned(env_for, appbi)
    res = await run_dashboard_html_plan(env, _run(env, plan))
    assert res["status"] == "draft_ready" and res["dashboard_id"] == 501 and res["chart_count"] == 2
    assert res["not_converted"] == [{"block": "block-9", "reason": "Narrative block not converted in chart-first import"}]
    build = [c[2] for c in appbi.calls if c[1] == BUILD]
    assert len(build) == 1
    assert build[0]["draft_only"] is True and build[0]["strict_fields"] is True and build[0]["idempotency_key"] == plan.id
    assert json.loads(build[0]["analysis_json"]) == plan.body["analysis"]


async def test_resume_after_an_ambiguous_build_returns_the_same_dashboard(env_for):
    appbi = ScriptedImport()
    appbi.ambiguous_builds = 1
    env, plan = await _planned(env_for, appbi)
    with pytest.raises(OperationError) as err:
        await run_dashboard_html_plan(env, _run(env, plan))
    assert err.value.status == "partially_failed"
    assert env.plans.step(plan.id, "build")["status"] == "sent"
    res = await run_dashboard_html_plan(env, _run(env, plan))
    assert res["status"] == "draft_ready" and res["dashboard_id"] == 501
    assert appbi.created == 1  # AppBI built exactly one dashboard
    keys = {c[2]["idempotency_key"] for c in appbi.calls if c[1] == BUILD}
    assert keys == {plan.id}
    # A finished step is never sent again.
    again = await run_dashboard_html_plan(env, _run(env, plan))
    assert again["dashboard_id"] == 501 and len([c for c in appbi.calls if c[1] == BUILD]) == 2


async def test_runner_stops_on_a_changed_model(env_for):
    appbi = ScriptedImport()
    env, plan = await _planned(env_for, appbi)
    appbi.model["views"][0]["dimensions"].append({"name": "new_col", "type": "string"})
    with pytest.raises(OperationError) as err:
        await run_dashboard_html_plan(env, _run(env, plan))
    assert err.value.status == "stale_plan"
    assert BUILD not in [c[1] for c in appbi.calls]


async def test_runner_refuses_a_build_appbi_did_not_make_draft(env_for):
    appbi = ScriptedImport()
    env, plan = await _planned(env_for, appbi)
    orig = appbi._call

    async def no_draft(method, path, body=None, form=None):
        out = await orig(method, path, body, form)
        if path == BUILD:
            out = {**out, "draft_only": False}
        return out

    appbi._call = no_draft  # type: ignore[method-assign]
    with pytest.raises(OperationError) as err:
        await run_dashboard_html_plan(env, _run(env, plan))
    assert err.value.status == "blocked" and "draft-only" in err.value.message
