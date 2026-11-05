"""AI Vibe (Report-as-Code) tools against a scripted Report Studio.

The fake keeps only Report Studio's lifecycle contract that the MCP depends on:
append-only revisions, the draft pointer, `base_number` -> 409 on a stale save, AI
jobs, restore-as-new-revision and publish-by-revision. It is not AppBI's validation.
"""

from __future__ import annotations

import time
from typing import Any

import pytest
from cryptography.fernet import Fernet

from appbi_mcp.appbi_client import BODY_GUARDS, AppbiError, GuardViolation, match_route
from appbi_mcp.approvals import render_summary
from appbi_mcp.context import Principal
from appbi_mcp.operations import OperationError, PlanStore, Run
from appbi_mcp.state import StateStore
from appbi_mcp.tools import vibe
from appbi_mcp.tools.runtime import Env


class Studio:
    def __init__(self, permission: str = "full") -> None:
        self.permission = permission
        self.revs: list[dict[str, Any]] = []
        self.draft = 0
        self.published: int | None = None
        self.job: dict[str, Any] | None = None
        self.calls: list[tuple[str, str, Any]] = []
        self.ai_fails = False
        self._add("<h1>v1</h1>", "", "", "manual")

    def _add(self, html: str, css: str, js: str, source: str) -> dict[str, Any]:
        n = len(self.revs) + 1
        rev = {"id": 1000 + n, "number": n, "html": html, "css": css, "js": js, "source": source,
               "content_hash": f"h{hash((html, css, js))}", "bindings": [{"id": "b1", "chart_id": 5}], "filters": [],
               "regions": [{"id": "kpis", "tag": "section", "label": "KPIs"}]}  # AppBI's shape
        self.revs.append(rev)
        self.draft = n
        return rev

    def _detail(self) -> dict[str, Any]:
        return {"id": 7, "name": "Sales vibe", "dataset_id": 3, "owner_id": "u1", "draft_number": self.draft,
                "published_number": self.published, "user_permission": self.permission, "public_link_count": 0,
                "job": self.job, "draft": dict(self.revs[self.draft - 1]), "warnings": [],
                "updated_at": "2999-01-01T00:00:00+00:00"}

    async def _call(self, method: str, path: str, body: Any = None) -> Any:
        template = match_route(method, path)
        assert template, f"{method} {path} not allowlisted"
        guard = BODY_GUARDS.get((method, template))
        if guard:
            guard(body)
        self.calls.append((method, path, body))
        if template == "/report-artifacts/{id}":
            return self._detail()
        if template == "/report-artifacts":
            if method == "GET":
                return [self._detail()]
            self.job = {"state": "done"}
            self._add("<h1>ai</h1>", "", "", "ai_generate")
            return {"id": 7}
        if template == "/report-artifacts/{id}/revisions/{id}":
            return dict(self.revs[int(path.rsplit("/", 1)[1]) - 1], is_draft=False, is_published=False)
        if template == "/report-artifacts/{id}/revisions":
            return [{"number": r["number"]} for r in reversed(self.revs)]
        if template == "/report-artifacts/{id}/source":
            if body["base_number"] != self.draft:
                raise AppbiError(409, "conflict", "Bản nháp đã đổi")
            rev = self._add(body["html"], body["css"], body["js"], "manual")
            return {"revision": rev, "warnings": []}
        if template == "/report-artifacts/{id}/ai-edit":
            if self.job and self.job.get("state") == "running":
                raise AppbiError(409, "conflict", "busy")
            if self.ai_fails:
                self.job = {"state": "failed", "error": "model refused"}
            else:
                self.job = {"state": "done", "notes": ["changed kpis"]}
                base = self.revs[self.draft - 1]
                self._add(base["html"] + "<p>ai</p>", base["css"], base["js"], "ai_edit")
            return {"job": self.job}
        if template == "/report-artifacts/{id}/job":
            return {"job": self.job, "draft_number": self.draft}
        if template == "/report-artifacts/{id}/revisions/{id}/restore":
            src = self.revs[int(path.split("/")[-2]) - 1]
            return {"revision": self._add(src["html"], src["css"], src["js"], "restore")}
        if template == "/report-artifacts/{id}/publish":
            rev = next(r for r in self.revs if r["id"] == body["revision_id"])
            if "SAMPLE" in rev["html"] and not body["allow_samples"]:
                raise AppbiError(409, "conflict", "sample numbers remain", {"code": "SAMPLE_NUMBERS"})
            self.published = rev["number"]
            return self._detail()
        if template == "/datasets/{id}":
            return {"id": 3, "name": "Sales"}
        raise AssertionError(f"unexpected {method} {path}")

    async def get(self, path: str, **_: Any) -> Any:
        return await self._call("GET", path)

    async def post(self, path: str, body: Any = None, **_: Any) -> Any:
        return await self._call("POST", path, body)

    async def put(self, path: str, body: Any = None, **_: Any) -> Any:
        return await self._call("PUT", path, body)

    def writes(self) -> list[tuple[str, str, Any]]:
        return [c for c in self.calls if c[0] != "GET"]


