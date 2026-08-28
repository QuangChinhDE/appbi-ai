"""Teach an outside model to write HTML this system can import without guessing.

The import pipeline has two ways in. One reads a plan the document DECLARES in a
`<script type="application/appbi-dashboard">` block; the other infers a plan from
the document's markup. The declarative path is the good one -- it is exact, it is
cheap, and it is stable -- but nothing in the product ever told anyone how to
produce a document that carries it, so in practice every import went down the
inference path.

Measured cost of inferring, on one fixture across four runs: the layout family
came back as `console`, `ops`, `brief` and `console`; four KPI cards became four
full-width tables one run and four preserved cards the next; and one invented
column (`avg_delivery_days_current`, which the model derived from a card showing
a delta) failed all ten charts of the import at once.

None of that is a model being bad at its job. It is a model being asked to
rediscover facts -- the dataset's real column names, which chart types exist,
what a KPI needs -- that the system already knows and could simply hand over.
This module hands them over.

The skill is generated per dataset, so the column names in it are the real ones.
That is the point: a document authored against this skill names columns that
exist, and the import becomes a validation rather than a translation.
"""

import hashlib
import json
from typing import Any, Dict, List, Optional, Tuple

#: Chart types the import pipeline accepts, with what each one needs to run.
#: Kept here rather than derived from the planner's prompt because a skill is a
#: contract: it has to state the requirement, not hint at it.
CHART_TYPE_CONTRACT: List[Dict[str, Any]] = [
    {"type": "KPI", "needs": "one numeric metric", "roles": {"metrics": 1}},
    {"type": "BAR", "needs": "one dimension + one or more metrics", "roles": {"dimension": 1, "metrics": 1}},
    {"type": "HORIZONTAL_BAR", "needs": "one dimension + one or more metrics", "roles": {"dimension": 1, "metrics": 1}},
    {"type": "STACKED_BAR", "needs": "one dimension + one metric + a breakdown", "roles": {"dimension": 1, "metrics": 1, "breakdown": 1}},
    {"type": "GROUPED_BAR", "needs": "one dimension + one metric + a breakdown", "roles": {"dimension": 1, "metrics": 1, "breakdown": 1}},
    {"type": "LINE", "needs": "one dimension + one or more metrics", "roles": {"dimension": 1, "metrics": 1}},
    {"type": "AREA", "needs": "one dimension + one or more metrics", "roles": {"dimension": 1, "metrics": 1}},
    {"type": "TIME_SERIES", "needs": "one DATE field + one or more metrics", "roles": {"timeField": 1, "metrics": 1}},
    {"type": "BAR_LINE", "needs": "one dimension + one bar metric + one line metric", "roles": {"dimension": 1, "metrics": 1, "lineMetric": 1}},
    {"type": "PIE", "needs": "one dimension + one metric", "roles": {"dimension": 1, "metrics": 1}},
    {"type": "SCATTER", "needs": "two numeric fields", "roles": {"scatterX": 1, "scatterY": 1}},
    {"type": "PODIUM", "needs": "one name dimension + one metric (top-N ranking)", "roles": {"dimension": 1, "metrics": 1}},
    {"type": "TABLE", "needs": "a list of columns to show", "roles": {"selectedColumns": 1}},
]

#: Non-chart tiles. These carry a report's structure; a document made only of
#: charts reads as a bag of tiles no matter how good the charts are.
WIDGET_CONTRACT: List[Dict[str, str]] = [
    {"widget_type": "section_header", "config": '{"title": "...", "subtitle": "..."}',
     "use": "the band that introduces the tiles under it"},
    {"widget_type": "callout", "config": '{"text": "...", "tone": "accent|info|success|warning|danger|neutral"}',
     "use": "a note or an observation beside the numbers"},
    {"widget_type": "text", "config": '{"template": "..."}',
     "use": "a paragraph of copy"},
    {"widget_type": "hero_strip", "config": '{"headline": "...", "subhead": "..."}',
     "use": "the opening banner of a report"},
]

