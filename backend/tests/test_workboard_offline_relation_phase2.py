import os
import sys
from pathlib import Path

import pytest
from fastapi import HTTPException

os.environ.setdefault("DATABASE_URL", "sqlite:///./test_workboard_offline_relation_phase2.db")
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.modules.workboards.models import WorkboardOpLog
from app.models.dataset import DatasetTable
from app.modules.workboards.models import Workboard
from app.modules.workboards.schemas import LayoutJson, RelatedRecordConfig
from app.modules.workboards.services.rls_service import CallerIdentity
from app.modules.workboards.services import screen_runtime
from app.modules.workboards.services.screen_runtime import (
    _op_request_fingerprint,
    _replay_op_result,
)
from app.modules.workboards.services.table_binding import (
    reassign_legacy_primary_table,
    workboard_table_references,
)


def _entry(**overrides):
    values = {
        "op_id": "op-parent-1",
        "workboard_id": 42,
        "screen_id": "parent-form",
        "actor_key": "app-user:field-worker",
        "request_fingerprint": "fingerprint-1",
        "result_payload": {
            "row": {"ticket_id": "PX000123"},
            "pk": {"ticket_id": "PX000123"},
            "affected_rows": 1,
        },
    }
    values.update(overrides)
    return WorkboardOpLog(**values)


def test_replay_returns_original_parent_key_for_dependent_children():
    result = _replay_op_result(
        _entry(),
        workboard_id=42,
        screen_id="parent-form",
        actor_key="app-user:field-worker",
        request_fingerprint="fingerprint-1",
    )

    assert result["idempotent"] is True
    assert result["pk"] == {"ticket_id": "PX000123"}
    assert result["row"]["ticket_id"] == "PX000123"


@pytest.mark.parametrize(
    ("kwargs", "detail"),
    [
        ({"workboard_id": 99}, "another workboard"),
        ({"screen_id": "other-form"}, "another screen"),
        ({"actor_key": "app-user:other"}, "another user"),
        ({"request_fingerprint": "changed"}, "different values"),
    ],
)
def test_replay_rejects_operation_id_reuse(kwargs, detail):
    with pytest.raises(HTTPException) as exc_info:
        _replay_op_result(
            _entry(),
            workboard_id=kwargs.get("workboard_id", 42),
            screen_id=kwargs.get("screen_id", "parent-form"),
            actor_key=kwargs.get("actor_key", "app-user:field-worker"),
            request_fingerprint=kwargs.get("request_fingerprint", "fingerprint-1"),
        )

    assert exc_info.value.status_code == 409
    assert detail in str(exc_info.value.detail)


def test_request_fingerprint_is_stable_for_json_key_order():
    first = _op_request_fingerprint(
        "child-form",
        {"employee_id": "NV001", "quantity": 120},
        {
            "relation_id": "production-details",
            "parent_screen_id": "parent-form",
            "parent_key_value": "PX000123",
        },
    )
    second = _op_request_fingerprint(
        "child-form",
        {"quantity": 120, "employee_id": "NV001"},
        {
            "parent_key_value": "PX000123",
            "parent_screen_id": "parent-form",
            "relation_id": "production-details",
        },
    )

    assert first == second


def test_replay_without_cached_result_is_not_treated_as_success():
    with pytest.raises(HTTPException) as exc_info:
        _replay_op_result(
            _entry(result_payload=None),
            workboard_id=42,
            screen_id="parent-form",
            actor_key="app-user:field-worker",
            request_fingerprint="fingerprint-1",
        )

    assert exc_info.value.status_code == 409
    assert "not available" in str(exc_info.value.detail)


