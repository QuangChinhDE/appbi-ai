"""Explore-preview == Dashboard-tile parity smoke (CI integration tier).

The recurring bug class the 3rd-party review keeps surfacing: the Explore
dataset-preview path (`datasets.py::_execute_semantic_dataset_query`) and the
dashboard / chart-runtime path (`ChartService.get_chart_data`) are SEPARATE code
paths that can classify the same field differently. Most recent example: a
DECLARED MEASURE dragged onto a scatter axis — the preview reclassified
dimension→measure, but the chart runtime pushed it into GROUP BY → Dashboard
400 "dimension not found" while Explore preview silently diverged.

Post the pipeline-unification refactor BOTH paths compile to ONE
``SemanticQuerySpec`` via ``classify_semantic_roles`` and call
``SemanticQueryEngine.run(spec)``. This smoke is the END-TO-END proof that the
shared classifier + binding/reachable-measure wiring actually agree at runtime,
across the chart SHAPES whose measure-field sets are computed differently on the
two paths (dashboard via the hydrated binding's ``reachableMeasureFields``;
preview via ``declared_measure_refs`` from the model joins). It runs the SAME
logical query through BOTH paths and asserts identical data — WITHOUT the
flakiness of a full browser E2E.

Coverage (each × {no filter, conformed-dim filter}):
  1. SCATTER — 1 dim + 2 DECLARED MEASURE axes (FE flattens axes into
     dimensions; BE reclassifies). The original divergence case.
  2. BAR (raw-column metric) — base=revenue, dim on the JOINED owner table,
     metric = raw column ``amount`` (agg=sum). Join + raw-measure.
  3. BAR (cross-table declared measure) — base=owner, declared measure that
     lives on the JOINED revenue table. The exact shape where the dashboard
     binding's ``reachableMeasureFields`` and the preview's reverse-reachable
     ``declared_measure_refs`` MUST agree or classify diverges.

Read-only (uses seeded charts; creates nothing). Run after
``seed_snowflake_ci_fixture.py``.

Exit 0 = parity holds; 1 = divergence; 2 = setup/fixture error.
"""
import sys

from app.core.database import SessionLocal
from app.models.dataset import Dataset, DatasetTable
from app.models.models import Chart
from app.schemas.dataset import AggregationSpec, ExecuteQueryRequest, FilterCondition
from app.services.chart_service import ChartService

DATASET_ID = 56

# A conformed-dim filter every case can honour (all three charts reach owner —
# scatter/cross-table from base=owner directly, "revenue by owner" forward M:1
# revenue→owner).
TEAM_FILTER_FIELD = "dataset_table_188.team"
TEAM_FILTER_VALUE = "North"

# Each case = (label, chart name, preview dimensions, preview measures).
# IMPORTANT: the Explore preview base table is the chart's OWN home table
# (`chart.dataset_table_id`) — re-opening a saved chart in Explore anchors the
# session to that table. Using the wrong base silently changes outer-join
# semantics (FROM revenue drops owners with no revenue; FROM owner LEFT-keeps
# them as NULL), so the base MUST come from the chart, not a hardcoded constant.
# `preview_*` mirror what the Explore editor sends for that shape:
#  - scatter flattens its measure axes into `dimensions` (the BE reclassifies
#    declared measures into the measure tier),
#  - bar/column send dim in `dimensions` and the metric in `measures`; a
#    DECLARED measure is sent with function="auto" (use the measure's stored
#    agg) exactly as the FE does, a RAW column with its explicit agg.
CASES = [
    {
        "label": "scatter rev-vs-kpi by owner",
        "chart": "[snow] scatter rev-vs-kpi by owner",
        "preview_dims": [
            "dataset_table_188.crm_name",
            "dataset_table_193.total_revenue",
            "dataset_table_188.avg_kpi",
        ],
        "preview_measures": [],
    },
    {
        "label": "bar revenue by owner (raw-column metric)",
        "chart": "[snow] revenue by owner",
        "preview_dims": ["dataset_table_188.crm_name"],
        "preview_measures": [("dataset_table_193.amount", "sum")],
    },
    {
        "label": "bar M revenue per owner (cross-table declared measure)",
        "chart": "[snow] M revenue per owner (cross-table measure)",
        "preview_dims": ["dataset_table_188.crm_name"],
        "preview_measures": [("dataset_table_193.total_revenue", "auto")],
    },
]