#: Layout templates, and what each one is FOR. A template is a composition, so
#: picking one is a statement about how the report will be read.
TEMPLATE_CONTRACT: List[Dict[str, str]] = [
    {"id": "console", "dock": "top",
     "shape": "KPI strip over a 2-across chart grid, filters along the top",
     "for": "a monitoring console: a few headline numbers and the visuals that explain them"},
    {"id": "brief", "dock": "left",
     "shape": "KPI row, then ONE full-width chart at a time, then a detail table",
     "for": "a board pack read in a meeting, where one chart carries the argument"},
    {"id": "ops", "dock": "left",
     "shape": "compact status row over a dense 3-across grid",
     "for": "a wall display watched continuously: maximum information per pixel"},
    {"id": "editorial", "dock": "drawer",
     "shape": "narrative sections with wide visuals between them",
     "for": "a data story read top to bottom"},
    {"id": "stage", "dock": "top",
     "shape": "a wall of oversized numbers, then a few very large visuals",
     "for": "a screen read from across a room"},
]

COLORWAYS = ["indigo", "emerald", "coral", "ocean", "amber", "slate", "midnight", "graphite"]

#: Grid the `layout` of each tile is expressed in.
GRID_COLUMNS = 12
#: One unit of `h`, measured on a live grid: rendered height = 96 * h - 16 px.
GRID_ROW_PX = 96


def schema_fingerprint(tables: List[Dict[str, Any]]) -> str:
    """A stable hash of the columns a document was authored against.

    It exists so an import can tell "this HTML was written for this dataset"
    apart from "this HTML was written for something else and the names happen to
    look similar". Only names and types go in: a fingerprint that changed
    whenever a row was added would be worthless.
    """
    payload = sorted(
        (
            str(table.get("display_name") or ""),
            tuple(sorted(
                (str(col.get("name") or ""), str(col.get("type") or ""))
                for col in (table.get("columns") or [])
            )),
        )
        for table in tables
    )
    digest = hashlib.sha256(json.dumps(payload, ensure_ascii=False).encode("utf-8")).hexdigest()
    return f"sha256:{digest[:32]}"


def _looks_like_identifier(name: str) -> bool:
    """Whether a column is a key rather than something a reader groups by.

    A chart grouped by `order_id` has one bar per row, and a slicer on it has one
    option per row. Neither is a mistake a person makes; both are mistakes a
    worked example teaches if it picks the first string column it finds.
    """
    lowered = str(name or "").strip().lower()
    return (
        lowered in {"id", "uuid", "guid", "key"}
        or lowered.endswith(("_id", "_uuid", "_guid", "_key", "_code", "_hash"))
        or lowered.startswith(("id_", "uuid_"))
    )


def _columns_of(table: Dict[str, Any]) -> List[Dict[str, str]]:
    return [
        {"name": str(col.get("name") or ""), "type": str(col.get("type") or "string")}
        for col in (table.get("columns") or [])
        if str(col.get("name") or "").strip()
    ]


def ambiguous_columns(tables: List[Dict[str, Any]]) -> Dict[str, List[str]]:
    """Column names that appear in more than one table.

    A dataset's tables are joined, so a bare `order_status` that exists in both
    `Orders` and `Seller Order Items` has no single meaning and the query engine
    refuses it:

        Field 'order_status' appears in several joined tables: Orders, Seller
        Order Items. Change the reference to 'Orders.order_status' ...

    Listing them lets an author avoid them. Hand-qualifying does NOT work: a
    field is quoted as one identifier, so `Orders.order_id` becomes
    `SELECT COUNT("Orders.order_id")` and fails, and the internal form
    (`dataset_table_437.order_id`) only resolves once a chart carries a semantic
    binding, which is created after import. Both were measured, not assumed.
    """
    seen: Dict[str, List[str]] = {}
    for table in tables:
        name = str(table.get("display_name") or "")
        for col in _columns_of(table):
            seen.setdefault(col["name"], []).append(name)
    return {col: owners for col, owners in sorted(seen.items()) if len(owners) > 1}


def build_source_contract(
    *,
    dataset_id: int,
    dataset_name: str,
    tables: List[Dict[str, Any]],
) -> Dict[str, Any]:
    """The block a generated document must carry so the import can verify it.

    `expected_columns` is the part that matters. The older contract listed table
    names only, and warned when one was missing -- so a document written against
    a different dataset whose tables happened to share names was imported
    anyway, and every column reference in it had to be re-guessed.
    """
    return {
        "dataset_id": dataset_id,
        "dataset_name": dataset_name,
        "schema_fingerprint": schema_fingerprint(tables),
        "expected_source_keys": [str(t.get("display_name") or "") for t in tables],
        "expected_columns": {
            str(table.get("display_name") or ""): [c["name"] for c in _columns_of(table)]
            for table in tables
        },
    }


