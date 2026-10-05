"""Dashboard parameter semantics — ONE definition, applied on every surface.

A published report must not change its numbers because it moved from the
Builder to a public page or an embed. Three parameter mechanisms exist and the
public runtime used to apply none of them:

1. **Tile instance parameters** — a chart declares parameters
   (``ChartParameter``: name + ``column_mapping``); each tile stores the values
   the AUTHOR chose (``DashboardChart.parameters``). The Builder turns them into
   filters on that tile (``frontend/src/lib/chart-instance-parameters.ts``).
   They are author-owned: a viewer cannot change them.
2. **Field-bound switcher** — a ``parameter_switcher`` widget with a ``field``:
   the selected option filters every chart on the page (``field IN [value]``,
   filter id ``param-<name>``). The viewer switches it; the author decides the
   field and the options.
3. **What-if binding** — a tile binds its dimension/metric to a switcher
   (``parameters.__whatifBindings``); the selected option (a field name)
   replaces that role at query time (``role_overrides``).

What the server accepts from a public viewer is exactly what the author's
controls can produce — nothing wider:

* a switcher filter must name that switcher's field (bare or qualified by a
  view), use ``in`` with ONE value that is one of its options;
* a what-if override must be a role this tile is bound for, and a value that is
  one of the bound switcher's options.

``tests/test_dashboard_parameter_parity.py`` runs the Python half of (1) and the
TypeScript half against the same vectors (``fixtures/instance_parameter_vectors.json``).
"""
from __future__ import annotations

import math
import re
from dataclasses import dataclass, field
from typing import Any, Iterable

from app.services.dashboard_service import is_draft_only_item

PARAM_FILTER_PREFIX = "param-"
WHATIF_KEY = "__whatifBindings"
WHATIF_ROLES = ("dimension", "metric")

NUMERIC_MAPPING_TYPES = frozenset({"number", "integer", "float", "double", "decimal", "numeric", "bigint", "int"})
DATE_MAPPING_TYPES = frozenset({"date", "datetime", "timestamp", "time"})


class ParameterRefused(ValueError):
    """A viewer sent a parameter value no author control can produce."""


@dataclass(frozen=True)
class SwitcherDef:
    name: str
    field: str | None
    options: tuple[str, ...]
    default: str | None = None


@dataclass
class DashboardParameters:
    switchers: dict[str, SwitcherDef] = field(default_factory=dict)

    def option_fields_of_bound_params(self, dashboard_charts: Iterable[Any]) -> set[str]:
        """Field names a what-if switch can swap in (they are read by charts)."""
        bound = {b["param"] for dc in dashboard_charts for b in whatif_bindings(dc)}
        out: set[str] = set()
        for name in bound:
            d = self.switchers.get(name)
            if d:
                out.update(o for o in d.options if o)
        return out


# ── definitions ──────────────────────────────────────────────────────────────

def _published(dashboard_charts: Iterable[Any]) -> list[Any]:
    return [dc for dc in (dashboard_charts or []) if not is_draft_only_item(dc)]


def dashboard_parameters(dashboard_charts: Iterable[Any], *, include_drafts: bool = False) -> DashboardParameters:
    """The switchers of the PUBLISHED report (mirrors ``extractParamDefs``).
    ``include_drafts`` is for the editor's own view of its draft."""
    out = DashboardParameters()
    rows = list(dashboard_charts or []) if include_drafts else _published(dashboard_charts)
    for dc in rows:
        if getattr(dc, "widget_type", None) != "parameter_switcher":
            continue
        cfg = getattr(dc, "widget_config", None) or {}
        if not isinstance(cfg, dict):
            continue
        name = str(cfg.get("paramName") or "").strip()
        if not name or name in out.switchers:
            continue
        opts = cfg.get("options") if isinstance(cfg.get("options"), list) else []
        values = tuple(str(o.get("value")) for o in opts if isinstance(o, dict) and o.get("value") is not None)
        fld = str(cfg.get("field") or "").strip() or None
        default = str(cfg["default"]) if cfg.get("default") is not None else None
        out.switchers[name] = SwitcherDef(name=name, field=fld, options=values, default=default)
    return out


def whatif_bindings(dc: Any) -> list[dict]:
    params = getattr(dc, "parameters", None) or {}
    raw = params.get(WHATIF_KEY) if isinstance(params, dict) else None
    if not isinstance(raw, list):
        return []
    return [
        {"param": str(b["param"]), "role": b["role"]}
        for b in raw
        if isinstance(b, dict) and b.get("param") and b.get("role") in WHATIF_ROLES
    ]


# ── (2) switcher filters ─────────────────────────────────────────────────────

def _binding_of(dc: Any) -> dict:
    chart = dc.get("chart") if isinstance(dc, dict) else getattr(dc, "chart", None)
    cfg = (chart.get("config") if isinstance(chart, dict) else getattr(chart, "config", None)) if chart else None
    sb = cfg.get("semanticBinding") if isinstance(cfg, dict) else None
    return sb if isinstance(sb, dict) else {}


