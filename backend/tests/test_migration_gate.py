"""Container start must not migrate an EXISTING database without explicit approval.

Locks the release-hardening fix: `entrypoint.sh` used to run `alembic upgrade head`
unconditionally, so pulling a release onto production applied irreversible data
migrations before anyone had taken a backup.
"""
from app.core.migration_gate import decide

HEADS = ["20261012_0001"]


def test_fresh_database_initialises_without_approval():
    assert decide(has_version_table=False, current=[], heads=HEADS, approved="").allowed


def test_database_at_head_restarts_without_approval():
    assert decide(has_version_table=True, current=HEADS, heads=HEADS, approved="").allowed


def test_existing_database_with_pending_revisions_is_refused():
    d = decide(has_version_table=True, current=["20260914_0002"], heads=HEADS, approved="")
    assert not d.allowed
    assert "APPBI_MIGRATE_APPROVED=20261012_0001" in d.message


def test_approval_for_a_different_target_is_refused():
    d = decide(has_version_table=True, current=["20260914_0002"], heads=HEADS, approved="20261008_0008")
    assert not d.allowed


def test_exact_target_or_auto_approves():
    for ok in ("20261012_0001", " 20261012_0001 ", "auto"):
        assert decide(has_version_table=True, current=["20260914_0002"], heads=HEADS, approved=ok).allowed


def test_populated_database_without_version_table_is_never_fresh():
    # A partial restore / wrong DB_NAME: tables present, history missing.
    for approved in ("", "auto", "20261012_0001"):
        d = decide(has_version_table=False, current=[], heads=HEADS, approved=approved, existing_tables=93)
        assert not d.allowed, approved
        assert "no alembic_version" in d.message
