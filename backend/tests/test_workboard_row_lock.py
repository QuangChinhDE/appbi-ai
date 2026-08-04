"""Table screen per-row edit lock (row_lock).

Locks individual rows (or the whole table) from being edited/deleted based on
the row's own data, with a role allow-list bypass. Complements the existing
column-level ``editable_columns`` and per-role RLS. Enforced server-side in
``screen_runtime._enforce_row_lock`` (the FE gate is advisory).

Contract mirrored from the status guard (``_enforce_status_rules``):
  * AppBI staff + ``owner`` always bypass (a locked record is never un-fixable).
  * The lock is evaluated on the row's CURRENT stored values, so a user cannot
    unlock a row by editing the lock column in the same request.
  * ``editable_by_roles`` (lowercased set) = roles that may still edit; empty =
    only owner. ``lock_delete`` gates deletes.
"""
import os

os.environ.setdefault("DATABASE_URL", "postgresql://stub@localhost/stub")

import pytest
from fastapi import HTTPException

from app.modules.workboards.schemas import RowLockConfig, TableScreenSpec
from app.modules.workboards.services.rls_service import CallerIdentity
from app.modules.workboards.services.screen_runtime import _enforce_row_lock


def _user(role):
    return CallerIdentity(app_user={"username": "u", "role": role})


def _staff():
    return CallerIdentity(appbi_user_id="staff-1")


def _enforce(cfg, row, identity, op="update"):
    """Return True if allowed, False if blocked (403)."""
    try:
        _enforce_row_lock(cfg, row, identity, op=op)
        return True
    except HTTPException as exc:
        assert exc.status_code == 403
        return False


APPROVED = {"trang_thai": "Đã duyệt"}
DRAFT = {"trang_thai": "Nháp"}
COND = RowLockConfig(lock_if="[trang_thai]=='Đã duyệt'", editable_by_roles=["admin"])


# ── Condition lock: role matrix ────────────────────────────────────────────

def test_user_blocked_on_locked_row():
    assert _enforce(COND, APPROVED, _user("user")) is False


def test_admin_in_allowlist_may_edit_locked_row():
    assert _enforce(COND, APPROVED, _user("admin")) is True


def test_owner_always_bypasses():
    assert _enforce(COND, APPROVED, _user("owner")) is True


def test_appbi_staff_bypasses():
    assert _enforce(COND, APPROVED, _staff()) is True


def test_unlocked_row_is_editable_by_anyone():
    assert _enforce(COND, DRAFT, _user("user")) is True


# ── Whole-table lock (lock_if='true') — "only admin edits anything" ────────

def test_whole_table_lock_blocks_user_allows_admin():
    wt = RowLockConfig(lock_if="true", editable_by_roles=["admin"])
    assert _enforce(wt, {"x": 1}, _user("user")) is False
    assert _enforce(wt, {"x": 1}, _user("admin")) is True


def test_hard_lock_empty_roles_blocks_user_privileged_bypass():
    # editable_by_roles=[] blocks the `user` role; owner AND admin are
    # privileged app-managers and always bypass (admin == owner now).
    hard = RowLockConfig(lock_if="true", editable_by_roles=[])
    assert _enforce(hard, {"x": 1}, _user("user")) is False
    assert _enforce(hard, {"x": 1}, _user("admin")) is True
    assert _enforce(hard, {"x": 1}, _user("owner")) is True


# ── Eval on EXISTING row (can't self-unlock) ───────────────────────────────

def test_lock_uses_existing_row_values_not_payload():
    # The gate only ever receives the previous_row (current DB state). A user
    # cannot pass a "Nháp" payload to dodge a lock on an "Đã duyệt" row: the
    # gate is called with the fetched existing row = APPROVED.
    assert _enforce(COND, APPROVED, _user("user")) is False


# ── Delete gate ────────────────────────────────────────────────────────────

def test_delete_blocked_when_lock_delete_true():
    assert _enforce(COND, APPROVED, _user("user"), op="delete") is False


def test_delete_allowed_when_lock_delete_false():
    cfg = RowLockConfig(lock_if="true", lock_delete=False)
    assert _enforce(cfg, {"x": 1}, _user("user"), op="delete") is True


