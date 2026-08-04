import os
import sys
from pathlib import Path

os.environ.setdefault("DATABASE_URL", "sqlite:///./test_workboard_app_user_roles.db")
os.environ.setdefault("DATA_DIR", ".testdata")

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest

from app.modules.workboards.schemas import Screen, ScreenRlsRule
from app.modules.workboards.models import WorkboardAppUser
from app.modules.workboards.services.app_user_service import compute_scope_context
from app.modules.workboards.services.rls_service import (
    CallerIdentity,
    RlsDenied,
    build_rls_filter,
    enforce_write_access,
    identity_from_app_user,
)
from app.modules.workboards.services.screen_runtime import is_screen_visible_for


class _FakeQuery:
    def __init__(self, rows):
        self._rows = rows

    def filter(self, *args, **kwargs):
        return self

    def all(self):
        return self._rows


class _FakeDb:
    def __init__(self, rows):
        self._rows = rows

    def query(self, *args, **kwargs):
        return _FakeQuery(self._rows)


def test_owner_role_bypasses_rls_filters():
    rules = [
        ScreenRlsRule(
            role="user",
            filter_column="farm_id",
            filter_value="{{app_user.farm_id}}",
        )
    ]
    identity = CallerIdentity(app_user={"username": "boss", "role": "owner"})

    filters, allowed = build_rls_filter(rules, None, identity)

    assert allowed is True
    assert filters == []


def test_owner_role_bypasses_write_restrictions():
    rules = [
        ScreenRlsRule(
            role="user",
            can_create=False,
            can_update=False,
            can_delete=False,
        )
    ]
    identity = CallerIdentity(app_user={"username": "boss", "role": "owner"})

    cleaned = enforce_write_access(
        rules,
        None,
        identity,
        op="update",
        row_values={"status": "approved"},
    )

    assert cleaned == {"status": "approved"}


def test_owner_role_bypasses_screen_visibility():
    screen = Screen(
        id="screen-1",
        kind="table",
        title="Orders",
        visible_for_roles=["user"],
        rls=[],
    )
    identity = CallerIdentity(app_user={"username": "boss", "role": "owner"})

    assert is_screen_visible_for(screen, identity) is True


def test_standard_app_user_without_rls_cannot_read_or_write():
    identity = CallerIdentity(app_user={"username": "worker-1", "role": "user"})

    filters, allowed = build_rls_filter([], None, identity)

    assert filters == []
    assert allowed is False
    with pytest.raises(RlsDenied):
        enforce_write_access(
            [],
            None,
            identity,
            op="insert",
            row_values={"status": "draft"},
        )


def test_admin_and_owner_are_privileged_and_bypass_rls():
    # Policy: admin is an app MANAGER, privileged like owner — it bypasses RLS
    # entirely (sees every row, no matching rule needed). Only ``user`` +
    # custom roles are scoped. (Changed from the old "admin is scoped" contract.)
    for role in ("admin", "owner"):
        identity = CallerIdentity(app_user={"username": "ops", "role": role})
        filters, allowed = build_rls_filter([], None, identity)
        assert filters == [] and allowed is True, role


def test_custom_scoped_role_scope_usernames_resolves_to_in_filter():
    # The scope-usernames → IN-filter mechanism still applies to NON-privileged
    # roles (a custom team-lead style role), just not to admin/owner anymore.
    rules = [
        ScreenRlsRule(
            role="team_lead",
            filter_column="created_by",
            filter_value="{{app_user.scope_usernames}}",
        )
    ]
    identity = CallerIdentity(
        app_user={
            "username": "ops",
            "role": "team_lead",
            "scope_usernames": ["ops", "worker-1", "worker-2"],
        }
    )

    filters, allowed = build_rls_filter(rules, None, identity)

    assert allowed is True
    assert filters == [
        {
            "field": "created_by",
            "operator": "in",
            "value": ["ops", "worker-1", "worker-2"],
        }
    ]


def test_insert_with_multi_user_scope_must_stay_inside_scope():
    rules = [
        ScreenRlsRule(
            role="team_lead",
            filter_column="created_by",
            filter_value="{{app_user.scope_usernames}}",
            can_create=True,
        )
    ]
    identity = CallerIdentity(
        app_user={
            "username": "ops",
            "role": "team_lead",
            "scope_usernames": ["ops", "worker-1"],
        }
    )

    cleaned = enforce_write_access(
        rules,
        None,
        identity,
        op="insert",
        row_values={"created_by": "worker-1", "status": "draft"},
    )

    assert cleaned == {"created_by": "worker-1", "status": "draft"}
    with pytest.raises(RlsDenied):
        enforce_write_access(
            rules,
            None,
            identity,
            op="insert",
            row_values={"created_by": "outside", "status": "draft"},
        )


def test_scope_context_expands_admin_branches_and_direct_reports():
    regional = WorkboardAppUser(
        workboard_id=1,
        username="regional",
        role="admin",
        active=True,
        context={"scope_admin_usernames": ["admin_hn", "admin_sg"]},
    )
    admin_hn = WorkboardAppUser(
        workboard_id=1,
        username="admin_hn",
        role="admin",
        active=True,
        context={},
    )
    admin_sg = WorkboardAppUser(
        workboard_id=1,
        username="admin_sg",
        role="admin",
        active=True,
        context={},
    )
    user_hn = WorkboardAppUser(
        workboard_id=1,
        username="user_hn",
        role="user",
        active=True,
        context={"manager_username": "admin_hn"},
    )
    user_sg = WorkboardAppUser(
        workboard_id=1,
        username="user_sg",
        role="user",
        active=True,
        context={"manager_username": "admin_sg"},
    )

    scope = compute_scope_context(
        _FakeDb([regional, admin_hn, admin_sg, user_hn, user_sg]),
        regional,
    )

    assert scope["scope_admin_usernames"] == ["regional", "admin_hn", "admin_sg"]
    assert scope["scope_usernames"] == [
        "regional",
        "admin_hn",
        "admin_sg",
        "user_hn",
        "user_sg",
    ]


def test_internal_appbi_preview_identity_is_not_mini_app_user():
    identity = identity_from_app_user({"username": "staff@appbi.test", "_internal": True})
    screen = Screen(
        id="screen-1",
        kind="table",
        title="Orders",
        visible_for_roles=["user"],
        rls=[],
    )

    filters, allowed = build_rls_filter([], None, identity)

    assert identity.is_app_user is False
    assert filters == []
    assert allowed is True
    assert is_screen_visible_for(screen, identity) is True
