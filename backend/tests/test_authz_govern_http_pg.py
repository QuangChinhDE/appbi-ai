"""Govern: the module gate is not object authorization (HTTP). Authz Gate 4.

Regressions locked (authz review + Gate-4 sweep of demo@11473148):
* metric-usage listed every chart / dashboard name using a measure, for any table;
* caveats (injected into AI answers) could be written/deleted on any dataset;
* ai-scope GET read and PUT REWROTE what the AI may see of any dataset;
* knowledge ai-draft sent any dataset's sample rows and any dashboard to the LLM;
* managed KPIs, certification, review approval and the change log - all global -
  were open to every editor.
"""
from __future__ import annotations

import uuid

import pytest

from tests.authz_http import client, db, make_user  # noqa: F401

pytestmark = pytest.mark.pg

FULL_GOV = dict(govern="edit", datasets="edit", dashboards="edit", explore_charts="edit")


@pytest.fixture()
def world(db):  # noqa: F811
    from app.models.dataset import Dataset, DatasetTable

    owner = make_user(db, "g-owner", **FULL_GOV)
    stranger = make_user(db, "g-stranger", **FULL_GOV)
    admin = make_user(db, "g-admin", govern="full", datasets="full", dashboards="full", explore_charts="full")
    ds = Dataset(name=f"g-{uuid.uuid4().hex[:6]}", owner_id=owner.id)
    db.add(ds)
    db.flush()
    t = DatasetTable(dataset_id=ds.id, display_name="t", source_table_name="t")
    db.add(t)
    db.commit()
    return dict(owner=owner, stranger=stranger, admin=admin, ds=ds, t=t)


def test_metric_usage_needs_the_dataset(client, world):  # noqa: F811
    q = {"table_id": world["t"].id, "name": "revenue"}
    assert client.get("/api/v1/catalog/govern/metric-usage", params=q,
                      headers=world["stranger"].headers).status_code == 404
    assert client.get("/api/v1/catalog/govern/metric-usage", params=q,
                      headers=world["owner"].headers).status_code == 200


def test_caveats_need_dataset_edit(client, world):  # noqa: F811
    body = {"title": "t", "content": "c", "dataset_id": world["ds"].id}
    assert client.put("/api/v1/catalog/govern/caveats", headers=world["stranger"].headers,
                      json=body).status_code == 404
    r = client.put("/api/v1/catalog/govern/caveats", headers=world["owner"].headers, json=body)
    assert r.status_code == 200, r.text
    cid = r.json()["id"]
    # the stranger can neither rewrite nor delete it, nor see it in the list
    assert client.put("/api/v1/catalog/govern/caveats", headers=world["stranger"].headers,
                      json={**body, "id": cid, "dataset_id": None}).status_code in (403, 404)
    assert client.delete(f"/api/v1/catalog/govern/caveats/{cid}",
                         headers=world["stranger"].headers).status_code == 404
    listed = client.get("/api/v1/catalog/govern/caveats", headers=world["stranger"].headers).json()["caveats"]
    assert cid not in [c["id"] for c in listed]


def test_global_caveat_is_admin_only(client, world):  # noqa: F811
    body = {"title": "g", "content": "c", "dataset_id": None}
    assert client.put("/api/v1/catalog/govern/caveats", headers=world["owner"].headers,
                      json=body).status_code == 403
    assert client.put("/api/v1/catalog/govern/caveats", headers=world["admin"].headers,
                      json=body).status_code == 200


@pytest.mark.parametrize("method,path", [
    ("get", "/api/v1/catalog/govern/ai-scope/{ds}"),
    ("put", "/api/v1/catalog/govern/ai-scope/{ds}"),
    ("post", "/api/v1/catalog/govern/certify/rule/1"),
    ("post", "/api/v1/catalog/govern/review-items/1/approve"),
    ("post", "/api/v1/catalog/govern/review-items/1/reject"),
    ("post", "/api/v1/catalog/govern/ai-draft"),
])
def test_deleted_ai_guidance_routes_are_unreachable_for_everyone(client, world, method, path):  # noqa: F811
    """These handlers belong to the deleted AI Guidance feature: the module gate
    404s them for every caller. They also carry object/admin checks now, as
    defence in depth should the prefix ever be re-mapped."""
    url = path.format(ds=world["ds"].id)
    for who in ("owner", "admin", "stranger"):
        r = client.request(method.upper(), url, headers=world[who].headers, json={})
        assert r.status_code == 404, (who, url, r.status_code)


