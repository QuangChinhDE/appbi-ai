"""Editing the Calendar never erases another subsystem's settings.

``Dataset.settings`` holds one namespace per owner — calendar_dimension,
snapshot_config, model_layout, destination. ``normalize_dataset_settings``
returned ONLY ``calendar_dimension``, and both calendar writers (dataset PUT and
"remove an auto-calendar join") assigned its result to the whole column: turning
the Calendar on erased the snapshot schedule, the model canvas layout and an
operational destination binding.
"""
from __future__ import annotations

from types import SimpleNamespace

from app.services.dataset_calendar_service import exclude_calendar_join, normalize_dataset_settings

OTHERS = {
    "snapshot_config": {"schedule": {"cron": "0 2 * * *"}, "partition": "order_date"},
    "model_layout": {"orders": {"x": 10, "y": 20}},
    "destination": {"spreadsheet_id": "sheet-B"},
}


def test_normalizing_keeps_every_other_namespace():
    out = normalize_dataset_settings({**OTHERS, "calendar_dimension": {"enabled": True}}, enabled_default=False)
    assert {k: out[k] for k in OTHERS} == OTHERS
    assert out["calendar_dimension"]["enabled"] is True


def test_removing_an_auto_calendar_join_keeps_every_other_namespace():
    ds = SimpleNamespace(settings={**OTHERS, "calendar_dimension": {"enabled": True}})
    assert exclude_calendar_join(ds, view_name="orders", column_name="order_date") is True
    assert {k: ds.settings[k] for k in OTHERS} == OTHERS
    assert ds.settings["calendar_dimension"]["excluded_auto_joins"] == [
        {"view_name": "orders", "column_name": "order_date"}]


def test_updating_the_calendar_through_dataset_update_keeps_every_other_namespace(monkeypatch):
    from app.services import dataset_crud

    src = open(dataset_crud.__file__, encoding="utf-8").read()
    # the writer must start from the full current settings, not a calendar-only dict
    assert '{**current_settings, "calendar_dimension": merged_calendar_settings}' in src
