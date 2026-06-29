"""Golden-output regression harness for the filter system.

Purpose
-------
Lock the BEHAVIOR (data + dropped_filters + routing + SQL pattern) of representative
filter scenarios. Every migration phase (relationship metadata → propagation engine →
per-measure isolation → symmetric aggregates) runs this harness; any divergence must
be either explicitly accepted (recapture golden with rationale) or treated as
regression and reverted.

Usage
-----
    # Capture / recapture baseline (run once, on a clean commit)
    python scripts/regression_filter_matrix.py --capture

    # Verify current state against committed golden
    python scripts/regression_filter_matrix.py --verify

    # Single case (debug)
    python scripts/regression_filter_matrix.py --verify --case G01_ds56_rev_baseline
    python scripts/regression_filter_matrix.py --capture --case G01_ds56_rev_baseline

    # Filter by tag
    python scripts/regression_filter_matrix.py --verify --tag snowflake

Exit codes
----------
    0  all selected cases pass (verify) or captured (capture)
    1  at least one case diverged (verify mode)
    2  harness error (config / DB connection)

Contracts preserved
-------------------
This harness READS via ChartService.get_chart_data — same public BE API the
HTTP endpoint /api/v1/charts/{id}/data uses. It does NOT touch engine
internals or perform any writes. Safe to run against any environment with
the fixture present.
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import sys
import traceback
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

import yaml

# Suppress noisy WARNINGS from the engine during capture; they're informational.
# (chart_contracts logs filter-drop reasons at WARNING; harness records them
# in the golden payload instead, so console noise is redundant.)
logging.getLogger("app.services.chart_contracts").setLevel(logging.ERROR)
logging.getLogger("app.services.dataset_model_service").setLevel(logging.ERROR)
logging.getLogger("app.services.datasource_service").setLevel(logging.ERROR)

from sqlalchemy import func

from app.core.database import SessionLocal
from app.models.models import Chart
from app.services.chart_service import ChartService

# Path resolution — scripts/golden/ relative to this file
SCRIPT_DIR = Path(__file__).resolve().parent
GOLDEN_DIR = SCRIPT_DIR / "golden"
CASES_FILE = GOLDEN_DIR / "cases.yaml"

# Local module — imported by relative path
sys.path.insert(0, str(SCRIPT_DIR))
from _normalize_sql import normalize_sql  # noqa: E402


# ────────────────────────────────────────────────────────────────────────────
# Data structures
# ────────────────────────────────────────────────────────────────────────────


@dataclass
class CaseDef:
    id: str
    description: str
    chart_name: str                   # resolved to id at runtime — robust to DB ID shifts
    dataset_id: int
    extra_filters: list[dict] = field(default_factory=list)
    expect_status: str = "ok"
    tags: list[str] = field(default_factory=list)
    # What golden fields to enforce in compare. Defaults match common-sense.
    comparison_keys: list[str] = field(default_factory=lambda: ["data", "row_count", "dropped_filter_reasons", "routing"])
    # SQL comparison strategy:
    #   "exact"   — normalized SQL must match byte-for-byte (after sqlglot normalize)
    #   "pattern" — golden carries `sql_patterns: [..]` substrings that must all appear
    #   "none"    — skip SQL compare; data-only enforcement
    sql_comparison: str = "pattern"   # default: pattern (less brittle to refactors)
    sql_patterns: list[str] = field(default_factory=list)


@dataclass
class CaseResult:
    status: str = "ok"                  # ok | error
    data_repr: list[dict] = field(default_factory=list)   # str-coerced for stable JSON
    row_count: int = 0
    dropped_filters: list[dict] = field(default_factory=list)
    dropped_filter_reasons: list[str] = field(default_factory=list)  # derived, easier to compare
    routing: str | None = None
    sql_normalized: str = ""
    sql_normalized_truncated: bool = False
    warnings: list[str] = field(default_factory=list)
    error: str | None = None


# ────────────────────────────────────────────────────────────────────────────
# Case loading
# ────────────────────────────────────────────────────────────────────────────


def load_cases() -> list[CaseDef]:
    if not CASES_FILE.exists():
        raise FileNotFoundError(f"cases file not found: {CASES_FILE}")
    raw = yaml.safe_load(CASES_FILE.read_text(encoding="utf-8")) or {}
    items = raw.get("cases") or []
    out: list[CaseDef] = []
    for entry in items:
        # Defensive: skip empty/malformed without crashing the whole harness.
        if not isinstance(entry, dict) or not entry.get("id"):
            continue
        cd = CaseDef(
            id=str(entry["id"]),
            description=str(entry.get("description", "")),
            chart_name=str(entry["chart_name"]),
            dataset_id=int(entry["dataset_id"]),
            extra_filters=list(entry.get("extra_filters") or []),
            expect_status=str(entry.get("expect_status", "ok")),
            tags=list(entry.get("tags") or []),
            comparison_keys=list(entry.get("comparison_keys") or ["data", "row_count", "dropped_filter_reasons", "routing"]),
            sql_comparison=str(entry.get("sql_comparison", "pattern")),
            sql_patterns=list(entry.get("sql_patterns") or []),
        )
        out.append(cd)
    return out


# ────────────────────────────────────────────────────────────────────────────
# Chart resolution
# ────────────────────────────────────────────────────────────────────────────


def resolve_chart_id(db, chart_name: str) -> int | None:
    """Case-insensitive trim match — same uniqueness contract as Chart.name index."""
    row = (
        db.query(Chart.id)
        .filter(func.lower(func.trim(Chart.name)) == chart_name.strip().lower())
        .first()
    )
    return row[0] if row else None


# ────────────────────────────────────────────────────────────────────────────
# Case execution
# ────────────────────────────────────────────────────────────────────────────


# Soft cap so single SQL doesn't bloat golden files. Truncated SQL still
# compares correctly under "pattern" mode; "exact" mode warns if truncated.
SQL_NORMALIZED_MAX = 6000


def _stringify_data(rows: list[dict]) -> list[dict]:
    """Coerce all cell values to str so Decimal/date/etc. serialize stably.

    None preserved as None (not 'None') so golden distinguishes missing vs string 'None'.
    """
    out: list[dict] = []
    for r in rows or []:
        if not isinstance(r, dict):
            continue
        out.append({k: (None if v is None else str(v)) for k, v in r.items()})
    return out


def _extract_drop_reasons(dropped: list[dict]) -> list[str]:
    """Sorted list of unique drop reasons. Easier to diff than full dropped objects."""
    if not dropped:
        return []
    reasons: list[str] = []
    for d in dropped:
        if not isinstance(d, dict):
            continue
        r = str(d.get("reason") or "").strip()
        if r:
            reasons.append(r)
    return sorted(set(reasons))


def run_case(case: CaseDef) -> CaseResult:
    """Execute one case via ChartService.get_chart_data (the canonical BE entry).

    Returns CaseResult with everything needed to diff against golden. NEVER raises
    — engine exceptions become CaseResult(status='error', error=<msg>).
    """
    db = SessionLocal()
    try:
        chart_id = resolve_chart_id(db, case.chart_name)
        if chart_id is None:
            return CaseResult(
                status="error",
                error=f"Chart not found by name: {case.chart_name!r}. "
                      f"Seed dataset {case.dataset_id} fixture first.",
            )

        extras = case.extra_filters if case.extra_filters else None
        try:
            res = ChartService.get_chart_data(db, chart_id, extra_filters=extras)
        except Exception as exc:
            return CaseResult(
                status="error",
                error=f"{type(exc).__name__}: {exc}",
            )

        # Normalize debug payload (handle list-of-sql when per_measure isolation lands)
        debug = res.get("debug") or {}
        sql_field = debug.get("sql_emitted")
        if isinstance(sql_field, list):
            # Phase 3 future: each entry is dict with 'fact_view' and 'sql'.
            # Concatenate normalized forms with separator for diff.
            parts = []
            for entry in sql_field:
                s = entry.get("sql") if isinstance(entry, dict) else str(entry)
                parts.append(normalize_sql(s or ""))
            sql_norm = "\n-----PER-MEASURE-GROUP-----\n".join(parts)
        else:
            sql_norm = normalize_sql(sql_field or "")

        truncated = False
        if len(sql_norm) > SQL_NORMALIZED_MAX:
            sql_norm = sql_norm[:SQL_NORMALIZED_MAX] + " ...[truncated]"
            truncated = True

        dropped = debug.get("dropped_filters") or []
        return CaseResult(
            status="ok",
            data_repr=_stringify_data(res.get("data") or []),
            row_count=len(res.get("data") or []),
            dropped_filters=dropped if isinstance(dropped, list) else [],
            dropped_filter_reasons=_extract_drop_reasons(dropped if isinstance(dropped, list) else []),
            routing=debug.get("routing"),
            sql_normalized=sql_norm,
            sql_normalized_truncated=truncated,
            warnings=list(debug.get("warnings") or []),
        )
    finally:
        db.close()


# ────────────────────────────────────────────────────────────────────────────
# Golden I/O
# ────────────────────────────────────────────────────────────────────────────


def golden_path(case_id: str) -> Path:
    return GOLDEN_DIR / f"{case_id}.json"


def capture_case(case: CaseDef, commit_sha: str) -> CaseResult:
    """Run case and overwrite its golden file. Returns the captured result."""
    result = run_case(case)
    payload = {
        "case_id": case.id,
        "description": case.description,
        "chart_name": case.chart_name,
        "dataset_id": case.dataset_id,
        "captured_at": datetime.now(timezone.utc).isoformat(),
        "captured_at_commit": commit_sha,
        "expect_status": case.expect_status,
        "tags": case.tags,
        "comparison_keys": case.comparison_keys,
        "sql_comparison": case.sql_comparison,
        "sql_patterns": case.sql_patterns,
        "result": asdict(result),
    }
    GOLDEN_DIR.mkdir(parents=True, exist_ok=True)
    golden_path(case.id).write_text(
        json.dumps(payload, indent=2, ensure_ascii=False, sort_keys=False),
        encoding="utf-8",
    )
    return result


def verify_case(case: CaseDef) -> tuple[bool, list[str]]:
    """Compare current run to committed golden. Return (passed, diff_messages)."""
    gp = golden_path(case.id)
    if not gp.exists():
        return False, [f"NO GOLDEN FILE: {gp.name} — run `--capture --case {case.id}` to create"]

    try:
        blob = json.loads(gp.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        return False, [f"Corrupt golden JSON: {exc}"]

    golden = blob.get("result") or {}
    keys = blob.get("comparison_keys") or case.comparison_keys
    sql_mode = blob.get("sql_comparison") or case.sql_comparison
    sql_patterns = blob.get("sql_patterns") or case.sql_patterns

    actual_result = run_case(case)
    actual = asdict(actual_result)

    diffs: list[str] = []

    # Status mismatch — most important
    if golden.get("status") != actual.get("status"):
        diffs.append(f"status: golden={golden.get('status')!r} actual={actual.get('status')!r}")
        if actual.get("error"):
            diffs.append(f"  actual error: {actual['error']}")

    # Compare requested keys
    for key in keys:
        if key == "data":
            g_data = golden.get("data_repr") if "data_repr" in golden else golden.get("data")
            a_data = actual.get("data_repr")
            if g_data != a_data:
                diffs.append(
                    f"data differ:\n"
                    f"  golden ({len(g_data or [])} rows): {_short_repr(g_data)}\n"
                    f"  actual ({len(a_data or [])} rows): {_short_repr(a_data)}"
                )
        elif key == "row_count":
            if golden.get("row_count") != actual.get("row_count"):
                diffs.append(f"row_count: golden={golden.get('row_count')} actual={actual.get('row_count')}")
        elif key == "dropped_filter_reasons":
            g_reasons = sorted(set(golden.get("dropped_filter_reasons") or []))
            a_reasons = sorted(set(actual.get("dropped_filter_reasons") or []))
            if g_reasons != a_reasons:
                diffs.append(f"dropped_filter_reasons: golden={g_reasons} actual={a_reasons}")
        elif key == "routing":
            if golden.get("routing") != actual.get("routing"):
                diffs.append(f"routing: golden={golden.get('routing')!r} actual={actual.get('routing')!r}")
        else:
            # Generic key compare
            if golden.get(key) != actual.get(key):
                diffs.append(f"{key}: golden={golden.get(key)!r} actual={actual.get(key)!r}")

    # SQL compare
    g_sql = golden.get("sql_normalized") or ""
    a_sql = actual.get("sql_normalized") or ""
    if sql_mode == "exact":
        if g_sql != a_sql:
            diffs.append(
                f"sql_normalized exact-mismatch:\n"
                f"--- golden ({len(g_sql)} chars) ---\n{g_sql[:500]}\n"
                f"--- actual ({len(a_sql)} chars) ---\n{a_sql[:500]}"
            )
    elif sql_mode == "pattern":
        for pat in sql_patterns:
            if pat not in a_sql:
                diffs.append(f"sql missing required pattern: {pat!r}")
    # 'none' → skip SQL compare

    return len(diffs) == 0, diffs


def _short_repr(data, max_rows: int = 5) -> str:
    """Compact data preview for diff output. Truncates at 5 rows."""
    if not data:
        return "[]"
    truncated = data[:max_rows]
    suffix = f" ... +{len(data) - max_rows} more" if len(data) > max_rows else ""
    return json.dumps(truncated, ensure_ascii=False) + suffix


# ────────────────────────────────────────────────────────────────────────────
# CLI
# ────────────────────────────────────────────────────────────────────────────


def _filter_cases(
    cases: list[CaseDef],
    case_id: str | None,
    tag: str | None,
    cases_csv: str | None = None,
) -> list[CaseDef]:
    out = cases
    if case_id:
        out = [c for c in out if c.id == case_id]
    if cases_csv:
        wanted = {s.strip() for s in cases_csv.split(",") if s.strip()}
        out = [c for c in out if c.id in wanted]
    if tag:
        out = [c for c in out if tag in c.tags]
    return out


def main():
    ap = argparse.ArgumentParser(description="Golden-output regression harness for filter system")
    mode = ap.add_mutually_exclusive_group(required=True)
    mode.add_argument("--capture", action="store_true", help="(Re)capture golden for selected cases")
    mode.add_argument("--verify", action="store_true", help="Verify current run matches committed golden")
    ap.add_argument("--case", help="Run only this case id")
    ap.add_argument("--cases", help="Run only this comma-separated set of case ids (CI gate uses this)")
    ap.add_argument("--tag", help="Filter cases by tag")
    ap.add_argument("--commit", default=os.environ.get("GIT_COMMIT", "unknown"),
                    help="Commit SHA to stamp into captured golden (default $GIT_COMMIT or 'unknown')")
    args = ap.parse_args()

    try:
        all_cases = load_cases()
    except FileNotFoundError as exc:
        print(f"[FATAL] {exc}", file=sys.stderr)
        sys.exit(2)
    except Exception as exc:
        print(f"[FATAL] failed to load cases.yaml: {exc}", file=sys.stderr)
        sys.exit(2)

    cases = _filter_cases(all_cases, args.case, args.tag, args.cases)
    if not cases:
        filt = f" (case={args.case})" if args.case else ""
        filt += f" (cases={args.cases})" if args.cases else ""
        filt += f" (tag={args.tag})" if args.tag else ""
        print(f"[WARN] no cases matched{filt}; aborting", file=sys.stderr)
        sys.exit(2)

    if args.capture:
        print(f"[capture] processing {len(cases)} case(s)...")
        for c in cases:
            try:
                r = capture_case(c, args.commit)
                marker = "✓" if r.status == "ok" else "✗"
                detail = f"{r.row_count} rows, drops={r.dropped_filter_reasons}"
                if r.error:
                    detail = f"ERROR: {r.error}"
                print(f"  {marker} {c.id}: {detail}")
            except Exception as exc:
                print(f"  ✗ {c.id}: HARNESS ERROR: {exc}")
                traceback.print_exc()
        print(f"\n[capture] wrote {len(cases)} golden file(s) to {GOLDEN_DIR}")
        sys.exit(0)

    # verify mode
    print(f"[verify] checking {len(cases)} case(s) against golden...")
    fail_ids: list[str] = []
    for c in cases:
        try:
            ok, diffs = verify_case(c)
        except Exception as exc:
            ok, diffs = False, [f"HARNESS ERROR: {type(exc).__name__}: {exc}"]
            traceback.print_exc()
        marker = "✓" if ok else "✗"
        print(f"  {marker} {c.id}  —  {c.description}")
        if not ok:
            for d in diffs:
                for line in d.splitlines():
                    print(f"      {line}")
            fail_ids.append(c.id)

    print()
    if fail_ids:
        print(f"[FAIL] {len(fail_ids)}/{len(cases)} case(s) diverged:")
        for fid in fail_ids:
            print(f"  - {fid}")
        print("\nIf the divergence is INTENTIONAL (phase change):")
        print(f"  python scripts/regression_filter_matrix.py --capture --case <id>")
        print("Commit the updated golden file with rationale in the commit message.")
        sys.exit(1)
    print(f"[PASS] {len(cases)}/{len(cases)} case(s) match golden")
    sys.exit(0)


if __name__ == "__main__":
    main()
