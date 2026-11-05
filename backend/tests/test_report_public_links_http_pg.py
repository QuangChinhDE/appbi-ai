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
    doc_url = ok.json()["document_url"]
    assert session not in doc_url, "the reusable session must never sit in a URL the report's code can read"
    grant = doc_url.split("g=", 1)[1]
    assert client.get(url + "/document", params={"g": grant}).status_code == 200, "the grant opens the document"
    assert client.get(url + "/document", params={"s": session}).status_code == 401, "a session in the URL is not accepted"
    # the grant is no session: it opens nothing but the document
    assert client.get(url, headers={"X-Public-Session": grant}).status_code == 401
    assert client.post(url + "/data", json={"binding": "b1", "state": {}},
                       headers={"X-Public-Session": grant}).status_code == 401

    client.patch(f"/api/v1/report-artifacts/{report.id}/public-links/{link['id']}", json={"password": "changed!"},
                 headers=owner.headers)
    assert client.get(url, headers={"X-Public-Session": session}).status_code == 401, "old session dies with the password"
    assert client.get(url + "/document", params={"g": grant}).status_code == 401, "and so does the document grant"

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


# ── The viewer's AI Bot on a report link ─────────────────────────────────────────────

def test_the_report_bot_is_closed_unless_the_link_opens_it_and_never_on_a_preview(client, owner, report):  # noqa: F811
    link = _create(client, owner, report)
    url = f"/api/v1/public/reports/{link['token']}"
    assert client.get(url + "/ai/status").json() == {"enabled": False, "ready": False}
    ask = {"question": "Doanh thu?", "conversation_key": "conv-12345678", "idempotency_key": "idem-12345678"}
    assert client.post(url + "/ai/answer", json=ask).status_code == 403, "bot not enabled on this link"
    preview = client.post(f"/api/v1/report-artifacts/{report.id}/public-links/preview",
                          json={"filters_config": [], "appearance_config": {"ai_bot_enabled": True}},
                          headers=owner.headers).json()["token"]
    assert client.post(f"/api/v1/public/reports/{preview}/ai/answer", json=ask).status_code == 404
    assert client.get(f"/api/v1/public/reports/{preview}").json()["appearance"]["ai_bot_enabled"] is False


def test_the_report_bot_refuses_a_lock_override_before_admitting_the_turn(client, db, owner, report):  # noqa: F811
    from app.models.report_artifact import ReportAnswerTurn

    link = _create(client, owner, report, filters_config=[{"field": "f1", "value": ["SP"]}],
                   appearance_config={"ai_bot_enabled": True})
    ask = {"question": "Doanh thu?", "conversation_key": "conv-12345678", "idempotency_key": "idem-12345678",
           "viewer_state": {"f1": ["RJ"]}}
    r = client.post(f"/api/v1/public/reports/{link['token']}/ai/answer", json=ask)
    assert r.status_code == 400, r.text
    assert db.query(ReportAnswerTurn).filter(ReportAnswerTurn.link_id == link["id"]).count() == 0, "nothing admitted"


def test_a_password_report_link_keeps_its_bot_behind_the_password(client, owner, report):  # noqa: F811
    link = _create(client, owner, report, password="s3cret!", appearance_config={"ai_bot_enabled": True})
    url = f"/api/v1/public/reports/{link['token']}"
    assert client.get(url + "/ai/status").status_code == 401
    ask = {"question": "Doanh thu?", "conversation_key": "conv-12345678", "idempotency_key": "idem-12345678"}
    assert client.post(url + "/ai/answer", json=ask).status_code == 401


def test_a_report_links_ai_key_is_never_stored_or_returned_in_plain_text(client, db, owner, report):  # noqa: F811
    from app.models.report_artifact import ReportArtifactPublicLink

    link = _create(client, owner, report, appearance_config={"ai_bot_enabled": True, "ai_bot_key": "test-only-not-a-real-key-1234", "ai_bot_provider": "openai"})
    stored = db.get(ReportArtifactPublicLink, link["id"])
    db.refresh(stored)
    assert "ai_bot_key" not in (stored.appearance_config or {}), "the key goes to the encrypted credential store"
    assert stored.appearance_config.get("ai_bot_credential_id"), "the link references the credential"
    assert "ai_bot_key" not in link["appearance_config"] and link["appearance_config"]["ai_bot_key_configured"] is True
    assert link["appearance_config"]["ai_bot_key_hint"] == "1234"


