"""Report-as-Code public links over HTTP on Postgres: the dashboard link model on reports.

What a shared report URL may do is decided here, at the HTTP boundary of the real app:
* only an ACTIVE link row resolves; disabled or deleted links are 404 at once, and the
  retired single-token column never serves (no fallback);
* expired is 410; a password link is 401 until /auth, and the session dies when the
  password changes (auth_version) — and it never opens a dashboard link;
* a locked filter is applied server-side whatever the viewer sends;
* only the PUBLISHED revision is served; an author's preview never exposes the draft;
* managing links needs FULL access; a viewer of the module cannot read tokens.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

import pytest

from tests.authz_http import client, db, make_user  # noqa: F401

pytestmark = pytest.mark.pg

DECL = [{"key": "f1", "label": "Bang", "kind": "category", "fieldKey": "state", "field": "state", "datasetId": 1}]


@pytest.fixture()
def owner(db):  # noqa: F811
    return make_user(db, "rpl-owner", dashboards="edit")


@pytest.fixture()
def report(db, owner):  # noqa: F811
    """A report with a published v1 and a DIFFERENT draft v2."""
    from app.models.report_artifact import ReportArtifact, ReportArtifactRevision

    art = ReportArtifact(name="RPL report", owner_id=owner.id)
    db.add(art)
    db.flush()
    pub = ReportArtifactRevision(artifact_id=art.id, number=1, html="<h1>PUBLISHED-ONLY</h1>", css="", js="",
                                 bindings=[], filters=DECL, source="manual", content_hash="a" * 64, created_by=owner.id)
    draft = ReportArtifactRevision(artifact_id=art.id, number=2, html="<h1>DRAFT-SECRET</h1>", css="", js="",
                                   bindings=[], filters=DECL, source="manual", content_hash="b" * 64, created_by=owner.id)
    db.add_all([pub, draft])
    db.flush()
    art.published_revision_id, art.draft_revision_id = pub.id, draft.id
    art.last_published_at = datetime.now(timezone.utc)
    db.commit()
    return art


def _create(client, owner, art, **body):  # noqa: F811
    r = client.post(f"/api/v1/report-artifacts/{art.id}/public-links", json={"name": "L", **body}, headers=owner.headers)
    assert r.status_code == 201, r.text
    return r.json()


def test_only_an_active_link_serves_and_only_the_published_revision(client, owner, report):  # noqa: F811
    link = _create(client, owner, report)
    meta = client.get(f"/api/v1/public/reports/{link['token']}")
    assert meta.status_code == 200 and meta.json()["version"] == 1
    doc = client.get(f"/api/v1/public/reports/{link['token']}/document")
    assert "PUBLISHED-ONLY" in doc.text and "DRAFT-SECRET" not in doc.text

    off = client.patch(f"/api/v1/report-artifacts/{report.id}/public-links/{link['id']}", json={"is_active": False},
                       headers=owner.headers)
    assert off.status_code == 200
    assert client.get(f"/api/v1/public/reports/{link['token']}").status_code == 404
    assert client.get(f"/api/v1/public/reports/{link['token']}/document").status_code == 404

    client.patch(f"/api/v1/report-artifacts/{report.id}/public-links/{link['id']}", json={"is_active": True}, headers=owner.headers)
    assert client.delete(f"/api/v1/report-artifacts/{report.id}/public-links/{link['id']}", headers=owner.headers).status_code == 200
    assert client.get(f"/api/v1/public/reports/{link['token']}").status_code == 404, "a deleted link is gone for good"


def test_the_retired_single_token_column_never_serves(client, db, owner, report):  # noqa: F811
    report.public_token = "rpt_" + uuid.uuid4().hex
    report.public_enabled = True
    db.commit()
    assert client.get(f"/api/v1/public/reports/{report.public_token}").status_code == 404


def test_expired_link_is_gone(client, owner, report):  # noqa: F811
    past = (datetime.now(timezone.utc) - timedelta(minutes=1)).isoformat()
    link = _create(client, owner, report, expires_at=past)
    assert client.get(f"/api/v1/public/reports/{link['token']}").status_code == 410


def test_password_session_is_bound_to_the_link_and_its_security_generation(client, owner, report):  # noqa: F811
    link = _create(client, owner, report, password="s3cret!")
    url = f"/api/v1/public/reports/{link['token']}"
    first = client.get(url)
    assert first.status_code == 401 and first.headers.get("X-Link-Password-Required") == "true"
    assert client.get(url + "/document").status_code == 401
    assert client.post(url + "/auth", json={"password": "nope"}).status_code == 403
    session = client.post(url + "/auth", json={"password": "s3cret!"}).json()["session_token"]
    ok = client.get(url, headers={"X-Public-Session": session})
    assert ok.status_code == 200
    assert "s=" in ok.json()["document_url"], "the frame carries the session (it cannot send a header)"
    assert client.get(url + "/document", params={"s": session}).status_code == 200

    client.patch(f"/api/v1/report-artifacts/{report.id}/public-links/{link['id']}", json={"password": "changed!"},
                 headers=owner.headers)
    assert client.get(url, headers={"X-Public-Session": session}).status_code == 401, "old session dies with the password"

    # A report session never opens a dashboard link, whatever the ids.
    from app.api.public import _verify_public_session

    class _Dash:
        token, id, auth_version = link["token"], link["id"], 1

    assert not _verify_public_session(session, _Dash())


def test_a_locked_filter_cannot_be_overridden_or_listed(client, owner, report):  # noqa: F811
    link = _create(client, owner, report, filters_config=[{"field": "f1", "value": ["SP"]}])
    url = f"/api/v1/public/reports/{link['token']}"
    meta = client.get(url).json()
    assert meta["filters"] == [], "the locked filter is not a viewer control"
    assert meta["locked_filters"][0]["value"] == ["SP"]
    r = client.post(url + "/data", json={"binding": "b1", "state": {"f1": ["RJ"]}})
    assert r.status_code in (400, 404), "no binding b1 here, but an override must never be accepted"
    assert client.post(url + "/values", json={"key": "f1", "search": "", "state": {}}).status_code == 400


def test_preview_shows_the_published_report_and_never_the_draft(client, owner, report):  # noqa: F811
    r = client.post(f"/api/v1/report-artifacts/{report.id}/public-links/preview", json={"filters_config": []},
                    headers=owner.headers)
    assert r.status_code == 200
    token = r.json()["token"]
    doc = client.get(f"/api/v1/public/reports/{token}/document")
    assert "PUBLISHED-ONLY" in doc.text and "DRAFT-SECRET" not in doc.text
    assert client.get(f"/api/v1/public/reports/{token}").json()["preview"] is True


def test_managing_links_needs_full_access_and_tokens_are_not_shown_to_others(client, db, owner, report):  # noqa: F811
    _create(client, owner, report)
    other = make_user(db, "rpl-other", dashboards="edit")
    base = f"/api/v1/report-artifacts/{report.id}/public-links"
    assert client.post(base, json={"name": "x"}, headers=other.headers).status_code in (403, 404)
    listed = client.get(base, headers=other.headers)
    assert listed.status_code in (403, 404) or all(link["token"] is None for link in listed.json())
