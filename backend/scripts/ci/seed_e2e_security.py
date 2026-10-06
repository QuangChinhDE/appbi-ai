"""Seed the Playwright SECURITY suite: principals + objects + real tokens.

Writes a JSON fixture (path: $E2E_SECURITY_FIXTURE, default
../e2e/.auth/security.json) that e2e/tests/security/*.spec.ts read. Every token
is minted by the PRODUCT's own functions (access/refresh/OAuth-state/public
session/workspace session); nothing is forged. Each run creates fresh users
and objects (unique suffix), so runs never interfere.

Principals: owner, viewer, editor, module admin, unrelated, team member
(dataset access only through a team grant), and a mini-app user.
Objects: a dataset (+ table) with user/team grants, a datasource with a stored
secret, a dashboard with a public link, a published workboard in an internal
workspace and a public-app-users workspace, global + dataset alert channels,
an agent flow shared with the viewer.

Refuses to run unless ENVIRONMENT is test/dev (it creates accounts).
"""
from __future__ import annotations

import json
import os
import pathlib
import secrets
import sys
import uuid

BACKEND = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(BACKEND))


def main() -> int:
    if (os.environ.get("ENVIRONMENT") or "").lower() not in ("test", "dev", "development"):
        print("refusing: seed_e2e_security only runs with ENVIRONMENT=test/dev")
        return 2
    from app.api import auth as auth_api
    from app.api.public import _create_public_session
    from app.core.database import SessionLocal
    from app.models.agent_brain import AgentBrainVersion
    from app.models.dataset import Dataset, DatasetGrant, DatasetTable
    from app.models.models import Dashboard, DashboardPublicLink, DataSource, DataSourceType
    from app.models.observability import ObservabilityAlertChannel
    from app.models.resource_share import ResourceShare, ResourceType, SharePermission
    from app.models.team import Team, TeamMembership
    from app.models.user import User, UserStatus
    from app.modules.workboards.models import Workboard, WorkboardAppUser, WorkboardWorkspace
    from app.modules.workboards.services import app_user_service
    from app.services.google_data_access_service import build_google_data_access_state

    run = uuid.uuid4().hex[:8]
    none = {k: "none" for k in ("data_sources", "datasets", "explore_charts", "dashboards", "workboards",
                                "govern", "agent_flows", "chat", "observability", "settings")}
    db = SessionLocal()
    try:
        def user(label, **levels):
            u = User(id=uuid.uuid4(), email=f"sec-{label}-{run}@e2e.test", full_name=f"sec {label}",
                     status=UserStatus.ACTIVE, permissions={**none, **levels}, password_hash=None)
            db.add(u)
            db.flush()
            return u

        work = dict(datasets="edit", explore_charts="edit", dashboards="edit", data_sources="edit",
                    workboards="edit", observability="edit", agent_flows="edit", chat="edit", govern="edit")
        owner = user("owner", **work)
        viewer = user("viewer", **work)
        editor = user("editor", **work)
        builder = user("builder", **work)
        admin = user("admin", **{k: "full" for k in work}, settings="full")
        unrelated = user("unrelated", **work)
        member = user("member", **work)

        team = Team(name=f"sec-team-{run}")
        db.add(team)
        db.flush()
        db.add(TeamMembership(team_id=team.id, user_id=member.id))

        dsrc = DataSource(name=f"sec-src-{run}", type=DataSourceType.MYSQL, owner_id=owner.id,
                          # MySQL, not Postgres: other specs pick "the first Postgres source"
                          # from the admin's picker, and this one points nowhere.
                          config={"host": "warehouse.invalid", "port": 3306, "database": "sales",
                                  "username": "svc", "password": f"stored-secret-{run}"})
        db.add(dsrc)
        ds = Dataset(name=f"sec-ds-{run}", owner_id=owner.id)
        db.add(ds)
        db.flush()
        table = DatasetTable(dataset_id=ds.id, display_name="orders", source_table_name="orders",
                             datasource_id=dsrc.id)
        db.add(table)
        db.flush()
        for who, verb in ((viewer, "view"), (editor, "edit"), (builder, "build")):
            db.add(DatasetGrant(dataset_id=ds.id, user_id=who.id, verb=verb, granted_by=owner.id))
        db.add(DatasetGrant(dataset_id=ds.id, team_id=team.id, verb="explore", granted_by=owner.id))
        db.add(ResourceShare(resource_type=ResourceType.DATASOURCE, resource_id=str(dsrc.id),
                             user_id=viewer.id, permission=SharePermission.VIEW, shared_by=owner.id))

        dash = Dashboard(name=f"sec-dash-{run}", owner_id=owner.id)
        other_dash = Dashboard(name=f"sec-other-{run}", owner_id=unrelated.id)
        db.add_all([dash, other_dash])
        db.flush()
        link = DashboardPublicLink(dashboard_id=dash.id, name="sec", token=secrets.token_urlsafe(24),
                                   is_active=True, source="user")
        db.add(link)
        for who, lvl in ((viewer, SharePermission.VIEW), (editor, SharePermission.EDIT)):
            db.add(ResourceShare(resource_type=ResourceType.DASHBOARD, resource_id=str(dash.id),
                                 user_id=who.id, permission=lvl, shared_by=owner.id))

        slug = f"sec-wb-{run}"
        wb = Workboard(name="sec app", slug=slug, dataset_id=ds.id, primary_table_id=table.id,
                       owner_id=owner.id, layout_json={}, is_published=True, published_layout_json={})
        db.add(wb)
        db.flush()
        db.add(ResourceShare(resource_type=ResourceType.WORKBOARD, resource_id=str(wb.id),
                             user_id=viewer.id, permission=SharePermission.VIEW, shared_by=owner.id))
        db.add(ResourceShare(resource_type=ResourceType.WORKBOARD, resource_id=str(wb.id),
                             user_id=editor.id, permission=SharePermission.EDIT, shared_by=owner.id))
        ws_internal = WorkboardWorkspace(name="sec internal", token=secrets.token_urlsafe(24),
                                         access_mode="internal", owner_id=owner.id, is_active=True,
                                         menu_config=[{"workboard_slug": slug, "label": "sec"}])
        ws_public = WorkboardWorkspace(name="sec public", token=secrets.token_urlsafe(24),
                                       access_mode="public_app_users", owner_id=owner.id, is_active=True,
                                       menu_config=[{"workboard_slug": slug, "label": "sec"}])
        db.add_all([ws_internal, ws_public])
        app_pin = "482913"
        app_user = WorkboardAppUser(workboard_id=wb.id, username=f"field-{run}", role="user", active=True,
                                    pin_hash=app_user_service.hash_pin(app_pin), context={})
        db.add(app_user)

        hook = "https://hooks.example.com/services/sec"
        # `scope` only where the column exists, so the same seed also runs on the
        # pre-remediation base (fail-first evidence).
        def channel(scope, **kw):
            if hasattr(ObservabilityAlertChannel, "scope"):
                kw["scope"] = scope
            return ObservabilityAlertChannel(kind="webhook", target=hook, **kw)

        g_channel = channel("global", name="global", dataset_id=None, owner_id=admin.id)
        d_channel = channel("dataset", name="ds", dataset_id=ds.id, owner_id=owner.id)
        db.add_all([g_channel, d_channel])

        flow_key = f"sec_flow_{run}"
        db.add(AgentBrainVersion(
            brain_key=flow_key, version=1, name="sec flow", status="published", owner_email=owner.email,
            body={"name": "sec flow", "nodes": [{"key": "a", "type": "agent", "name": "A", "prompt": "p",
                  "tools": [], "knowledge": [{"source": "semantic", "ref": str(ds.id),
                  "description": "Doanh số bán hàng theo ngày; tra khi hỏi về doanh thu."}]}]}))
        db.add(ResourceShare(resource_type=ResourceType.AGENT_BRAIN, resource_id=flow_key, user_id=viewer.id,
                             permission=SharePermission.VIEW, shared_by=owner.id))
        db.commit()

        class _Link:
            token, id, auth_version = link.token, link.id, int(link.auth_version or 0)

        def tok(u):
            return auth_api.create_access_token(db.get(User, u.id))

        out = {
            "run": run,
            "users": {name: {"id": str(u.id), "email": u.email, "access": tok(u)} for name, u in {
                "owner": owner, "viewer": viewer, "editor": editor, "builder": builder, "admin": admin,
                "unrelated": unrelated, "member": member}.items()},
            "tokens": {
                "owner_refresh": auth_api.create_refresh_token(db.get(User, owner.id)),
                "owner_oauth_state": build_google_data_access_state(user=db.get(User, owner.id),
                                                                    return_to="/", popup=False),
                "public_session": _create_public_session(_Link()),
                "workspace_session": app_user_service.create_internal_session_token(
                    ws_internal, appbi_user=db.get(User, owner.id))[0],
            },
            "team_id": str(team.id),
            "dataset": {"id": ds.id, "table_id": table.id},
            "datasource": {"id": dsrc.id, "stored_password": f"stored-secret-{run}"},
            "dashboard": {"id": dash.id, "link_id": link.id, "link_token": link.token, "other_id": other_dash.id},
            "workboard": {"id": wb.id, "ws_internal": ws_internal.token, "ws_public": ws_public.token,
                          "ws_internal_id": ws_internal.id, "app_user": app_user.username, "app_pin": app_pin},
            "observability": {"global_channel": g_channel.id, "dataset_channel": d_channel.id},
            "flow": {"key": flow_key},
        }
    finally:
        db.close()
    path = pathlib.Path(os.environ.get("E2E_SECURITY_FIXTURE")
                        or (BACKEND.parent / "e2e" / ".auth" / "security.json"))
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(out, indent=1), encoding="utf-8")
    print(f"security fixture written: {path} (run {run})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