# ── Edge cases ─────────────────────────────────────────────────────────────

def test_empty_lock_if_is_inert():
    inert = RowLockConfig(lock_if="", editable_by_roles=[])
    assert _enforce(inert, APPROVED, _user("user")) is True


def test_none_previous_row_is_noop():
    # No existing row (e.g. concurrent delete) → nothing to lock; downstream
    # RLS existence check handles the missing row.
    assert _enforce(COND, None, _user("user")) is True


def test_malformed_expr_fails_open():
    bad = RowLockConfig(lock_if="[unclosed", editable_by_roles=[])
    assert _enforce(bad, APPROVED, _user("user")) is True  # not locked on parse error


def test_case_insensitive_role_match():
    cfg = RowLockConfig(lock_if="true", editable_by_roles=["Admin"])
    assert _enforce(cfg, {"x": 1}, _user("ADMIN")) is True


def test_custom_message_used():
    cfg = RowLockConfig(lock_if="true", editable_by_roles=[], message="Phiếu đã chốt, liên hệ quản lý.")
    with pytest.raises(HTTPException) as ei:
        _enforce_row_lock(cfg, {"x": 1}, _user("user"))
    assert ei.value.detail == "Phiếu đã chốt, liên hệ quản lý."


# ── Schema round-trip ──────────────────────────────────────────────────────

def test_tablescreenspec_accepts_row_lock():
    spec = TableScreenSpec(columns=["a"], row_lock=RowLockConfig(lock_if="true", editable_by_roles=["admin"]))
    assert spec.row_lock is not None and spec.row_lock.lock_if == "true"


def test_row_lock_defaults_none():
    assert TableScreenSpec(columns=["a"]).row_lock is None


# ── Time-based lock via DATE_DIFF (auto-lock after N days) ─────────────────
# The user scenario: "Ngày đánh giá" older than 3 days auto-locks for users,
# admins still edit. No scheduled job — re-evaluated on every write relative
# to today. Uses the new DATE_DIFF({{today}}, [col]) engine function.

from datetime import datetime, timezone, timedelta  # noqa: E402
from app.modules.workboards.services.expr_eval import evaluate  # noqa: E402


def _days_ago(n):
    return (datetime.now(timezone.utc).date() - timedelta(days=n)).isoformat()


@pytest.mark.parametrize("a,b,expected", [
    ("2026-08-03", "2026-07-27", 7),
    ("03/08/2026", "27/07/2026", 7),          # vi-VN
    ("2026-07-27", "2026-08-03", -7),
    ("2026-08-03T10:00:00", "2026-08-01", 2),  # datetime part ignored
])
def test_date_diff(a, b, expected):
    assert evaluate(f"DATE_DIFF('{a}', '{b}')", {"row": {}}) == expected


def test_date_diff_unparseable_is_none():
    assert evaluate("DATE_DIFF('abc', '2026-08-03')", {"row": {}}) is None


_TIME_LOCK = RowLockConfig(
    lock_if="DATE_DIFF({{today}}, [ngay_danh_gia]) > 3",
    editable_by_roles=["admin"],
)


def test_time_lock_old_row_blocks_user_allows_admin():
    old = {"ngay_danh_gia": _days_ago(5)}
    assert _enforce(_TIME_LOCK, old, _user("user")) is False
    assert _enforce(_TIME_LOCK, old, _user("admin")) is True
    assert _enforce(_TIME_LOCK, old, _user("owner")) is True


def test_time_lock_recent_row_editable_by_all():
    assert _enforce(_TIME_LOCK, {"ngay_danh_gia": _days_ago(1)}, _user("user")) is True


def test_time_lock_boundary_exactly_3_days_not_locked():
    # ">3" — day 3 is still open, day 4 locks.
    assert _enforce(_TIME_LOCK, {"ngay_danh_gia": _days_ago(3)}, _user("user")) is True
    assert _enforce(_TIME_LOCK, {"ngay_danh_gia": _days_ago(4)}, _user("user")) is False
