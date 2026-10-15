"""A failed dataset refresh / Sync & Publish tells the owner (in-app + email).

Locks:
* failed run → in-app notification for the owner, plus ONE email per failure
  streak (an open notification = streak already announced → no second email);
* ``snapshot_config.notify.email_on_failure = False`` → in-app only, no email;
* success → the open notification is cleared (streak reset);
* the toggle round-trips through ``validate_config`` and defaults to ON;
* an alert error never escapes into the run that triggered it.
"""
from __future__ import annotations

from datetime import datetime
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from app.services import dataset_snapshot_config as sc
from app.services import dataset_sync_alerts as alerts
from app.services import quality_email_service, user_notification_service


def _ds(notify=None):
    cfg = {} if notify is None else {"snapshot_config": {"notify": notify}}
    return SimpleNamespace(id=7, name="Sales", owner_id="u-1", settings=cfg, published_generation=3)


def _run(status="failed"):
    return SimpleNamespace(id=11, dataset_id=7, status=status, trigger="scheduled",
                           error="SOURCE_SCHEMA_DRIFT: column x missing\ntrace...",
                           finished_at=datetime(2026, 10, 15, 2, 0))


def _db(ds, streak_open):
    """query(...).filter(...).first() answers Dataset, open-notification, User in order."""
    db = MagicMock()
    owner = SimpleNamespace(id="u-1", email="owner@example.com")
    db.query.return_value.filter.return_value.first.side_effect = [
        ds, (1,) if streak_open else None, owner]
    return db


@pytest.fixture
def sent(monkeypatch):
    calls = {"notify": [], "email": []}
    monkeypatch.setattr(user_notification_service, "notify_user",
                        lambda db, uid, **kw: calls["notify"].append((uid, kw)))
    monkeypatch.setattr(quality_email_service, "send_quality_report",
                        lambda **kw: calls["email"].append(kw) or True)
    return calls


def test_first_failure_notifies_and_emails_owner(sent):
    alerts.on_run_finished(_db(_ds(), streak_open=False), _run(), "failed")
    assert len(sent["notify"]) == 1
    uid, kw = sent["notify"][0]
    assert uid == "u-1" and kw["level"] == "error" and kw["dedup_key"] == "dataset_sync_failed:7"
    assert "SOURCE_SCHEMA_DRIFT" in kw["description"] and "trace" not in kw["description"]
    assert len(sent["email"]) == 1
    mail = sent["email"][0]
    assert mail["primary_recipient"] == "owner@example.com"
    assert "Sales" in mail["subject"] and "/datasets/7" in mail["text_body"]


def test_repeat_failure_in_streak_does_not_email_again(sent):
    alerts.on_run_finished(_db(_ds(), streak_open=True), _run(), "failed")
    assert len(sent["notify"]) == 1
    assert sent["email"] == []


def test_email_toggle_off_keeps_in_app_only(sent):
    alerts.on_run_finished(_db(_ds({"email_on_failure": False}), streak_open=False), _run(), "failed")
    assert len(sent["notify"]) == 1
    assert sent["email"] == []


def test_success_clears_open_failure_notification(sent):
    db = MagicMock()
    db.query.return_value.filter.return_value.delete.return_value = 1
    alerts.on_run_finished(db, _run("success"), "success")
    db.query.return_value.filter.return_value.delete.assert_called_once()
    db.commit.assert_called_once()
    assert sent["notify"] == [] and sent["email"] == []


def test_stopped_run_sends_nothing(sent):
    db = MagicMock()
    alerts.on_run_finished(db, _run("stopped"), "stopped")
    db.query.assert_not_called()
    assert sent["notify"] == [] and sent["email"] == []


def test_alert_failure_never_raises(monkeypatch):
    def boom(*a, **k):
        raise RuntimeError("smtp down")
    monkeypatch.setattr(user_notification_service, "notify_user", boom)
    db = _db(_ds(), streak_open=False)
    alerts.on_run_finished(db, _run(), "failed")  # must not raise
    db.rollback.assert_called()


def test_toggle_round_trips_and_defaults_on():
    assert sc.validate_config({"notify": {"email_on_failure": False}})["notify"] == {"email_on_failure": False}
    assert "notify" not in sc.validate_config({"schedule": {"mode": "manual"}})
    assert sc.email_on_failure_enabled(_ds()) is True
    assert sc.email_on_failure_enabled(_ds({"email_on_failure": False})) is False
    assert sc.email_on_failure_enabled(_ds({"email_on_failure": True})) is True
