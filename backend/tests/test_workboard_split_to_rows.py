"""FORM multi-select fan-out (split_to_rows).

A form field with widget='enum_list' + split_to_rows explodes each selected
value into its OWN row on submit (one submit -> N rows), copying every other
field onto each row. The primary key is server-generated (auto-number).

These lock the pure planner (``_plan_split_submit`` / ``_parse_split_values``)
and the schema validator. The full insert fan-out reuses ``insert_screen_row``
recursively (per-row auto-number/RLS/computed already covered elsewhere).
"""
import os

os.environ.setdefault("DATABASE_URL", "postgresql://stub@localhost/stub")

import json
import types

import pytest

from app.modules.workboards.schemas import FormScreenSpec, FormField
from app.modules.workboards.services.screen_runtime import (
    _parse_split_values,
    _plan_split_submit,
)


# ── _parse_split_values: tolerate JSON string / list / scalar ──────────────

@pytest.mark.parametrize("raw,expected", [
    (json.dumps(["A", "B", "C"]), ["A", "B", "C"]),   # FE sends a JSON string
    (["A", "B"], ["A", "B"]),                          # raw list
    ("A", ["A"]),                                      # bare scalar
    ("", []),
    ("[]", []),
    (None, []),
    (["A", "", None, "B"], ["A", "B"]),                # blanks dropped
    ('["Sọt A","Sọt B"]', ["Sọt A", "Sọt B"]),          # unicode
])
def test_parse_split_values(raw, expected):
    assert _parse_split_values(raw) == expected


# ── _plan_split_submit: fan-out / single / none ────────────────────────────

def _sf(col="sot"):
    return types.SimpleNamespace(column=col)


def test_plan_fanout_copies_fields_and_overrides_split_col():
    mode, payload = _plan_split_submit(
        {"sot": json.dumps(["A", "B"]), "ngay": "2026-08-03", "nguoi": "u1"},
        _sf(),
        "op-uuid",
    )
    assert mode == "fanout"
    assert [cv for cv, _ in payload] == [
        {"sot": "A", "ngay": "2026-08-03", "nguoi": "u1"},
        {"sot": "B", "ngay": "2026-08-03", "nguoi": "u1"},
    ]


def test_plan_fanout_op_ids_are_distinct_and_deterministic():
    _, payload = _plan_split_submit({"sot": json.dumps(["A", "B", "C"])}, _sf(), "op")
    assert [op for _, op in payload] == ["op:0", "op:1", "op:2"]


def test_plan_fanout_op_ids_none_when_no_client_op():
    _, payload = _plan_split_submit({"sot": ["A", "B"]}, _sf(), None)
    assert [op for _, op in payload] == [None, None]


def test_plan_single_unwraps_scalar():
    assert _plan_split_submit({"sot": json.dumps(["A"])}, _sf(), "op") == ("single", "A")


def test_plan_none_when_empty():
    assert _plan_split_submit({"sot": ""}, _sf(), "op") == ("none", None)
    assert _plan_split_submit({}, _sf(), "op") == ("none", None)


def test_plan_does_not_mutate_input():
    base = {"sot": ["A", "B"], "ngay": "x"}
    _plan_split_submit(base, _sf(), "op")
    assert base == {"sot": ["A", "B"], "ngay": "x"}  # untouched


# ── Schema validator ───────────────────────────────────────────────────────

def test_single_split_field_ok():
    spec = FormScreenSpec(fields=[
        FormField(column="sot", widget="enum_list", split_to_rows=True),
        FormField(column="ngay", widget="date"),
    ])
    assert any(f.split_to_rows for f in spec.fields)


def test_two_split_fields_rejected():
    with pytest.raises(Exception):
        FormScreenSpec(fields=[
            FormField(column="a", widget="enum_list", split_to_rows=True),
            FormField(column="b", widget="enum_list", split_to_rows=True),
        ])


def test_split_on_non_enum_rejected():
    with pytest.raises(Exception):
        FormScreenSpec(fields=[FormField(column="a", widget="text", split_to_rows=True)])


def test_split_defaults_false():
    f = FormField(column="a", widget="enum_list")
    assert f.split_to_rows is False
