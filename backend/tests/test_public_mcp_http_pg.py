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


def test_claude_gets_the_ai_bot_context_in_its_brief_only_when_shared(client, owner, report):  # noqa: F811
    """One foundation, two engines: the AI Bot's instructions + guide reach Claude's brief —
    and only on the publisher's say-so; a viewer never receives them."""
    note = "Luon bao cao theo don vi trieu dong."
    guide = {"definitions": [{"name": "AOV", "formula": "revenue / orders"}],
             "out_of_scope": [{"topic": "luong nhan vien"}]}
    cfg = {"ai_bot_report_context_note": note, "ai_bot_guide": guide}
    off = _link(client, owner, report, appearance_config={"mcp_access": {"enabled": True}, **cfg})
    brief = _describe(client, _pair(client, off["token"]).json()["grant"]).json()["assistant_brief"]
    assert "PMCP report" in brief and note not in brief and "AOV" not in brief

    on = _link(client, owner, report, appearance_config={"mcp_access": {"enabled": True, "share_guide": True}, **cfg})
    out = _describe(client, _pair(client, on["token"]).json()["grant"]).json()
    assert out["publisher_guide"]["instructions"] == note
    for text in (note, "AOV: revenue / orders", "luong nhan vien"):
        assert text in out["assistant_brief"]
    meta = client.get(f"/api/v1/public/reports/{on['token']}").json()
    assert "ai_bot_report_context_note" not in meta["appearance"] and "ai_bot_guide" not in meta["appearance"]


def _transcript(client, grant, turn, view_state=None):  # noqa: F811
    return client.post("/api/v1/public/mcp/transcript", json={"turn": turn, "view_state": view_state or {}},
                       headers={"X-Public-MCP-Grant": grant})


def test_claude_turns_are_kept_in_the_ai_bot_history_without_secrets(client, db, owner, report):  # noqa: F811
    from app.models.report_artifact import ReportAnswerTurn

    link = _link(client, owner, report, appearance_config=ON)
    meta = client.get(f"/api/v1/public/reports/{link['token']}").json()
    assert meta["appearance"]["mcp_keeps_history"] is True, "the viewer is told the conversation is kept"
    p = _pair(client, link["token"]).json()
    secret = "sk-ant-oat01-" + "x" * 60
    turn = {"id": "lease1-1", "question": f"Doanh thu? {secret}", "answer": "2,253,900 (Bearer abc.def.ghi)",
            "tools": [{"name": "read_chart", "input": {"chart": "b1", "token": "y" * 64}}], "model": "claude-opus-5-5",
            "duration_ms": 1200}
    r = _transcript(client, p["grant"], turn, {"page": "p1", "filters": {"f1": ["SP"]}})
    assert r.status_code == 200 and r.json()["kept"] is True, r.text
    assert _transcript(client, p["grant"], turn).json().get("replayed") is True, "a retried report is kept once"
    rows = db.query(ReportAnswerTurn).filter(ReportAnswerTurn.link_id == link["id"]).all()
    assert len(rows) == 1
    row = rows[0]
    assert row.idempotency_key == "claude:lease1-1" and row.conversation_key == f"claude-{p['sid']}"[:64]
    assert row.status == "answered" and row.envelope["engine"] == "claude"
    assert row.envelope["tools"][0]["name"] == "read_chart" and row.envelope["view_state"]["filters"] == {"f1": ["SP"]}
    dumped = str(row.question) + str(row.envelope)
    assert "sk-ant" not in dumped and "abc.def.ghi" not in dumped and "y" * 64 not in dumped


def test_history_off_keeps_nothing_and_a_dead_grant_cannot_write(client, db, owner, report):  # noqa: F811
    from app.models.report_artifact import ReportAnswerTurn

    link = _link(client, owner, report, appearance_config={"mcp_access": {"enabled": True, "keep_history": False}})
    assert client.get(f"/api/v1/public/reports/{link['token']}").json()["appearance"]["mcp_keeps_history"] is False
    grant = _pair(client, link["token"]).json()["grant"]
    r = _transcript(client, grant, {"id": "t", "question": "q", "answer": "a"})
    assert r.status_code == 200 and r.json() == {"kept": False, "reason": "history_off"}
    assert db.query(ReportAnswerTurn).filter(ReportAnswerTurn.link_id == link["id"]).count() == 0
    assert _transcript(client, "forged", {"id": "t", "question": "q"}).status_code in (401, 403)


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