def test_knowledge_ai_draft_refuses_unreadable_inputs_before_the_llm(client, world, monkeypatch):  # noqa: F811
    called = []
    monkeypatch.setattr("app.services.dashboard_ai_bot.govern_ai_draft.draft_document",
                        lambda *a, **k: called.append(1) or {"title": "x"})
    r = client.post("/api/v1/catalog/govern/knowledge/ai-draft", headers=world["stranger"].headers,
                    json={"dataset_ids": [world["ds"].id]})
    assert r.status_code == 404 and not called


@pytest.mark.parametrize("method,path,body", [
    ("put", "/api/v1/catalog/govern/managed-metric", {"name": "m", "label": "M"}),
    ("delete", "/api/v1/catalog/govern/managed-metric/m", None),
    ("post", "/api/v1/catalog/govern/managed-metric/m/certify", None),
    ("get", "/api/v1/catalog/govern/change-log", None),
])
def test_global_governance_is_admin_only(client, world, method, path, body):  # noqa: F811
    kw = {"json": body} if body is not None else {}
    r = client.request(method.upper(), path, headers=world["owner"].headers, **kw)
    assert r.status_code == 403, (path, r.status_code, r.text[:200])
    r = client.request(method.upper(), path, headers=world["admin"].headers, **kw)
    assert r.status_code != 403, (path, r.text[:200])


# ── Tenant-wide vocabulary is a Govern administrator action (second review, F2) ──
#
# Glossaries, terms, classifications and tags feed every AI answer and metric
# vocabulary; any dataset editor could rewrite or delete them (spec §10).

def test_vocabulary_writes_are_govern_admin_only(client, world):  # noqa: F811
    tag = uuid.uuid4().hex[:6]
    writes = [
        ("put", "/api/v1/catalog/govern/glossary", {"name": f"g{tag}", "description": "x"}),
        ("put", "/api/v1/catalog/govern/classification", {"name": f"c{tag}", "description": "x"}),
    ]
    for method, path, body in writes:
        r = getattr(client, method)(path, headers=world["owner"].headers, json=body)
        assert r.status_code == 403, (path, r.status_code, r.text)
    for path in ("/api/v1/catalog/govern/glossary/anything", "/api/v1/catalog/govern/glossary-term/a.b",
                 "/api/v1/catalog/govern/classification/anything", "/api/v1/catalog/govern/tag/a.b"):
        assert client.delete(path, headers=world["owner"].headers).status_code == 403, path
    assert client.put("/api/v1/catalog/govern/glossary-term", headers=world["owner"].headers,
                      json={"glossary": "g", "name": "t"}).status_code == 403
    assert client.put("/api/v1/catalog/govern/tag", headers=world["owner"].headers,
                      json={"classification": "c", "name": "t"}).status_code == 403
    # positive control: a Govern administrator may
    r = client.put("/api/v1/catalog/govern/glossary", headers=world["admin"].headers,
                   json={"name": f"g{tag}", "description": "x"})
    assert r.status_code == 200, r.text


# ── Govern search / graph list only what the caller may read (fourth pass, F2) ─
# (confirmed over HTTP: names + ids of datasets/dashboards the caller got 403 on
# came back from /search, /graph and /knowledge-map.)

def test_govern_search_and_graph_hide_unreadable_assets(client, world, db):  # noqa: F811
    from app.models.models import Dashboard

    tag = f"SECRET{uuid.uuid4().hex[:6]}"
    world["ds"].name = f"{tag}ds"
    d = Dashboard(name=f"{tag}dash", owner_id=world["owner"].id)
    db.add(d)
    db.commit()
    for path in (f"/api/v1/catalog/govern/search?q={tag}", "/api/v1/catalog/govern/graph",
                 "/api/v1/catalog/govern/knowledge-map"):
        r = client.get(path, headers=world["stranger"].headers)
        assert r.status_code == 200, (path, r.text[:200])
        assert tag not in r.text, path
    # positive control: the owner finds both
    r = client.get(f"/api/v1/catalog/govern/search?q={tag}", headers=world["owner"].headers)
    assert f"{tag}ds" in r.text and f"{tag}dash" in r.text
