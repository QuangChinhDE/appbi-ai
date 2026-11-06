"""Public Read MCP over HTTP on Postgres: a customer's own Claude on ONE public link.

What the grant may do is decided here, at the HTTP boundary of the real app:
* OFF by default: a link pairs a Claude only after its publisher turns it on, and the
  viewer payload says only whether it is on (never its settings);
* a grant re-resolves the link on EVERY call: disabled / expired / password changed /
  Claude access off / publisher disconnect (epoch) — refused on the next call;
* a forged or foreign grant, or a report grant used as another kind, is refused;
* a lock cannot be overridden and an undeclared or locked filter is refused loudly;
* a chart the link does not serve is refused; a draft is never read;
* a password link pairs only with its password session.
"""
from __future__ import annotations

import secrets
import uuid
from datetime import datetime, timedelta, timezone

import pytest

from tests.authz_http import client, db, make_user  # noqa: F401

pytestmark = pytest.mark.pg

DECL = [
    {"key": "f1", "label": "Bang", "kind": "category", "fieldKey": "state", "field": "state", "datasetId": 1},
    {"key": "f2", "label": "Kenh", "kind": "category", "fieldKey": "channel", "field": "channel", "datasetId": 1},
]
ON = {"mcp_access": {"enabled": True}}


@pytest.fixture()
def owner(db):  # noqa: F811
    return make_user(db, "pmcp-owner", dashboards="edit")


@pytest.fixture()
def report(db, owner):  # noqa: F811
    from app.models.report_artifact import ReportArtifact, ReportArtifactRevision

    art = ReportArtifact(name="PMCP report", owner_id=owner.id)
    db.add(art)
    db.flush()
    pub = ReportArtifactRevision(artifact_id=art.id, number=1, html="<h1>PUBLISHED</h1>", css="", js="",
                                 bindings=[], filters=DECL, source="manual", content_hash="a" * 64, created_by=owner.id)
    db.add(pub)
    db.flush()
    art.published_revision_id = pub.id
    art.last_published_at = datetime.now(timezone.utc)
    db.commit()
    return art


def _link(client, owner, art, **body):  # noqa: F811
    r = client.post(f"/api/v1/report-artifacts/{art.id}/public-links", json={"name": "L", **body}, headers=owner.headers)
    assert r.status_code == 201, r.text
    return r.json()


def _patch(client, owner, art, link, **body):  # noqa: F811
    r = client.patch(f"/api/v1/report-artifacts/{art.id}/public-links/{link['id']}", json=body, headers=owner.headers)
    assert r.status_code == 200, r.text


def _pair(client, token, kind="report", session=None):  # noqa: F811
    h = {"X-Public-Session": session} if session else {}
    return client.post("/api/v1/public/mcp/pair", json={"kind": kind, "token": token}, headers=h)


def _describe(client, grant, state=None):  # noqa: F811
    return client.post("/api/v1/public/mcp/describe", json={"state": state or {}}, headers={"X-Public-MCP-Grant": grant})


def test_off_by_default_and_the_viewer_never_sees_the_settings(client, owner, report):  # noqa: F811
    link = _link(client, owner, report)
    r = _pair(client, link["token"])
    assert r.status_code == 403 and r.json()["error"] == "mcp_disabled"
    meta = client.get(f"/api/v1/public/reports/{link['token']}").json()
    assert meta["appearance"]["mcp_enabled"] is False

    _patch(client, owner, report, link, appearance_config={"mcp_access": {"enabled": True, "share_guide": False, "epoch": 3}})
    meta = client.get(f"/api/v1/public/reports/{link['token']}").json()
    assert meta["appearance"]["mcp_enabled"] is True
    assert "mcp_access" not in meta["appearance"], "the publisher's settings are never served to a viewer"


