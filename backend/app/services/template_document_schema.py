"""Helpers for the clean-slate template document schema."""

from __future__ import annotations

from copy import deepcopy
from typing import Any, Dict, List


_DEFAULT_PAGE = {
    "size": "A4",
    "orientation": "portrait",
    "margin": {"top": 24, "right": 24, "bottom": 24, "left": 24},
}

_DEFAULT_THEME = {
    "palette": {
        "primary": "#0f172a",
        "accent": "#2563eb",
        "surface": "#ffffff",
        "muted": "#e2e8f0",
        "text": "#0f172a",
        "subtleText": "#475569",
    },
    "typography": {
        "headingFont": "var(--font-sans)",
        "bodyFont": "var(--font-sans)",
    },
    "spacing": {"blockGap": 16, "sectionGap": 24},
}

_DEFAULT_MODES = {
    "default": "design",
    "available": ["design", "bind", "entry", "preview", "publish", "share"],
}

_DEFAULT_ROOT = {
    "id": "root",
    "type": "page",
    "name": "Document Root",
    "children": [
        {
            "id": "section-header",
            "type": "section",
            "name": "Header",
            "children": [],
        },
        {
            "id": "section-body",
            "type": "section",
            "name": "Body",
            "children": [],
        },
    ],
}

_DEFAULT_DOCUMENT = {
    "engine": "document",
    "schemaVersion": 1,
    "page": _DEFAULT_PAGE,
    "theme": _DEFAULT_THEME,
    "modes": _DEFAULT_MODES,
    "dataSources": [],
    "root": _DEFAULT_ROOT,
}


def create_default_template_document() -> Dict[str, Any]:
    """Return the default clean-slate template document payload."""
    return deepcopy(_DEFAULT_DOCUMENT)


def is_template_document_definition(value: Any) -> bool:
    """Return True when the payload uses the clean-slate document engine."""
    return isinstance(value, dict) and str(value.get("engine") or "").strip().lower() == "document"


def normalize_template_document(value: Any) -> Dict[str, Any]:
    """Validate and normalize a clean-slate template document payload."""
    if not isinstance(value, dict):
        raise ValueError("Template document payload must be an object.")
    if not is_template_document_definition(value):
        raise ValueError("Template document payload must declare engine='document'.")

    normalized = create_default_template_document()
    schema_version = value.get("schemaVersion", normalized["schemaVersion"])
    if not isinstance(schema_version, int) or schema_version < 1:
        raise ValueError("Template document schemaVersion must be a positive integer.")
    normalized["schemaVersion"] = schema_version

    normalized["page"] = _normalize_page(value.get("page"))
    normalized["theme"] = _normalize_theme(value.get("theme"))
    normalized["modes"] = _normalize_modes(value.get("modes"))

    data_sources = value.get("dataSources", [])
    if data_sources is None:
        data_sources = []
    if not isinstance(data_sources, list):
        raise ValueError("Template document dataSources must be a list.")
    normalized["dataSources"] = [dict(item) if isinstance(item, dict) else item for item in data_sources]

    normalized["root"] = _normalize_block(value.get("root") or normalized["root"], is_root=True)
    return normalized


def _normalize_page(value: Any) -> Dict[str, Any]:
    normalized = deepcopy(_DEFAULT_PAGE)
    if value is None:
        return normalized
    if not isinstance(value, dict):
        raise ValueError("Template document page must be an object.")

    size = str(value.get("size") or normalized["size"]).strip() or normalized["size"]
    orientation = str(value.get("orientation") or normalized["orientation"]).strip().lower()
    if orientation not in {"portrait", "landscape"}:
        orientation = normalized["orientation"]

    margin = value.get("margin") or {}
    if not isinstance(margin, dict):
        raise ValueError("Template document page.margin must be an object.")
    normalized_margin = {}
    for key, default in normalized["margin"].items():
        candidate = margin.get(key, default)
        if not isinstance(candidate, (int, float)):
            candidate = default
        normalized_margin[key] = max(int(candidate), 0)

    normalized["size"] = size
    normalized["orientation"] = orientation
    normalized["margin"] = normalized_margin
    return normalized


def _normalize_theme(value: Any) -> Dict[str, Any]:
    normalized = deepcopy(_DEFAULT_THEME)
    if value is None:
        return normalized
    if not isinstance(value, dict):
        raise ValueError("Template document theme must be an object.")

    for section_name in ("palette", "typography", "spacing"):
        section = value.get(section_name)
        if section is None:
            continue
        if not isinstance(section, dict):
            raise ValueError(f"Template document theme.{section_name} must be an object.")
        normalized[section_name] = {**normalized[section_name], **section}
    return normalized


def _normalize_modes(value: Any) -> Dict[str, Any]:
    normalized = deepcopy(_DEFAULT_MODES)
    if value is None:
        return normalized
    if not isinstance(value, dict):
        raise ValueError("Template document modes must be an object.")

    available = value.get("available", normalized["available"])
    if not isinstance(available, list) or not available:
        raise ValueError("Template document modes.available must be a non-empty list.")
    normalized_available: List[str] = []
    for item in available:
        name = str(item or "").strip().lower()
        if name and name not in normalized_available:
            normalized_available.append(name)
    if not normalized_available:
        raise ValueError("Template document modes.available must contain at least one mode.")

    default_mode = str(value.get("default") or normalized["default"]).strip().lower()
    if default_mode not in normalized_available:
        default_mode = normalized_available[0]

    normalized["available"] = normalized_available
    normalized["default"] = default_mode
    return normalized


def _normalize_block(value: Any, *, is_root: bool = False) -> Dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError("Template document blocks must be objects.")

    normalized = dict(value)
    block_type = str(normalized.get("type") or ("page" if is_root else "section")).strip().lower()
    if not block_type:
        raise ValueError("Template document blocks require a type.")
    if is_root and block_type != "page":
        raise ValueError("Template document root block must use type='page'.")

    block_id = str(normalized.get("id") or ("root" if is_root else "")).strip()
    if not block_id:
        raise ValueError("Template document blocks require an id.")

    children = normalized.get("children", [])
    if children is None:
        children = []
    if not isinstance(children, list):
        raise ValueError("Template document block children must be a list.")

    normalized["id"] = block_id
    normalized["type"] = block_type
    normalized["children"] = [_normalize_block(child) for child in children]
    normalized["name"] = str(normalized.get("name") or normalized["type"]).strip() or normalized["type"]
    return normalized