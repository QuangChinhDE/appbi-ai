"""Dashboard planning and execution (spec §5.3).

Every chart proposal goes through AppBI's canonical `POST /charts/dry-run-create`
at plan time; only proposals AppBI accepts enter the plan, stored as AppBI's own
`normalized_config`. Execution creates the charts, adds them as `draftOnly`
tiles (exactly as the Builder does), and stages filters in the shared draft
with `base_rev`. Nothing goes live until a separately approved publish.
"""

import re
from typing import Any, Literal

from pydantic import BaseModel, Field, model_validator

from ..appbi_client import AppbiError
from ..oauth import scopes as sc
from ..operations import OperationError, Run
from .dataset import _ts
from .runtime import Env, tool

GRID_COLS = 36
GRID_VERSION = 2
GRID_FINER = 3
MAX_CHARTS = 24
MAX_FILTERS = 12

ChartType = Literal[
    "BAR", "HORIZONTAL_BAR", "LINE", "PIE", "DONUT", "RADAR", "POLAR_AREA", "TIME_SERIES", "TABLE", "MATRIX",
    "AREA", "STACKED_BAR", "GROUPED_BAR", "BAR_LINE", "SCATTER", "BUBBLE", "HEATMAP", "TREEMAP", "FUNNEL",
    "GAUGE", "WATERFALL", "MAP_POINT", "MAP_REGION", "BOXPLOT", "BULLET", "SANKEY", "SUNBURST", "RIBBON",
    "TIMELINE", "WORD_CLOUD", "KPI", "PODIUM", "NINE_BOX",
]


class ChartStyle(BaseModel):
    """Presentation keys AppBI's renderer honours (config.styleConfig)."""
    dual_axis: bool | None = Field(default=None, description="LINE/TIME_SERIES with 2+ measures: second measure on a right axis. "
                                                             "Default: on when the two measures' scales differ by 5x or more")
    sort: Literal["value_desc", "value_asc", "none"] | None = Field(default=None, description="Bars: order by the first measure. Default value_desc for one-dimension bars")
    top_n: int | None = Field(default=None, ge=1, le=500, description="Keep only the top N categories by the first measure")
    number_format: Literal["auto", "number", "compact", "percent", "currency"] | None = None
    currency_symbol: str | None = Field(default=None, max_length=8)
    decimals: int | None = Field(default=None, ge=0, le=6)


