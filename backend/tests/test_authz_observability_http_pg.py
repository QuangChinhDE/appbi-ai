"""Observability: global is explicit and admin-only; channels are owned (HTTP).

Regressions locked (authz review of demo@11473148):
* H9  - update/delete/test of a channel with dataset_id NULL checked nothing
        beyond `observability: edit`: any editor could repoint a global webhook
        to themselves and receive every dataset's incidents; editors saw every
        target (webhook / Slack URL = credential).
* H9  - a view share on a dataset was enough to repoint / delete someone
        else's dataset channel.
* H9/SSRF - targets were never validated; "test" posted to any URL from the
        backend and echoed the client exception text.
* H8  - POST /observability/scan ran every monitor on every dataset and
        notified every channel for anyone with `datasets: edit`.
"""
from __future__ import annotations

import uuid

import pytest

from tests.authz_http import client, db, make_user, share  # noqa: F401

pytestmark = pytest.mark.pg

HOOK = "https://hooks.example.com/services/T000/B000/secret-token"


@pytest.fixture(autouse=True)
def public_test_dns(monkeypatch):
    """*.example.com resolves to a PUBLIC documentation-adjacent address so the
    egress policy treats it as an allowed public target without real DNS.
    Everything else (127.0.0.1, 10.x, ...) resolves for real."""
    import socket

    real = socket.getaddrinfo

    def _gai(host, port, *a, **k):
        if str(host).endswith("example.com"):
            return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", port or 0))]
        return real(host, port, *a, **k)

    monkeypatch.setattr(socket, "getaddrinfo", _gai)


@pytest.fixture()
def world(db):  # noqa: F811
    from app.models.dataset import Dataset
    from app.models.observability import ObservabilityAlertChannel

    admin = make_user(db, "o-admin", observability="full", datasets="full")
    owner = make_user(db, "o-owner", observability="edit", datasets="edit")
    editor = make_user(db, "o-editor", observability="edit", datasets="edit")
    viewer_share = make_user(db, "o-viewshare", observability="edit", datasets="edit")
    ds = Dataset(name=f"o-{uuid.uuid4().hex[:6]}", owner_id=owner.id)
    db.add(ds)
    db.commit()
    share(db, "dataset", ds.id, viewer_share, "view", owner)
    g = ObservabilityAlertChannel(kind="webhook", name="global", target=HOOK, scope="global",
                                  dataset_id=None, owner_id=admin.id)
    d = ObservabilityAlertChannel(kind="webhook", name="ds", target=HOOK, scope="dataset",
                                  dataset_id=ds.id, owner_id=owner.id)
    db.add_all([g, d])
    db.commit()
    return dict(admin=admin, owner=owner, editor=editor, viewer_share=viewer_share, ds=ds, g=g, d=d)


@pytest.fixture()
def no_send(monkeypatch):
    sent = []
    monkeypatch.setattr("app.services.observability_notifier._send_one", lambda ch, inc: sent.append(ch.id))
    return sent


def test_editor_cannot_touch_a_global_channel(client, world, no_send):  # noqa: F811
    gid, h = world["g"].id, world["editor"].headers
    assert client.patch(f"/api/v1/observability/alert-channels/{gid}", headers=h,
                        json={"target": "https://attacker.example/x"}).status_code == 403
    assert client.post(f"/api/v1/observability/alert-channels/{gid}/test", headers=h).status_code == 403
    assert client.delete(f"/api/v1/observability/alert-channels/{gid}", headers=h).status_code == 403
    assert not no_send


def test_editor_cannot_create_a_global_channel(client, world):  # noqa: F811
    r = client.post("/api/v1/observability/alert-channels", headers=world["editor"].headers,
                    json={"kind": "webhook", "name": "mine", "target": "https://attacker.example/x"})
    assert r.status_code == 403