def _relation_layout(
    *,
    parent_key: str = "parent_id",
    allow_multiple: bool = True,
    delete_behavior: str = "restrict",
):
    return LayoutJson.model_validate(
        {
            "screens": [
                {
                    "id": "parent-form",
                    "kind": "form",
                    "title": "Parent",
                    "table_id": 10,
                    "primary_key_columns": ["parent_id"],
                    "form": {
                        "fields": [],
                        "related_records": [
                            {
                                "id": "children",
                                "child_screen_id": "child-form",
                                "parent_key_column": parent_key,
                                "child_foreign_key_column": "parent_id",
                                "allow_multiple": allow_multiple,
                                "delete_behavior": delete_behavior,
                            }
                        ],
                    },
                },
                {
                    "id": "child-form",
                    "kind": "form",
                    "title": "Child",
                    "table_id": 20,
                    "primary_key_columns": ["child_id"],
                    "form": {"fields": []},
                },
            ]
        }
    )


def test_relation_parent_key_must_be_a_declared_primary_key():
    layout = _relation_layout(parent_key="display_name")
    with pytest.raises(HTTPException) as exc_info:
        screen_runtime._resolve_relation_bound_values(
            object(),
            Workboard(id=1),
            layout,
            layout.screens[1],
            {
                "relation_id": "children",
                "parent_screen_id": "parent-form",
                "parent_key_value": "duplicate-name",
            },
            CallerIdentity(appbi_user_id="owner"),
        )

    assert exc_info.value.status_code == 400
    assert "primary_key_columns" in str(exc_info.value.detail)


def test_single_child_relation_rejects_a_second_insert_after_parent_check(monkeypatch):
    layout = _relation_layout(allow_multiple=False)
    tables = {
        10: DatasetTable(
            id=10,
            dataset_id=1,
            source_kind="physical_table",
            columns_cache=[{"name": "parent_id", "is_primary_key": True}],
        ),
        20: DatasetTable(
            id=20,
            dataset_id=1,
            source_kind="physical_table",
            columns_cache=[
                {"name": "child_id", "is_primary_key": True},
                {"name": "parent_id"},
            ],
        ),
    }
    monkeypatch.setattr(screen_runtime, "_load_table", lambda _db, table_id: tables[table_id])
    monkeypatch.setattr(screen_runtime, "_load_datasource", lambda _db, _table: object())
    monkeypatch.setattr(
        screen_runtime.LiveQueryService,
        "execute_preview_query",
        lambda *_args, **_kwargs: {"rows": [{"parent_id": "P-1"}]},
    )

    with pytest.raises(HTTPException) as exc_info:
        screen_runtime._resolve_relation_bound_values(
            object(),
            Workboard(id=1),
            layout,
            layout.screens[1],
            {
                "relation_id": "children",
                "parent_screen_id": "parent-form",
                "parent_key_value": "P-1",
            },
            CallerIdentity(appbi_user_id="owner"),
            enforce_cardinality=True,
        )

    assert exc_info.value.status_code == 409
    assert "only one child" in str(exc_info.value.detail)


def test_screen_write_routes_to_target_table_without_mutating_legacy_primary(monkeypatch):
    layout = _relation_layout()
    screen = layout.screens[1]
    workboard = Workboard(
        id=7,
        dataset_id=1,
        primary_table_id=10,
        primary_key_columns=["parent_id"],
        layout_json=layout.model_dump(mode="json"),
    )
    captured = {}
    monkeypatch.setattr(screen_runtime, "media_cap_kb", lambda *_args: 1024)
    monkeypatch.setattr(
        screen_runtime, "_apply_field_conditions", lambda _screen, values, *_args, **_kwargs: values
    )
    monkeypatch.setattr(
        screen_runtime, "enforce_write_access", lambda *_args, row_values, **_kwargs: row_values
    )
    monkeypatch.setattr(screen_runtime, "_apply_geocode", lambda _screen, values: values)

    def fake_insert(_db, _workboard, values, _user, **kwargs):
        captured.update(kwargs)
        return {"row": values, "pk": {"child_id": "C-1"}, "affected_rows": 1}

    monkeypatch.setattr(screen_runtime.WorkboardWriteService, "insert_row", fake_insert)
    result = screen_runtime.insert_screen_row(
        object(),
        workboard,
        screen,
        {"child_id": "C-1"},
        identity=CallerIdentity(appbi_user_id="owner"),
    )

    assert result["pk"] == {"child_id": "C-1"}
    assert captured == {
        "target_table_id": 20,
        "primary_key_columns": ["child_id"],
    }
    assert workboard.primary_table_id == 10
    assert workboard.primary_key_columns == ["parent_id"]


