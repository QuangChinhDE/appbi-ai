"""PAT authority is always a subset of its owner's LIVE authority (HTTP, Postgres).

The file ``test_module_floor`` has long pointed at for this guarantee. Every case
mints a REAL personal access token through ``POST /auth/personal-access-tokens/``
with a session, then calls the API with ``Authorization: Bearer appbi_pat_...``.

Regressions locked (authz review of demo@11473148):
* N-PAT1 - three paths read ``current_user.permissions`` raw: a PAT scoped to
  ``explore_charts: view`` could SAVE charts (then through ``/charts/ai-preview``,
  since removed — the canonical save path ``POST /charts/`` is asserted now)
  because its owner held edit.
* a PAT row with empty scopes ``{}`` (the column default) was stamped with no
  cap at all and authenticated as its full owner.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

import pytest

from tests.authz_http import client, db, make_user, set_permissions  # noqa: F401

pytestmark = pytest.mark.pg

PAT_URL = "/api/v1/auth/personal-access-tokens/"


def _mint(client, human, scopes, **extra):  # noqa: F811
    r = client.post(PAT_URL, headers=human.headers,
                    json={"name": f"t-{uuid.uuid4().hex[:6]}", "scopes": scopes, "expires_in_days": 30, **extra})
    assert r.status_code == 201, r.text
    body = r.json()
    return body["token"], {"Authorization": f"Bearer {body['token']}"}, body


@pytest.fixture()
def human(db):  # noqa: F811
    return make_user(db, "pat-human", datasets="edit", explore_charts="edit", dashboards="edit",
                     data_sources="edit", workboards="edit")


@pytest.fixture()
def own_dataset(db, human):  # noqa: F811
    from app.models.dataset import Dataset, DatasetTable

    ds = Dataset(name=f"pat-{uuid.uuid4().hex[:6]}", owner_id=human.id)
    db.add(ds)
    db.flush()
    t = DatasetTable(dataset_id=ds.id, display_name="t", source_table_name="t")
    db.add(t)
    db.commit()
    return ds, t


def test_pat_view_cannot_edit_what_the_human_can(client, human, own_dataset):  # noqa: F811
    ds, _ = own_dataset
    _, pat, _ = _mint(client, human, {"datasets": "view"})
    assert client.put(f"/api/v1/datasets/{ds.id}", headers=pat, json={"description": "x"}).status_code == 403
    # positive controls: the PAT can read; the human session can edit
    assert client.get(f"/api/v1/datasets/{ds.id}", headers=pat).status_code == 200
    assert client.put(f"/api/v1/datasets/{ds.id}", headers=human.headers,
                      json={"description": "x"}).status_code == 200


def test_pat_none_on_a_module_sees_nothing_there(client, human, own_dataset):  # noqa: F811
    _, pat, _ = _mint(client, human, {"dashboards": "view"})
    assert client.get("/api/v1/datasets/", headers=pat).status_code == 403


def test_human_demotion_caps_the_pat_on_the_next_request(client, db, human, own_dataset):  # noqa: F811
    ds, _ = own_dataset
    _, pat, _ = _mint(client, human, {"datasets": "edit"})
    assert client.get(f"/api/v1/datasets/{ds.id}", headers=pat).status_code == 200
    set_permissions(db, human, datasets="none", explore_charts="edit")
    assert client.get(f"/api/v1/datasets/{ds.id}", headers=pat).status_code == 403


def test_revoked_pat_fails(client, human):  # noqa: F811
    _, pat, body = _mint(client, human, {"datasets": "view"})
    assert client.delete(f"{PAT_URL}{body['item']['id']}", headers=human.headers).status_code == 204
    assert client.get("/api/v1/datasets/", headers=pat).status_code == 401


def test_expired_pat_fails(client, db, human):  # noqa: F811
    from app.models.personal_access_token import PersonalAccessToken

    _, pat, body = _mint(client, human, {"datasets": "view"})
    row = db.get(PersonalAccessToken, uuid.UUID(body["item"]["id"]))
    row.expires_at = datetime.now(timezone.utc) - timedelta(seconds=1)
    db.commit()
    assert client.get("/api/v1/datasets/", headers=pat).status_code == 401


def test_empty_scope_row_is_not_an_uncapped_owner(client, db, human):  # noqa: F811
    from app.models.personal_access_token import PersonalAccessToken

    _, pat, body = _mint(client, human, {"datasets": "view"})
    row = db.get(PersonalAccessToken, uuid.UUID(body["item"]["id"]))
    row.scopes = {}
    db.commit()
    assert client.get("/api/v1/datasets/", headers=pat).status_code == 401


def test_pat_cannot_mint_or_reveal_tokens(client, human):  # noqa: F811
    _, pat, body = _mint(client, human, {"datasets": "edit"})
    assert client.post(PAT_URL, headers=pat, json={"name": "x", "scopes": {"datasets": "view"},
                                                   "expires_in_days": 1}).status_code in (401, 403)


def test_pat_scope_cannot_be_regained_through_chart_save(client, human, own_dataset):  # noqa: F811
    _, t = own_dataset
    _, pat, _ = _mint(client, human, {"datasets": "view", "explore_charts": "view"})
    r = client.post("/api/v1/charts/", headers=pat,
                    json={"name": f"pat-save-{uuid.uuid4().hex[:6]}", "dataset_table_id": t.id,
                          "chart_type": "TABLE", "config": {"roleConfig": {"metrics": []}}})
    assert r.status_code == 403, r.text


def test_pat_cannot_exceed_owner_at_creation(client, db):  # noqa: F811
    viewer = make_user(db, "pat-viewer", datasets="view")
    r = client.post(PAT_URL, headers=viewer.headers,
                    json={"name": "x", "scopes": {"datasets": "edit"}, "expires_in_days": 1})
    assert r.status_code == 400


# ── Decision Q4: plaintext only at owner create / rotate ─────────────────────

def test_no_reveal_endpoint_exists(client, db, human):  # noqa: F811
    _, _, body = _mint(client, human, {"datasets": "view"})
    tid = body["item"]["id"]
    admin = make_user(db, "pat-admin", settings="full")
    assert client.get(f"{PAT_URL}{tid}/reveal", headers=human.headers).status_code in (404, 405)
    assert client.get(f"{PAT_URL}admin/{tid}/reveal", headers=admin.headers).status_code in (404, 405)


def test_no_reversible_copy_is_stored(client, db, human):  # noqa: F811
    from app.models.personal_access_token import PersonalAccessToken

    _, _, body = _mint(client, human, {"datasets": "view"})
    assert db.get(PersonalAccessToken, uuid.UUID(body["item"]["id"])).secret_enc is None


def test_admin_invalidates_but_never_receives_a_token(client, db, human):  # noqa: F811
    _, pat, body = _mint(client, human, {"datasets": "view"})
    tid = body["item"]["id"]
    admin = make_user(db, "pat-admin2", settings="full")
    r = client.post(f"{PAT_URL}admin/{tid}/invalidate", headers=admin.headers)
    assert r.status_code == 200, r.text
    assert "token" not in r.json()                     # no usable bearer token
    assert "..." in r.json()["token_hint"]               # only the masked hint
    assert client.get("/api/v1/datasets/", headers=pat).status_code == 401
    # the OWNER gets a new secret by rotating it themselves
    r = client.post(f"{PAT_URL}{tid}/rotate", headers=human.headers)
    assert r.status_code == 200 and r.json()["token"].startswith("appbi_pat_")
    assert client.get("/api/v1/datasets/",
                      headers={"Authorization": f"Bearer {r.json()['token']}"}).status_code == 200