def _example_plan(dataset_id: int, dataset_name: str, tables: List[Dict[str, Any]]) -> Dict[str, Any]:
    """A minimal, VALID plan built from this dataset's own first columns.

    Generated rather than written out, so the example never drifts from the
    dataset it is supposed to describe -- a worked example with the wrong column
    names in it teaches the wrong thing more effectively than no example at all.
    """
    first = tables[0] if tables else {"display_name": "Table", "columns": []}
    cols = _columns_of(first)
    numeric = next((c["name"] for c in cols if c["type"] in {"integer", "float", "number"}), None)
    # Not merely "the first string column": that is usually the primary key, and
    # the example was picking `order_id` as both the bar dimension and the
    # slicer -- contradicting the rule printed a few lines above it.
    dimension = next(
        (c["name"] for c in cols if c["type"] == "string" and not _looks_like_identifier(c["name"])),
        None,
    )
    date = next((c["name"] for c in cols if c["type"] in {"date", "datetime", "timestamp"}), None)
    source_key = str(first.get("display_name") or "Table")

    charts: List[Dict[str, Any]] = []
    if date and numeric:
        charts.append({
            "block_id": "trend-over-time",
            "title": f"{numeric} over time",
            "chart_type": "TIME_SERIES",
            "source_key": source_key,
            "role_config": {"timeField": date, "metrics": [{"field": numeric, "agg": "sum"}]},
            "layout": {"x": 0, "y": 1, "w": 6, "h": 4},
        })
    if dimension and numeric:
        charts.append({
            "block_id": "breakdown",
            "title": f"{numeric} by {dimension}",
            "chart_type": "BAR",
            "source_key": source_key,
            "role_config": {"dimension": dimension, "metrics": [{"field": numeric, "agg": "sum"}]},
            "layout": {"x": 6, "y": 1, "w": 6, "h": 4},
        })

    return {
        "version": "appbi-import/v1",
        "dashboard": {
            "title": f"{dataset_name} overview",
            "template_family": "console",
            "colorway": "indigo",
            "slicers": [dimension] if dimension else [],
        },
        # Abridged on purpose. The real contract is printed in full right below
        # the snippet; inlining thirteen tables here buries the plan shape the
        # reader came to learn.
        "source_contract": "<<paste the source_contract block printed below>>",
        "widgets": [{
            "block_id": "intro",
            "widget_type": "section_header",
            "widget_config": {"title": "Overview", "subtitle": ""},
            "layout": {"x": 0, "y": 0, "w": 12, "h": 1},
        }],
        "charts": charts,
    }


