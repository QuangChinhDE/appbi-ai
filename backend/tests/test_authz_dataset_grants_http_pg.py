"""Dataset grants: no self-escalation, no over-delete, team grants work (HTTP).

Regressions locked (independent review of demo@11473148):

* H4  — ``DELETE /datasets/{id}/grants`` with no target filtered on
        ``team_id IS NULL`` and deleted EVERY user grant on the dataset; an
        invalid id was a 500; both targets silently ignored the team.
* H4b — a ``reshare`` holder could ``POST {"user_id": <self>, "verb": "manage"}``
        and become a manager of the dataset.
* H3  — team grants imported a non-existent ``TeamMember`` class, swallowed the
        ImportError and resolved to no teams, so every team grant was ignored.

Every case pairs the refusal with a positive control, through the real app.
"""
from __future__ import annotations

import uuid

import pytest

from tests.authz_http import client, db, make_user  # noqa: F401  (fixtures)

pytestmark = pytest.mark.pg


@pytest.fixture()
def world(db):  # noqa: F811
    from app.models.dataset import Dataset, DatasetGrant
    from app.models.team import Team, TeamMembership

    owner = make_user(db, "owner", datasets="edit")
    mallory = make_user(db, "mallory", datasets="edit")
    colleagues = [make_user(db, f"colleague{i}", datasets="edit") for i in range(3)]
    member = make_user(db, "teammember", datasets="edit")
    outsider = make_user(db, "outsider", datasets="edit")

    ds = Dataset(name=f"grants-{uuid.uuid4().hex[:6]}", owner_id=owner.id)
    db.add(ds)
    db.flush()
    team = Team(name=f"team-{uuid.uuid4().hex[:8]}")
    db.add(team)
    db.flush()
    db.add(TeamMembership(team_id=team.id, user_id=member.id))
    db.add(DatasetGrant(dataset_id=ds.id, user_id=mallory.id, verb="reshare", granted_by=owner.id))
    for c in colleagues:
        db.add(DatasetGrant(dataset_id=ds.id, user_id=c.id, verb="view", granted_by=owner.id))
    db.commit()
    return dict(ds=ds, owner=owner, mallory=mallory, colleagues=colleagues,
                member=member, outsider=outsider, team=team)


def _grants(client, who, ds_id):  # noqa: F811
    r = client.get(f"/api/v1/datasets/{ds_id}/grants", headers=who.headers)
    return r


def _user_grant_count(db, ds_id):  # noqa: F811
    from app.models.dataset import DatasetGrant

    db.expire_all()
    return db.query(DatasetGrant).filter(DatasetGrant.dataset_id == ds_id,
                                         DatasetGrant.user_id.isnot(None)).count()


def test_reshare_holder_cannot_self_grant_manage(client, db, world):  # noqa: F811
    ds, m = world["ds"], world["mallory"]
    r = client.post(f"/api/v1/datasets/{ds.id}/grants", headers=m.headers,
                    json={"user_id": str(m.id), "verb": "manage"})
    assert r.status_code == 403, r.text
    # positive control: re-sharing what they can use to someone else works
    r = client.post(f"/api/v1/datasets/{ds.id}/grants", headers=m.headers,
                    json={"user_id": str(world["outsider"].id), "verb": "view"})
    assert r.status_code == 200, r.text


@pytest.mark.parametrize("verb", ["reshare", "edit", "manage", "explore", "build"])
def test_reshare_holder_cannot_grant_above_what_they_hold(client, world, verb):  # noqa: F811
    ds, m = world["ds"], world["mallory"]
    r = client.post(f"/api/v1/datasets/{ds.id}/grants", headers=m.headers,
                    json={"user_id": str(world["outsider"].id), "verb": verb})
    # mallory holds {view, reshare}: explore/build are not hers to give either
    assert r.status_code == 403, (verb, r.text)


def test_owner_may_grant_any_verb_positive_control(client, world):  # noqa: F811
    ds, o = world["ds"], world["owner"]
    r = client.post(f"/api/v1/datasets/{ds.id}/grants", headers=o.headers,
                    json={"user_id": str(world["outsider"].id), "verb": "manage"})
    assert r.status_code == 200, r.text


def test_reshare_holder_cannot_downgrade_a_manager(client, world):  # noqa: F811
    ds, o, m = world["ds"], world["owner"], world["mallory"]
    target = world["outsider"]
    assert client.post(f"/api/v1/datasets/{ds.id}/grants", headers=o.headers,
                       json={"user_id": str(target.id), "verb": "manage"}).status_code == 200
    r = client.post(f"/api/v1/datasets/{ds.id}/grants", headers=m.headers,
                    json={"user_id": str(target.id), "verb": "view"})
    assert r.status_code == 403, r.text
    r = client.delete(f"/api/v1/datasets/{ds.id}/grants", headers=m.headers,
                      params={"user_id": str(target.id)})
    assert r.status_code == 403, r.text


def test_revoke_without_a_target_deletes_nothing(client, db, world):  # noqa: F811
    ds, m = world["ds"], world["mallory"]
    before = _user_grant_count(db, ds.id)
    for params in ({}, {"user_id": ""}, {"team_id": ""}):
        r = client.delete(f"/api/v1/datasets/{ds.id}/grants", headers=m.headers, params=params)
        assert r.status_code == 400, (params, r.text)
    assert _user_grant_count(db, ds.id) == before