@pytest.fixture
def env_for(tmp_path):
    plans = PlanStore(StateStore(str(tmp_path / "s"), Fernet.generate_key()))

    class App:
        class settings:
            appbi_public_url = "http://appbi"
            public_url = "http://mcp"
            operation_budget_seconds = 60

    def make(studio: Studio) -> Env:
        return Env(app=App(), principal=Principal("u1", "a@x", "g", "c", ["appbi.author"], "r"), appbi=studio, plans=plans)  # type: ignore[arg-type]

    return make


async def _execute(env: Env, plan_id: str) -> dict[str, Any]:
    plan = env.plans.get(plan_id, "u1")
    env.plans.approve(plan, "u1")
    assert env.plans.consume_approval(plan)
    return await vibe.run_vibe_plan(env, Run(plans=env.plans, plan=plan, deadline=time.time() + 60))


async def test_planning_writes_nothing_and_shows_a_real_diff(env_for):
    studio = Studio()
    env = env_for(studio)
    out = await vibe.plan_vibe_source_edit(env, 7, html="<h1>v2</h1>")
    assert out["status"] == "awaiting_approval" and out["approval_url"].endswith(out["plan_id"])
    assert studio.writes() == []
    page = render_summary(env.plans.get(out["plan_id"], "u1").summary)
    assert "<span class=del>-&lt;h1&gt;v1&lt;/h1&gt;</span>" in page and "<span class=add>+&lt;h1&gt;v2&lt;/h1&gt;</span>" in page
    assert "http://appbi/dashboards/code/7?revision=1" in page  # the real Studio renderer link


async def test_source_edit_creates_a_new_draft_revision_and_verifies(env_for):
    studio = Studio()
    env = env_for(studio)
    out = await vibe.plan_vibe_source_edit(env, 7, html="<h1>v2</h1>", css="h1{color:red}")
    result = await _execute(env, out["plan_id"])
    assert result["status"] == "draft_ready" and result["draft_number"] == 2
    assert studio.published is None  # nothing went live
    assert set(result["diff"]["changed"]) == {"html", "css"}
    assert result["preview_url"] == "http://appbi/dashboards/code/7?revision=2"
    puts = [c for c in studio.writes() if c[0] == "PUT"]
    assert len(puts) == 1 and puts[0][2]["base_number"] == 1


async def test_a_concurrent_save_makes_the_plan_stale_and_overwrites_nothing(env_for):
    studio = Studio()
    env = env_for(studio)
    out = await vibe.plan_vibe_source_edit(env, 7, html="<h1>mine</h1>")
    studio._add("<h1>someone else</h1>", "", "", "manual")  # a co-author saves in the Studio
    with pytest.raises(OperationError) as err:
        await _execute(env, out["plan_id"])
    assert err.value.status == "stale_plan"
    assert studio.revs[-1]["html"] == "<h1>someone else</h1>" and not [c for c in studio.writes() if c[0] == "PUT"]


async def test_appbi_base_number_conflict_is_reported_as_conflict(env_for):
    studio = Studio()
    env = env_for(studio)
    out = await vibe.plan_vibe_source_edit(env, 7, html="<h1>mine</h1>")
    plan = env.plans.get(out["plan_id"], "u1")
    original = studio._call

    async def racing(method: str, path: str, body: Any = None) -> Any:
        if method == "PUT":  # the co-author wins the race between our check and our save
            studio._add("<h1>race</h1>", "", "", "manual")
        return await original(method, path, body)

    studio._call = racing  # type: ignore[method-assign]
    env.plans.approve(plan, "u1")
    with pytest.raises(OperationError) as err:
        await vibe.run_vibe_plan(env, Run(plans=env.plans, plan=plan, deadline=time.time() + 60))
    assert err.value.status == "conflict"
    assert studio.revs[-1]["html"] == "<h1>race</h1>"


async def test_ai_edit_runs_once_and_is_not_repeated_on_resume(env_for):
    studio = Studio()
    env = env_for(studio)
    out = await vibe.plan_vibe_ai_edit(env, 7, "Make the KPIs bigger", region="kpis")
    first = await _execute(env, out["plan_id"])
    assert first["status"] == "draft_ready" and first["draft_number"] == 2
    plan = env.plans.get(out["plan_id"], "u1")
    again = await vibe.run_vibe_plan(env, Run(plans=env.plans, plan=plan, deadline=time.time() + 60))
    assert again["draft_number"] == 2
    assert len([c for c in studio.writes() if c[1].endswith("/ai-edit")]) == 1  # one AI run, one cost


async def test_ai_failure_is_blocked_with_appbi_reason(env_for):
    studio = Studio()
    studio.ai_fails = True
    env = env_for(studio)
    out = await vibe.plan_vibe_ai_edit(env, 7, "Redesign")
    with pytest.raises(OperationError) as err:
        await _execute(env, out["plan_id"])
    assert err.value.status == "blocked" and "model refused" in err.value.message