# ── Lifecycle: the charts a report made go with it, unless something else uses them ──

def test_deleting_a_report_removes_its_own_charts_and_keeps_one_a_dashboard_uses(client, db, owner):  # noqa: F811
    from app.models.models import Chart, ChartType, Dashboard, DashboardChart
    from app.models.report_artifact import ReportArtifact, ReportArtifactRevision

    def chart(name):
        c = Chart(name=name, chart_type=ChartType.KPI, config={}, owner_id=owner.id)
        db.add(c)
        db.flush()
        return c

    tag = uuid.uuid4().hex[:8]
    own, shared = chart(f"RPL own {tag}"), chart(f"RPL shared {tag}")
    dash = Dashboard(name=f"RPL dash {tag}", owner_id=owner.id)
    db.add(dash)
    db.flush()
    db.add(DashboardChart(dashboard_id=dash.id, chart_id=shared.id, layout={}))
    art = ReportArtifact(name="RPL lifecycle", owner_id=owner.id)
    db.add(art)
    db.flush()
    rev = ReportArtifactRevision(artifact_id=art.id, number=1, html="<p></p>", css="", js="", filters=[],
                                 bindings=[{"id": "b1", "chart_id": own.id, "title": "a", "kind": "kpi"},
                                           {"id": "b2", "chart_id": shared.id, "title": "b", "kind": "kpi"}],
                                 source="manual", content_hash="c" * 64, created_by=owner.id)
    db.add(rev)
    db.flush()
    art.draft_revision_id = rev.id
    db.commit()
    own_id, shared_id = own.id, shared.id
    assert client.delete(f"/api/v1/report-artifacts/{art.id}", headers=owner.headers).status_code == 204
    db.expire_all()
    assert db.get(Chart, own_id) is None, "the report's own chart is not left orphaned in Explore"
    assert db.get(Chart, shared_id) is not None, "a chart a dashboard still shows is kept"


def test_the_report_list_carries_every_report_without_a_silent_cut_off(client, owner, report):  # noqa: F811
    rows = client.get("/api/v1/report-artifacts", headers=owner.headers).json()
    mine = next(r for r in rows if r["id"] == report.id)
    assert mine["user_permission"] == "full" and mine["published_number"] == 1 and "binding_count" in mine


def test_a_rollback_that_breaks_a_locked_link_says_so_and_the_link_fails_closed(client, db, owner):  # noqa: F811
    """Rolling back to a version without the filter a link locks: the link must refuse to
    serve (serving would drop the lock) - and the publisher must be told, not the viewer."""
    from app.models.report_artifact import ReportArtifact, ReportArtifactRevision

    art = ReportArtifact(name="RPL rollback", owner_id=owner.id)
    db.add(art)
    db.flush()
    v1 = ReportArtifactRevision(artifact_id=art.id, number=1, html="<p>v1</p>", css="", js="", bindings=[], filters=[],
                                source="manual", content_hash="d" * 64, created_by=owner.id)
    v2 = ReportArtifactRevision(artifact_id=art.id, number=2, html="<p>v2</p>", css="", js="", bindings=[], filters=DECL,
                                source="manual", content_hash="e" * 64, created_by=owner.id)
    db.add_all([v1, v2])
    db.flush()
    art.draft_revision_id = art.published_revision_id = v2.id
    db.commit()
    link = _create(client, owner, art, filters_config=[{"field": "f1", "value": ["SP"]}])
    r = client.post(f"/api/v1/report-artifacts/{art.id}/publish", json={"revision_id": v1.id}, headers=owner.headers)
    assert r.status_code == 200
    assert any("L" in w and "1" in w for w in r.json().get("warnings") or []), r.json()
    assert client.get(f"/api/v1/public/reports/{link['token']}").status_code == 404, "fails closed"
    ok = client.post(f"/api/v1/report-artifacts/{art.id}/publish", json={"revision_id": v2.id}, headers=owner.headers)
    assert not ok.json().get("warnings") and client.get(f"/api/v1/public/reports/{link['token']}").status_code == 200


