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

import contextlib
import contextvars
import logging
import threading
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
    # Phase 4 — the snapshot GENERATION this plan reads (one refresh batch =
    # one id). Cache identity should key on this, not on a timestamp: two
    # different physical snapshot sets can share the same oldest-built_at.
    generation: Optional[int] = None
    # Phase 1 — published-only: this plan is PINNED to a published generation;
    # on a missing/broken snapshot it must BLOCK (re-sync), NEVER fall back to
    # live or a previous generation (the execute path checks this flag).
    published: bool = False
    # Phase 1 — security scope baked into the cache key so a future per-tenant/
    # per-user snapshot can never be served across principals.
    security_scope: Optional[str] = None
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


class ReadScope:
    """ONE logical read — a public page batch, an AI turn, an export page — sees
    ONE snapshot generation per dataset (the dashboard generation contract).

    Each tile resolves its generation independently, so a read straddling a
    publish (the pointer flips N → N+1 between two tiles) used to draw tile A
    from N and tile B from N+1 under one "data as of" label. The first tile of
    a dataset in the scope fixes its generation; every later tile of that
    dataset in the same scope is served the SAME one (or refused when it is no
    longer servable) — never the other. Thread-safe: a batch plans its tiles in
    a thread pool."""

    def __init__(self) -> None:
        self._pins: Dict[int, Optional[int]] = {}
        self._lock = threading.Lock()

    def pin(self, dataset_id: Any, generation: Optional[int]) -> Optional[int]:
        """The generation this read serves for ``dataset_id``: the first one
        seen, else ``generation`` (which then becomes the pin)."""
        with self._lock:
            return self._pins.setdefault(int(dataset_id), generation)

    def pins(self) -> Dict[int, Optional[int]]:
        with self._lock:
            return dict(self._pins)


_read_scope_var: contextvars.ContextVar[Optional[ReadScope]] = contextvars.ContextVar(
    "appbi_read_scope", default=None,
)


def current_read_scope() -> Optional[ReadScope]:
    return _read_scope_var.get()


@contextlib.contextmanager
def read_scope(scope: Optional[ReadScope] = None):
    """Run a logical read under ``scope`` (a new one when omitted; the current
    one is kept when already inside a read)."""
    active = scope or _read_scope_var.get() or ReadScope()
    token = _read_scope_var.set(active)
    try:
        yield active
    finally:
        _read_scope_var.reset(token)


def _pinned_generation(dataset_id: Any, generation: Optional[int]) -> Optional[int]:
    scope = _read_scope_var.get()
    if scope is None or dataset_id is None:
        return generation
    return scope.pin(dataset_id, generation)


_GENERATION_MOVED = (
    "Dữ liệu của dataset vừa được cập nhật trong lúc tải báo cáo — tải lại để xem cùng một phiên bản "
    "dữ liệu cho mọi biểu đồ."
)


