"""A stored datasource secret is bound to its target and to edit authority (HTTP).

Regression (authz review of demo@11473148, N-DS1): ``POST /datasources/test``
with a ``data_source_id`` refilled the stored password into a config whose host
the caller chose, for any caller holding only a VIEW share.

Hermetic: the connection layer is replaced by a recorder, so no network call is
made. The assertion is about what the backend WOULD have connected with.
"""
from __future__ import annotations

import pytest

from tests.authz_http import client, db, make_user, share  # noqa: F401

pytestmark = pytest.mark.pg

STORED = {"host": "warehouse.internal", "port": 5432, "database": "sales",
          "username": "svc", "password": "s3cret-stored"}


@pytest.fixture()
def calls(monkeypatch):
    seen = []

    def _record(ds_type, config):
        seen.append(dict(config))
        return True, "ok"

    monkeypatch.setattr(
        "app.services.datasource_service.DataSourceConnectionService.test_connection",
        staticmethod(_record),
    )
    return seen


@pytest.fixture()
def world(db):  # noqa: F811
    from app.models.models import DataSource, DataSourceType

    owner = make_user(db, "ds-owner", data_sources="edit")
    viewer = make_user(db, "ds-viewer", data_sources="view")
    editor = make_user(db, "ds-editor", data_sources="edit")
    import uuid
    ds = DataSource(name=f"wh-{uuid.uuid4().hex[:8]}", type=DataSourceType.POSTGRESQL, config=dict(STORED), owner_id=owner.id)
    db.add(ds)
    db.commit()
    share(db, "datasource", ds.id, viewer, "view", owner)
    share(db, "datasource", ds.id, editor, "edit", owner)
    return dict(ds=ds, owner=owner, viewer=viewer, editor=editor)


def _test(client, who, ds_id, **cfg):  # noqa: F811
    config = {**{k: v for k, v in STORED.items() if k != "password"}, "password": ""}
    config.update(cfg)
    return client.post("/api/v1/datasources/test", headers=who.headers,
                       json={"type": "postgresql", "data_source_id": ds_id, "config": config})


def test_viewer_cannot_use_the_stored_secret(client, world, calls):  # noqa: F811
    r = _test(client, world["viewer"], world["ds"].id)
    assert r.status_code == 403, r.text
    assert not any(c.get("password") == STORED["password"] for c in calls)


def test_changed_host_never_receives_the_stored_secret(client, world, calls):  # noqa: F811
    for who in ("editor", "owner"):
        r = _test(client, world[who], world["ds"].id, host="elsewhere.example")
        assert r.status_code == 400, (who, r.text)
    assert not any(c.get("password") == STORED["password"] for c in calls)


def test_changed_type_never_receives_the_stored_secret(client, world, calls):  # noqa: F811
    config = {**STORED, "password": ""}
    r = client.post("/api/v1/datasources/test", headers=world["owner"].headers,
                    json={"type": "mysql", "data_source_id": world["ds"].id, "config": config})
    assert r.status_code == 400, r.text
    assert not calls


def test_same_target_reuse_by_editor_positive_control(client, world, calls):  # noqa: F811
    r = _test(client, world["editor"], world["ds"].id)
    assert r.status_code == 200, r.text
    assert calls and calls[-1]["password"] == STORED["password"]


def test_viewer_may_test_with_own_credentials_positive_control(client, world, calls):  # noqa: F811
    r = _test(client, world["viewer"], world["ds"].id, password="typed-by-viewer")
    assert r.status_code == 200, r.text
    assert calls[-1]["password"] == "typed-by-viewer"


def test_update_cannot_repoint_the_stored_secret(client, world, monkeypatch):  # noqa: F811
    # The real connection probe would fail offline and mask the bug with a 400 of
    # its own; make it succeed so only the secret-binding rule can refuse.
    monkeypatch.setattr("app.api.datasources._validate_datasource_connection_or_raise",
                        lambda *a, **k: None)
    cfg = {**STORED, "password": "", "host": "elsewhere.example"}
    r = client.put(f"/api/v1/datasources/{world['ds'].id}", headers=world["editor"].headers,
                   json={"config": cfg})
    assert r.status_code == 400, r.text


# ── Network level: the backend never connects to a forbidden destination ──────

@pytest.fixture()
def listener():
    import socket
    import threading

    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    sock.listen(5)
    sock.settimeout(0.2)
    state = {"n": 0, "stop": False}

    def run():
        while not state["stop"]:
            try:
                c, _ = sock.accept()
                state["n"] += 1
                c.close()
            except OSError:
                continue

    t = threading.Thread(target=run, daemon=True)
    t.start()
    yield sock.getsockname()[1], state
    state["stop"] = True
    t.join(1)
    sock.close()


def test_viewer_own_credentials_cannot_reach_loopback(client, world, listener, monkeypatch):  # noqa: F811
    """A viewer testing a connection with credentials THEY type cannot turn the
    backend into a scanner of its own loopback / private network."""
    monkeypatch.delenv("DATASOURCE_ALLOW_LOOPBACK", raising=False)
    port, state = listener
    for host in ("127.0.0.1", "localhost", "169.254.169.254", "2130706433"):
        r = client.post("/api/v1/datasources/test", headers=world["viewer"].headers,
                        json={"type": "postgresql", "config": {"host": host, "port": port, "database": "d",
                                                              "username": "u", "password": "typed"}})
        assert r.status_code == 200 and r.json()["success"] is False, (host, r.text)
    assert state["n"] == 0


def test_stored_secret_never_reaches_a_listener(client, world, listener, monkeypatch):  # noqa: F811
    """With the target changed to a host the caller controls, the stored
    secret is refused before any connection (also by owners)."""
    monkeypatch.setenv("DATASOURCE_ALLOW_LOOPBACK", "true")   # even if loopback were allowed
    port, state = listener
    r = _test(client, world["owner"], world["ds"].id, host="127.0.0.1", port=port)
    assert r.status_code == 400, r.text
    assert state["n"] == 0


def test_viewer_cannot_run_sql_on_the_source(client, world):  # noqa: F811
    r = client.post("/api/v1/datasources/query", headers=world["viewer"].headers,
                    json={"data_source_id": world["ds"].id, "sql_query": "SELECT 1"})
    assert r.status_code == 403, r.text