# ── The list actions a dashboard has, on a Vibe Report: duplicate, share, export HTML ──

def test_duplicate_copies_the_draft_for_the_caller_unpublished_and_without_links(client, db, owner, report):  # noqa: F811
    from app.models.report_artifact import ReportArtifact, ReportArtifactPublicLink

    _create(client, owner, report)
    r = client.post(f"/api/v1/report-artifacts/{report.id}/duplicate", headers=owner.headers)
    assert r.status_code == 201, r.text
    copy = db.get(ReportArtifact, r.json()["id"])
    db.refresh(copy)
    assert copy.id != report.id and str(copy.owner_id) == str(owner.id)
    assert copy.published_revision_id is None, "a copy is never published by duplicating"
    assert db.query(ReportArtifactPublicLink).filter(ReportArtifactPublicLink.artifact_id == copy.id).count() == 0
    detail = client.get(f"/api/v1/report-artifacts/{copy.id}", headers=owner.headers).json()
    assert "DRAFT-SECRET" in detail["draft"]["html"], "the copy is the draft as it stands"


def test_a_report_is_shared_through_the_one_share_system(client, db, owner, report):  # noqa: F811
    other = make_user(db, "rpl-viewer", dashboards="view")
    url = f"/api/v1/report-artifacts/{report.id}"
    assert client.get(url, headers=other.headers).status_code in (403, 404), "not shared yet"
    r = client.post(f"/api/v1/shares/report_artifact/{report.id}",
                    json={"user_id": str(other.id), "permission": "view"}, headers=owner.headers)
    assert r.status_code in (200, 201), r.text
    seen = client.get(url, headers=other.headers)
    assert seen.status_code == 200 and seen.json()["user_permission"] == "view"
    listed = {x["id"]: x for x in client.get("/api/v1/report-artifacts", headers=other.headers).json()}
    assert listed[report.id]["user_permission"] == "view"
    # a view share does not let them change it, share it or manage its links
    assert client.put(f"{url}/source", json={"html": "x", "css": "", "js": ""}, headers=other.headers).status_code in (403, 404)
    assert client.post(f"/api/v1/shares/report_artifact/{report.id}", json={"user_id": str(other.id), "permission": "edit"},
                       headers=other.headers).status_code in (403, 404)
    assert client.post(f"{url}/public-links", json={"name": "x"}, headers=other.headers).status_code in (403, 404)


def test_export_html_is_a_standalone_page_with_a_data_snapshot_and_no_internals(client, owner, report):  # noqa: F811
    r = client.get(f"/api/v1/report-artifacts/{report.id}/export-html", headers=owner.headers)
    assert r.status_code == 200 and "attachment" in r.headers.get("content-disposition", "")
    page = r.text
    # what a link serves: the PUBLISHED revision, never the unpublished draft
    assert "PUBLISHED-ONLY" in page and "DRAFT-SECRET" not in page
    assert "rac:init" in page and "MessageChannel" in page
    import re as _re

    assert '"chart_id"' not in page, "no chart id in the snapshot"
    assert not _re.search(r"select[^<]{0,200}from", page, _re.I), "no SQL in the file"


# ── Data rights on every report -> data path (export, duplicate, publish, public link) ──
# A share on a REPORT is not a grant on its DATA: /data already checks each bound chart
# and its dataset lineage; every other path that turns the report into numbers must too,
# or a report share is a way around the data's own rights.

@pytest.fixture()
def bound(db):  # noqa: F811
    """A report whose revisions bind one chart the owner can read (explore_charts)."""
    from app.models.models import Chart, ChartType
    from app.models.report_artifact import ReportArtifact, ReportArtifactRevision

    own = make_user(db, "rpl-data-owner", dashboards="edit", explore_charts="edit")
    chart = Chart(name=f"RPL bound {uuid.uuid4().hex[:8]}", chart_type=ChartType.KPI, config={}, owner_id=own.id)
    db.add(chart)
    db.flush()
    art = ReportArtifact(name="RPL bound report", owner_id=own.id)
    db.add(art)
    db.flush()
    binding = [{"id": "b1", "chart_id": chart.id, "title": "Revenue", "kind": "kpi"}]
    rev = ReportArtifactRevision(artifact_id=art.id, number=1, html='<p data-rac-value="b1"></p>', css="", js="",
                                 bindings=binding, filters=[], source="manual", content_hash="d" * 64, created_by=own.id)
    db.add(rev)
    db.flush()
    art.draft_revision_id = rev.id
    db.commit()
    return own, art