def resolve_switcher_fields(dashboard_charts: Iterable[Any], *, include_drafts: bool = False) -> dict[str, dict]:
    """The column each field-bound switcher filters, as the identity the query
    engine needs: ``{paramName: {field, semanticField?, fieldKey?, datasetId?}}``.

    Decided HERE, once, and served to BOTH the Builder and every public surface
    (``parameter_fields`` on the dashboard response); the frontend's
    ``paramsToFilters`` uses it as is. The Builder used to resolve a switcher's
    free-text field on its own (first matching column in its own ordering), so
    the same report could filter a different column on another surface.

    Deterministic: the first match by precedence — the exact semantic ref, the
    chart's own ``fieldMap`` entry, its base view's column, then any reachable
    ``<view>.<field>`` — scanning the report's charts in tile order. A field no
    chart binding knows (a non-semantic dataset) stays the bare column name.
    """
    rows = list(dashboard_charts or []) if include_drafts else _published(dashboard_charts)
    params = dashboard_parameters(rows, include_drafts=True)
    bindings = [(b, b.get("datasetId")) for b in (_binding_of(dc) for dc in rows) if b]

    def _candidates(b: dict) -> list[str]:
        cands = b.get("reachableFields") or b.get("dimensionFields") or list((b.get("fieldMap") or {}).values())
        return [str(c).strip() for c in cands if isinstance(c, str) and str(c).strip()]

    out: dict[str, dict] = {}
    for name, d in params.switchers.items():
        if not d.field:
            continue
        raw = d.field
        found: tuple[str, Any] | None = None
        rules = (
            lambda b, c: c == raw,
            lambda b, c: (b.get("fieldMap") or {}).get(raw) == c,
            lambda b, c: bool(b.get("baseViewName")) and c == f"{b.get('baseViewName')}.{raw}",
            lambda b, c: "." not in raw and c.endswith("." + raw),
        )
        for rule in rules:
            for b, ds in bindings:
                hit = next((c for c in _candidates(b) if rule(b, c)), None)
                if hit:
                    found = (hit, ds)
                    break
            if found:
                break
        if found:
            ref, ds = found
            entry = {"field": ref.rsplit(".", 1)[-1], "semanticField": ref, "fieldKey": ref}
            if isinstance(ds, int):
                entry["datasetId"] = ds
            out[name] = entry
        else:
            out[name] = {"field": raw}
    return out


# ── switcher filters from a viewer ──────────────────────────────────────────

def _names(entry: dict) -> list[str]:
    names = [entry.get(k) for k in ("semanticField", "fieldKey", "field")]
    names += list(entry.get("linkedFields") or [])
    return [str(n).strip() for n in names if isinstance(n, str) and str(n).strip()]


def _same_column(name: str, declared: str) -> bool:
    """`declared` itself, or `declared` qualified by a view (`view.declared`), or
    — when `declared` is qualified — its bare column. The Builder resolves a
    switcher's field to the column's semantic identity; nothing else."""
    if name == declared:
        return True
    bare = declared.rsplit(".", 1)[-1]
    return name == bare or (name.count(".") == 1 and name.rsplit(".", 1)[-1] == bare and "." not in declared)


def split_switcher_filters(
    viewer_filters: list[dict],
    params: DashboardParameters,
    resolved: dict[str, dict] | None = None,
) -> tuple[list[dict], list[dict]]:
    """(validated switcher filters, everything else). Raises ParameterRefused for
    an entry that claims to be a switcher's but is not one it can produce."""
    switcher: list[dict] = []
    rest: list[dict] = []
    for entry in viewer_filters or []:
        fid = str(entry.get("id") or "") if isinstance(entry, dict) else ""
        if not fid.startswith(PARAM_FILTER_PREFIX):
            rest.append(entry)
            continue
        name = fid[len(PARAM_FILTER_PREFIX):]
        d = params.switchers.get(name)
        if d is None or not d.field:
            raise ParameterRefused(f"Unknown report parameter '{name}'.")
        names = _names(entry)
        res = (resolved or {}).get(name) or {}
        allowed = {str(v) for v in (res.get("semanticField"), res.get("fieldKey"), res.get("field"), d.field) if v}
        if not names or not all(n in allowed or (not res and _same_column(n, d.field)) for n in names):
            raise ParameterRefused(f"Parameter '{name}' filters a field it does not control.")
        value = entry.get("value")
        if str(entry.get("operator") or "").lower() != "in" or not isinstance(value, list) or len(value) != 1:
            raise ParameterRefused(f"Parameter '{name}' takes exactly one of its options.")
        if str(value[0]) not in d.options:
            raise ParameterRefused(f"'{value[0]}' is not an option of parameter '{name}'.")
        clean = {k: entry[k] for k in ("id", "field", "semanticField", "fieldKey", "datasetId", "type", "label") if k in entry}
        clean.update(operator="in", value=[str(value[0])])
        switcher.append(clean)
    return switcher, rest


