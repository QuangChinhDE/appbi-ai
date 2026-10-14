"""What each Source provider can do (spec: provider capability model, F15).

One table, read by the backend (to refuse a path a provider does not support)
and exposed on the DataSource response (so the frontend filters pickers by it
instead of keeping its own list of type names).

  tabular   holds tables/sheets a Dataset can be built from
  test      has a connection test
  discover  can list schemas / tables / columns
  query     can run an ad-hoc read query
  stream    can stream table/query rows (sync / snapshot extraction)
  write     can write rows back upstream (Sheets / SQL write ops)
  oauth     can connect with a per-source Google account
"""
from __future__ import annotations

from typing import Any, Dict

CAPABILITY_KEYS = ("tabular", "test", "discover", "query", "stream", "write", "oauth")

_CAPS: Dict[str, Dict[str, bool]] = {
    "postgresql":    {"tabular": True,  "test": True, "discover": True,  "query": True,  "stream": True,  "write": True,  "oauth": False},
    "mysql":         {"tabular": True,  "test": True, "discover": True,  "query": True,  "stream": True,  "write": True,  "oauth": False},
    "bigquery":      {"tabular": True,  "test": True, "discover": True,  "query": True,  "stream": True,  "write": False, "oauth": True},
    "google_sheets": {"tabular": True,  "test": True, "discover": True,  "query": True,  "stream": True,  "write": True,  "oauth": True},
    "manual":        {"tabular": True,  "test": True, "discover": True,  "query": True,  "stream": True,  "write": False, "oauth": False},
    # A Google Docs source only carries the Google account Knowledge Docs read
    # through. It has no tables: every tabular path must refuse it.
    "google_docs":   {"tabular": False, "test": True, "discover": False, "query": False, "stream": False, "write": False, "oauth": True},
}

_NONE = {k: False for k in CAPABILITY_KEYS}


class SourceNotTabularError(ValueError):
    """A tabular operation was asked of a provider that has no tables."""

    code = "source_not_tabular"

    def __init__(self, ds_type: str, operation: str = "tabular"):
        self.ds_type = ds_type
        self.operation = operation
        super().__init__(
            f"Nguồn loại '{ds_type}' không chứa bảng dữ liệu, không dùng được cho thao tác này."
        )


def _type_value(ds_type: Any) -> str:
    return str(getattr(ds_type, "value", ds_type) or "").strip().lower()


def capabilities_for(ds_type: Any) -> Dict[str, bool]:
    """Capabilities of a provider; an unknown provider can do nothing."""
    return dict(_CAPS.get(_type_value(ds_type), _NONE))


def supports(ds_type: Any, capability: str) -> bool:
    return bool(capabilities_for(ds_type).get(capability))


def require_capability(ds_type: Any, capability: str = "tabular") -> None:
    """Raise SourceNotTabularError when the provider lacks `capability`."""
    if not supports(ds_type, capability):
        raise SourceNotTabularError(_type_value(ds_type), capability)
