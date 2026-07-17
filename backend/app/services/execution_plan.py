"""
Execution planning for the semantic chart runtime (pipeline refactor Phase 1+2).

Phase 1 — CONTRACTS: ``ExecutionPlan`` / ``SnapshotState`` give the physical
execution decision a single, typed, observable shape (mode, dialect, credential,
snapshot refs, freshness, why) instead of five loose ``_snap_*`` locals.

Phase 2 — PLANNER: ``plan_chart_execution()`` is the ONE place that decides how
a semantic chart request executes physically. It replaces the decision logic
previously scattered through ``chart_service`` (`_resolve_chart_snapshot_overrides`
+ `_assert_dataset_single_engine` + the dialect/credential forcing block), with
two deliberate fixes:

  * ORDERING (issue #5): the mixed-engine check now runs AFTER snapshot
    resolution. A dataset that mixes sources (e.g. BigQuery facts + a Postgres
    dim) is fine when every table is materialized into the host BigQuery — it
    is only blocked when it would have to run LIVE (one SQL cannot join across
    engines). The old guard ran first and (had it not been dead code due to a
    bad import) would have blocked exactly the federation case it was meant to
    allow.
  * SCOPE (issue #6, first slice): only ``enabled`` tables are considered by
    both the engine-span check and snapshot eligibility, so a disabled/legacy
    table can no longer knock a whole dataset off the snapshot path. (Scoping
    down to "only the views this chart's query actually touches" needs the
    recursion-reachable view set and is deferred to a later phase — see the
    measure-isolation re-anchor notes in semantic_query_engine.)

The planner NEVER raises: a planning failure degrades to a live plan (same
contract as the old resolver — "snapshot must never break a chart"). A request
that CANNOT run at all (mixed engines without a complete snapshot) is expressed
as ``plan.blocked`` — a clear, actionable message the runtime raises as a
ValueError → 400, instead of the engine leaking one dialect's SQL into another
and failing with a cryptic parser error.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import Any, Dict, Optional

from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)


class SnapshotState(str, Enum):
    """Why the plan is (or is not) snapshot-backed. LIVE/FRESH/STALE/NOT_BUILT
    are produced today; INCOMPATIBLE/MISSING are reserved for the
    reconcile-on-read phase (fingerprint drift / physical table gone)."""

    LIVE = "live"
    FRESH = "fresh"
    STALE = "stale"
    NOT_BUILT = "not_built"
    INCOMPATIBLE = "incompatible"  # reserved (Phase 5)
    MISSING = "missing"            # reserved (Phase 5)


@dataclass(frozen=True)
class ExecutionPlan:
    """Complete physical execution decision for ONE semantic chart request.

    ``mode``            "live" | "snapshot".
    ``dialect``/``ds_type``  the engine the SQL must be rendered for / executed
                        on. For mode="snapshot" these are ALWAYS "bigquery"
                        (snapshot refs render as BigQuery tables in the host).
                        For mode="live" they are informational — the runtime
                        keeps its own locals so the live path stays
                        byte-identical to the pre-planner behaviour.
    ``exec_config``     credential/config for execute_query. None → the
                        datasource's own config (live). Non-None → the host's
                        snapshot (service-account) config.
    ``cred``            "source_datasource" | "host_service_account" (log/debug).
    ``overrides``       {dataset_table_id -> snapshot physical_ref} for the
                        engine's FROM-clause redirect. Empty → live SQL.
    ``federated``       dataset ENGINE-SPAN flag: True when the dataset's
                        enabled non-calendar tables live on >1 SQL dialect.
                        (Not "base datasource isn't BigQuery" — a BigQuery-based
                        chart in a mixed dataset is just as federated: it has NO
                        live fallback because live SQL would join across
                        engines.)
    ``blocked``         None, or a user-facing message meaning "this request
                        cannot run in this state" — the runtime raises it.
    ``trigger_dataset_id``  dataset to warm/rebuild in the background.
    ``reason``          one human-readable line for the [exec-decision] log.
    """

    mode: str
    dialect: str
    ds_type: str
    exec_config: Any
    cred: str
    snapshot_state: SnapshotState
    overrides: Dict[int, str] = field(default_factory=dict)
    as_of: Optional[datetime] = None
    stale: bool = False
    federated: bool = False
    host_id: Optional[int] = None
    dataset_id: Optional[int] = None
    trigger_dataset_id: Optional[int] = None
    reason: str = ""
    blocked: Optional[str] = None

    @classmethod
    def live_stub(cls) -> "ExecutionPlan":
        """Test/QA helper: force the pure-live path (no snapshot layer). Used by
        the golden harness to lock the semantic RENDERER free of snapshot state."""
        return cls(
            mode="live", dialect="", ds_type="", exec_config=None,
            cred="source_datasource", snapshot_state=SnapshotState.LIVE,
            reason="forced live (test stub)",
        )


def _resolve_dataset_id(db: Session, binding: dict, base_view_name: str) -> Optional[int]:
    """The chart's dataset id — from binding.datasetId, else via the base view.
    Shared by span + snapshot resolution so BOTH see the same dataset even on
    the preview path (whose binding may lack datasetId — the gap that made the
    old cross-source guard silently skip). Int-coerced: the binding value comes
    from author-controlled chart config JSON."""
    from app.models.dataset import DatasetTable
    from app.models.semantic import SemanticView

    raw = binding.get("datasetId")
    if raw is not None:
        try:
            return int(raw)
        except (TypeError, ValueError):
            pass
    if base_view_name:
        bv = db.query(SemanticView).filter(SemanticView.name == base_view_name).first()
        if bv is not None and getattr(bv, "dataset_table_id", None):
            bt = db.query(DatasetTable).filter(DatasetTable.id == bv.dataset_table_id).first()
            if bt is not None:
                return bt.dataset_id
    return None


def plan_chart_execution(
    db: Session,
    datasource,
    binding: dict,
    base_view_name: str,
    *,
    ttl_minutes: Optional[int] = None,
) -> ExecutionPlan:
    """Decide how this semantic chart request executes physically.

    Decision order (the issue-#5 fix lives in this ordering):
      1. Resolve the dataset + its ENGINE SPAN (enabled, non-calendar tables).
      2. Try the snapshot path (host + all-or-nothing current refs) — a fully
         materialized dataset runs in the host BigQuery on the SA credential,
         mixed-source or not.
      3. Only if the request must run LIVE: a single-engine dataset runs live
         unchanged; a mixed-engine dataset is BLOCKED with a clear message
         (live SQL cannot join across engines) + a background warm-up when a
         host exists.

    ``ttl_minutes`` semantics unchanged from the old resolver: None → builder /
    authed (serve current snapshot at any age, no auto-rebuild); 0 → realtime
    (bypass snapshots); >0 → public per-link TTL (serve-stale-then-async).
    NEVER raises — planning failure degrades to a live plan."""
    base_ds_type = str(getattr(datasource.type, "value", datasource.type)).lower()
    from app.services.live_query_service import _dialect_for_ds_type
    base_dialect = _dialect_for_ds_type(base_ds_type)

    def live(
        reason: str,
        *,
        state: SnapshotState = SnapshotState.LIVE,
        trigger: Optional[int] = None,
        blocked: Optional[str] = None,
        federated: bool = False,
        dataset_id: Optional[int] = None,
    ) -> ExecutionPlan:
        return ExecutionPlan(
            mode="live", dialect=base_dialect, ds_type=base_ds_type,
            exec_config=None, cred="source_datasource", snapshot_state=state,
            federated=federated, dataset_id=dataset_id,
            trigger_dataset_id=trigger, reason=reason, blocked=blocked,
        )

    try:
        from app.models.dataset import DatasetTable
        from app.models.models import DataSource
        from app.services import snapshot_service
        from app.services.dataset_calendar_service import is_generated_calendar_table

        dataset_id = _resolve_dataset_id(db, binding, base_view_name)
        if not dataset_id:
            return live("no dataset resolved from binding/base view")

        # Enabled tables only (issue #6 first slice): a disabled table must not
        # block snapshots or flag a phantom engine mix. `enabled` is nullable —
        # NULL means enabled (column default True on old rows).
        tables = (
            db.query(DatasetTable)
            .filter(DatasetTable.dataset_id == dataset_id)
            .filter((DatasetTable.enabled.is_(None)) | (DatasetTable.enabled == True))  # noqa: E712
            .all()
        )
        noncal = [t for t in tables if not is_generated_calendar_table(t)]

        # Engine span: which SQL dialects do this dataset's sources need?
        ds_ids = sorted({t.datasource_id for t in noncal if t.datasource_id})
        ds_rows = (
            db.query(DataSource).filter(DataSource.id.in_(ds_ids)).all() if ds_ids else []
        )
        by_dialect: Dict[str, list] = {}
        for d in ds_rows:
            dia = _dialect_for_ds_type(str(getattr(d.type, "value", d.type)).lower())
            by_dialect.setdefault(dia, []).append(getattr(d, "name", None) or f"#{d.id}")
        federated = len(by_dialect) > 1
        engines_txt = "; ".join(f"{k} ({', '.join(v)})" for k, v in sorted(by_dialect.items()))
        mixed_pre = (
            f"Dataset này trộn nhiều nguồn khác engine ({engines_txt}) nên một "
            "biểu đồ không thể chạy trực tiếp (live) — một truy vấn SQL chỉ chạy "
            "được trên MỘT engine. "
        )

        # ── Realtime (ttl=0): bypass snapshots ────────────────────────────────
        if ttl_minutes == 0:
            if federated:
                return live(
                    "realtime requested but dataset is mixed-engine",
                    federated=True, dataset_id=dataset_id,
                    blocked=mixed_pre + "Chế độ Realtime (TTL=0) bỏ qua snapshot "
                    "hợp nhất nên không dùng được với dataset trộn nguồn — chọn "
                    "chế độ làm mới khác cho public link, hoặc tách dataset theo nguồn.",
                )
            return live("realtime (ttl=0) → bypass snapshots", dataset_id=dataset_id)

        # ── Snapshot path (all-or-nothing over the dataset's enabled tables) ──
        host = snapshot_service.resolve_host(db, dataset_id)
        if host is None:
            if federated:
                return live(
                    "mixed-engine dataset without a materialization host",
                    federated=True, dataset_id=dataset_id,
                    blocked=mixed_pre + "Cần một kết nối BigQuery đã bật "
                    "materialization làm host để hệ thống tự đồng bộ mọi nguồn về "
                    "snapshot BigQuery, hoặc tách dataset theo nguồn.",
                )
            return live("no materialization host (not BigQuery or not opted-in)",
                        dataset_id=dataset_id)

        mat_tables = []
        for t in noncal:
            if not snapshot_service.is_federated_materializable(t):
                if federated:
                    return live(
                        "mixed-engine dataset with a non-materializable (derived) table",
                        federated=True, dataset_id=dataset_id,
                        blocked=mixed_pre + "Dataset có bảng dẫn xuất (derived) chưa "
                        "hỗ trợ đồng bộ snapshot nên không thể hợp nhất về một engine. "
                        "Chuyển bảng dẫn xuất thành bảng SQL trên nguồn, hoặc tách "
                        "dataset theo nguồn.",
                    )
                return live("non-materializable table (derived) → live",
                            dataset_id=dataset_id)
            mat_tables.append(t)
        if not mat_tables:
            return live("no materializable tables", dataset_id=dataset_id)

        overrides: Dict[int, str] = {}
        for t in mat_tables:
            ref = snapshot_service.resolve_current_ref(db, t.id, ttl_minutes=None)
            if ref is None:
                # Not built yet → warm in the background. Single-engine dataset
                # serves live meanwhile; mixed-engine CANNOT run live → blocked
                # with a "building" message (same trigger keeps warming it).
                if federated:
                    return live(
                        "mixed-engine dataset, snapshot not built yet (warming)",
                        state=SnapshotState.NOT_BUILT, trigger=dataset_id,
                        federated=True, dataset_id=dataset_id,
                        blocked=mixed_pre + "Snapshot hợp nhất trên BigQuery đang "
                        "được dựng ở nền — thử lại sau giây lát, hoặc bấm Refresh "
                        "trên Dataset.",
                    )
                return live("snapshot not built yet → live + background warm",
                            state=SnapshotState.NOT_BUILT, trigger=dataset_id,
                            dataset_id=dataset_id)
            overrides[t.id] = ref

        as_of = snapshot_service.as_of(db, list(overrides.keys()))
        stale = snapshot_service.is_stale(as_of, ttl_minutes)
        # Change-driven refresh: rate-limited background check — rebuild if the
        # SOURCE DATA changed since build (works for builder too; no TTL needed).
        snapshot_service.schedule_source_change_check(dataset_id)

        from app.services.datasource_service import DataSourceConnectionService

        return ExecutionPlan(
            mode="snapshot",
            # Snapshot refs render as BigQuery tables in the host → the WHOLE
            # statement (calendar, time-grain, quoting, functions) must be
            # BigQuery, whatever the base datasource is.
            dialect="bigquery", ds_type="bigquery",
            exec_config=DataSourceConnectionService.snapshot_query_config(host.config),
            cred="host_service_account",
            snapshot_state=SnapshotState.STALE if stale else SnapshotState.FRESH,
            overrides=overrides, as_of=as_of, stale=stale,
            federated=federated, host_id=host.id, dataset_id=dataset_id,
            trigger_dataset_id=(dataset_id if stale else None),
            reason=("all tables snapshot-backed in host BigQuery"
                    + (" (mixed-engine dataset federated into host)" if federated else "")),
        )
    except Exception:  # noqa: BLE001 — planning must NEVER break a chart
        logger.warning("[exec-plan] planning failed; falling back to live", exc_info=True)
        return live("planner error → live fallback")
