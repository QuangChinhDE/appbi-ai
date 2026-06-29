"""Phase-A (PBI-parity rework) — unit tests for filter_entry Pydantic models.

Confirms defaults, parsing tolerance, and camelCase field names match
what the FE sends.
"""

import os
os.environ.setdefault("DATABASE_URL", "postgresql://stub@localhost/stub")

from app.schemas.filter_entry import (
    FilterEntry,
    SlicerEntry,
    PublicLinkFilterEntry,
    parse_filter_entry,
    parse_filter_list,
    parse_slicer_list,
    parse_public_link_filter_list,
)


def test_filter_entry_defaults():
    """publicMode='visible', allowOverride=False, showBanner=True by default."""
    f = FilterEntry(field="region", value=["North"])
    assert f.publicMode == "visible"
    assert f.allowOverride is False
    assert f.showBanner is True
    assert f.operator == "in"


def test_filter_entry_accepts_locked_mode():
    """publicMode='locked' is accepted."""
    f = FilterEntry(field="date", value="2026", publicMode="locked", showBanner=False)
    assert f.publicMode == "locked"
    assert f.showBanner is False


def test_filter_entry_accepts_hidden_mode():
    """publicMode='hidden' is accepted."""
    f = FilterEntry(field="secret", value="x", publicMode="hidden")
    assert f.publicMode == "hidden"


def test_filter_entry_extra_fields_allowed():
    """Unknown extra fields don't fail validation (extra='allow')."""
    f = FilterEntry(field="x", value="y", linkedFields=["a", "b"], customKey="hello")
    assert f.field == "x"
    # extra survives — Pydantic v2 with extra='allow' keeps them
    assert getattr(f, "linkedFields", None) == ["a", "b"]


def test_slicer_entry_has_no_publicMode():
    """SlicerEntry shape doesn't include publicMode — slicers are always visible."""
    s = SlicerEntry(field="region", value=["North"])
    # Pydantic doesn't expose publicMode by default since it's not defined
    # on SlicerEntry — extra='allow' lets it through if explicitly set.
    assert not hasattr(s, "publicMode") or s.publicMode is None  # type: ignore[attr-defined]


def test_public_link_filter_entry_hidden_default_false():
    p = PublicLinkFilterEntry(field="region", value="North")
    assert p.hidden is False


def test_public_link_filter_entry_hidden_marker():
    p = PublicLinkFilterEntry(field="year", hidden=True)
    assert p.hidden is True


def test_parse_filter_entry_returns_none_for_non_dict():
    assert parse_filter_entry("not-a-dict") is None  # type: ignore[arg-type]
    assert parse_filter_entry(None) is None  # type: ignore[arg-type]
    assert parse_filter_entry({}) is None  # missing required `field`


def test_parse_filter_list_drops_invalid_entries():
    """Each invalid entry is dropped; valid entries pass through."""
    items = [
        {"field": "a", "value": 1},
        {"no_field_here": True},
        {"field": "b", "value": 2, "publicMode": "locked"},
        None,
        "not-a-dict",
    ]
    parsed = parse_filter_list(items)
    assert len(parsed) == 2
    assert parsed[0].field == "a"
    assert parsed[1].field == "b"
    assert parsed[1].publicMode == "locked"


def test_parse_slicer_list():
    items = [
        {"field": "region"},
        {"field": "date", "operator": "between", "value": ["2026-01-01", "2026-12-31"]},
    ]
    parsed = parse_slicer_list(items)
    assert len(parsed) == 2
    assert parsed[1].operator == "between"


def test_parse_public_link_filter_list_splits_locked_vs_hidden():
    items = [
        {"field": "region", "value": "North"},
        {"field": "year", "hidden": True},
    ]
    parsed = parse_public_link_filter_list(items)
    assert len(parsed) == 2
    locked = [e for e in parsed if not e.hidden]
    hidden = [e for e in parsed if e.hidden]
    assert len(locked) == 1 and locked[0].field == "region"
    assert len(hidden) == 1 and hidden[0].field == "year"