def test_open_related_records_uses_server_row_and_rls_for_existing_parent(monkeypatch):
    raw = _relation_layout().model_dump(mode="json")
    raw["screens"].append(
        {
            "id": "parent-table",
            "kind": "table",
            "title": "Parents",
            "table_id": 10,
            "primary_key_columns": ["parent_id"],
            "table": {
                "columns": ["parent_id", "tenant_id"],
                "row_actions": [
                    {
                        "id": "open-children",
                        "label": "Children",
                        "action_type": "open_related_records",
                        "relation_id": "children",
                        "parent_screen_id": "parent-form",
                    }
                ],
            },
        }
    )
    layout = LayoutJson.model_validate(raw)
    workboard = Workboard(
        id=9,
        dataset_id=1,
        primary_table_id=10,
        primary_key_columns=["parent_id"],
        layout_json=layout.model_dump(mode="json"),
    )
    tables = {
        10: DatasetTable(
            id=10,
            dataset_id=1,
            source_kind="physical_table",
            columns_cache=[
                {"name": "parent_id", "is_primary_key": True},
                {"name": "tenant_id"},
            ],
        ),
        20: DatasetTable(
            id=20,
            dataset_id=1,
            source_kind="physical_table",
            columns_cache=[
                {"name": "child_id", "is_primary_key": True},
                {"name": "parent_id"},
            ],
        ),
    }
    query_filters = []
    monkeypatch.setattr(screen_runtime, "_load_table", lambda _db, table_id: tables[table_id])
    monkeypatch.setattr(screen_runtime, "_load_datasource", lambda _db, _table: object())
    monkeypatch.setattr(
        screen_runtime,
        "build_rls_filter",
        lambda *_args: (
            [{"field": "tenant_id", "operator": "eq", "value": "TENANT-1"}],
            True,
        ),
    )

    def fake_query(_datasource, _table, **kwargs):
        query_filters.append(kwargs["filters"])
        return {"rows": [{"parent_id": "P-1", "tenant_id": "TENANT-1"}]}

    monkeypatch.setattr(
        screen_runtime.LiveQueryService,
        "execute_preview_query",
        fake_query,
    )
    result = screen_runtime.open_related_records_context(
        object(),
        workboard,
        layout.screens[2],
        action_id="open-children",
        pk={"parent_id": "P-1"},
        identity=CallerIdentity(appbi_user_id="owner"),
    )

    assert result["child_screen_id"] == "child-form"
    assert result["relation_context"]["parent_key_value"] == "P-1"
    assert all(
        any(item.get("field") == "tenant_id" for item in filters)
        for filters in query_filters
    )


@pytest.mark.parametrize(
    ("behavior", "write_method", "expected_values"),
    [
        ("cascade", "delete_row", None),
        ("unlink", "update_row", {"parent_id": None}),
    ],
)
def test_parent_delete_behavior_executes_authorized_child_plan(
    monkeypatch, behavior, write_method, expected_values
):
    layout = _relation_layout(delete_behavior=behavior)
    child_table = DatasetTable(
        id=20,
        dataset_id=1,
        source_kind="physical_table",
        columns_cache=[
            {"name": "child_id", "is_primary_key": True},
            {"name": "parent_id"},
        ],
    )
    monkeypatch.setattr(
        screen_runtime,
        "_load_table",
        lambda _db, table_id: child_table if table_id == 20 else None,
    )
    monkeypatch.setattr(screen_runtime, "_load_datasource", lambda _db, _table: object())
    monkeypatch.setattr(
        screen_runtime.LiveQueryService,
        "execute_preview_query",
        lambda *_args, **_kwargs: {
            "rows": [{"child_id": "C-1", "parent_id": "P-1"}]
        },
    )
    writes = []

    def fake_write(*args, **kwargs):
        writes.append((args, kwargs))
        return {"affected_rows": 1}

    monkeypatch.setattr(
        screen_runtime.WorkboardWriteService,
        write_method,
        fake_write,
    )
    screen_runtime._apply_parent_relation_delete_behaviors(
        object(),
        Workboard(id=1),
        layout,
        parent_table_id=10,
        parent_row={"parent_id": "P-1"},
        identity=CallerIdentity(appbi_user_id="owner"),
        delete_stack={(10, '{"parent_id": "P-1"}')},
    )

    assert len(writes) == 1
    assert writes[0][1]["target_table_id"] == 20
    if expected_values is not None:
        assert writes[0][0][3] == expected_values


