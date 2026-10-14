"""Workboard credentials and durable writes need the matching action (HTTP).

Regressions locked (authz review of demo@11473148):
* H7  - GET /workboards/{id}/export?include_credentials=true returned every app
        user's bcrypt PIN hash to any VIEW-level user; the layout went out raw
        with the OCR api_key ciphertext.
* H7b - an imported or saved layout could carry a foreign OCR ciphertext that
        GET /{id}/ocr-key would then decrypt for the importer.
* H6  - authenticated media upload needed only VIEW.
* N-WB3 - every new workboard's owner app user got PIN 123456.
* NEW - users imported without a PIN got the hash of a fixed string written in
        the source: a known credential for all of them.
"""
from __future__ import annotations

import uuid

import pytest

from tests.authz_http import client, db, make_user, share  # noqa: F401

pytestmark = pytest.mark.pg

class IMPORT_REPORT:  # minimal stand-in for the import report object
    def __init__(self):
        self.warnings = []
        self.app_users_imported = 0
        self.app_users_needing_pin = []

    def __getattr__(self, name):
        return []


PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64


@pytest.fixture()
def world(db):  # noqa: F811
    from app.core.crypto import encrypt_value
    from app.models.dataset import Dataset, DatasetTable
    from app.modules.workboards.models import Workboard, WorkboardAppUser
    from app.modules.workboards.services.app_user_service import hash_pin

    owner = make_user(db, "c-owner", workboards="edit", datasets="edit")
    viewer = make_user(db, "c-viewer", workboards="view", datasets="view")
    editor = make_user(db, "c-editor", workboards="edit", datasets="edit")
    ds = Dataset(name=f"c-{uuid.uuid4().hex[:6]}", owner_id=owner.id)
    db.add(ds)
    db.flush()
    t = DatasetTable(dataset_id=ds.id, display_name="t", source_table_name="t")
    db.add(t)
    db.flush()
    cipher = encrypt_value("ocr-provider-secret-key")
    layout = {"screens": [{"id": "s1", "kind": "form", "title": "F",
                           "form": {"ocr": {"enabled": True, "provider": "openai", "api_key": cipher}}}]}
    wb = Workboard(name="C", slug=f"c-{uuid.uuid4().hex[:8]}", dataset_id=ds.id, primary_table_id=t.id,
                   owner_id=owner.id, layout_json=layout)
    db.add(wb)
    db.flush()
    db.add(WorkboardAppUser(workboard_id=wb.id, username="field1", pin_hash=hash_pin("482913"),
                            role="user", active=True, context={}))
    db.commit()
    from app.models.dataset import DatasetGrant

    for p, lvl in ((viewer, "view"), (editor, "edit")):
        share(db, "workboard", wb.id, p, lvl, owner)
        db.add(DatasetGrant(dataset_id=ds.id, user_id=p.id, verb="build", granted_by=owner.id))
    db.commit()
    return dict(owner=owner, viewer=viewer, editor=editor, wb=wb, cipher=cipher)


def _export(client, w, who, creds):  # noqa: F811
    return client.get(f"/api/v1/workboards/{w['wb'].id}/export", headers=w[who].headers,
                      params={"include_credentials": str(creds).lower()})


def test_viewer_cannot_export(client, world):  # noqa: F811
    assert _export(client, world, "viewer", False).status_code == 403
    assert _export(client, world, "viewer", True).status_code == 403


def test_editor_exports_without_credentials_only(client, world):  # noqa: F811
    r = _export(client, world, "editor", False)
    assert r.status_code == 200, r.text
    assert "pin_hash" not in r.text
    assert _export(client, world, "editor", True).status_code == 403


def test_owner_may_export_credentials_positive_control(client, world):  # noqa: F811
    r = _export(client, world, "owner", True)
    assert r.status_code == 200 and "pin_hash" in r.text


@pytest.mark.parametrize("who,creds", [("editor", False), ("owner", True)])
def test_ocr_key_material_never_leaves_in_an_export(client, world, who, creds):  # noqa: F811
    r = _export(client, world, who, creds)
    assert r.status_code == 200
    assert world["cipher"] not in r.text and "api_key" not in r.text


def test_foreign_ocr_ciphertext_is_not_adopted_on_save():
    from app.core.crypto import encrypt_value
    from app.modules.workboards.services.ocr_secrets import encrypt_layout_ocr_keys

    stolen = encrypt_value("someone-elses-key")
    new = {"screens": [{"id": "s1", "form": {"ocr": {"enabled": True, "api_key": stolen}}}]}
    out = encrypt_layout_ocr_keys(new, {"screens": [{"id": "s1", "form": {"ocr": {"api_key": None}}}]})
    assert out["screens"][0]["form"]["ocr"]["api_key"] is None
    own = encrypt_value("my-key")
    out = encrypt_layout_ocr_keys(
        {"screens": [{"id": "s1", "form": {"ocr": {"api_key": own}}}]},
        {"screens": [{"id": "s1", "form": {"ocr": {"api_key": own}}}]},
    )
    assert out["screens"][0]["form"]["ocr"]["api_key"] == own


def test_media_upload_needs_edit(client, world):  # noqa: F811
    url = f"/api/v1/workboards/{world['wb'].id}/media"
    files = lambda: {"file": ("a.png", PNG, "image/png")}  # noqa: E731
    assert client.post(url, headers=world["viewer"].headers, files=files()).status_code == 403
    assert client.post(url, headers=world["editor"].headers, files=files()).status_code in (200, 201)


def test_import_placeholder_pin_is_not_a_known_string(db, world):  # noqa: F811
    from app.modules.workboards.models import WorkboardAppUser
    from app.modules.workboards.services import template_service
    from app.modules.workboards.services.app_user_service import verify_pin

    before = {u.id for u in db.query(WorkboardAppUser).filter_by(workboard_id=world["wb"].id)}
    template_service._import_app_users(db, world["wb"], {"app_users": [{"username": "imported1", "role": "user"}]}, IMPORT_REPORT())
    db.commit()
    new = [u for u in db.query(WorkboardAppUser).filter_by(workboard_id=world["wb"].id) if u.id not in before]
    assert new, "import created no user"
    for u in new:
        assert not verify_pin("__appbi_placeholder__set_via_admin__", u.pin_hash)
        assert not verify_pin("123456", u.pin_hash)


def test_new_workboard_owner_pin_is_random(client, db, world):  # noqa: F811
    from app.modules.workboards.models import WorkboardAppUser
    from app.modules.workboards.services.app_user_service import verify_pin

    pins = []
    for _ in range(2):
        r = client.post("/api/v1/workboards/", headers=world["owner"].headers,
                        json={"name": f"new-{uuid.uuid4().hex[:6]}", "dataset_id": world["wb"].dataset_id,
                              "primary_table_id": world["wb"].primary_table_id})
        assert r.status_code in (200, 201), r.text
        pin = r.headers.get("X-AppBI-Default-Owner-Pin")
        assert pin and pin != "123456" and len(pin) >= 8
        owner_row = db.query(WorkboardAppUser).filter_by(workboard_id=r.json()["id"]).first()
        assert verify_pin(pin, owner_row.pin_hash) and not verify_pin("123456", owner_row.pin_hash)
        pins.append(pin)
    assert pins[0] != pins[1]