def test_page_charts_follow_tile_placement_not_the_stale_page_record():
    """Rig finding: page-1's record said chart_ids [] while its tiles (no pageId) rendered there,
    so Claude's brief told it the overview page was empty."""
    from app.services.public_mcp.service import page_charts

    pages = [{"id": "page-1", "name": "Tong quan", "chart_ids": []}, {"id": "page-2", "name": "Chi tiet", "chart_ids": [9]}]
    tiles = {1: [{"tile_id": 1, "page_id": "page-1"}], 2: [{"tile_id": 2, "page_id": "page-1"}],
             3: [{"tile_id": 3, "page_id": "page-2"}]}
    assert page_charts(pages, tiles) == [{"page_id": "page-1", "name": "Tong quan", "chart_ids": [1, 2]},
                                         {"page_id": "page-2", "name": "Chi tiet", "chart_ids": [3]}]


def test_a_viewer_rates_their_own_claude_answer_like_an_ai_bot_answer(client, db, owner, report):  # noqa: F811
    """Same verdict, same column, same rules as the AI Bot's thumb; only the session that asked."""
    from app.models.report_artifact import ReportAnswerTurn

    def rate(grant, turn, rating):
        return client.post("/api/v1/public/mcp/rating", json={"turn": turn, "rating": rating},
                           headers={"X-Public-MCP-Grant": grant})

    link = _link(client, owner, report, appearance_config=ON)
    me, other = _pair(client, link["token"]).json(), _pair(client, link["token"]).json()
    assert _transcript(client, me["grant"], {"id": "rtl-1", "question": "q", "answer": "a"}).json()["kept"] is True
    _transcript(client, me["grant"], {"id": "rtl-2", "question": "q", "answer": "", "error": "claude_failed"})

    assert rate(other["grant"], "rtl-1", "up").status_code == 404, "another viewer's session cannot rate it"
    assert rate(me["grant"], "rtl-1", "meh").status_code in (409, 422)
    assert rate(me["grant"], "rtl-2", "up").status_code == 409, "a failed turn holds no answer to rate"
    assert rate(me["grant"], "nope", "up").status_code == 404
    r = rate(me["grant"], "rtl-1", "down")
    assert r.status_code == 200 and r.json() == {"rated": True, "rating": "down"}, r.text
    assert rate(me["grant"], "rtl-1", "up").json()["rating"] == "up", "one current verdict, changeable"
    row = db.query(ReportAnswerTurn).filter(ReportAnswerTurn.link_id == link["id"],
                                            ReportAnswerTurn.idempotency_key == "claude:rtl-1").one()
    db.refresh(row)
    assert row.rating == "up"


def test_chart_dataset_map_is_one_query_per_request_however_many_charts(monkeypatch):
    """Pilot: describe took 17-19 s on a 52-chart dashboard — every per-chart lookup re-scanned
    every chart and hit the DB per table (chart x chart x session.get). Now one query, memoised."""
    from types import SimpleNamespace as NS

    from app.api import public as P

    class Q:
        def __init__(self, s): self.s = s
        def filter(self, *a): return self
        def all(self):
            self.s.queries += 1
            return [(t, 100 + t % 3) for t in range(1, 61)]

    class Sess:
        def __init__(self): self.info, self.queries = {}, 0
        def query(self, *a): return Q(self)

    sess = Sess()
    charts = [NS(chart_id=i, chart=NS(dataset_table_id=i, config={})) for i in range(1, 53)]
    charts.append(NS(chart_id=99, chart=NS(dataset_table_id=None, config={"semanticBinding": {"datasetId": 7}})))
    dash = NS(id=1, dashboard_charts=charts)
    monkeypatch.setattr(P, "_session_of", lambda obj: sess)

    for c in charts:
        P._foreign_check_for  # noqa: B018 - same helpers the filter path uses
        P._chart_dataset_id(dash, c.chart_id)
        P._report_dataset_ids(dash)
    assert sess.queries == 1, "one DatasetTable query for the whole request"
    assert P._chart_dataset_id(dash, 4) == 101 and P._chart_dataset_id(dash, 99) == 7, "table first, binding fallback"
    assert P._report_dataset_ids(dash) == {100, 101, 102, 7}
