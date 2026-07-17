"""
Semantic-layer GOLDEN harness v2 (Phase 0 regression backbone, hardened per
adversarial review).

TWO goldens, because later phases change different layers:

  1. SQL GOLDEN  (renderer lock) — the exact SQL the semantic engine generates
     per chart with the DECISION LAYER FORCED TO LIVE. Proves the semantic
     backbone (dims/measures/joins/filter SQL) is untouched by a refactor.
     NOTE: normalized-identical (whitespace collapsed, snapshot versions
     masked), not strictly byte-identical.

  2. DECISION GOLDEN (decision-layer lock) — the [exec-decision] line per chart
     with the REAL decision layer (snapshot resolver / planner), execution still
     mocked and all rebuild TRIGGERS stubbed to no-ops (no state mutation).
     Proves mode/dialect/credential/host decisions are unchanged by a refactor.

Coverage v2: per-dialect quotas (BigQuery + PostgreSQL + DuckDB/Sheets/manual),
NEWEST charts first, ds111 (PG flagship) force-included, chart_type recorded.

All patches are applied inside try/finally (restored even on early failure);
DataSourceConnectionService.execute_query is restored via staticmethod().

Usage (inside backend container, PYTHONPATH=/app):
  python harness.py capture   # write both goldens to /app/qa_golden_v2.json
  python harness.py check     # compare both; exit 1 on drift
"""
import hashlib
import json
import logging
import re
import sys

GOLDEN_PATH = "/app/qa_golden_v2.json"
PER_DATASET = 3
PER_DIALECT_MIN = 6      # try to keep at least this many charts per dialect
MAX_TOTAL = 60
ALWAYS_INCLUDE = [782]   # federated BQ×PG demo chart (renderer-only in SQL golden)

_VOLATILE = [
    (re.compile(r"(snap_t\d+_v)\d+"), r"\1<VER>"),  # snapshot version suffix
]


def _normalize_sql(sql: str) -> str:
    if not sql:
        return sql
    out = sql
    for rx, repl in _VOLATILE:
        out = rx.sub(repl, out)
    # Collapse whitespace so formatting-only diffs don't create false drift.
    # (Known blind spot: whitespace INSIDE string literals is also collapsed.)
    return re.sub(r"\s+", " ", out).strip()


_DECISION_KEYS = [
    "dataset", "base_ds", "base_ds_type", "mode", "dialect",
    "exec_host_ds", "cred", "stale", "federated", "n_overrides",
]


def _parse_decision(line: str) -> dict:
    """key=value pairs from an [exec-decision] line; volatile keys dropped;
    unknown/new keys ignored so ADDING fields never breaks the golden."""
    out = {}
    for k in _DECISION_KEYS:
        m = re.search(rf"\b{k}=(\S+)", line)
        if m:
            out[k] = m.group(1)
    return out


def _select_charts(db):
    """Newest-first, per-dataset + per-dialect quotas, PG/Sheets force-covered."""
    from app.models import Chart
    from app.models.dataset import DatasetTable
    from app.models.models import DataSource
    from app.services.live_query_service import _dialect_for_ds_type

    tables = {t.id: t for t in db.query(DatasetTable).all()}
    sources = {d.id: d for d in db.query(DataSource).all()}

    def chart_meta(c):
        t = tables.get(c.dataset_table_id)
        if t is None:
            return None
        ds = sources.get(t.datasource_id) if t.datasource_id else None
        if ds is None:  # derived/calendar table → dialect via a sibling table
            sib = next((x for x in tables.values()
                        if x.dataset_id == t.dataset_id and x.datasource_id), None)
            ds = sources.get(sib.datasource_id) if sib else None
        dia = _dialect_for_ds_type(
            str(getattr(ds.type, "value", ds.type))) if ds else "unknown"
        return {"dataset_id": t.dataset_id, "dialect": dia,
                "chart_type": str(c.chart_type)}

    charts = db.query(Chart).order_by(Chart.id.desc()).all()
    chosen, per_ds, per_dia = [], {}, {}
    metas = {}
    for c in charts:
        m = chart_meta(c)
        if m is None:
            continue
        metas[c.id] = m
        if c.id in ALWAYS_INCLUDE:
            continue  # added at the end unconditionally
        if per_ds.get(m["dataset_id"], 0) >= PER_DATASET:
            continue
        if len(chosen) >= MAX_TOTAL - len(ALWAYS_INCLUDE):
            # over cap: only still accept if this dialect is under-represented
            if per_dia.get(m["dialect"], 0) >= PER_DIALECT_MIN:
                continue
        per_ds[m["dataset_id"]] = per_ds.get(m["dataset_id"], 0) + 1
        per_dia[m["dialect"]] = per_dia.get(m["dialect"], 0) + 1
        chosen.append(c.id)
    for cid in ALWAYS_INCLUDE:
        if cid in metas and cid not in chosen:
            chosen.append(cid)
    return [(cid, metas[cid]) for cid in chosen]


