"""A signed embed claim keeps its operator.

`validate_and_lock_filters` turns an M2M caller's filters into the link's LOCKED
entries. It normalised a list operator with `op in ("in", "not_in", "eq") → "in"`,
so a claim EXCLUDING a value became a lock to ONLY that value: the embed showed
exactly the rows the caller asked to keep out, and nothing said so.

Locked through to the filter the chart engine receives.
"""
from __future__ import annotations

from types import SimpleNamespace

import pytest

from app.api import public as public_api
from app.services import embed_link_service as svc

FIELDS = [{"field": "customer_state", "semanticField": "t3.customer_state", "datasetId": 7}]


@pytest.fixture(autouse=True)
def _allowed_fields(monkeypatch):
    monkeypatch.setattr(public_api, "_build_public_filter_fields", lambda *_a, **_k: list(FIELDS))


def _lock(op, value):
    return svc.validate_and_lock_filters(None, SimpleNamespace(), [{"field": "customer_state", "operator": op, "value": value}])


def test_an_exclusion_claim_stays_an_exclusion():
    [entry] = _lock("not_in", ["SP"])
    assert entry["operator"] == "not_in" and entry["value"] == ["SP"]


def test_a_list_under_eq_or_in_is_one_of_these():
    assert _lock("eq", ["SP", "RJ"])[0]["operator"] == "in"
    assert _lock("in", ["SP"])[0]["operator"] == "in"


def test_the_chart_engine_receives_the_exclusion():
    locked = _lock("not_in", ["SP"])
    dash = SimpleNamespace(filters_config=[], slicers_config=[], pages_config=[])
    merged = public_api._build_public_chart_filters(dash, locked, [])
    applied = [f for f in merged if (f.get("field") == "customer_state")]
    assert applied and all(f.get("operator") == "not_in" for f in applied), applied


def test_a_bare_name_equal_to_an_unqualified_inventory_ref_is_still_counted_for_ambiguity(monkeypatch):
    """An inventory item without a semanticField is keyed by its bare field; a
    caller's bare `field` equal to it must still be checked for uniqueness, not
    taken as an exact reference (that was the first-match behaviour again)."""
    from fastapi import HTTPException

    inventory = [{"field": "region", "semanticField": None, "datasetId": 7},
                 {"field": "region", "semanticField": "customers.region", "datasetId": 8}]
    monkeypatch.setattr(public_api, "_build_public_filter_fields", lambda *_a, **_k: list(inventory))
    with pytest.raises(HTTPException) as exc:
        svc.validate_and_lock_filters(None, SimpleNamespace(), [{"field": "region", "operator": "in", "value": ["N"]}])
    assert exc.value.status_code == 400 and "ambiguous" in str(exc.value.detail)
    [entry] = svc.validate_and_lock_filters(None, SimpleNamespace(), [
        {"field": "region", "semanticField": "customers.region", "datasetId": 8, "operator": "in", "value": ["N"]}])
    assert entry["semanticField"] == "customers.region" and entry["datasetId"] == 8 and entry["field"] == "region"