class ChartSpec(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    chart_type: ChartType
    dataset_table_id: int = Field(description="The dataset table the chart is based on (usually the fact table)")
    config: dict[str, Any] = Field(
        description=(
            "AppBI chart config. Fields are '<view>.<field>' as get_dataset lists them. Examples: "
            "KPI {'roleConfig': {'metrics': [{'field': 'dataset_table_1.revenue', 'agg': 'auto'}]}}; "
            "BAR {'roleConfig': {'dimension': 'dataset_table_2.region', 'metrics': [{'field': 'dataset_table_1.revenue', 'agg': 'auto'}]}}; "
            "A metric on a dataset MEASURE always uses agg 'auto' (the measure's own aggregation); "
            "sum/avg/count/... are only for raw columns. "
            "TIME_SERIES {'roleConfig': {'timeField': 'dataset_table_1.order_date', 'timeGrains': {'dataset_table_1.order_date': 'month'}, "
            "'metrics': [...]}} (grains: day, week, month, quarter, year). AppBI validates every config and returns its reasons."
        )
    )
    description: str | None = Field(default=None, max_length=1000)
    style: ChartStyle | None = None
    width: int | None = Field(default=None, ge=4, le=GRID_COLS, description="Tile width on a 36-column grid")
    height: int | None = Field(default=None, ge=3, le=60)


class FilterSpec(BaseModel):
    field: str = Field(pattern=r"^[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*$", description="'<view>.<dimension>'")
    label: str | None = Field(default=None, max_length=120)
    type: Literal["dropdown", "date", "numeric"] = "dropdown"


class DashboardPlanInput(BaseModel):
    dataset_id: int
    dashboard_name: str | None = Field(default=None, max_length=200, description="Name for a NEW dashboard")
    dashboard_id: int | None = Field(default=None, description="Add to this EXISTING dashboard instead")
    description: str | None = Field(default=None, max_length=1000)
    charts: list[ChartSpec] = Field(min_length=1, max_length=MAX_CHARTS)
    filters: list[FilterSpec] = Field(default_factory=list, max_length=MAX_FILTERS)

    @model_validator(mode="after")
    def _target(self) -> "DashboardPlanInput":
        if (self.dashboard_name is None) == (self.dashboard_id is None):
            raise ValueError("give exactly one of dashboard_name (new) or dashboard_id (existing)")
        return self


_METRIC_KEYS = ("metrics", "lineMetric", "benchmarkMetric")


def pin_measure_aggregations(config: dict[str, Any], measure_types: dict[str, str]) -> tuple[dict[str, Any], list[str]]:
    """Make every metric that references a semantic measure use the measure's own
    aggregation (`agg: "auto"`).

    In AppBI an explicit chart agg OVERRIDES the measure's declared type: `sum` on a
    `count_distinct` measure computes SUM of the column, a valid query with a wrong
    number. A planner that copies "sum" everywhere would publish wrong KPIs, so the
    measure's definition wins here and any differing request is reported.
    """
    import copy

    cfg = copy.deepcopy(config)
    notes: list[str] = []
    for container_key in ("roleConfig", "generatedRoleConfig"):
        role = cfg.get(container_key)
        if not isinstance(role, dict):
            continue
        for key in _METRIC_KEYS:
            value = role.get(key)
            items = value if isinstance(value, list) else [value] if isinstance(value, dict) else []
            for m in items:
                field = str(m.get("field") or "")
                if field in measure_types:
                    asked = str(m.get("agg") or "auto").lower()
                    if asked not in ("auto", measure_types[field]):
                        notes.append(
                            f"{field} is a {measure_types[field]} measure; the requested '{asked}' would change its meaning, "
                            "so the measure's own aggregation is used"
                        )
                    m["agg"] = "auto"
    return cfg, notes


_BAR_TYPES = {"BAR", "HORIZONTAL_BAR", "STACKED_BAR", "GROUPED_BAR"}
_LINE_TYPES = {"LINE", "TIME_SERIES"}
DUAL_AXIS_RATIO = 5.0


def _metrics(config: dict[str, Any]) -> list[dict[str, Any]]:
    m = (config.get("roleConfig") or {}).get("metrics")
    return [x for x in (m if isinstance(m, list) else []) if isinstance(x, dict)]


def _series_max(rows: list[dict[str, Any]], field: str) -> float:
    vals = []
    for r in rows:
        for k, v in r.items():
            if (k == field or k.endswith("__" + field)) and isinstance(v, (int, float)):
                vals.append(abs(float(v)))
    return max(vals, default=0.0)


def apply_style(chart_type: str, config: dict[str, Any], style: dict[str, Any] | None,
                preview: list[dict[str, Any]] | None = None) -> tuple[dict[str, Any], list[str]]:
    """Map the plan's style onto config.styleConfig, with defaults that keep charts honest:
    two measures of very different size share no axis (the small one would read as zero),
    one-dimension bars are ordered by value. Returns (config, notes)."""
    import copy

    cfg = copy.deepcopy(config)
    style_cfg = dict(cfg.get("styleConfig") or {})
    st = dict(style or {})
    notes: list[str] = []
    metrics = _metrics(cfg)
    if chart_type in _LINE_TYPES and len(metrics) >= 2:
        dual = st.get("dual_axis")
        if dual is None and preview:
            a, b = _series_max(preview, metrics[0]["field"]), _series_max(preview, metrics[1]["field"])
            dual = min(a, b) > 0 and max(a, b) / min(a, b) >= DUAL_AXIS_RATIO
            if dual:
                notes.append("the second measure is on a right axis (its scale is far smaller than the first)")
        if dual:
            style_cfg["dualYAxis"] = True   # the renderer puts the 2nd series on the right axis
    role = cfg.get("roleConfig") or {}
    one_dim = bool(role.get("dimension")) and not role.get("breakdown") and not role.get("legend")
    sort = st.get("sort") or ("value_desc" if chart_type in _BAR_TYPES and one_dim and metrics else None)
    if sort in ("value_desc", "value_asc") and metrics:
        key = f"{metrics[0].get('agg') or 'auto'}__{metrics[0]['field']}"   # the renderer's metricKey
        style_cfg["chartSortRules"] = [{"field": key, "direction": "desc" if sort == "value_desc" else "asc"}]
    if st.get("top_n"):
        style_cfg["dataLimit"], style_cfg["dataLimitDirection"] = int(st["top_n"]), "top"
    if st.get("number_format"):
        style_cfg["numberFormat"] = st["number_format"]
    if st.get("currency_symbol"):
        style_cfg["currencySymbol"] = st["currency_symbol"]
    if st.get("decimals") is not None:
        style_cfg["decimalPlaces"] = int(st["decimals"])
    if style_cfg:
        cfg["styleConfig"] = style_cfg
    return cfg, notes


def model_fingerprint(model: dict[str, Any]) -> str:
    from ..state import canonical_json, sha256_hex
    from .discovery import model_digest

    return sha256_hex(canonical_json(model_digest(model or {})))


def default_size(chart_type: str) -> tuple[int, int]:
    """Mirror of the Builder's `defaultSizeForChartType` (frontend/src/lib/dashboard-pages.ts)."""
    t = chart_type.lower()
    if t in ("kpi", "card"):
        return 4 * GRID_FINER, 7
    if t == "podium":
        base = (6, 4)
    elif t in ("gauge", "bullet"):
        base = (3, 4)
    elif t in ("table", "matrix"):
        base = (6, 8)
    elif t in ("pie", "donut", "polar_area", "funnel", "word_cloud", "radar"):
        base = (4, 5)
    elif t in ("map_point", "map_region", "sankey", "sunburst", "treemap", "heatmap", "scatter", "bubble", "boxplot"):
        base = (6, 6)
    elif t in ("bar", "horizontal_bar", "line", "area", "time_series", "stacked_bar", "grouped_bar", "bar_line", "waterfall", "ribbon", "timeline"):
        base = (6, 5)
    else:
        base = (4, 4)
    return base[0] * GRID_FINER, base[1] * GRID_FINER


def pack(sizes: list[tuple[int, int]], start_y: int = 0) -> list[dict[str, int]]:
    """Left-to-right rows on the 36-column grid, below any existing content."""
    out = []
    x, y, row_h = 0, start_y, 0
    for w, h in sizes:
        w = min(w, GRID_COLS)
        if x + w > GRID_COLS:
            x, y, row_h = 0, y + row_h, 0
        out.append({"x": x, "y": y, "w": w, "h": h})
        x += w
        row_h = max(row_h, h)
    return out


def _filter_entry(f: dict[str, Any], dataset_id: int) -> dict[str, Any]:
    view, dim = f["field"].split(".", 1)
    operator = {"dropdown": "in", "date": "between", "numeric": "between"}[f["type"]]
    value: Any = {"dropdown": [], "date": ["", ""], "numeric": ["", ""]}[f["type"]]
    slug = re.sub(r"[^a-z0-9]+", "-", f["field"].lower()).strip("-")
    return {
        "id": f"f-mcp-{slug}",
        "field": dim,
        "fieldKey": f["field"],
        "semanticField": f["field"],
        "datasetId": dataset_id,
        "type": f["type"],
        "operator": operator,
        "value": value,
        "label": f.get("label") or dim.replace("_", " ").title(),
        # The control a viewer uses (the Builder's defaultInteractionFor): without it,
        # and without a control tile on the grid, a filter is invisible to viewers.
        "interactionType": {"dropdown": "dropdown", "date": "date_range", "numeric": "slider"}[f["type"]],
        **({"datePreset": "custom"} if f["type"] == "date" else {}),
    }


SLICER_W, SLICER_H, SLICERS_PER_ROW = 8, 3, 4   # the Builder's card control size on the 36-col grid


def slicer_layouts(n: int, start_y: int) -> list[dict[str, int]]:
    return [{"x": (i % SLICERS_PER_ROW) * SLICER_W, "y": start_y + (i // SLICERS_PER_ROW) * SLICER_H, "w": SLICER_W, "h": SLICER_H}
            for i in range(n)]


@tool(scope=sc.READ, title="Plan a dashboard", read_only=True)
async def plan_dashboard(env: Env, plan: DashboardPlanInput) -> dict[str, Any]:
    """Validate a Dashboard plan through AppBI's chart dry-run and return an approval link. Writes nothing.

    Every chart is checked by AppBI (`/charts/dry-run-create`): config shape,
    field references and a live preview. Charts AppBI rejects come back with
    AppBI's reasons so you can fix them and plan again.
    """
    p = plan
    model = await env.appbi.get(f"/datasets/{p.dataset_id}/model")
    views = {v["name"]: v for v in model.get("views", []) or []}
    table_ids = {int(v["dataset_table_id"]) for v in views.values() if v.get("dataset_table_id") is not None}
    measure_types = {
        f"{v['name']}.{m.get('name')}": str(m.get("type") or "").lower()
        for v in views.values() for m in v.get("measures", []) or []
    }
    errors: list[str] = []
    warnings: list[str] = []

    for f in p.filters:
        view, dim = f.field.split(".", 1)
        v = views.get(view)
        if not v or dim not in {d.get("name") for d in v.get("dimensions", []) or []}:
            errors.append(f"filter field '{f.field}' is not a dimension of dataset {p.dataset_id}")

    existing_dash: dict[str, Any] | None = None
    # Charts are validated against THIS model; a later change to it (a measure
    # renamed or removed in AppBI) must stop the run rather than create charts
    # against a model that no longer matches what was approved.
    fingerprint: dict[str, Any] = {"model": model_fingerprint(model)}
    if p.dashboard_id is not None:
        existing_dash = await env.appbi.get(f"/dashboards/{p.dashboard_id}")
        if (existing_dash.get("user_permission") or "edit") not in ("edit", "full", "owner"):
            errors.append("you can view this dashboard but not edit it")
        fingerprint["shared_rev"] = (existing_dash.get("shared_draft") or {}).get("rev")
    else:
        visible = await env.appbi.get("/dashboards/", skip=0, limit=500)
        if any(str(d.get("name", "")).strip().lower() == p.dashboard_name.strip().lower() for d in visible or []):
            errors.append(f"a dashboard named '{p.dashboard_name}' already exists; choose another name")

    mine = await env.appbi.get("/charts/", scope="mine", limit=500)
    # AppBI refuses a chart name that matches one of the owner's charts case-insensitively
    # (real pilot: "Monthly Revenue and Orders" vs an existing "Monthly revenue and orders"
    # failed the build mid-run), so the clash check folds case too.
    my_chart_names = {str(c.get("name")).casefold() for c in (mine.get("items", mine) if isinstance(mine, dict) else mine) or []}

    charts: list[dict[str, Any]] = []
    rejected: list[dict[str, Any]] = []
    used_names: set[str] = set()
    for i, ch in enumerate(p.charts):
        if ch.dataset_table_id not in table_ids:
            rejected.append({"chart": ch.title, "errors": [f"dataset_table_id {ch.dataset_table_id} is not a table of dataset {p.dataset_id}"]})
            continue
        # Chart names are unique per owner in AppBI and show as the tile title, so a
        # clash gets a short counter rather than a long suffix.
        name = ch.title[:240]
        n = 2
        while name.casefold() in my_chart_names or name.casefold() in used_names:
            name = f"{ch.title[:240]} ({n})"
            n += 1
        used_names.add(name.casefold())
        config, agg_notes = pin_measure_aggregations(dict(ch.config), measure_types)
        warnings.extend(f"{ch.title}: {n}" for n in agg_notes)
        config.setdefault("chartType", ch.chart_type)
        dry = await env.appbi.post("/charts/dry-run-create", {
            "name": name, "chart_type": ch.chart_type, "dataset_table_id": ch.dataset_table_id, "config": config,
            **({"description": ch.description} if ch.description else {}),
        })
        if dry.get("ok") and (ch.style is not None or ch.chart_type in _LINE_TYPES | _BAR_TYPES):
            styled, style_notes = apply_style(ch.chart_type, dry["normalized_config"], ch.style.model_dump() if ch.style else None,
                                              dry.get("runtime_preview_sample") or [])
            if styled != dry["normalized_config"]:
                warnings.extend(f"{ch.title}: {n}" for n in style_notes)
                dry2 = await env.appbi.post("/charts/dry-run-create", {
                    "name": name, "chart_type": ch.chart_type, "dataset_table_id": ch.dataset_table_id, "config": styled,
                    **({"description": ch.description} if ch.description else {}),
                })
                if dry2.get("ok"):
                    dry = dry2
                else:
                    warnings.append(f"{ch.title}: AppBI refused the presentation settings; the chart keeps its default look")
        if not dry.get("ok"):
            rejected.append({
                "chart": ch.title,
                "validation_errors": dry.get("validation_errors"),
                "runtime_errors": dry.get("runtime_errors"),
                "refusal": dry.get("runtime_refusal"),
            })
            continue
        w, h = default_size(ch.chart_type)
        charts.append({
            "title": ch.title,
            "name": name,
            "chart_type": ch.chart_type,
            "dataset_table_id": ch.dataset_table_id,
            "description": ch.description,
            "config": dry["normalized_config"],
            "w": ch.width or w,
            "h": ch.height or h,
            "preview": (dry.get("runtime_preview_sample") or [])[:5],
            "semantic_warnings": dry.get("semantic_warnings") or [],
        })

    if errors or rejected:
        return {"status": "invalid", "errors": errors, "rejected_charts": rejected, "accepted_charts": [c["title"] for c in charts]}

    # KPI tiles first, then the rest, packed on the 36-col grid below existing tiles.
    order = sorted(range(len(charts)), key=lambda k: 0 if charts[k]["chart_type"] == "KPI" else 1)
    start_y = 0
    if existing_dash:
        start_y = max(((t.get("layout") or {}).get("y", 0) + (t.get("layout") or {}).get("h", 0) for t in existing_dash.get("dashboard_charts", []) or []), default=0)
    # Filter controls sit in a band above the charts, where a report's filter bar is.
    band = slicer_layouts(len(p.filters), start_y)
    chart_y = start_y + (-(-len(p.filters) // SLICERS_PER_ROW) * SLICER_H if p.filters else 0)
    slots = pack([(charts[k]["w"], charts[k]["h"]) for k in order], chart_y)
    for k, slot in zip(order, slots):
        charts[k]["layout"] = slot

    filters = [_filter_entry(f.model_dump(), p.dataset_id) for f in p.filters]
    body = {
        "dataset_id": p.dataset_id,
        "dashboard_id": p.dashboard_id,
        "dashboard_name": p.dashboard_name,
        "description": p.description,
        "charts": [{k: v for k, v in c.items() if k not in ("preview", "semantic_warnings")} for c in charts],
        "filters": filters,
        "slicers": [{"slicer_id": f["id"], "layout": band[i]} for i, f in enumerate(filters)],
    }
    for c in charts:
        for w in c["semantic_warnings"]:
            warnings.append(f"{c['title']}: {w}")
    summary = {
        "sections": [
            {"title": "Dashboard", "items": [{
                "target": f"New dashboard '{p.dashboard_name}'" if p.dashboard_name else f"Existing dashboard '{(existing_dash or {}).get('name')}' (#{p.dashboard_id})",
                "visibility": "Your draft only — others see nothing until you publish",
            }]},
            {"title": "Charts (validated by AppBI)", "items": [
                {"chart": c["name"], "type": c["chart_type"], "preview": "; ".join(", ".join(f"{k}={v}" for k, v in row.items()) for row in c["preview"][:3]) or "—"}
                for c in charts
            ]},
            {"title": "Filters (visible controls above the charts)", "items": [
                {"label": f["label"], "field": f["semanticField"], "control": f["interactionType"]} for f in filters] or ["None"]},
            {"title": "What happens", "items": [
                "AppBI creates the charts and adds them to the dashboard as your draft.",
                "Filters are staged in the dashboard's shared draft; a change by a co-author since this plan stops the run instead of overwriting it.",
                "Nothing is published and no public link is created.",
            ]},
        ],
        "warnings": warnings,
    }
    saved = env.plans.create(user_id=env.principal.user_id, grant_id=env.principal.grant_id, kind="dashboard", body=body, summary=summary, fingerprint=fingerprint)
    return {
        "status": "awaiting_approval",
        "plan_id": saved.id,
        "plan_hash": saved.plan_hash,
        "approval_url": env.approval_url(saved.id),
        "charts": [{"title": c["title"], "name": c["name"], "type": c["chart_type"], "preview": c["preview"]} for c in charts],
        "warnings": warnings,
        "next": "Ask the user to open approval_url and approve, then call execute_plan(plan_id).",
    }


async def run_dashboard_plan(env: Env, run: Run) -> dict[str, Any]:
    p = run.plan.body
    me = str(env.principal.user_id)
    dashboard_id = p.get("dashboard_id")

    if env.plans.step(run.plan.id, "start_check") is None:
        model = await env.appbi.get(f"/datasets/{p['dataset_id']}/model")
        if model_fingerprint(model) != run.plan.fingerprint.get("model"):
            raise OperationError("stale_plan", "The dataset's model changed since this plan was validated. Plan again.", step="start_check")
        if dashboard_id is not None:
            current = await env.appbi.get(f"/dashboards/{dashboard_id}")
            if (current.get("shared_draft") or {}).get("rev") != run.plan.fingerprint.get("shared_rev"):
                raise OperationError("stale_plan", "Someone changed this dashboard's shared draft since the plan was made. Plan again.", step="start_check")
        env.plans.mark(run.plan.id, "start_check", "done", result={"ok": True})

    if dashboard_id is None:
        async def create_dashboard() -> dict[str, Any]:
            try:
                d = await env.appbi.post("/dashboards/", {"name": p["dashboard_name"], **({"description": p["description"]} if p.get("description") else {})})
            except AppbiError as exc:
                if exc.status == 400 and "exist" in exc.message.lower():
                    raise OperationError("blocked", f"A dashboard named '{p['dashboard_name']}' already exists. Plan again with another name.", step="create_dashboard") from exc
                raise
            return {"dashboard_id": d["id"], "name": d["name"]}

        async def find_dashboard(since: float) -> dict[str, Any] | None:
            for d in await env.appbi.get("/dashboards/", skip=0, limit=500) or []:
                if d.get("name") == p["dashboard_name"] and str(d.get("owner_id")) == me and (_ts(d.get("created_at")) or 0) >= since:
                    return {"dashboard_id": d["id"], "name": d["name"]}
            return None

        dash = await run.write("create_dashboard", create_dashboard, reconcile=find_dashboard)
        dashboard_id = int(dash["dashboard_id"])
    run.resources.append({"type": "dashboard", "id": dashboard_id, "url": env.link(f"/dashboards/{dashboard_id}"), "state": "draft"})

    created: list[dict[str, Any]] = []
    for idx, ch in enumerate(p["charts"]):
        async def create_chart(ch: dict[str, Any] = ch) -> dict[str, Any]:
            body = {"name": ch["name"], "chart_type": ch["chart_type"], "dataset_table_id": ch["dataset_table_id"], "config": ch["config"]}
            if ch.get("description"):
                body["description"] = ch["description"]
            try:
                c = await env.appbi.post("/charts/", body)
            except AppbiError as exc:
                if exc.status == 400 and "already" in exc.message.lower():
                    raise OperationError("blocked", f"You already have a chart named '{ch['name']}'. Plan again.", step=f"chart:{idx}") from exc
                raise
            return {"chart_id": c["id"]}

        async def find_chart(since: float, ch: dict[str, Any] = ch) -> dict[str, Any] | None:
            res = await env.appbi.get("/charts/", scope="mine", q=ch["name"], limit=50)
            for c in (res.get("items", res) if isinstance(res, dict) else res) or []:
                if c.get("name") == ch["name"] and (_ts(c.get("created_at")) or 0) >= since:
                    return {"chart_id": c["id"]}
            return None

        chart = await run.write(f"chart:{idx}", create_chart, reconcile=find_chart)
        chart_id = int(chart["chart_id"])
        run.resources.append({"type": "chart", "id": chart_id, "name": ch["name"], "url": env.link(f"/explore/{chart_id}"), "state": "saved"})

        async def add_tile(ch: dict[str, Any] = ch, chart_id: int = chart_id) -> dict[str, Any]:
            layout = {**ch["layout"], "gv": GRID_VERSION, "draftOnly": True}
            d = await env.appbi.post(f"/dashboards/{dashboard_id}/charts", {"chart_id": chart_id, "layout": layout})
            tile = _my_draft_tile(d, chart_id, me)
            if tile is None:
                raise OperationError("partially_failed", "AppBI accepted the tile but it is not in the dashboard response.", step=f"tile:{idx}")
            return {"tile_id": tile["id"], "chart_id": chart_id}

        async def find_tile(_since: float, chart_id: int = chart_id) -> dict[str, Any] | None:
            d = await env.appbi.get(f"/dashboards/{dashboard_id}")
            tile = _my_draft_tile(d, chart_id, me)
            return {"tile_id": tile["id"], "chart_id": chart_id} if tile else None

        tile = await run.write(f"tile:{idx}", add_tile, reconcile=find_tile)
        created.append({"title": ch["title"], "chart_id": chart_id, "tile_id": tile["tile_id"], "type": ch["chart_type"]})

    if p["filters"]:
        async def stage_filters() -> dict[str, Any]:
            for attempt in range(2):
                current = await env.appbi.get(f"/dashboards/{dashboard_id}")
                rev = (current.get("shared_draft") or {}).get("rev")
                # Report-wide SLICERS (slicers_config), as the Builder stages them: a
                # control applies (and stages for Apply) only a slicer. A legacy
                # filters_config entry with a control showed the choice but never
                # applied it (real browser check, pilot P6).
                have = list(current.get("slicers_config") or [])
                keys = {str(f.get("semanticField") or f.get("fieldKey") or f.get("field")) for f in have}
                merged = have + [f for f in p["filters"] if f["semanticField"] not in keys]
                try:
                    await env.appbi.put(f"/dashboards/{dashboard_id}/draft-filters", {"slicers_config": merged, "base_rev": rev})
                    return {"filters": [f["semanticField"] for f in p["filters"]]}
                except AppbiError as exc:
                    # A co-author wrote in between our read and write: re-read and
                    # merge onto THEIR state once; never overwrite it.
                    if exc.status == 409 and attempt == 0:
                        continue
                    if exc.status == 409:
                        raise OperationError("conflict", "A co-author keeps changing this dashboard's filters. Try again later.", step="filters", detail=exc.detail) from exc
                    raise
            raise OperationError("conflict", "Could not stage filters.", step="filters")

        async def find_filters(_since: float) -> dict[str, Any] | None:
            current = await env.appbi.get(f"/dashboards/{dashboard_id}")
            keys = {str(f.get("semanticField")) for f in current.get("slicers_config") or []}
            return {"filters": list(keys)} if all(f["semanticField"] in keys for f in p["filters"]) else None

        await run.write("filters", stage_filters, reconcile=find_filters)

    # Each filter gets its native control on the grid (as your draft), or viewers cannot use it.
    placed: list[dict[str, Any]] = []
    for i, sl in enumerate(p.get("slicers") or []):
        async def add_slicer(sl: dict[str, Any] = sl, i: int = i) -> dict[str, Any]:
            d = await env.appbi.post(f"/dashboards/{dashboard_id}/widgets", {
                "widget_type": "slicer",
                "layout": {**sl["layout"], "gv": GRID_VERSION, "draftOnly": True},
                "widget_config": {"slicerId": sl["slicer_id"], "treatment": "auto", "origin": "author"},
            })
            tile = _my_slicer_tile(d, sl["slicer_id"], me)
            if tile is None:
                raise OperationError("partially_failed", "AppBI accepted the filter control but it is not in the dashboard response.", step=f"slicer:{i}")
            return {"tile_id": tile["id"], "slicer_id": sl["slicer_id"]}

        async def find_slicer(_since: float, sl: dict[str, Any] = sl) -> dict[str, Any] | None:
            tile = _my_slicer_tile(await env.appbi.get(f"/dashboards/{dashboard_id}"), sl["slicer_id"], me)
            return {"tile_id": tile["id"], "slicer_id": sl["slicer_id"]} if tile else None

        placed.append(await run.write(f"slicer:{i}", add_slicer, reconcile=find_slicer))

    # Read back what AppBI now holds, and the numbers each chart renders.
    final = await env.appbi.get(f"/dashboards/{dashboard_id}")
    for c in created:
        tile = next((t for t in final.get("dashboard_charts", []) if t.get("id") == c["tile_id"]), None)
        c["in_your_draft"] = bool(tile and (tile.get("layout") or {}).get("draftOnly"))
        try:
            data = await env.appbi.get(f"/charts/{c['chart_id']}/data", context="dashboard")
            rows = data.get("data") or []
            c["rows"] = len(rows)
            c["sample"] = rows[:3]
        except AppbiError as exc:
            c["data_error"] = exc.message
    missing = [c["title"] for c in created if not c["in_your_draft"]]
    if missing:
        raise OperationError("partially_failed", f"These tiles are not in your draft after the run: {missing}", step="verify")
    return {
        "status": "draft_ready",
        "dashboard_id": dashboard_id,
        "preview_url": env.link(f"/dashboards/{dashboard_id}"),
        "charts": created,
        "filters": [f["label"] for f in p["filters"]],
        "filter_controls_placed": len(placed),
        "note": "These changes are your draft: open preview_url in AppBI to see them. Publish with request_publish.",
    }


def _my_slicer_tile(dashboard: dict[str, Any], slicer_id: str, me: str) -> dict[str, Any] | None:
    for t in dashboard.get("dashboard_charts", []) or []:
        layout = t.get("layout") or {}
        cfg = t.get("widget_config") or {}
        if (t.get("widget_type") == "slicer" and str(cfg.get("slicerId")) == slicer_id
                and layout.get("draftOnly") and str(layout.get("draftOwner")) == me):
            return t
    return None


def _my_draft_tile(dashboard: dict[str, Any], chart_id: int, me: str) -> dict[str, Any] | None:
    for t in dashboard.get("dashboard_charts", []) or []:
        layout = t.get("layout") or {}
        if t.get("chart_id") == chart_id and layout.get("draftOnly") and str(layout.get("draftOwner")) == me:
            return t
    return None