def _share(client, own, art, who, permission):  # noqa: F811
    r = client.post(f"/api/v1/shares/report_artifact/{art.id}", json={"user_id": str(who.id), "permission": permission},
                    headers=own.headers)
    assert r.status_code in (200, 201), r.text


def test_a_report_share_without_data_rights_cannot_read_export_or_copy_the_data(client, db, bound):  # noqa: F811
    own, art = bound
    viewer = make_user(db, "rpl-no-data", dashboards="edit")  # the module, a view share, NO chart rights
    _share(client, own, art, viewer, "view")
    url = f"/api/v1/report-artifacts/{art.id}"
    assert client.get(url, headers=viewer.headers).status_code == 200, "the share opens the report"
    assert client.post(f"{url}/data", json={"binding": "b1", "state": {}}, headers=viewer.headers).status_code == 403
    exp = client.get(f"{url}/export-html", headers=viewer.headers)
    assert exp.status_code == 403, "export must not mint data /data refuses"
    dup = client.post(f"{url}/duplicate", headers=viewer.headers)
    assert dup.status_code == 403, "a copy the caller owns would let them publish data they cannot read"
    # the owner, who can read the chart, still can
    assert client.get(f"{url}/export-html", headers=own.headers).status_code == 200
    assert client.post(f"{url}/duplicate", headers=own.headers).status_code == 201


def test_full_access_to_a_report_without_data_rights_cannot_publish_or_open_a_public_link(client, db, bound):  # noqa: F811
    own, art = bound
    # full on the report = the module's admin level; still no right on the bound data
    manager = make_user(db, "rpl-full-no-data", dashboards="full")
    url = f"/api/v1/report-artifacts/{art.id}"
    assert client.get(url, headers=manager.headers).json()["user_permission"] == "full"
    assert client.post(f"{url}/publish", json={"revision_id": None}, headers=manager.headers).status_code == 403
    assert client.post(f"{url}/public-links", json={"name": "x"}, headers=manager.headers).status_code == 403
    # the person who can read the data publishes; the manager still cannot open a link on it
    assert client.post(f"{url}/publish", json={"revision_id": None}, headers=own.headers).status_code == 200
    assert client.post(f"{url}/public-links", json={"name": "x"}, headers=manager.headers).status_code == 403
    assert client.post(f"{url}/public-links", json={"name": "x"}, headers=own.headers).status_code == 201


def test_publish_refuses_sample_numbers_until_the_author_says_so(client, db, owner):  # noqa: F811
    from app.models.report_artifact import ReportArtifact, ReportArtifactRevision

    art = ReportArtifact(name="RPL samples", owner_id=owner.id)
    db.add(art)
    db.flush()
    rev = ReportArtifactRevision(artifact_id=art.id, number=1, html='<p>GOP <span data-rac-sample>20,91 tỷ</span></p>',
                                 css="", js="", bindings=[], filters=[], source="import", content_hash="e" * 64,
                                 created_by=owner.id)
    db.add(rev)
    db.flush()
    art.draft_revision_id = rev.id
    db.commit()
    url = f"/api/v1/report-artifacts/{art.id}/publish"
    r = client.post(url, json={"revision_id": None}, headers=owner.headers)
    assert r.status_code == 409, r.text
    assert r.json()["detail"]["code"] == "SAMPLE_NUMBERS" and r.json()["detail"]["count"] == 1
    db.refresh(art)
    assert art.published_revision_id is None, "nothing was published"
    ok = client.post(url, json={"revision_id": None, "allow_samples": True}, headers=owner.headers)
    assert ok.status_code == 200, ok.text


# ── P0: a link token is the data; a lock is applied or the binding is refused ──────