def plan_chart_execution(
    db: Session,
    datasource,
    binding: dict,
    base_view_name: str,
    *,
    ttl_minutes: Optional[int] = None,
    is_preview: bool = False,
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

        # ── Phase 1 — PUBLISHED-ONLY gate ─────────────────────────────────────
        # A dataset under the publish lifecycle (publish_state != NULL) is served
        # ONLY from its pinned published generation — never live, never "newest",
        # never a fallback. A LEGACY dataset (publish_state NULL) falls straight
        # through to the existing behaviour below (no change → no broken
        # dashboards). Preview/Explore (is_preview) on an un-published design is
        # allowed to run live — that's design-time, not a Dashboard.
        from app.models.dataset import Dataset as _Dataset
        dataset_obj = db.query(_Dataset).filter(_Dataset.id == dataset_id).first()
        # OPERATIONAL (Workboard live DB) → NEVER materialized: always run live,
        # no host resolution, no background snapshot warm.
        if dataset_obj is not None and snapshot_service.is_operational_dataset(dataset_obj):
            return live("operational dataset — live only (never materialized)", dataset_id=dataset_id)
        if dataset_obj is not None and getattr(dataset_obj, "publish_state", None) is not None:
            return _plan_published(db, dataset_obj, base_view_name, is_preview=is_preview)

        # Phase 5 — model self-heal: background, rate-limited check that the
        # semantic views still mirror columns_cache; resyncs when drifted so a
        # schema change no longer requires a manual Dataset visit (issue #23).
        try:
            from app.services.dataset_model_service import schedule_model_drift_check
            schedule_model_drift_check(dataset_id)
        except Exception:  # noqa: BLE001 — self-heal must never break planning
            pass

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

        # Phase 4 — resolve ONE consistent generation for ALL tables (never a
        # torn half-old/half-new mix while a rebuild is mid-flight).
        overrides, stored_fps, generation, as_of = snapshot_service.resolve_generation_refs(
            db, [t.id for t in mat_tables]
        )
        # One read, one generation per dataset (ReadScope): a later tile of this
        # read is served the generation its first tile was — never the newer one.
        if overrides and generation is not None:
            pinned = _pinned_generation(dataset_id, generation)
            if pinned != generation:
                if pinned is None:
                    return live(_GENERATION_MOVED, dataset_id=dataset_id, blocked=_GENERATION_MOVED)
                overrides, stored_fps, as_of = snapshot_service.resolve_specific_generation_refs(
                    db, [t.id for t in mat_tables], pinned
                )
                if not overrides:
                    return live(_GENERATION_MOVED, dataset_id=dataset_id, blocked=_GENERATION_MOVED)
                generation = pinned
        if not overrides:
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

        # Phase 5 — fingerprint reconcile-on-read (issue #12): a snapshot whose
        # stored fingerprint no longer matches the CURRENT table definition
        # (source SQL / schema / columns_cache drift) is INCOMPATIBLE — old
        # logic must not keep serving silently just because it is young.
        from app.models.dataset import Dataset as _Dataset
        dataset_obj = db.query(_Dataset).filter(_Dataset.id == dataset_id).first()
        ds_by_id = {d.id: d for d in ds_rows}
        incompatible = None
        for t in mat_tables:
            src_ds = ds_by_id.get(t.datasource_id)
            if src_ds is None or dataset_obj is None:
                continue  # cannot verify → serve as-is (unknown ≠ incompatible)
            expected = snapshot_service.current_fingerprint_for_table(db, dataset_obj, t, src_ds)
            if expected is not None and stored_fps.get(t.id) not in (None, expected):
                incompatible = t.id
                break
        if incompatible is not None:
            if federated:
                return live(
                    f"snapshot INCOMPATIBLE (definition changed, table {incompatible}) — rebuilding",
                    state=SnapshotState.INCOMPATIBLE, trigger=dataset_id,
                    federated=True, dataset_id=dataset_id,
                    blocked=mixed_pre + "Định nghĩa dataset vừa thay đổi nên snapshot "
                    "hợp nhất đang được dựng lại ở nền — thử lại sau giây lát, hoặc "
                    "bấm Refresh trên Dataset.",
                )
            return live(
                f"snapshot INCOMPATIBLE (definition changed, table {incompatible}) → live + rebuild",
                state=SnapshotState.INCOMPATIBLE, trigger=dataset_id,
                dataset_id=dataset_id,
            )

        # Calendar (best-effort) — semantic-audit 2026-07 (#3): mirror
        # _plan_published. The legacy path excluded the generated calendar from
        # `overrides`, so role-played date-dim views fell back to their
        # SYNC-dialect inline calendar SQL — executed on the BigQuery snapshot
        # host that SQL 400s for Sheets/PG-sourced datasets. Point the Date view
        # (and through the engine's role-dim redirect, every date-dim) at the
        # materialized calendar when THIS generation has one; older generations
        # without it keep the inline fallback (now dialect-corrected engine-side).
        cal_ids = [t.id for t in tables if is_generated_calendar_table(t)]
        if cal_ids and generation is not None:
            cal_refs, _cf, _ca = snapshot_service.resolve_specific_generation_refs(
                db, cal_ids, generation
            )
            if cal_refs:
                overrides = {**overrides, **cal_refs}

        stale = snapshot_service.is_stale(as_of, ttl_minutes)
        # Change-driven refresh: rate-limited background check — rebuild if the
        # SOURCE DATA changed since build (works for builder too; no TTL needed).
        snapshot_service.schedule_source_change_check(dataset_id)

        from app.services.datasource_service import DataSourceConnectionService

        # Issue #1: the execution HOST must be the one that BUILT the generation
        # we're serving — not an independently resolved host that may point at a
        # different project/credential. Fall back to `host` only for legacy
        # (generation NULL) rows.
        gen_host = snapshot_service.host_for_generation(db, dataset_id, generation) or host

        return ExecutionPlan(
            mode="snapshot",
            # Snapshot refs render as BigQuery tables in the host → the WHOLE
            # statement (calendar, time-grain, quoting, functions) must be
            # BigQuery, whatever the base datasource is.
            dialect="bigquery", ds_type="bigquery",
            exec_config=DataSourceConnectionService.snapshot_query_config(gen_host.config),
            cred="host_service_account",
            snapshot_state=SnapshotState.STALE if stale else SnapshotState.FRESH,
            overrides=overrides, as_of=as_of, stale=stale,
            federated=federated, host_id=gen_host.id, dataset_id=dataset_id,
            trigger_dataset_id=(dataset_id if stale else None),
            generation=generation,
            reason=("all tables snapshot-backed in host BigQuery"
                    + (f" (generation {generation})" if generation else " (legacy per-table refs)")
                    + (" (mixed-engine dataset federated into host)" if federated else "")),
        )
    except Exception:  # noqa: BLE001 — planning must NEVER break a chart
        logger.warning("[exec-plan] planning failed; falling back to live", exc_info=True)
        # Fail-CLOSED for a PUBLISHED dataset. The published contract (Pair #5) is
        # "served ONLY from the pinned published generation — never live". If the
        # published plan cannot be CONSTRUCTED (not just executed), a silent live
        # fallback would show un-published source numbers under a published
        # intent. Block with a clear message instead, mirroring the execution-time
        # refusal. A LEGACY (publish_state NULL) dataset keeps the live fallback.
        try:
            ds_id = _resolve_dataset_id(db, binding, base_view_name)
            if ds_id and not is_preview:
                from app.models.dataset import Dataset as _Dataset
                from app.services import snapshot_service as _ss
                _d = db.query(_Dataset).filter(_Dataset.id == ds_id).first()
                if (_d is not None and getattr(_d, "publish_state", None) is not None
                        and not _ss.is_operational_dataset(_d)):
                    return live(
                        "planner error on a PUBLISHED dataset → blocked (no live fallback)",
                        dataset_id=ds_id,
                        blocked="Không lập được kế hoạch đọc snapshot đã phát hành của Dataset "
                        "(có thể cấu hình/registry lỗi). Dashboard không tự chạy trực tiếp (live) "
                        "để tránh hiển thị số liệu chưa được phát hành — vào Dataset bấm "
                        "“Sync & Publish” để dựng lại.",
                    )
        except Exception:  # noqa: BLE001 — never break the block decision
            pass
        # Issue #5: fail-CLOSED for mixed-engine datasets. A silent live fallback
        # on a dataset that spans >1 engine would generate cross-engine SQL and
        # leak one dialect into another. Cheap re-probe of the engine span; if
        # mixed → BLOCK with a clear message instead of leaking.
        try:
            ds_id = _resolve_dataset_id(db, binding, base_view_name)
            if ds_id and _dataset_is_mixed_engine(db, ds_id):
                return live(
                    "planner error on a mixed-engine dataset → blocked (no cross-engine live)",
                    federated=True, dataset_id=ds_id,
                    blocked="Dataset này trộn nhiều nguồn khác engine và hệ thống gặp lỗi "
                    "khi lập kế hoạch thực thi — không thể chạy trực tiếp (một truy vấn "
                    "chỉ chạy trên MỘT engine). Thử lại, hoặc bấm Refresh trên Dataset; "
                    "nếu lặp lại, báo dev kiểm tra cấu hình dataset.",
                )
        except Exception:  # noqa: BLE001
            pass
        return live("planner error → live fallback")


def _unpublished_dashboard_message(db: Session, dataset_obj, state) -> str:
    """Message for a Dashboard chart on an un-published dataset. Distinguishes
    'sync in progress / interrupted (resumable)' — where the DA just needs to
    finish the sync — from 'never synced'. Best-effort; falls back to the generic
    prompt. NEVER raises (a bad count must not change the block behaviour)."""
    generic = ("Dataset chưa được Publish — bấm “Sync & Publish” trên Dataset "
               "trước khi dùng trên Dashboard.")
    try:
        from app.models.dataset import DatasetTable
        from app.services import snapshot_service
        from app.services.dataset_calendar_service import is_generated_calendar_table

        mat = [
            t for t in db.query(DatasetTable)
            .filter(DatasetTable.dataset_id == dataset_obj.id)
            .filter((DatasetTable.enabled.is_(None)) | (DatasetTable.enabled == True))  # noqa: E712
            .all()
            if not is_generated_calendar_table(t) and snapshot_service.is_federated_materializable(t)
        ]
        built = sum(1 for t in mat if snapshot_service.resolve_current_ref(db, t.id) is not None)
        remaining = max(0, len(mat) - built)
        if state == "syncing":
            return (f"Đang đồng bộ lần đầu (còn {remaining}/{len(mat)} bảng) — Dashboard sẽ hiển thị "
                    f"sau khi Sync & Publish hoàn tất.")
        if built > 0 and remaining > 0:
            return (f"Đồng bộ lần đầu chưa xong (còn {remaining}/{len(mat)} bảng) — bấm “Sync & Publish” "
                    f"trên Dataset để tiếp tục; Dashboard hiển thị sau khi publish xong.")
    except Exception:  # noqa: BLE001 — never break the block on a counting error
        pass
    return generic


def _plan_published(db: Session, dataset_obj, base_view_name: str, *, is_preview: bool) -> ExecutionPlan:
    """Serve a lifecycle-managed dataset ONLY from its pinned published
    generation. No live, no 'newest', no fallback (Phase 1). Blocks with a clear
    message when there is nothing safe to serve — the Dashboard shows the reason,
    never wrong data."""
    from app.models.dataset import DatasetTable
    from app.services import snapshot_service
    from app.services.dataset_calendar_service import is_generated_calendar_table
    from app.services.datasource_service import DataSourceConnectionService

    dataset_id = dataset_obj.id
    state = getattr(dataset_obj, "publish_state", None)
    current_pg = getattr(dataset_obj, "published_generation", None)
    # One read, one generation per dataset (ReadScope): a publish that flips the
    # pointer mid-read does not split this read across N and N+1.
    pg = _pinned_generation(dataset_id, current_pg)
    scope = getattr(dataset_obj, "security_scope", None) or "shared"

    def blocked_plan(msg: str, *, trigger: Optional[int] = None) -> ExecutionPlan:
        return ExecutionPlan(
            mode="live", dialect="", ds_type="", exec_config=None,
            cred="source_datasource", snapshot_state=SnapshotState.NOT_BUILT,
            dataset_id=dataset_id, security_scope=scope, published=True,
            trigger_dataset_id=trigger, reason="published-gate: " + msg, blocked=msg,
        )

    if state == "disabled":
        return blocked_plan("Dataset đang bị vô hiệu hoá (Disabled) — bật lại để dùng trên Dashboard.")

    # No published data yet: preview/design-time may run live; a Dashboard blocks.
    if pg is None:
        if is_preview:
            # Design-time preview: run live. dialect/ds_type left empty so the
            # chart runtime keeps its own base-datasource locals (exec_config
            # None ⇒ runtime does not override them).
            return ExecutionPlan(
                mode="live", dialect="", ds_type="", exec_config=None,
                cred="source_datasource", snapshot_state=SnapshotState.LIVE,
                dataset_id=dataset_id, security_scope=scope,
                reason="preview on un-published dataset (design-time live)",
            )
        # Context-aware guidance: a first sync in progress / interrupted (some
        # tables already built) reads very differently to "never synced". The
        # Dashboard still blocks (never serves incomplete/un-pinned data), but the
        # message tells the DA it just needs to finish/resume the sync.
        return blocked_plan(_unpublished_dashboard_message(db, dataset_obj, state))

    # Serve the PINNED published generation.
    tables = (
        db.query(DatasetTable)
        .filter(DatasetTable.dataset_id == dataset_id)
        .filter((DatasetTable.enabled.is_(None)) | (DatasetTable.enabled == True))  # noqa: E712
        .all()
    )
    want = [
        t.id for t in tables
        if not is_generated_calendar_table(t) and snapshot_service.is_federated_materializable(t)
    ]
    if want:
        refs, _fps, as_of = snapshot_service.resolve_specific_generation_refs(db, want, pg)
        if not refs and pg != current_pg:
            return blocked_plan(_GENERATION_MOVED)
        if not refs:
            return blocked_plan(
                "Snapshot đã publish không còn đầy đủ (có thể đã hết hạn/bị xoá) — bấm “Sync & Publish” "
                "để dựng lại. (Dashboard KHÔNG tự chạy live để tránh lệch dữ liệu.)",
                trigger=None,
            )
    else:
        # A dataset whose data comes entirely from parent datasets has no own
        # materializable tables — refs start empty and are filled by composition.
        refs, as_of = {}, None

    # Dataset-on-Dataset composition: point each parent-ref table at the parent's
    # PINNED published snapshot. This reuses the SAME `overrides` map the engine
    # already uses for federation (semantic_query_engine._snapshot_ref_for_view),
    # so the calculation layer treats the parent snapshot as an ordinary leaf view
    # — no new calculation path is introduced.
    from app.services import dataset_composition_service as _comp
    parent_ovr, block_msg = _comp.parent_snapshot_overrides(db, dataset_id)
    if block_msg:
        return blocked_plan(block_msg)
    if parent_ovr:
        refs = {**refs, **parent_ovr}

    # Calendar (best-effort): point the Date view at its snapshot table when THIS
    # generation materialized it; older generations built before calendar
    # materialization have none → engine falls back to inline calendar SQL. Never
    # blocks — the calendar is generated, not source data.
    cal_ids = [t.id for t in tables if is_generated_calendar_table(t)]
    if cal_ids:
        cal_refs, _cf, _ca = snapshot_service.resolve_specific_generation_refs(db, cal_ids, pg)
        if cal_refs:
            refs = {**refs, **cal_refs}

    if not refs:
        return blocked_plan(
            "Snapshot đã publish không còn đầy đủ (có thể đã hết hạn/bị xoá) — bấm “Sync & Publish” "
            "để dựng lại. (Dashboard KHÔNG tự chạy live để tránh lệch dữ liệu.)",
            trigger=None,
        )
    host = snapshot_service.host_for_generation(db, dataset_id, pg) or snapshot_service.resolve_host(db, dataset_id)
    if host is None:
        return blocked_plan("Không xác định được host BigQuery của generation đã publish — cần Sync lại.")
    return ExecutionPlan(
        mode="snapshot", dialect="bigquery", ds_type="bigquery",
        exec_config=DataSourceConnectionService.snapshot_query_config(host.config),
        cred="host_service_account",
        snapshot_state=(SnapshotState.STALE if state == "changes_pending" else SnapshotState.FRESH),
        overrides=refs, as_of=as_of, stale=(state == "changes_pending"),
        host_id=host.id, dataset_id=dataset_id, generation=pg, published=True,
        security_scope=scope,
        reason=("published generation %s%s" % (pg, " (design has unsynced changes)" if state == "changes_pending" else "")),
    )


def _dataset_is_mixed_engine(db: Session, dataset_id: int) -> bool:
    """Cheap probe: do this dataset's ENABLED non-calendar tables span >1 SQL
    dialect? Used by the planner's fail-closed path (issue #5)."""
    from app.models.dataset import DatasetTable
    from app.models.models import DataSource
    from app.services.dataset_calendar_service import is_generated_calendar_table
    from app.services.live_query_service import _dialect_for_ds_type
    tables = (
        db.query(DatasetTable)
        .filter(DatasetTable.dataset_id == dataset_id)
        .filter((DatasetTable.enabled.is_(None)) | (DatasetTable.enabled == True))  # noqa: E712
        .all()
    )
    ds_ids = {t.datasource_id for t in tables if t.datasource_id and not is_generated_calendar_table(t)}
    if len(ds_ids) <= 1:
        return False
    rows = db.query(DataSource).filter(DataSource.id.in_(list(ds_ids))).all()
    dialects = {_dialect_for_ds_type(str(getattr(d.type, "value", d.type)).lower()) for d in rows}
    return len(dialects) > 1


# ── One live statement, one connection ────────────────────────────────────────
# A live statement runs on ONE connection, and each table in it is rendered from
# its OWN datasource's definition. A Postgres / MySQL table is named relative to
# the connection (`sales`, `schema.sales`: its database and search_path), and a
# Sheets / manual datasource is its own in-memory engine — so a table of
# datasource B read through datasource A's connection is A's object of that
# name: another database's rows (or nothing). BigQuery names a PHYSICAL table
# absolutely (`project.dataset.table`); a custom-SQL / calculated table's text
# names its tables relative to the executing job's project (`dataset.table`).
# Two connections to the same physical scope (host, port, database, schema,
# user) are one connection.

_IDENTITY_KEYS = (("host",), ("port",), ("database", "dbname", "db"), ("schema_name", "schema"),
                  ("username", "user"))
_DEFAULT_PORT = {"postgresql": "5432", "mysql": "3306"}
_LOOPBACK = {"localhost", "127.0.0.1", "::1"}


def _connection_identity(ds) -> tuple:
    ds_type = str(getattr(ds.type, "value", ds.type)).lower()
    cfg = getattr(ds, "config", None) or {}
    out = []
    for keys in _IDENTITY_KEYS:
        val = next((cfg.get(k) for k in keys if cfg.get(k) not in (None, "")), None)
        out.append(str(val).strip().lower() if val is not None else None)
    host, port, database, schema, user = out
    if host in _LOOPBACK:
        host = "localhost"
    port = port or _DEFAULT_PORT.get(ds_type)
    if ds_type == "postgresql":
        schema = schema or "public"
    else:
        schema = None            # MySQL: the database IS the schema
    return (ds_type, host, port, database, schema, user)


def _bigquery_project(ds) -> str | None:
    cfg = getattr(ds, "config", None) or {}
    val = cfg.get("project_id")
    return str(val).strip().lower() if val else None


def refuse_foreign_live_sources(db: Session, source_ids, executing_ds, source_kinds=None) -> None:
    """Refuse (SemanticRefusal UNSUPPORTED_CONTEXT) a live statement that reads
    a table of a datasource other than ``executing_ds`` unless the statement
    can read it there as the same physical table (see above). ``source_ids``:
    the engine's ``live_source_ids``; ``source_kinds``: ``{datasource id: {the
    source kinds read}}`` (the engine's ``live_source_kinds``) — without it a
    foreign BigQuery table counts as named relative to the job."""
    from app.models.models import DataSource
    from app.services.live_query_service import _dialect_for_ds_type
    from app.services.semantic_join_resolver import SemanticRefusal

    exec_id = getattr(executing_ds, "id", None)
    others = {int(i) for i in (source_ids or ()) if i and int(i) != exec_id}
    if not others or executing_ds is None:
        return
    kinds = source_kinds or {}
    exec_type = str(getattr(executing_ds.type, "value", executing_ds.type)).lower()
    exec_dialect = _dialect_for_ds_type(exec_type)
    for other in db.query(DataSource).filter(DataSource.id.in_(sorted(others))).all():
        o_type = str(getattr(other.type, "value", other.type)).lower()
        if _dialect_for_ds_type(o_type) != exec_dialect:
            why = f"một bảng thuộc kết nối {o_type} không chạy được trên engine {exec_type}"
        elif exec_dialect == "bigquery":
            if _bigquery_project(other) == _bigquery_project(executing_ds):
                continue  # the same project: relative and absolute names alike
            read = kinds.get(other.id) or kinds.get(int(other.id)) or set()
            if read and read <= {"physical_table"}:
                continue  # physical tables are named absolutely (project.dataset.table)
            why = ("một bảng SQL / bảng tính toán của kết nối BigQuery khác đặt tên bảng theo project "
                   "của chính nó — chạy trong project khác sẽ đọc một bảng khác")
        elif exec_type in ("postgresql", "mysql") and _connection_identity(other) == _connection_identity(executing_ds):
            continue      # the same physical database / schema
        else:
            why = ("một bảng của kết nối khác được đặt tên theo kết nối của chính nó — đọc qua kết nối "
                   "đang chạy sẽ là một bảng khác (database / schema / engine khác)")
        raise SemanticRefusal(
            "Truy vấn này đọc bảng từ nhiều kết nối dữ liệu khác nhau, nhưng một truy vấn trực tiếp "
            f"(live) chỉ chạy trên MỘT kết nối: {why}. Dùng snapshot hợp nhất (bật materialization "
            "trên một kết nối BigQuery làm host), hoặc đặt các bảng trên cùng một kết nối.",
            category=SemanticRefusal.UNSUPPORTED_CONTEXT,
        )