def _is_num(s) -> bool:
    try:
        float(s)
        return True
    except (TypeError, ValueError):
        return False


def _norm(rows):
    """{dimension-string -> sorted tuple of the OTHER (measure) values}, robust
    to per-path key naming + numeric type (Decimal/float/int). The dimension
    value is the non-numeric string; everything else is a measure (None kept)."""
    out: dict = {}
    for r in (rows or []):
        key = None
        vals = []
        for v in r.values():
            if isinstance(v, str) and not _is_num(v):
                key = v
            else:
                vals.append(None if v is None else str(round(float(v), 6)))
        out[key] = tuple(sorted(vals, key=lambda x: (x is None, x or "")))
    return out


def _preview(db, ds, tbl, dims, measures, filt):
    from app.api.datasets import _execute_semantic_dataset_query
    req = ExecuteQueryRequest(
        dimensions=list(dims),
        measures=[AggregationSpec(field=f, function=fn) for f, fn in measures] or None,
        filters=[filt] if filt else None,
        limit=10_000,
    )
    return _execute_semantic_dataset_query(db, ds, tbl, req).rows


def _dashboard(db, chart_id, extra):
    res = ChartService.get_chart_data(db, chart_id, extra_filters=[extra] if extra else None)
    return res.get("data") or []


def main():
    db = SessionLocal()
    try:
        ds = db.query(Dataset).filter(Dataset.id == DATASET_ID).first()
        if not ds:
            print(f"[FATAL] fixture missing (ds={bool(ds)}) — "
                  f"run seed_snowflake_ci_fixture.py first")
            sys.exit(2)

        filt_variants = [
            ("no filter", None, None),
            (
                "owner.team=North",
                FilterCondition(field=TEAM_FILTER_FIELD, operator="eq", value=TEAM_FILTER_VALUE),
                {"semanticField": TEAM_FILTER_FIELD, "field": TEAM_FILTER_FIELD,
                 "operator": "eq", "value": TEAM_FILTER_VALUE, "datasetId": DATASET_ID},
            ),
        ]

        failures = []
        for case in CASES:
            chart = db.query(Chart).filter(Chart.name == case["chart"]).first()
            if not chart:
                print(f"  [FAIL] {case['label']}: chart {case['chart']!r} missing")
                failures.append(case["label"])
                continue
            # Preview base = the chart's own home table (what Explore anchors to).
            tbl = db.query(DatasetTable).filter(DatasetTable.id == chart.dataset_table_id).first()
            if not tbl:
                print(f"  [FAIL] {case['label']}: home table "
                      f"{chart.dataset_table_id} missing")
                failures.append(case["label"])
                continue
            for fl_label, prev_filt, dash_filt in filt_variants:
                label = f"{case['label']} / {fl_label}"
                try:
                    p = _norm(_preview(db, ds, tbl, case["preview_dims"],
                                       case["preview_measures"], prev_filt))
                    d = _norm(_dashboard(db, chart.id, dash_filt))
                except Exception as exc:  # a crash on either path IS a parity failure
                    print(f"  [FAIL] {label}: {type(exc).__name__}: {exc}")
                    failures.append(label)
                    continue
                ok = p == d
                print(f"  [{'PASS' if ok else 'FAIL'}] {label}: preview={p} dashboard={d}")
                if not ok:
                    failures.append(label)

        if failures:
            print(f"[FAIL] Explore preview != Dashboard tile for: {failures}")
            sys.exit(1)
        total = len(CASES) * len(filt_variants)
        print(f"[PASS] Explore preview == Dashboard tile ({total} checks across "
              f"{len(CASES)} chart shapes: scatter + bar(raw) + bar(cross-table measure))")
        sys.exit(0)
    finally:
        db.close()


if __name__ == "__main__":
    main()
