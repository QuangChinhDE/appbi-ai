"""What stored public links do under the V3 filter authority — for a deploy check.

Two V3 changes can change what an EXISTING link returns:

  * a link entry the engine cannot apply (``between 5``) now refuses the link
    (409) instead of silently serving unconstrained data;
  * a link's lock no longer REPLACES a page filter or a 🔒/🚫 report filter on
    the same field — the two AND. A lock whose values the author's boundary does
    not allow now returns no rows on that page.

``audit_link`` reports both, per link, from the stored configuration only (no
warehouse query). Read-only: remediation is the report owner's decision.
"""
from __future__ import annotations

from typing import Any, Dict, Iterable, List, Optional

from app.services.filter_layered_merge import (
    LINK_ENTRY_ENFORCED,
    canonical_link_entry,
    link_entry_is_scope,
    link_entry_state,
    malformed_link_entries,
    split_dashboard_filters_by_public_mode,
)

REFUSED = "refused_malformed"          # every public request under the link → 409
EMPTY = "empty_against_boundary"       # the lock and an author boundary share no value
NARROWED = "narrowed_by_boundary"      # the author boundary now also applies (fewer rows)


def _key(entry: Dict[str, Any]) -> str:
    return str(entry.get("semanticField") or entry.get("field") or "").strip().lower()


def _values(entry: Dict[str, Any]) -> Optional[set[str]]:
    """The value set of an equality/``in`` condition; None for any other operator
    (a range or a pattern cannot be compared from configuration alone)."""
    op = str(entry.get("operator") or "in").strip().lower()
    if op not in ("in", "eq", "=", "equals"):
        return None
    v = entry.get("value")
    items = v if isinstance(v, (list, tuple)) else [v]
    out = {str(x) for x in items if x not in (None, "")}
    return out or None


def _author_boundaries(filters_config: Any, pages_config: Any) -> List[Dict[str, Any]]:
    _visible, authoritative = split_dashboard_filters_by_public_mode(list(filters_config or []))
    out = [{**f, "_where": "report"} for f in authoritative]
    for page in pages_config or []:
        if not isinstance(page, dict):
            continue
        for f in page.get("filters") or []:
            if isinstance(f, dict):
                out.append({**f, "_where": f"page {page.get('name') or page.get('id')}"})
    return out


def audit_link(
    link_filters_config: Optional[Iterable[Dict[str, Any]]],
    *,
    filters_config: Any = None,
    pages_config: Any = None,
) -> List[Dict[str, Any]]:
    findings: List[Dict[str, Any]] = []
    entries = [canonical_link_entry(e) for e in (link_filters_config or []) if isinstance(e, dict)]
    for bad in malformed_link_entries(entries):
        findings.append({
            "kind": REFUSED, "field": _key(bad), "operator": bad.get("operator"),
            "remedy": "Open the link in Share → edit the filter so it has a value the engine can apply, or remove it.",
        })
    boundaries = _author_boundaries(filters_config, pages_config)
    for entry in entries:
        if link_entry_is_scope(entry) or link_entry_state(entry) != LINK_ENTRY_ENFORCED:
            continue
        mine = _values(entry)
        for bound in boundaries:
            if _key(bound) != _key(entry) or not _key(entry):
                continue
            theirs = _values(bound)
            if mine is not None and theirs is not None and not (mine & theirs):
                findings.append({
                    "kind": EMPTY, "field": _key(entry), "where": bound["_where"],
                    "remedy": ("The link's value is outside the report's own filter here, so this page now shows no rows. "
                               "Change the link's value, or widen/remove the report filter if the link should see it."),
                })
            else:
                findings.append({
                    "kind": NARROWED, "field": _key(entry), "where": bound["_where"],
                    "remedy": "No action if intended: the report's filter now also applies on this link (it used to be replaced).",
                })
    return findings