# ── (3) what-if overrides from a viewer ─────────────────────────────────────

def validate_role_overrides(dc: Any, overrides: dict | None, params: DashboardParameters) -> dict | None:
    """The overrides a viewer may apply to THIS tile, or ParameterRefused."""
    if not overrides:
        return None
    if not isinstance(overrides, dict):
        raise ParameterRefused("Parameter overrides must be an object.")
    bound = {b["role"]: b["param"] for b in whatif_bindings(dc)}
    out: dict[str, str] = {}
    for role, value in overrides.items():
        if role not in WHATIF_ROLES:
            raise ParameterRefused(f"Unknown parameter role '{role}'.")
        param = bound.get(role)
        if param is None:
            raise ParameterRefused(f"This chart's {role} is not bound to a parameter.")
        d = params.switchers.get(param)
        text = str(value or "").strip()
        if d is None or text not in d.options:
            raise ParameterRefused(f"'{text}' is not an option of parameter '{param}'.")
        out[role] = text
    return out or None


# ── (1) tile instance parameters ─────────────────────────────────────────────

_JS_NUMBER = re.compile(r"^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$")


def _js_number(text: str) -> float | int | None:
    """JavaScript ``Number(text)`` for the inputs a parameter value can hold:
    decimal / exponent / Infinity-free. ``0x``/``0b``/``0o`` prefixes as JS.
    Returns None where JS would give NaN or ±Infinity (Number.isFinite false)."""
    t = text.strip()
    if t == "":
        return 0
    low = t.lower()
    try:
        if low.startswith(("0x", "0b", "0o")) and len(t) > 2:
            return int(t, 0)
    except ValueError:
        return None
    if not _JS_NUMBER.match(t):
        return None
    num = float(t)
    if not math.isfinite(num):
        return None
    return int(num) if num.is_integer() and "e" not in low and "." not in t else num


def mapping_type(param: Any) -> str:
    cm = _get(param, "column_mapping") or {}
    mt = str((cm.get("type") if isinstance(cm, dict) else "") or "").lower()
    if mt and mt != "string":
        return mt
    pt = str(_get(param, "parameter_type") or "").lower()
    if pt == "time_range":
        return "date"
    if pt == "measure":
        return "number"
    return mt or "string"


def coerce_atom(raw: Any, mtype: str) -> Any:
    if raw is None:
        return raw
    if mtype in NUMERIC_MAPPING_TYPES:
        if isinstance(raw, (int, float)) and not isinstance(raw, bool):
            return raw if math.isfinite(raw) else str(raw)
        num = _js_number(str(raw))
        return num if num is not None else str(raw).strip()
    return raw.strip() if isinstance(raw, str) else raw


def _get(obj: Any, key: str) -> Any:
    return obj.get(key) if isinstance(obj, dict) else getattr(obj, key, None)


def instance_parameter_filters(chart_parameters: Iterable[Any] | None, values: dict | None) -> list[dict]:
    """The filters a tile's author-set parameter values impose (mirrors
    ``buildInstanceParameterFilters`` in the frontend, vector for vector)."""
    if not chart_parameters or not isinstance(values, dict) or not values:
        return []
    out: list[dict] = []
    for param in chart_parameters:
        cm = _get(param, "column_mapping") or {}
        column = cm.get("column") if isinstance(cm, dict) else None
        name = _get(param, "parameter_name")
        if not column or name is None or name not in values:
            continue
        raw = values[name]
        if raw is None:
            continue
        mtype = mapping_type(param)
        is_date = mtype in DATE_MAPPING_TYPES
        text = raw.strip() if isinstance(raw, str) else ""
        if isinstance(raw, str) and not text:
            continue
        if isinstance(raw, str) and (".." in text or (is_date and "," in text)):
            parts = [p.strip() for p in (text.split("..") if ".." in text else text.split(","))]
            parts = [p for p in parts if p]
            if parts:
                lo = coerce_atom(parts[0], mtype) if len(parts) > 0 and parts[0] else None
                hi = coerce_atom(parts[1], mtype) if len(parts) > 1 and parts[1] else None
                out.append({"field": column, "operator": "between", "value": [lo, hi]})
                continue
        if isinstance(raw, list) or (isinstance(raw, str) and "," in text):
            items = raw if isinstance(raw, list) else text.split(",")
            vals = [coerce_atom(str(p).strip(), mtype) for p in items if str(p).strip()]
            if vals:
                out.append({"field": column, "operator": "in", "value": vals})
                continue
        out.append({"field": column, "operator": "eq", "value": coerce_atom(raw, mtype)})
    return out


def tile_instance_filters(dc: Any) -> list[dict]:
    chart = getattr(dc, "chart", None)
    values = getattr(dc, "parameters", None) or {}
    values = {k: v for k, v in values.items() if k != WHATIF_KEY} if isinstance(values, dict) else {}
    return instance_parameter_filters(getattr(chart, "parameters", None) if chart is not None else None, values)
