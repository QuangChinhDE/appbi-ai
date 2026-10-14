"""Every privileged authorization action leaves an audit row (HTTP).

Giving or taking access, choosing who is alerted, rotating an address, opening a
report to the public: each is driven through the real endpoint and the audit
trail is read back - who did it, on what, with which action. Before this, dataset
grants, alert channels, the global scan, workspace token rotation, public-link
updates and share edits were not recorded at all.

The audit entry must be written by the SAME request that performed the action
(a later job reconstructing it is not an audit), and never contain a secret.
"""
from __future__ import annotations

import secrets
import uuid

import pytest

from tests.authz_http import client, db, make_user, share  # noqa: F401

pytestmark = pytest.mark.pg


def _rows(db, action: str, resource_id) -> list:  # noqa: F811
    from app.models.audit_log import AuditLog

    db.expire_all()
    return [r for r in db.query(AuditLog).filter(AuditLog.resource_id == str(resource_id)).all()
            if (r.action.value if hasattr(r.action, "value") else r.action) == action]


@pytest.fixture()
def world(db):  # noqa: F811
    from app.models.dataset import Dataset
    from app.models.models import Dashboard
    from app.modules.workboards.models import WorkboardWorkspace

    full = dict(datasets="edit", dashboards="edit", observability="full", workboards="edit")
    owner = make_user(db, "aud-owner", **full)
    other = make_user(db, "aud-other", datasets="view", dashboards="view")
    ds = Dataset(name=f"aud-{uuid.uuid4().hex[:8]}", owner_id=owner.id)
    dash = Dashboard(name=f"aud-{uuid.uuid4().hex[:8]}", owner_id=owner.id)
    ws = WorkboardWorkspace(name="aud", token=secrets.token_urlsafe(24), access_mode="internal",
                            owner_id=owner.id, is_active=True, menu_config=[])
    db.add_all([ds, dash, ws])
    db.commit()
    return dict(owner=owner, other=other, ds=ds, dash=dash, ws=ws)


def test_dataset_grant_and_revoke_are_audited(client, world, db):  # noqa: F811
    o, ds = world["owner"], world["ds"]
    r = client.post(f"/api/v1/datasets/{ds.id}/grants", headers=o.headers,
                    json={"user_id": str(world["other"].id), "verb": "view"})
    assert r.status_code == 200, r.text
    rows = _rows(db, "dataset_grant_created", ds.id)
    assert len(rows) == 1 and str(rows[0].user_id) == str(o.id)
    assert rows[0].details["verb"] == "view"
    r = client.delete(f"/api/v1/datasets/{ds.id}/grants", headers=o.headers,
                      params={"user_id": str(world["other"].id)})
    assert r.status_code == 200, r.text
    assert len(_rows(db, "dataset_grant_revoked", ds.id)) == 1


def test_alert_channel_lifecycle_and_global_scan_are_audited(client, world, db, monkeypatch):  # noqa: F811
    monkeypatch.setattr("app.services.observability_notifier.test_channel", lambda db, ch: (True, None))
    monkeypatch.setattr("app.services.observability_service.ObservabilityService.scan_all",
                        staticmethod(lambda db: {"ok": True}))
    monkeypatch.setattr("app.core.egress.check_destination", lambda *a, **k: "93.184.216.34")
    h = world["owner"].headers
    secret_target = "https://hooks.example.com/services/T000/B000/s3cr3t"
    r = client.post("/api/v1/observability/alert-channels", headers=h,
                    json={"kind": "webhook", "name": "a", "target": secret_target})
    assert r.status_code == 201, r.text
    cid = r.json()["id"]
    assert len(_rows(db, "alert_channel_created", cid)) == 1
    assert client.patch(f"/api/v1/observability/alert-channels/{cid}", headers=h,
                        json={"name": "b"}).status_code == 200
    assert len(_rows(db, "alert_channel_updated", cid)) == 1
    assert client.post(f"/api/v1/observability/alert-channels/{cid}/test", headers=h).status_code == 200
    assert len(_rows(db, "alert_channel_tested", cid)) == 1
    assert client.delete(f"/api/v1/observability/alert-channels/{cid}", headers=h).status_code == 204
    deleted = _rows(db, "alert_channel_deleted", cid)
    assert len(deleted) == 1
    # the webhook URL is a credential: never in the trail
    for action in ("alert_channel_created", "alert_channel_updated", "alert_channel_deleted"):
        for row in _rows(db, action, cid):
            assert "s3cr3t" not in str(row.details)
    before = len(_rows(db, "observability_global_scan", "global"))
    assert client.post("/api/v1/observability/scan", headers=h).status_code == 200
    assert len(_rows(db, "observability_global_scan", "global")) == before + 1


def test_workspace_token_rotation_is_audited(client, world, db):  # noqa: F811
    ws = world["ws"]
    r = client.post(f"/api/v1/workspaces/{ws.id}/rotate-token", headers=world["owner"].headers)
    assert r.status_code == 200, r.text
    rows = _rows(db, "workspace_token_rotated", ws.id)
    assert len(rows) == 1
    db.refresh(ws)
    assert ws.token not in str(rows[0].details)


def test_public_link_lifecycle_is_audited(client, world, db):  # noqa: F811
    d, h = world["dash"], world["owner"].headers
    r = client.post(f"/api/v1/dashboards/{d.id}/public-links", headers=h, json={"name": "x", "password": "pw-123456"})
    assert r.status_code == 201, r.text
    lid = r.json()["id"]
    created = _rows(db, "public_link_created", d.id)
    assert len(created) == 1 and created[0].details["link_id"] == lid
    assert "pw-123456" not in str(created[0].details)
    assert client.patch(f"/api/v1/dashboards/{d.id}/public-links/{lid}", headers=h,
                        json={"is_active": False}).status_code == 200
    assert len(_rows(db, "public_link_updated", d.id)) == 1
    assert client.delete(f"/api/v1/dashboards/{d.id}/public-links/{lid}", headers=h).status_code == 200
    assert len(_rows(db, "public_link_deleted", d.id)) == 1


def test_share_permission_change_is_audited(client, world, db):  # noqa: F811
    d, o = world["dash"], world["owner"]
    share(db, "dashboard", d.id, world["other"], "view", o)
    r = client.put(f"/api/v1/shares/dashboard/{d.id}/{world['other'].id}", headers=o.headers,
                   json={"permission": "edit"})
    assert r.status_code == 200, r.text
    rows = _rows(db, "share_updated", d.id)
    assert len(rows) == 1 and rows[0].details["permission"] == "edit"


def test_refused_actions_write_no_success_row(client, world, db):  # noqa: F811
    """A refused privileged action must not be recorded as done."""
    ds = world["ds"]
    r = client.post(f"/api/v1/datasets/{ds.id}/grants", headers=world["other"].headers,
                    json={"user_id": str(world["other"].id), "verb": "manage"})
    assert r.status_code in (403, 404), r.text
    assert _rows(db, "dataset_grant_created", ds.id) == []
