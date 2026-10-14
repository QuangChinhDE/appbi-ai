#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Create ONE public link carrying an active Agent Flow binding. CI only.

WHY IT EXISTS. `surfaces.spec.ts` asks what a published bot surface hands a
viewer: the link resolves to a brain, and the binding — not the flow — is what
names the charts and capabilities. That test makes NO model call. It failed to
run anyway, because `usableLink()` scans for a link with an ACTIVE binding and a
CI database built by `alembic upgrade head` seconds earlier has no dashboards, no
links and no flows. So the assertion skipped itself on every run, silently, and
`5 skipped` read as a property of the suite rather than of the fixture.

WHY IT SEEDS THROUGH THE SERVICE, NOT THROUGH INSERTs. `save_binding` runs the
real preflight and refuses a contract it could not serve. Writing the rows
directly would produce a binding shape the product never creates, and the test
would then assert against an artifact of this script. Going through the service
means the fixture is a binding in exactly the sense the product means.

WHAT IT DELIBERATELY DOES NOT DO. It does not make the four provider-dependent
specs runnable: those POST `/brains/{key}/test`, which calls a model, and CI
configures no key on purpose. A link alone cannot fix that, and adding a
credential to turn `37 passed / 5 skipped` into `42 passed` would buy a number
rather than coverage.

IDEMPOTENT. Everything is looked up by a fixed name or token first, so a second
run re-uses what the first made. It never touches a row it did not create.
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from app.core.database import SessionLocal  # noqa: E402
from app.models.models import (  # noqa: E402
    Chart, ChartType, Dashboard, DashboardChart, DashboardPublicLink,
)
from app.models.user import User  # noqa: E402
from app.services.agent_flows import binding as binding_service  # noqa: E402
from app.services.agent_flows import registry as reg  # noqa: E402
from app.services.agent_flows.contract import Flow  # noqa: E402

EMAIL = os.environ.get("E2E_EMAIL", "admin@appbi.io")
DASHBOARD = "E2E Agent Flow fixture"
TOKEN = "e2e-agent-flow-binding-fixture"
BRAIN_KEY = "e2e_fixture_bound_flow"
CHART = "E2E Agent Flow fixture chart"

#: The FAKE key the flow's one step names. Every model step must reference a
#: stored AI key, or publishing and binding are refused ("chưa có AI key"). The
#: secret is deliberately invalid: no spec here calls a model. Same name as the
#: e2e helper `withE2eKey`, so both reuse one row.
KEY_NAME = "e2e fake openai key"
FAKE_SECRET = "sk-e2e-fake-key-never-valid-000000000000"

#: A flow with NO data requirements, so `preflight` has nothing to resolve beyond
#: the chart scope. The spec reads the binding, not what a run of this would say.
BODY = {
    "nodes": [
        {"key": "tra_loi", "type": "agent", "name": "Trả lời",
         "prompt": "Trả lời ngắn gọn."},
    ],
    "answer_node": "tra_loi",
}


def _fake_key_id(db, user) -> int:
    """The e2e fake OpenAI key, made through the real AI Keys service once."""
    from app.models.ai_provider_credential import AiProviderCredential
    from app.services.agent_flows import credentials as creds

    row = (
        db.query(AiProviderCredential)
        .filter(AiProviderCredential.owner_id == user.id,
                AiProviderCredential.name == KEY_NAME,
                AiProviderCredential.deleted_at.is_(None))
        .first()
    )
    if row is not None:
        return row.id
    return int(creds.create(db, user, name=KEY_NAME, provider="openai", secret=FAKE_SECRET)["id"])