def test_admin_manages_global_channels_positive_control(client, world, no_send):  # noqa: F811
    gid, h = world["g"].id, world["admin"].headers
    assert client.patch(f"/api/v1/observability/alert-channels/{gid}", headers=h,
                        json={"name": "renamed"}).status_code == 200
    assert client.post(f"/api/v1/observability/alert-channels/{gid}/test", headers=h).status_code == 200
    r = client.post("/api/v1/observability/alert-channels", headers=h,
                    json={"kind": "webhook", "name": "g2", "target": "https://hooks.example.com/x"})
    assert r.status_code == 201 and r.json()["scope"] == "global"


def test_targets_are_masked_unless_the_caller_manages_the_channel(client, world):  # noqa: F811
    def targets(who):
        rows = client.get("/api/v1/observability/alert-channels", headers=world[who].headers).json()
        return {r["id"]: r["target"] for r in rows}
    assert HOOK not in targets("editor").values()
    t_owner = targets("owner")
    assert t_owner[world["d"].id] == HOOK and t_owner[world["g"].id] != HOOK
    assert targets("admin")[world["g"].id] == HOOK


def test_dataset_view_share_cannot_manage_someone_elses_channel(client, world, no_send):  # noqa: F811
    did, h = world["d"].id, world["viewer_share"].headers
    assert client.patch(f"/api/v1/observability/alert-channels/{did}", headers=h,
                        json={"target": "https://attacker.example/x"}).status_code == 403
    assert client.delete(f"/api/v1/observability/alert-channels/{did}", headers=h).status_code == 403
    assert client.post(f"/api/v1/observability/alert-channels/{did}/test", headers=h).status_code == 403
    assert not no_send


def test_owner_manages_their_dataset_channel_positive_control(client, world, no_send):  # noqa: F811
    did, h = world["d"].id, world["owner"].headers
    assert client.patch(f"/api/v1/observability/alert-channels/{did}", headers=h,
                        json={"name": "mine"}).status_code == 200


def test_dataset_channel_creation_needs_dataset_edit(client, world):  # noqa: F811
    body = {"kind": "webhook", "name": "x", "target": "https://hooks.example.com/x",
            "dataset_id": world["ds"].id}
    assert client.post("/api/v1/observability/alert-channels", headers=world["viewer_share"].headers,
                       json=body).status_code == 403
    assert client.post("/api/v1/observability/alert-channels", headers=world["owner"].headers,
                       json=body).status_code == 201


@pytest.mark.parametrize("target", [
    "http://127.0.0.1:8000/api/v1/health", "http://169.254.169.254/latest/meta-data/",
    "http://[::1]/", "http://10.0.0.5/hook", "http://2130706433/", "file:///etc/passwd",
])
def test_internal_targets_are_refused_on_save(client, world, target):  # noqa: F811
    r = client.post("/api/v1/observability/alert-channels", headers=world["admin"].headers,
                    json={"kind": "webhook", "name": "x", "target": target})
    assert r.status_code == 400, (target, r.text)
    r = client.patch(f"/api/v1/observability/alert-channels/{world['g'].id}",
                     headers=world["admin"].headers, json={"target": target})
    assert r.status_code == 400, (target, r.text)


def test_test_errors_do_not_echo_client_internals(client, db, world, monkeypatch):  # noqa: F811
    def boom(ch, inc):
        raise RuntimeError("connect to 10.1.2.3:8443 failed; body=<internal secret>")
    monkeypatch.setattr("app.services.observability_notifier._send_one", boom)
    r = client.post(f"/api/v1/observability/alert-channels/{world['g'].id}/test",
                    headers=world["admin"].headers)
    assert r.status_code == 200
    assert "10.1.2.3" not in r.text and "internal secret" not in r.text


def test_global_scan_is_admin_only(client, world, monkeypatch):  # noqa: F811
    ran = []
    monkeypatch.setattr("app.services.observability_service.ObservabilityService.scan_all",
                        staticmethod(lambda db: ran.append(1) or {"monitors": 0}))
    assert client.post("/api/v1/observability/scan", headers=world["editor"].headers).status_code == 403
    assert not ran
    assert client.post("/api/v1/observability/scan", headers=world["admin"].headers).status_code == 200
    assert ran == [1]