def test_a_links_token_is_never_listed_to_full_access_without_data_rights(client, db, bound):  # noqa: F811
    own, art = bound
    url = f"/api/v1/report-artifacts/{art.id}"
    assert client.post(f"{url}/publish", json={"revision_id": None}, headers=own.headers).status_code == 200
    link = client.post(f"{url}/public-links", json={"name": "x"}, headers=own.headers).json()
    assert link["token"], "the data owner sees the token they created"
    manager = make_user(db, "rpl-full-no-data-list", dashboards="full")
    listed = client.get(f"{url}/public-links", headers=manager.headers)
    assert listed.status_code == 200
    assert all(item["token"] is None for item in listed.json()), "full on the report is not a right on its data"
    assert all(not item["capabilities"]["reveal_token"] for item in listed.json())
    assert client.get(f"{url}/public-links/{link['id']}/ai/catalog", headers=manager.headers).status_code == 403
    mine = client.get(f"{url}/public-links", headers=own.headers).json()
    assert mine and mine[0]["token"] == link["token"]


LOCK_DECL = [{"key": "f1", "label": "Vung-An", "kind": "category", "fieldKey": "t2.region", "field": "region", "datasetId": 1},
             {"key": "f2", "label": "Bang", "kind": "category", "fieldKey": "t1.state", "field": "state", "datasetId": 1}]


@pytest.fixture()
def locked_link(client, db, bound):  # noqa: F811
    """`bound`'s report, published with two filters and a link HIDING a lock on f1."""
    own, art = bound
    from app.models.report_artifact import ReportArtifactRevision

    rev = db.get(ReportArtifactRevision, art.draft_revision_id)
    rev.filters = LOCK_DECL
    db.commit()
    url = f"/api/v1/report-artifacts/{art.id}"
    assert client.post(f"{url}/publish", json={"revision_id": None}, headers=own.headers).status_code == 200
    r = client.post(f"{url}/public-links", json={"name": "lock", "filters_config": [
        {"field": "f1", "value": ["North"], "hidden": True}]}, headers=own.headers)
    assert r.status_code == 201, r.text
    return r.json()["token"]


def _engine(monkeypatch, *, unreachable: str = "", dropped: list | None = None, seen: list | None = None):
    """The chart engine, as seen by the report: a filter on `unreachable` cannot be applied
    (no relationship path). It refuses an AUTHORITATIVE one, like ChartService does."""
    from app.services import chart_service as cs
    from app.services.chart_contracts import refuse_unapplied_authoritative

    def fake(db, chart_id, extra_filters=None, **kw):
        drops = list(dropped or [])
        for f in extra_filters or []:
            if seen is not None:
                seen.append(dict(f))
            if f.get("fieldKey") == unreachable:
                refuse_unapplied_authoritative(f, "unreachable_view")
                drops.append({"semantic_field": f["fieldKey"], "field": f["field"], "reason": "unreachable_view"})
        return {"data": [{"m": 1250}], "debug": {"dropped_filters": drops}}

    monkeypatch.setattr(cs.ChartService, "get_chart_data", staticmethod(fake))


def test_a_lock_the_engine_cannot_apply_refuses_the_binding_instead_of_widening_it(client, locked_link, monkeypatch):  # noqa: F811
    seen: list = []
    _engine(monkeypatch, unreachable="t2.region", seen=seen)
    r = client.post(f"/api/v1/public/reports/{locked_link}/data", json={"binding": "b1", "state": {}})
    assert r.status_code == 200, r.text
    dto = r.json()
    assert dto["status"] == "refused" and dto["rows"] == [], "no number wider than the link's scope"
    assert any(f.get("_authoritative") for f in seen if f.get("fieldKey") == "t2.region"), "the lock is marked authoritative"
    assert "Vung-An" not in r.text and "North" not in r.text and "t2.region" not in r.text, "a hidden lock is never named"