def main() -> int:
    db = SessionLocal()
    try:
        user = db.query(User).filter(User.email == EMAIL).first()
        if user is None:
            print(f"seed_e2e_binding: no user {EMAIL} — run seed_e2e_user.py first")
            return 1

        dashboard = db.query(Dashboard).filter(Dashboard.name == DASHBOARD).first()
        if dashboard is None:
            dashboard = Dashboard(name=DASHBOARD,
                                  description="Fixture for surfaces.spec.ts")
            db.add(dashboard)
            db.flush()

        # ONE CHART, because `preflight` refuses a binding that exposes none
        # ("Chưa chọn biểu đồ nào cho trợ lý đọc") — and it is right to: a link
        # serving a report assistant that may read nothing is not a link anybody
        # would create. `dataset_table_id` is nullable, so this costs no
        # datasource and no warehouse; the spec reads the BINDING, and the
        # binding is still produced by the real service.
        chart = db.query(Chart).filter(Chart.name == CHART).first()
        if chart is None:
            chart = Chart(name=CHART, chart_type=ChartType.BAR, owner_id=user.id,
                          config={"measures": [{"field": "revenue"}],
                                  "dimensions": [{"field": "category"}]})
            db.add(chart)
            db.flush()
        placed = (
            db.query(DashboardChart)
            .filter(DashboardChart.dashboard_id == dashboard.id,
                    DashboardChart.chart_id == chart.id)
            .first()
        )
        if placed is None:
            db.add(DashboardChart(dashboard_id=dashboard.id, chart_id=chart.id,
                                  layout={"x": 0, "y": 0, "w": 6, "h": 4}))
            db.flush()

        link = (
            db.query(DashboardPublicLink)
            .filter(DashboardPublicLink.token == TOKEN)
            .first()
        )
        if link is None:
            link = DashboardPublicLink(
                dashboard_id=dashboard.id, name="E2E binding fixture",
                token=TOKEN, is_active=True, created_by=user.id,
            )
            db.add(link)
            db.flush()

        # Reuse a published version if this script already made one. Publishing
        # again on every run would leave v2, v3, v4 behind on a machine where the
        # seed is run more than once, which is not what "idempotent" promised.
        # `get_brain` returns the row's own `version` and `status`; there is no
        # `published_version` key, and reading one — as a first version did —
        # made this guard dead code that published v2, v3, v4 on successive runs
        # while its comment claimed the opposite.
        try:
            existing = reg.get_brain(db, BRAIN_KEY) or {}
        except Exception:
            existing = {}
        published = str(existing.get("status") or "").lower() == "published"
        # A version published before steps carried AI keys cannot be bound any
        # more (its step has no key) — reusing it would make the seed fail on a
        # database that ran an older copy of this script. Cut a new one instead.
        keyed = all(
            n.get("credential_id")
            for n in ((existing.get("body") or {}).get("nodes") or [])
            if n.get("type") in ("agent", "coordinate")
        )
        version = int(existing.get("version") or 0) if (published and keyed) else 0
        if not version:
            body = {**BODY, "nodes": [
                {**n, "provider": "openai", "model": "gpt-4o-mini",
                 "credential_id": _fake_key_id(db, user)}
                for n in BODY["nodes"]
            ]}
            reg.save_draft(
                db, user, brain_key=BRAIN_KEY, name="E2E bound flow",
                description="Fixture", body=body, actor_email=EMAIL,
                # `save_draft` accepts only "bot"/"chat" and falls back to the
            # default otherwise; a report link wants the default, and naming a
            # type it would discard only reads as though it did something.
            flow_type=None,
            )
            db.commit()
            detail = reg.get_brain(db, BRAIN_KEY)
            version = int(detail.get("version") or detail.get("draft_version") or 1)
            reg.publish(db, BRAIN_KEY, version, EMAIL)
            db.commit()

        published = reg.get_brain(db, BRAIN_KEY, version)
        flow = Flow.model_validate({
            **published["body"], "key": BRAIN_KEY, "name": "E2E bound flow",
        })
        binding, _result = binding_service.save_binding(
            db, link=link, dashboard=dashboard, flow=flow,
            contract=binding_service.DataContract.model_validate(
                {"charts": {"mode": "allowlist", "ids": [chart.id]}}),
            pinned_version=version, actor_email=EMAIL,
        )
        db.commit()
        print(f"seed_e2e_binding: link {link.id} -> binding {binding.id} "
              f"({binding.status}) on brain {BRAIN_KEY} v{version}")
        # HAND THE ID OVER RATHER THAN HOPING IT IS FOUND. `usableLink()` scans
        # ids 1..60 and honours `E2E_LINK_ID` first; on a fresh CI database this
        # link is id 1 and the scan works, but that is a coincidence of ordering,
        # and a suite whose fixture is found by luck skips silently the day it is
        # not. Writing it to the step environment makes the link explicit.
        github_env = os.environ.get("GITHUB_ENV")
        if github_env:
            with open(github_env, "a", encoding="utf-8") as fh:
                fh.write(f"E2E_LINK_ID={link.id}\n")
        return 0
    finally:
        db.close()


if __name__ == "__main__":
    raise SystemExit(main())