async def test_unknown_region_is_refused_at_plan_time(env_for):
    env = env_for(Studio())
    out = await vibe.plan_vibe_ai_edit(env, 7, "x y", region="nope")
    assert out["status"] == "invalid" and out["regions"] == ["kpis"]


async def test_viewer_cannot_plan_edits(env_for):
    studio = Studio(permission="view")
    env = env_for(studio)
    assert (await vibe.plan_vibe_source_edit(env, 7, html="x"))["status"] == "forbidden"
    assert (await vibe.plan_vibe_ai_edit(env, 7, "do it"))["status"] == "forbidden"
    assert (await vibe.plan_vibe_restore(env, 7, 1))["status"] == "forbidden"
    assert env.plans.store.query("SELECT * FROM plans") == []


async def test_restore_adds_a_revision_and_deletes_nothing(env_for):
    studio = Studio()
    studio._add("<h1>v2</h1>", "", "", "manual")
    env = env_for(studio)
    out = await vibe.plan_vibe_restore(env, 7, 1)
    result = await _execute(env, out["plan_id"])
    assert result["draft_number"] == 3 and studio.revs[2]["html"] == "<h1>v1</h1>" and len(studio.revs) == 3


async def test_publish_needs_its_own_approval_and_names_the_exact_revision(env_for):
    studio = Studio()
    env = env_for(studio)
    req = await vibe.vibe_publish_request(env, 7, None, False)
    assert req["status"] == "awaiting_approval" and studio.writes() == []
    plan = env.plans.get(req["plan_id"], "u1")
    assert plan.kind == "vibe_publish" and plan.body["revision_id"] == 1001
    assert not await vibe.vibe_publish_is_stale(env, plan)
    studio._add("<h1>later</h1>", "", "", "manual")
    assert await vibe.vibe_publish_is_stale(env, plan)  # a newer draft needs a new approval


async def test_publish_goes_live_and_is_verified(env_for):
    studio = Studio()
    env = env_for(studio)
    req = await vibe.vibe_publish_request(env, 7, None, False)
    plan = env.plans.get(req["plan_id"], "u1")
    result = await vibe.run_vibe_publish(env, Run(plans=env.plans, plan=plan, deadline=time.time() + 60))
    assert result["status"] == "published" and studio.published == 1


async def test_sample_numbers_block_publish_unless_explicitly_approved(env_for):
    studio = Studio()
    studio._add("<b data-rac-sample>SAMPLE 1.2M</b>", "", "", "ai_generate")
    env = env_for(studio)
    req = await vibe.vibe_publish_request(env, 7, None, False)
    plan = env.plans.get(req["plan_id"], "u1")
    with pytest.raises(OperationError) as err:
        await vibe.run_vibe_publish(env, Run(plans=env.plans, plan=plan, deadline=time.time() + 60))
    assert err.value.status == "blocked" and studio.published is None


async def test_viewer_or_editor_cannot_request_publish(env_for):
    for level in ("view", "edit"):
        out = await vibe.vibe_publish_request(env_for(Studio(permission=level)), 7, None, False)
        assert out["status"] == "forbidden"


async def test_ai_create_spends_one_run_and_lands_as_draft(env_for):
    studio = Studio()
    env = env_for(studio)
    out = await vibe.plan_vibe_report(env, 3, "Sales vibe", mode="ai", prompt="Revenue by month with KPIs")
    assert studio.writes() == []
    result = await _execute(env, out["plan_id"])
    assert result["status"] == "draft_ready" and studio.published is None
    assert len([c for c in studio.writes() if c[1] == "/report-artifacts"]) == 1


def test_guards_refuse_unsafe_bodies():
    with pytest.raises(GuardViolation):
        BODY_GUARDS[("PUT", "/report-artifacts/{id}/source")]({"html": "x"})
    with pytest.raises(GuardViolation):
        BODY_GUARDS[("POST", "/report-artifacts/{id}/publish")]({})
    with pytest.raises(GuardViolation):
        BODY_GUARDS[("POST", "/report-artifacts")]({"dataset_id": 1, "reference_html": "<script>"})
    for method, path in (("DELETE", "/report-artifacts/7"), ("POST", "/report-artifacts/7/public-links"),
                         ("POST", "/report-artifacts/7/document-ticket")):
        assert match_route(method, path) is None


def test_diff_lists_binding_changes():
    a = {"html": "x", "bindings": [{"id": "b1", "chart_id": 1}]}
    b = {"html": "x", "bindings": [{"id": "b1", "chart_id": 2}, {"id": "b2", "chart_id": 3}]}
    d = vibe.source_diff(a, b)
    assert d["bindings"] == {"added": ["b2"], "removed": [], "changed": ["b1"]} and "html" not in d["changed"]