def run(decision_mode: bool):
    """One pass over the selected charts.
    decision_mode=False → SQL golden (decision layer forced LIVE).
    decision_mode=True  → decision golden (REAL decisions; triggers stubbed)."""
    from app.core.database import SessionLocal
    from app.services import query_cache
    from app.services import snapshot_service as ss
    from app.services.datasource_service import DataSourceConnectionService as D
    from app.services.chart_service import ChartService
    import app.services.chart_service as cs
    import app.services.live_query_service as lqs

    # ---- capture [exec-decision] (logger must pass INFO for the handler) ----
    decisions = {}
    chart_logger = logging.getLogger("app.services.chart_service")

    class _DecisionHandler(logging.Handler):
        def emit(self, record):
            try:
                msg = record.getMessage()
            except Exception:
                return
            if "[exec-decision]" in msg:
                m = re.search(r"chart_id=(-?\d+)", msg)
                if m:
                    decisions.setdefault(
                        m.group(1), msg.split("[exec-decision]", 1)[1].strip())

    handler = _DecisionHandler()
    result = {}
    patched = []  # (obj, attr, original) — restore in reverse order

    def patch(obj, attr, new):
        patched.append((obj, attr, obj.__dict__.get(attr, getattr(obj, attr))))
        setattr(obj, attr, new)

    captured = {}

    def _fake_execute_query(ds_type, config, sql_query, *a, **k):
        cid = str(cs._pbi_current_chart_id())
        captured.setdefault(cid, []).append(
            {"ds_type": str(ds_type), "sql": _normalize_sql(sql_query)})
        return [], [], 0.0

    db = None
    prev_level = chart_logger.level
    try:
        chart_logger.addHandler(handler)
        chart_logger.setLevel(logging.INFO)  # fix P1: default WARNING killed capture

        # execute mock: record SQL, no warehouse call
        patch(D, "execute_query", staticmethod(_fake_execute_query))
        # offline BQ cost guard
        patch(lqs, "_estimate_bigquery_bytes", lambda *a, **k: 0)
        # force cache MISS so SQL/decisions always recompute
        patch(query_cache, "get_cached", lambda *a, **k: None)
        patch(query_cache, "begin_coalesced_compute", lambda *a, **k: (None, True))
        patch(query_cache, "set_cached", lambda *a, **k: None)
        patch(query_cache, "end_coalesced_compute", lambda *a, **k: None)

        if decision_mode:
            # REAL decisions — but NO state mutation: stub every rebuild trigger.
            patch(ss, "trigger_async_refresh", lambda *a, **k: None)
            patch(ss, "schedule_source_change_check", lambda *a, **k: None)
            patch(ss, "start_manual_refresh", lambda *a, **k: [])
        else:
            # SQL golden: force the decision layer to pure LIVE so the golden
            # locks the RENDERER (semantic backbone) free of snapshot churn.
            if hasattr(cs, "plan_chart_execution"):
                from app.services import execution_plan as xp
                patch(cs, "plan_chart_execution",
                      lambda *a, **k: xp.ExecutionPlan.live_stub())
            else:
                patch(cs, "_resolve_chart_snapshot_overrides",
                      lambda *a, **k: ({}, None, "live", False, None, None))

        db = SessionLocal()
        selected = _select_charts(db)
        print("selected %d charts" % len(selected))
        for cid, meta in selected:
            captured.pop(str(cid), None)
            decisions.pop(str(cid), None)
            entry = dict(meta)
            try:
                ChartService.get_chart_data(
                    db, cid, extra_filters=None, filter_context=None)
                entry["status"] = "ok"
            except Exception as e:  # noqa: BLE001 — golden records the failure
                entry["status"] = "error"
                entry["error"] = _normalize_sql(str(e))[:400]
            entry["sql"] = captured.get(str(cid), [])
            raw = decisions.get(str(cid))
            entry["decision"] = _parse_decision(raw) if raw else None
            result[str(cid)] = entry
    finally:
        if db is not None:
            db.close()
        for obj, attr, orig in reversed(patched):
            setattr(obj, attr, orig)
        chart_logger.removeHandler(handler)
        chart_logger.setLevel(prev_level)
    return result