def build_import_skill(
    *,
    dataset_id: int,
    dataset_name: str,
    tables: List[Dict[str, Any]],
) -> str:
    """The skill document, as markdown, for one dataset.

    Everything in it is generated from the live dataset, so the column names an
    author reads here are the ones the import will look for.
    """
    contract = build_source_contract(
        dataset_id=dataset_id, dataset_name=dataset_name, tables=tables
    )
    lines: List[str] = []
    add = lines.append

    add(f"# Writing an AppBI dashboard for “{dataset_name}”")
    add("")
    add("You are writing a single HTML file that AppBI will import as a dashboard.")
    add("Design it however you like — the visual work is yours. What this document")
    add("fixes is the *contract*: the data it may reference and the plan it must")
    add("declare, so that importing it is a check rather than a translation.")
    add("")
    add("## The one rule that matters")
    add("")
    add("**Use only the columns listed below, spelled exactly as they appear.**")
    add("AppBI verifies them on import. A column that does not exist is not")
    add("re-mapped to something similar — the import stops and tells you which")
    add("name was wrong. Inventing a column (`revenue_current`, `total_prev`) is")
    add("the single most common way a generated dashboard fails to import: one")
    add("invented name in a derived field breaks every chart in the file, because")
    add("the derived column is added to the query for all of them.")
    add("")
    add("If you need a figure the dataset does not hold, derive it with")
    add("`dataset_ops` (below) from columns that do exist. Do not assume it.")
    add("")

    add("## The dataset")
    add("")
    add(f"- **Dataset**: `{dataset_name}` (id `{dataset_id}`)")
    add(f"- **Schema fingerprint**: `{contract['schema_fingerprint']}`")
    add("")
    add("Copy the fingerprint into `source_contract` verbatim. It is how the")
    add("import knows the file was written for this dataset and not another one")
    add("with similar table names.")
    add("")
    for table in tables:
        cols = _columns_of(table)
        add(f"### `{table.get('display_name')}`  ({len(cols)} columns)")
        add("")
        add("| column | type |")
        add("| --- | --- |")
        for col in cols:
            add(f"| `{col['name']}` | {col['type']} |")
        add("")

    add("## Columns that live in more than one table")
    add("")
    add("These names appear in several of the tables below, and those tables are")
    add("joined. A chart that uses one of them may fail to resolve — the engine")
    add("cannot tell which table you meant, and says so:")
    add("")
    add("> Field 'order_status' appears in several joined tables: Orders, Seller")
    add("> Order Items. Change the reference to one of ...")
    add("")
    add("**Prefer a column that only one table has.** That is the reliable move")
    add("and it costs you nothing at authoring time.")
    add("")
    add("Do NOT try to qualify the name yourself. A field is quoted as a single")
    add("identifier, so `\"Orders.order_id\"` is read as a column with a dot in")
    add("its name and fails outright — measured, not assumed. `source_key` says")
    add("which table the chart reads from, but on a joined model it does not by")
    add("itself settle a repeated column: if you use one, expect to set the")
    add("reference in the chart editor after import, or ask for the dataset's")
    add("model to be adjusted.")
    add("")
    ambiguous = ambiguous_columns(tables)
    if ambiguous:
        add("| repeated column | appears in |")
        add("| --- | --- |")
        for column, owners in list(ambiguous.items())[:30]:
            add(f"| `{column}` | {', '.join(f'`{o}`' for o in owners[:5])} |")
        if len(ambiguous) > 30:
            add(f"| … | {len(ambiguous) - 30} more |")
    else:
        add("This dataset has no repeated column names — every name resolves on its own.")
    add("")

    add("## Charts")
    add("")
    add("Every chart declares its type and the fields for that type's roles.")
    add("A type whose roles are not satisfied is rejected, not downgraded.")
    add("")
    add("| chart_type | requires |")
    add("| --- | --- |")
    for entry in CHART_TYPE_CONTRACT:
        add(f"| `{entry['type']}` | {entry['needs']} |")
    add("")
    add("Aggregations: `sum`, `avg`, `count`, `min`, `max`, `count_distinct`.")
    add("")

    add("## Tiles that are not charts")
    add("")
    add("A report is its structure. A file made only of charts imports as a bag")
    add("of tiles, however good the charts are — declare the headings and notes")
    add("that hold it together.")
    add("")
    add("| widget_type | config | use it for |")
    add("| --- | --- | --- |")
    for widget in WIDGET_CONTRACT:
        add(f"| `{widget['widget_type']}` | `{widget['config']}` | {widget['use']} |")
    add("")

    add("## Layout")
    add("")
    add(f"The grid is **{GRID_COLUMNS} columns**. One unit of `h` renders about")
    add(f"**{GRID_ROW_PX}px** tall, so `h: 4` is a chart you can read and `h: 1` is")
    add("a heading band. Give every tile an explicit `layout` — a declared layout")
    add("is never overwritten, and it is the only way the imported report keeps")
    add("the arrangement you designed.")
    add("")
    add("Sensible heights: heading `1`, KPI card `2`, chart `4`, table `5`.")
    add("")
    add("Pick a `template_family` for the parts you do not place yourself:")
    add("")
    add("| template_family | filter dock | shape | read it as |")
    add("| --- | --- | --- | --- |")
    for tpl in TEMPLATE_CONTRACT:
        add(f"| `{tpl['id']}` | {tpl['dock']} | {tpl['shape']} | {tpl['for']} |")
    add("")
    add(f"`colorway`: one of {', '.join(f'`{c}`' for c in COLORWAYS)}.")
    add("")

    add("## Filters")
    add("")
    add("List the columns a reader should be able to filter by in")
    add("`dashboard.slicers`. Render them in the HTML however you like — AppBI")
    add("builds its own controls from the column names, so a `<select>` in your")
    add("markup is for your design, not for the import.")
    add("")
    add("Avoid identifier columns: a slicer on `order_id` has one option per row")
    add("and means nothing to a reader.")
    add("")

    add("## Deriving a figure the dataset does not hold")
    add("")
    add("```json")
    add(json.dumps({"dataset_ops": [{
        "op": "add_column",
        "source_key": str((tables[0] or {}).get("display_name") or "Table") if tables else "Table",
        "name": "margin",
        "expression": "price - freight_value",
        "label": "Margin",
    }]}, indent=2, ensure_ascii=False))
    add("```")
    add("")
    add("Expressions are simple SQL maths: `+ - * /`, `ROUND()`, `COALESCE()`,")
    add("`IF(cond, a, b)`. No `SELECT`, no `JOIN`, no window functions. Every")
    add("name in the expression must be a real column from the tables above, or a")
    add("field defined by an EARLIER `add_column`.")
    add("")

    add("## The block to embed")
    add("")
    add("Put this in `<head>`, filled in with your real plan. Nothing else in the")
    add("file needs to follow any convention.")
    add("")
    add("```html")
    add('<script type="application/appbi-dashboard">')
    add(json.dumps(_example_plan(dataset_id, dataset_name, tables), indent=2, ensure_ascii=False))
    add("</script>")
    add("```")
    add("")
    add("And the `source_contract` to paste into it, in full:")
    add("")
    add("```json")
    add(json.dumps(contract, indent=2, ensure_ascii=False))
    add("```")
    add("")
    add("`block_id` is yours to choose; it links a plan entry to the markup it")
    add("came from, so keep it stable if you revise the file.")
    add("")

    add("## Before you hand the file over")
    add("")
    add("- Every `field`, `dimension`, `timeField` and `selectedColumns` entry")
    add("  appears in the tables above, spelled identically.")
    add("- No chart depends on a repeated column where a unique one would do.")
    add("- Every chart's `chart_type` has the roles that type requires.")
    add("- `source_key` names the table each chart reads from.")
    add("- Every tile has a `layout`, and no two tiles overlap.")
    add("- `schema_fingerprint` is copied exactly.")
    add("")
    return "\n".join(lines)


