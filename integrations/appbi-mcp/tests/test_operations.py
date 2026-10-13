"""Plans, approvals and resumable operations (exactly-once writes)."""

from __future__ import annotations

import re
import time

import pytest
from cryptography.fernet import Fernet

from appbi_mcp.appbi_client import AmbiguousWrite, AppbiError
from appbi_mcp.operations import OperationError, PlanStore, Run
from appbi_mcp.security import redact
from appbi_mcp.state import StateStore

from .conftest import connect


@pytest.fixture
def plans(tmp_path) -> PlanStore:
    return PlanStore(StateStore(str(tmp_path / "s"), Fernet.generate_key()))


def _plan(plans: PlanStore, user: str = "u1"):
    return plans.create(user_id=user, grant_id="g1", kind="dataset", body={"name": "x"}, summary={}, fingerprint={})


def _run(plans: PlanStore, plan) -> Run:
    return Run(plans=plans, plan=plan, deadline=time.time() + 60)


async def test_done_step_is_not_repeated(plans):
    plan = _plan(plans)
    calls = []

    async def write():
        calls.append(1)
        return {"id": 7}

    assert await _run(plans, plan).write("create", write) == {"id": 7}
    assert await _run(plans, plan).write("create", write) == {"id": 7}
    assert calls == [1]


async def test_ambiguous_write_is_reconciled_not_repeated(plans):
    plan = _plan(plans)
    calls = []

    async def write():
        calls.append(1)
        raise AmbiguousWrite("timeout after send")

    with pytest.raises(OperationError) as err:
        await _run(plans, plan).write("create", write)
    assert err.value.status == "partially_failed"
    assert plans.step(plan.id, "create")["status"] == "sent"

    async def found(_since):
        return {"id": 9}  # AppBI did create it

    result = await _run(plans, plan).write("create", write, reconcile=found)
    assert result == {"id": 9} and calls == [1]


async def test_ambiguous_write_retried_only_when_reconcile_finds_nothing(plans):
    plan = _plan(plans)
    plans.mark(plan.id, "create", "sent")

    async def nothing(_since):
        return None

    async def write():
        return {"id": 3}

    assert await _run(plans, plan).write("create", write, reconcile=nothing) == {"id": 3}


async def test_appbi_refusal_marks_the_step_failed(plans):
    plan = _plan(plans)

    async def write():
        raise AppbiError(400, "invalid", "fan-out")

    with pytest.raises(AppbiError):
        await _run(plans, plan).write("join", write)
    assert plans.step(plan.id, "join")["status"] == "failed"


async def test_budget_exhaustion_stops_cleanly(plans):
    plan = _plan(plans)
    run = Run(plans=plans, plan=plan, deadline=time.time() - 1)
    with pytest.raises(OperationError) as err:
        await run.write("x", lambda: None)  # type: ignore[arg-type]
    assert err.value.status == "partially_failed"


def test_one_runner_per_plan(plans):
    plan = _plan(plans)
    plans.start_operation(plan)
    assert plans.claim_runner(plan.id, "r1", 60)
    assert not plans.claim_runner(plan.id, "r2", 60)
    plans.finish_operation(plan.id, "r1", "draft_ready", {})
    assert plans.claim_runner(plan.id, "r2", 60)


def test_approval_is_bound_to_user_and_hash_and_single_use(plans):
    plan = _plan(plans)
    with pytest.raises(PermissionError):
        plans.approve(plan, "someone-else")
    assert plans.approval_state(plan) == "none"
    plans.approve(plan, "u1")
    assert plans.approval_state(plan) == "approved"
    assert plans.consume_approval(plan)
    assert not plans.consume_approval(plan)
    assert plans.approval_state(plan) == "consumed"
    # A plan of another user is invisible.
    assert plans.get(plan.id, "someone-else") is None


def test_tampered_plan_body_fails_hash(plans):
    plan = _plan(plans)
    plan.body["name"] = "changed"
    assert not plans.verify_hash(plan)


def test_redaction():
    out = redact({"config": {"password": "p", "host": "h", "service_account_json": "{...}"},
                  "note": "token appbi_pat_abc.def leaked", "items": [{"access_token": "x"}]})
    assert out["config"]["password"] == "[redacted]" and out["config"]["host"] == "h"
    assert out["config"]["service_account_json"] == "[redacted]"
    assert "appbi_pat_" not in out["note"]
    assert out["items"][0]["access_token"] == "[redacted]"


# ── approval pages ──────────────────────────────────────────────────────────────


async def _approval_setup(app, client, fake_appbi):
    pat = fake_appbi.add_user("a@example.com")
    await connect(client, pat)  # leaves the appbi_mcp_session cookie in this "browser"
    plans = PlanStore(app.state.ctx.store)
    plan = plans.create(user_id="user-1", grant_id="g", kind="dataset", body={"name": "x"},
                        summary={"sections": [{"title": "Dataset", "items": [{"name": "<script>x</script>"}]}]}, fingerprint={})
    return plans, plan


async def test_get_never_approves_and_escapes_summary(app, client, fake_appbi):
    plans, plan = await _approval_setup(app, client, fake_appbi)
    r = await client.get(f"/mcp-oauth/approve/{plan.id}")
    assert r.status_code == 200
    assert "<script>x</script>" not in r.text and "&lt;script&gt;" in r.text
    assert plans.approval_state(plan) == "none"


async def test_post_requires_csrf_then_approves(app, client, fake_appbi):
    plans, plan = await _approval_setup(app, client, fake_appbi)
    r = await client.post(f"/mcp-oauth/approve/{plan.id}", data={"decision": "approve", "csrf": "bad", "plan_hash": plan.plan_hash})
    assert r.status_code == 403 and plans.approval_state(plan) == "none"
    page = (await client.get(f"/mcp-oauth/approve/{plan.id}")).text
    csrf = re.search(r"name=csrf value='([0-9a-f]+)'", page).group(1)
    r = await client.post(f"/mcp-oauth/approve/{plan.id}", data={"decision": "approve", "csrf": csrf, "plan_hash": plan.plan_hash})
    assert r.status_code == 200 and plans.approval_state(plan) == "approved"


async def test_another_users_session_cannot_see_or_approve(app, client, fake_appbi):
    pat_b = fake_appbi.add_user("b@example.com")
    await connect(client, pat_b)  # this browser now belongs to user-1 (b)
    plans = PlanStore(app.state.ctx.store)
    plan = plans.create(user_id="user-999", grant_id="g", kind="dataset", body={}, summary={}, fingerprint={})
    r = await client.get(f"/mcp-oauth/approve/{plan.id}")
    assert r.status_code == 404


async def test_no_browser_session_goes_through_appbi_verification(app, client, fake_appbi):
    plans = PlanStore(app.state.ctx.store)
    plan = plans.create(user_id="user-1", grant_id="g", kind="dataset", body={}, summary={}, fingerprint={})
    r = await client.get(f"/mcp-oauth/approve/{plan.id}")
    assert r.status_code == 302 and "/mcp-oauth/connect/start" in r.headers["location"]
    r = await client.post(f"/mcp-oauth/approve/{plan.id}", data={"decision": "approve"})
    assert r.status_code == 401 and plans.approval_state(plan) == "none"