def test_a_lock_reported_dropped_on_any_path_refuses_and_a_hidden_lock_is_never_named(client, locked_link, monkeypatch):  # noqa: F811
    # e.g. a result-cache hit that only REPORTS the engine's drop
    _engine(monkeypatch, dropped=[{"semantic_field": "t2.region", "field": "region", "reason": "unreachable_view"}])
    dto = client.post(f"/api/v1/public/reports/{locked_link}/data", json={"binding": "b1", "state": {}}).json()
    assert dto["status"] == "refused" and dto["rows"] == []
    # an interactive filter the engine ignores is told by name; a hidden lock never is
    _engine(monkeypatch, dropped=[{"semantic_field": "t1.state", "field": "state", "reason": "unreachable_view"}])
    r = client.post(f"/api/v1/public/reports/{locked_link}/data", json={"binding": "b1", "state": {"f2": ["SP"]}})
    dto = r.json()
    assert dto["status"] == "ready" and dto["notApplied"] == ["Bang"]
    assert "Vung-An" not in r.text and "f1" not in dto["state"]


def test_the_filter_value_list_runs_under_the_links_lock_as_authoritative(client, locked_link, monkeypatch):  # noqa: F811
    from app.services import dataset_model_service as dms

    seen: list = []

    def fake(db, dataset_id, field, limit=200, filters=None, search=None, **kw):
        seen.extend(filters or [])
        return {"values": ["SP", "RJ"]}

    monkeypatch.setattr(dms, "get_distinct_field_values", fake)
    r = client.post(f"/api/v1/public/reports/{locked_link}/values", json={"key": "f2", "state": {}})
    assert r.status_code == 200, r.text
    assert any(f.get("fieldKey") == "t2.region" and f.get("_authoritative") for f in seen)
    # the hidden lock itself has no value list
    assert client.post(f"/api/v1/public/reports/{locked_link}/values", json={"key": "f1", "state": {}}).status_code == 400


def test_creating_a_link_whose_lock_a_binding_cannot_apply_says_so(client, db, bound, monkeypatch):  # noqa: F811
    own, art = bound
    from app.models.report_artifact import ReportArtifactRevision

    rev = db.get(ReportArtifactRevision, art.draft_revision_id)
    rev.filters = LOCK_DECL
    db.commit()
    url = f"/api/v1/report-artifacts/{art.id}"
    assert client.post(f"{url}/publish", json={"revision_id": None}, headers=own.headers).status_code == 200
    _engine(monkeypatch, unreachable="t2.region")
    bad = client.post(f"{url}/public-links", json={"name": "lock", "filters_config": [
        {"field": "f1", "value": ["North"], "hidden": True}]}, headers=own.headers)
    assert bad.status_code == 201, bad.text
    assert bad.json()["lock_warnings"] == [{"binding": "b1", "title": "Revenue", "reason": "lock_not_applicable"}]
    ok = client.post(f"{url}/public-links", json={"name": "ok", "filters_config": [
        {"field": "f2", "value": ["SP"]}]}, headers=own.headers)
    assert ok.status_code == 201 and ok.json()["lock_warnings"] == []
    # switching a link back on re-checks it
    lid = bad.json()["id"]
    client.patch(f"{url}/public-links/{lid}", json={"is_active": False}, headers=own.headers)
    on = client.patch(f"{url}/public-links/{lid}", json={"is_active": True}, headers=own.headers)
    assert on.json()["lock_warnings"][0]["binding"] == "b1"


def test_a_place_with_no_binding_is_said_unbound_not_a_generic_404(client, owner, report):  # noqa: F811
    """Live (artifact 1 rev 1, published before the publish guard): three tables read
    data-rac-bind="missing" and showed EMPTY to viewers and author alike - /data answered
    the 404 of a revoked link. A live link (and the studio) say "not bound" with its own
    code; a dead link keeps its 404."""
    link = _create(client, owner, report)
    url = f"/api/v1/public/reports/{link['token']}/data"
    r = client.post(url, json={"binding": "missing", "state": {}})
    assert r.status_code == 200 and r.json()["status"] == "unbound" and r.json()["code"] == "BINDING_UNBOUND"
    assert r.json()["rows"] == [] and "Chưa gắn dữ liệu" in r.json()["error"]
    s = client.post(f"/api/v1/report-artifacts/{report.id}/data", json={"binding": "b99", "state": {}}, headers=owner.headers)
    assert s.status_code == 200 and s.json()["code"] == "BINDING_UNBOUND"
    assert client.post("/api/v1/public/reports/rpt_doesnotexist/data", json={"binding": "missing", "state": {}}).status_code == 404