def test_grant_reads_only_what_the_link_serves(client, owner, report):  # noqa: F811
    link = _link(client, owner, report, appearance_config=ON,
                 filters_config=[{"field": "f2", "value": ["web"], "hidden": True}])
    p = _pair(client, link["token"])
    assert p.status_code == 200, p.text
    body = p.json()
    assert body["sid"].startswith("vs_") and body["report"]["kind"] == "report"
    d = _describe(client, body["grant"])
    assert d.status_code == 200, d.text
    out = d.json()
    assert out["kind"] == "report" and out["name"] == "PMCP report"
    assert [f["key"] for f in out["viewer_filters"]] == ["f1"], "a locked filter is not offered"
    assert out["other_fixed_filters"] == 1 and "web" not in d.text, "a hidden lock is counted, never named"
    assert out["publisher_guide"] is None, "the guide is shared only when the publisher says so"

    h = {"X-Public-MCP-Grant": body["grant"]}
    bad = client.post("/api/v1/public/mcp/check-state", json={"state": {"filters": {"f2": ["store"]}}}, headers=h)
    assert bad.status_code == 403 and bad.json()["error"] == "filter_not_adjustable", "a lock is never overridden"
    ok = client.post("/api/v1/public/mcp/check-state", json={"state": {"filters": {"f1": ["SP"]}}}, headers=h)
    assert ok.status_code == 200, ok.text
    unknown = client.post("/api/v1/public/mcp/check-state", json={"state": {"filters": {"zz": ["x"]}}}, headers=h)
    assert unknown.status_code == 403
    nochart = client.post("/api/v1/public/mcp/chart-data", json={"chart": "b-not-on-page", "state": {}}, headers=h)
    assert nochart.status_code == 404 and nochart.json()["error"] == "chart_not_published"


def test_every_revocation_takes_effect_on_the_next_call(client, owner, report):  # noqa: F811
    cases = [
        ("disabled", {"is_active": False}, 404, "link_closed"),
        ("password", {"password": "now-locked!"}, 401, "link_changed"),
        ("mcp_off", {"appearance_config": {"mcp_access": {"enabled": False}}}, 403, "mcp_disabled"),
        ("epoch", {"appearance_config": {"mcp_access": {"enabled": True, "epoch": 1}}}, 401, "mcp_revoked"),
        ("expired", {"expires_at": (datetime.now(timezone.utc) - timedelta(minutes=1)).isoformat()}, 401, "link_changed"),
    ]
    for name, change, status, code in cases:
        link = _link(client, owner, report, appearance_config=ON)
        grant = _pair(client, link["token"]).json()["grant"]
        assert _describe(client, grant).status_code == 200, name
        _patch(client, owner, report, link, **change)
        r = _describe(client, grant)
        assert r.status_code == status and r.json()["error"] == code, (name, r.status_code, r.text)


def test_forged_or_foreign_grants_are_refused(client, owner, report):  # noqa: F811
    from app.core import tokens

    link = _link(client, owner, report, appearance_config=ON)
    assert _describe(client, "not-a-grant").status_code == 401
    assert _describe(client, "").status_code == 401
    # a public-link PASSWORD session is another token domain: never a grant
    sess = tokens.encode(tokens.PUBLIC_SESSION, {"sub": link["token"], "lid": link["id"], "av": 0, "k": "report"},
                         ttl=timedelta(minutes=5))
    assert _describe(client, sess).status_code == 401
    # the same claims under the right domain but another kind name a dashboard link row
    forged = tokens.encode(tokens.PUBLIC_MCP_GRANT, {"k": "dashboard", "lid": link["id"], "av": 0, "ep": 0, "sid": "vs_x"},
                           ttl=timedelta(minutes=5))
    r = _describe(client, forged)
    assert r.status_code in (401, 403, 404) and r.json()["error"] != "ok"


