import os
import sys
from pathlib import Path

import pytest
from fastapi import HTTPException

os.environ.setdefault("DATABASE_URL", "sqlite:///./test_workboard_offline_relation_phase2.db")
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.modules.workboards.models import WorkboardOpLog
from app.modules.workboards.services.screen_runtime import (
    _op_request_fingerprint,
    _replay_op_result,
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
