"""The quarantine inventory is for Govern administrators only. Real Postgres, real HTTP.

`GET /api/v1/catalog/govern/knowledge-quarantine` lists the Approved rules,
playbooks, Verified Q&A and active AI instructions that are quarantined
(SEC-10, ADR-014). The listing is tenant-wide, so only a Govern administrator may
read it. The removed management routes (`/govern/rules` …) stay 404: this
endpoint must not become a back door to them.
"""
from __future__ import annotations

import uuid

import pytest

from tests.authz_http import client, db, make_user  # noqa: F401

pytestmark = pytest.mark.pg

URL = "/api/v1/catalog/govern/knowledge-quarantine"


@pytest.fixture()
def world(db):  # noqa: F811
    from app.models.governance import GovernRule, GovernVerifiedQA

    tag = uuid.uuid4().hex[:6]
    rule = GovernRule(name=f"rule-{tag}", condition_text="c", conclusion_text="k",
                      applies_to=[], status="Approved")
    qa = GovernVerifiedQA(question=f"q-{tag}?", trigger_phrases=[f"q {tag}"],
                          answer_md="ANSWER-BODY-NEVER-LISTED", status="Approved")
    db.add_all([rule, qa])
    db.commit()
    return dict(
        admin=make_user(db, "kq-admin", govern="full"),
        viewer=make_user(db, "kq-viewer", govern="view"),
        stranger=make_user(db, "kq-none", govern="none"),
        rule=rule, qa=qa,
    )


def test_a_govern_administrator_reads_the_inventory(client, world):  # noqa: F811
    r = client.get(URL, headers=world["admin"].headers)
    assert r.status_code == 200, r.text
    body = r.json()
    assert world["rule"].id in [i["id"] for i in body["items"]["rule"]]
    assert world["qa"].id in [i["id"] for i in body["items"]["qa"]]
    assert set(body["quarantined_kinds"]) == {"rule", "playbook", "qa", "instruction"}
    assert "ANSWER-BODY-NEVER-LISTED" not in r.text


def test_a_govern_viewer_is_refused(client, world):  # noqa: F811
    assert client.get(URL, headers=world["viewer"].headers).status_code == 403


def test_without_govern_the_route_is_not_reachable(client, world):  # noqa: F811
    assert client.get(URL, headers=world["stranger"].headers).status_code in (403, 404)


@pytest.mark.parametrize("path", ["/api/v1/catalog/govern/rules", "/api/v1/catalog/govern/qa",
                                  "/api/v1/catalog/govern/playbooks", "/api/v1/catalog/govern/instructions"])
def test_the_removed_management_routes_stay_404_even_for_an_admin(client, world, path):  # noqa: F811
    """ADR-013: no orphaned route is reopened by mapping it onto a wider key."""
    assert client.get(path, headers=world["admin"].headers).status_code == 404