def test_a_password_link_pairs_only_with_its_session(client, owner, report):  # noqa: F811
    link = _link(client, owner, report, appearance_config=ON, password="s3cret!")
    r = _pair(client, link["token"])
    assert r.status_code == 401 and r.json()["error"] == "password_required"
    session = client.post(f"/api/v1/public/reports/{link['token']}/auth", json={"password": "s3cret!"}).json()["session_token"]
    p = _pair(client, link["token"], session=session)
    assert p.status_code == 200, p.text
    assert _describe(client, p.json()["grant"]).status_code == 200, "the grant carries the link, not the 2h session"


def test_the_guide_is_shared_only_on_the_publishers_say_so(client, owner, report):  # noqa: F811
    guide = {"context": {"purpose": "Theo doi doanh thu"}, "facts": [{"title": "Khuyen mai", "content": "Q3 co khuyen mai"}]}
    link = _link(client, owner, report, appearance_config={"mcp_access": {"enabled": True, "share_guide": True},
                                                           "ai_bot_guide": guide})
    grant = _pair(client, link["token"]).json()["grant"]
    out = _describe(client, grant).json()
    assert out["publisher_guide"] and "Theo doi doanh thu" in str(out["publisher_guide"])
    meta = client.get(f"/api/v1/public/reports/{link['token']}").json()
    assert "ai_bot_guide" not in meta["appearance"], "a viewer still never receives the guide"


# ── dashboard links ───────────────────────────────────────────────────────────

@pytest.fixture()
def dashboard_link(db, owner):  # noqa: F811
    from app.models.models import Dashboard, DashboardPublicLink

    dash = Dashboard(name=f"pmcp-{uuid.uuid4().hex[:8]}", owner_id=owner.id)
    db.add(dash)
    db.flush()
    link = DashboardPublicLink(dashboard_id=dash.id, name="L", token=secrets.token_urlsafe(24), is_active=True,
                               source="user", appearance_config=dict(ON),
                               filters_config=[{"field": "orders.region", "operator": "in", "value": ["North"]}])
    db.add(link)
    db.commit()
    return dash, link


def test_dashboard_grant_and_its_refusals(client, db, dashboard_link):  # noqa: F811
    dash, link = dashboard_link
    p = _pair(client, link.token, kind="dashboard")
    assert p.status_code == 200, p.text
    grant = p.json()["grant"]
    d = _describe(client, grant)
    assert d.status_code == 200, d.text
    assert d.json()["kind"] == "dashboard" and d.json()["charts"] == []
    meta = client.get(f"/api/v1/public/dashboards/{link.token}")
    assert meta.status_code == 200 and meta.json()["public_link_appearance"]["mcp_enabled"] is True
    assert "mcp_access" not in meta.json()["public_link_appearance"]

    h = {"X-Public-MCP-Grant": grant}
    r = client.post("/api/v1/public/mcp/check-state",
                    json={"state": {"viewer_filters": [{"field": "orders.region", "operator": "in", "value": ["South"]}]}}, headers=h)
    assert r.status_code == 403 and r.json()["error"] == "filter_not_adjustable", "a locked field cannot be re-filtered"
    r = client.post("/api/v1/public/mcp/chart-data", json={"chart": 999999, "state": {}}, headers=h)
    assert r.status_code == 404 and r.json()["error"] == "chart_not_published"

    # a dashboard grant never opens a report link with the same row id, and vice versa
    from app.core import tokens
    other = tokens.encode(tokens.PUBLIC_MCP_GRANT, {"k": "report", "lid": link.id, "av": 0, "ep": 0, "sid": "vs_y"},
                          ttl=timedelta(minutes=5))
    assert _describe(client, other).status_code in (401, 403, 404)

    link.is_active = False
    db.commit()
    r = _describe(client, grant)
    assert r.status_code == 404 and r.json()["error"] == "link_closed"


def test_embed_grants_cannot_pair(client):  # noqa: F811
    r = _pair(client, "emb_" + secrets.token_urlsafe(16), kind="dashboard")
    assert r.status_code == 404