def test_revoke_with_both_targets_or_garbage_is_400_not_500(client, db, world):  # noqa: F811
    ds, m = world["ds"], world["mallory"]
    before = _user_grant_count(db, ds.id)
    both = {"user_id": str(world["colleagues"][0].id), "team_id": str(world["team"].id)}
    for params in (both, {"user_id": "not-a-uuid"}, {"team_id": "1; drop table"}):
        r = client.delete(f"/api/v1/datasets/{ds.id}/grants", headers=m.headers, params=params)
        assert r.status_code == 400, (params, r.text)
    assert _user_grant_count(db, ds.id) == before


def test_revoke_removes_exactly_one_grant(client, db, world):  # noqa: F811
    ds, m = world["ds"], world["mallory"]
    before = _user_grant_count(db, ds.id)
    r = client.delete(f"/api/v1/datasets/{ds.id}/grants", headers=m.headers,
                      params={"user_id": str(world["colleagues"][0].id)})
    assert r.status_code == 200 and r.json()["revoked"] == 1, r.text
    assert _user_grant_count(db, ds.id) == before - 1


def test_grant_rejects_bad_targets(client, world):  # noqa: F811
    ds, o = world["ds"], world["owner"]
    url = f"/api/v1/datasets/{ds.id}/grants"
    assert client.post(url, headers=o.headers, json={"verb": "view"}).status_code == 400
    assert client.post(url, headers=o.headers, json={"verb": "view", "user_id": "x"}).status_code == 400
    assert client.post(url, headers=o.headers,
                       json={"verb": "view", "user_id": str(uuid.uuid4())}).status_code == 400
    assert client.post(url, headers=o.headers,
                       json={"verb": "view", "user_id": str(world["outsider"].id),
                             "team_id": str(world["team"].id)}).status_code == 400


def test_team_grant_reaches_team_members(client, world):  # noqa: F811
    ds, o, member = world["ds"], world["owner"], world["member"]
    r = client.post(f"/api/v1/datasets/{ds.id}/grants", headers=o.headers,
                    json={"team_id": str(world["team"].id), "verb": "manage"})
    assert r.status_code == 200, r.text
    # A team manager can publish-manage: the grants-tier destination read needs view.
    r = client.get(f"/api/v1/datasets/{ds.id}/destination", headers=member.headers)
    assert r.status_code != 403, r.text
    # negative control: a non-member gets nothing from the team grant
    r = client.get(f"/api/v1/datasets/{ds.id}/destination", headers=world["outsider"].headers)
    assert r.status_code == 403, r.text


# ── Module level is a CEILING, never a capability (final Dataset contract) ──

def _caps(client, who, ds_id):  # noqa: F811
    r = client.get(f"/api/v1/datasets/{ds_id}/grants", headers=who.headers)
    return r.status_code, (set(r.json().get("my_capabilities", [])) if r.status_code == 200 else None)


def _dataset(db, owner):  # noqa: F811
    from app.models.dataset import Dataset

    ds = Dataset(name=f"ceil-{uuid.uuid4().hex[:6]}", owner_id=owner.id)
    db.add(ds)
    db.commit()
    return ds


def test_module_edit_without_relation_is_not_manage(client, db):  # noqa: F811
    owner = make_user(db, "c-owner", datasets="edit")
    stranger = make_user(db, "c-stranger", datasets="edit")
    ds = _dataset(db, owner)
    assert client.post(f"/api/v1/datasets/{ds.id}/publish", headers=stranger.headers).status_code == 403
    assert client.post(f"/api/v1/datasets/{ds.id}/grants", headers=stranger.headers,
                       json={"user_id": str(owner.id), "verb": "view"}).status_code == 403


def test_owner_with_module_view_stays_view_class(client, db):  # noqa: F811
    owner = make_user(db, "c-viewowner", datasets="view")
    ds = _dataset(db, owner)
    code, caps = _caps(client, owner, ds.id)
    assert code == 200 and caps == {"view", "explore"}


def test_owner_with_module_edit_is_manager_positive_control(client, db):  # noqa: F811
    owner = make_user(db, "c-editowner", datasets="edit")
    ds = _dataset(db, owner)
    code, caps = _caps(client, owner, ds.id)
    assert code == 200 and caps == {"view", "explore", "build", "edit", "reshare", "manage"}


def test_module_admin_manages_any_dataset_explicitly(client, db):  # noqa: F811
    owner = make_user(db, "c-o", datasets="edit")
    admin = make_user(db, "c-admin", datasets="full")
    ds = _dataset(db, owner)
    code, caps = _caps(client, admin, ds.id)
    assert code == 200 and "manage" in caps


@pytest.mark.parametrize("level,expected", [
    ("view", {"view", "explore"}),
    ("edit", {"view", "explore", "build", "edit"}),
])
def test_legacy_resource_share_maps_to_canonical_verbs(client, db, level, expected):  # noqa: F811
    from tests.authz_http import share

    owner = make_user(db, "c-lo", datasets="edit")
    sharee = make_user(db, "c-ls", datasets="edit")
    ds = _dataset(db, owner)
    share(db, "dataset", ds.id, sharee, level, owner)
    code, caps = _caps(client, sharee, ds.id)
    assert code == 200 and caps == expected