def compare_source_contract_to_dataset(
    *,
    source_contract: Dict[str, Any],
    tables: List[Dict[str, Any]],
) -> Tuple[bool, List[str]]:
    """Does this document's declared contract still hold against the dataset?

    Returns `(is_importable, findings)`.

    The distinction the older check missed: a table name matching is not the
    same as the columns being there. A document written for a different dataset
    whose tables happen to share names imported cleanly and then had every
    column reference re-guessed -- which is exactly what the declared path
    exists to avoid.
    """
    findings: List[str] = []
    if not source_contract:
        return True, findings

    available = {
        str(t.get("display_name") or ""): {c["name"] for c in _columns_of(t)}
        for t in tables
    }

    declared_id = source_contract.get("dataset_id")
    declared_print = str(source_contract.get("schema_fingerprint") or "")
    actual_print = schema_fingerprint(tables)

    if declared_print and declared_print == actual_print:
        return True, findings

    if declared_print:
        findings.append(
            "This file was written against a different version of the dataset "
            f"(declared {declared_print}, current {actual_print}). Checking each "
            "column it uses."
        )

    missing_tables = [
        name for name in (source_contract.get("expected_source_keys") or [])
        if str(name) and str(name) not in available
    ]
    if missing_tables:
        findings.append(
            "The dataset has no table named " + ", ".join(f"'{t}'" for t in missing_tables[:4])
            + ". Pick the dataset this file was written for, or regenerate the file "
            "against this one."
        )
        return False, findings

    expected_columns = source_contract.get("expected_columns")
    if isinstance(expected_columns, dict):
        for table_name, columns in expected_columns.items():
            present = available.get(str(table_name))
            if present is None:
                continue
            missing = [str(c) for c in (columns or []) if str(c) not in present]
            if missing:
                findings.append(
                    f"Table '{table_name}' no longer has "
                    + ", ".join(f"'{c}'" for c in missing[:4])
                    + ". These are referenced by the file's charts and are not "
                    "guessed at -- regenerate the file against the current dataset."
                )
                return False, findings

    if declared_id is not None:
        findings.append(
            "Column names all still resolve, so the import will go ahead."
        )
    return True, findings