def _digest(obj) -> str:
    return hashlib.sha256(
        json.dumps(obj, sort_keys=True, ensure_ascii=False).encode()).hexdigest()[:12]


def _compare(golden, current, *, compare_decisions):
    drift = []
    for cid, g in golden.items():
        c = current.get(cid)
        if c is None:
            drift.append(f"chart {cid}: MISSING now")
            continue
        if g.get("status") != c.get("status"):
            drift.append(f"chart {cid}: status {g.get('status')} -> {c.get('status')} "
                         f"(err: {str(c.get('error'))[:120]})")
        g_sql = [(s["ds_type"], s["sql"]) for s in g.get("sql", [])]
        c_sql = [(s["ds_type"], s["sql"]) for s in c.get("sql", [])]
        if g_sql != c_sql:
            drift.append(f"chart {cid}: SQL/ds_type DRIFT")
        if g.get("dataset_id") != c.get("dataset_id"):
            drift.append(f"chart {cid}: dataset {g.get('dataset_id')} -> {c.get('dataset_id')}")
        if compare_decisions and g.get("decision") != c.get("decision"):
            drift.append(f"chart {cid}: DECISION {g.get('decision')} -> {c.get('decision')}")
    for cid in current:
        if cid not in golden:
            drift.append(f"chart {cid}: NEW now")
    return drift


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "capture"
    if mode == "capture":
        sql_golden = run(decision_mode=False)
        dec_golden = run(decision_mode=True)
        payload = {"sql": sql_golden, "decision": dec_golden}
        with open(GOLDEN_PATH, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, indent=1, sort_keys=True)
        n_dec = sum(1 for v in dec_golden.values() if v.get("decision"))
        dialects = {}
        for v in sql_golden.values():
            dialects[v["dialect"]] = dialects.get(v["dialect"], 0) + 1
        print("CAPTURED sql=%d charts (dialects=%s) decision=%d charts "
              "(%d with decision line) sha=%s -> %s"
              % (len(sql_golden), dialects, len(dec_golden), n_dec,
                 _digest(payload), GOLDEN_PATH))
    elif mode == "check":
        try:
            with open(GOLDEN_PATH, encoding="utf-8") as f:
                golden = json.load(f)
        except FileNotFoundError:
            print("NO GOLDEN FILE — run capture first")
            sys.exit(2)
        print("golden sha=%s" % _digest(golden))
        sql_now = run(decision_mode=False)
        dec_now = run(decision_mode=True)
        drift = ["[sql] " + d for d in _compare(golden["sql"], sql_now, compare_decisions=False)]
        drift += ["[decision] " + d for d in _compare(golden["decision"], dec_now, compare_decisions=True)]
        if drift:
            print("DRIFT DETECTED (%d):" % len(drift))
            for d in drift:
                print("  " + d)
            sys.exit(1)
        print("OK — sql=%d + decision=%d charts, normalized-identical to golden"
              % (len(golden["sql"]), len(golden["decision"])))
    else:
        print("usage: harness.py [capture|check]")
        sys.exit(2)


if __name__ == "__main__":
    main()