def test_parent_delete_restrict_stops_before_child_write(monkeypatch):
    layout = _relation_layout(delete_behavior="restrict")
    child_table = DatasetTable(
        id=20,
        dataset_id=1,
        source_kind="physical_table",
        columns_cache=[
            {"name": "child_id", "is_primary_key": True},
            {"name": "parent_id"},
        ],
    )
    monkeypatch.setattr(screen_runtime, "_load_table", lambda *_args: child_table)
    monkeypatch.setattr(screen_runtime, "_load_datasource", lambda *_args: object())
    monkeypatch.setattr(
        screen_runtime.LiveQueryService,
        "execute_preview_query",
        lambda *_args, **_kwargs: {
            "rows": [{"child_id": "C-1", "parent_id": "P-1"}]
        },
    )

    with pytest.raises(HTTPException) as exc_info:
        screen_runtime._apply_parent_relation_delete_behaviors(
            object(),
            Workboard(id=1),
            layout,
            parent_table_id=10,
            parent_row={"parent_id": "P-1"},
            identity=CallerIdentity(appbi_user_id="owner"),
            delete_stack={(10, '{"parent_id": "P-1"}')},
        )

    assert exc_info.value.status_code == 409
    assert "still has 1 child" in str(exc_info.value.detail)


def test_hidden_primary_anchor_is_reassigned_but_real_layout_references_block():
    workboard = Workboard(
        id=8,
        dataset_id=1,
        primary_table_id=10,
        primary_key_columns=["legacy_id"],
        is_published=True,
        layout_json={
            "screens": [
                {
                    "id": "child",
                    "kind": "form",
                    "title": "Child",
                    "table_id": 20,
                }
            ]
        },
        published_layout_json={"screens": []},
        lookup_tables=[],
        published_runtime_config={
            "schema_version": 1,
            "binding": {
                "dataset_id": 1,
                "primary_table_id": 10,
                "primary_key_columns": ["legacy_id"],
                "lookup_tables": [],
            },
        },
    )
    replacement = DatasetTable(
        id=20,
        dataset_id=1,
        source_kind="physical_table",
        columns_cache=[{"name": "child_id", "is_primary_key": True}],
    )

    assert workboard_table_references(workboard, 10) == []
    reassign_legacy_primary_table(workboard, replacement)
    assert workboard.primary_table_id == 20
    assert workboard.primary_key_columns == ["child_id"]
    assert workboard.published_runtime_config["binding"]["primary_table_id"] == 20

    workboard.layout_json = {
        "screens": [
            {
                "id": "legacy",
                "kind": "table",
                "title": "Legacy",
                "table_id": 10,
            }
        ]
    }
    assert "layout.screens[0].table_id" in workboard_table_references(workboard, 10)


@pytest.mark.parametrize("behavior", ["restrict", "cascade", "unlink"])
def test_delete_behavior_contract_round_trips(behavior):
    relation = RelatedRecordConfig(
        id="children",
        child_screen_id="child-form",
        parent_key_column="parent_id",
        child_foreign_key_column="parent_id",
        delete_behavior=behavior,
    )
    assert relation.model_dump()["delete_behavior"] == behavior
