"""The Governed Query Service core (spec §2, ADR-001).

ONE boundary for a new analytical read made on a person's behalf. It adds no
second engine: it runs the sequence `/semantic/query` already runs
(`routers/semantic.py`) and puts governance around it.

    plan(request)      decide everything BEFORE a warehouse is touched:
                       principal → relation → authorization (I-1) → data policy
                       → strict datasource → compile (the existing engine)
                       → dropped filters (I-6) → foreign live sources
    execute(request)   audit row first (I-7) → key probes → bounded execution
                       → result-column policy → audit finalize

NOT LIVE. No route, tool or Analyst calls this yet. `execute` needs an
`AuditSink`; the durable ledger is PR-1E, so in this release there is no sink
and every `execute` is refused `audit_unavailable` before anything runs. A
query endpoint is wired to GQS only after the ledger, bounds, cancellation and
refusal tests are accepted (PO, Phase 1 gate).
"""
from __future__ import annotations

import hashlib
import json
import re
import time
import uuid
from typing import Any, Iterable, Optional

from app.services.governed_query.ai_scope import FieldReach, refuse_excluded
from app.services.governed_query.audit import AuditSink
from app.services.governed_query.bounds import effective_bounds
from app.services.governed_query.contracts import (
    ColumnMeta, CompiledQuery, Freshness, GovernedQueryRequest, GovernedQueryResult, QueryEvidence,
)
from app.services.governed_query.principal import AuthorizationContext, GovernedRefusal

#: Surfaces whose rows are rendered for the person asking and never reach a
#: model. GovernAIScope applies to EVERY other surface (fail closed: a caller
#: that declares an unexpected surface is held to the AI scope).
HUMAN_RENDER_SURFACES = frozenset({"chart"})

#: Sources whose executor enforces the bounds (timeout, rows, BigQuery bytes).
def _bq_label(value: str) -> str:
    """A BigQuery label value: lowercase letters, digits, `_`/`-`, max 63."""
    return re.sub(r"[^a-z0-9_-]", "_", str(value).lower())[:63]


_BOUNDED_SOURCES = frozenset({"postgresql", "mysql", "bigquery"})

#: The Direct Semantic API's filter contract (schemas/semantic.py FilterCondition).
_FILTER_OPERATORS = frozenset({"eq", "ne", "gt", "gte", "lt", "lte", "in", "not_in",
                               "contains", "starts_with", "ends_with"})
_GRAINS = frozenset({"day", "week", "month", "quarter", "year"})

#: Refusal code -> the status the audit ledger records. Anything not named here
#: is a plain refusal; `timeout` and `cancelled` are their own outcomes because
#: an operator reading the ledger needs to tell "we stopped it" from "it was
#: refused" (spec §2.4).
_AUDIT_STATUS = {"timeout": "timeout", "cancelled": "cancelled"}


def _sha(obj: Any) -> str:
    return hashlib.sha256(json.dumps(obj, sort_keys=True, default=str).encode("utf-8")).hexdigest()


class GovernedQueryService:
    """Built per request around ONE `AuthorizationContext` (never cached across
    requests, so a revoked grant is honoured on the next question)."""

    def __init__(self, authz: AuthorizationContext, *, audit: Optional[AuditSink] = None,
                 cancel_registry: Optional[Any] = None):
        self.authz = authz
        self.db = authz.db
        self.audit = audit
        #: Where a running statement registers its canceller (PR-1D). None uses
        #: the process registry; a test passes its own.
        self.cancel_registry = cancel_registry

    # ── plan: nothing here reaches a warehouse ──────────────────────────────
    def plan(self, request: GovernedQueryRequest) -> CompiledQuery:
        query_id = uuid.uuid4().hex
        try:
            return self._plan(request, query_id)
        except GovernedRefusal as refusal:
            self._audit_refusal(request, query_id, refusal.code)
            raise

    def _plan(self, request: GovernedQueryRequest, query_id: str) -> CompiledQuery:
        from app.core.authz.decision import Action

        principal = request.principal
        if principal != self.authz.principal:
            raise GovernedRefusal("not_authenticated", "Yêu cầu không khớp phiên đăng nhập.")
        ask = request.ask
        self._refuse_escape_hatches(ask)
        filters = self._normalized_filters(ask)
        time_grains = self._checked_time_grains(ask)

        relation = request.relation
        if relation.kind != "semantic_explore":
            raise GovernedRefusal(
                "not_a_governed_relation",
                "Chỉ truy vấn được qua mô hình ngữ nghĩa đã quản trị.",
                {"relation_kind": relation.kind},
            )
        # AUTHORIZATION BEFORE ANYTHING THAT REVEALS EXISTENCE. A missing explore,
        # an explore no Dataset owns, and an explore the caller may not query all
        # get the same code, message and detail; nothing about the relation
        # (dataset id, purpose) is decided or disclosed before `explore` holds.
        explore, model = self._explore(relation)
        dataset = self._dataset_of(model) if explore is not None else None
        if dataset is None:
            raise self._not_authorized(relation)
        decision = self.authz.decide(Action.EXPLORE, dataset)
        if not decision.allowed:
            if decision.via == "surface_ceiling":
                # The caller holds the right; only this surface may not reach it.
                raise GovernedRefusal("not_authorized", "Bạn không có quyền truy vấn dữ liệu này.",
                                      {"relation_id": relation.id, "via": "surface_ceiling"})
            raise self._not_authorized(relation)
        if str(getattr(dataset, "purpose", None) or "reporting").strip().lower() == "operational":
            # Operational (Workboard) data carries row-level rules that live in
            # rls_service, which this path does not apply. Refuse rather than
            # read it without them (ADR-002).
            raise GovernedRefusal(
                "policy_unenforceable",
                "Dữ liệu vận hành có quy tắc theo dòng mà đường truy vấn này chưa áp được.",
                {"dataset_id": dataset.id},
            )
        # A composed Dataset reads its parents' rows: every ancestor is held to the
        # same decision (composition principle #3, at the `explore` level here).
        ancestors = self._ancestors(dataset.id)
        for pid in ancestors:
            parent = self._dataset(pid)
            if parent is None or not self.authz.decide(Action.EXPLORE, parent).allowed:
                raise GovernedRefusal(
                    "not_authorized",
                    "Dataset này dựng trên một Dataset khác mà bạn không có quyền truy vấn.",
                    {"relation_id": relation.id, "via": "composition_parent"},
                )
        dataset_ids = (int(dataset.id), *sorted(int(a) for a in ancestors))

        datasource, table = self._datasource_of(explore)
        ds_type = datasource.type if isinstance(datasource.type, str) else datasource.type.value
        if ds_type not in _BOUNDED_SOURCES:
            # Sheets / manual executors take no timeout: the bounds would be a claim.
            raise GovernedRefusal(
                "policy_unenforceable",
                "Loại nguồn này chưa áp được giới hạn thực thi của truy vấn có quản trị.",
                {"source_type": ds_type},
            )

        excluded_cols, excluded_measures = (set(), set())
        if principal.surface not in HUMAN_RENDER_SURFACES:
            # Fail closed: every surface except a person's own chart render is
            # treated as one whose rows may reach a model.
            excluded_cols, excluded_measures = self.authz.ai_scope_exclusions(dataset_ids)
            refs = list(ask.dimensions) + list(ask.measures) + list(filters) + list(time_grains) \
                + [str(s.get("field") or "") for s in ask.sorts]
            if excluded_cols or excluded_measures:
                reach = FieldReach(self.db, model, self._table_ids(dataset_ids))
                refuse_excluded(reach, refs, excluded_cols, excluded_measures)

        from app.services.live_query_service import _dialect_for_ds_type

        dialect = _dialect_for_ds_type(ds_type)
        bounds = effective_bounds(request.requested_bounds)

        sql, out_columns, engine = self._compile(explore, ask, filters, time_grains, dialect, bounds)
        accepted = {str(a) for a in request.accept_dropped_filters}
        dropped = [dict(d) for d in (getattr(engine, "_propagation_drops", None) or []) if isinstance(d, dict)]
        unaccepted = [d for d in dropped if str(d.get("field") or "") not in accepted]
        if unaccepted:
            # I-6: never answer unfiltered with a warning. The refusal names each
            # filter so the Analyst can ask the USER to accept the wider scope.
            raise GovernedRefusal(
                "filter_would_drop",
                "Không áp được một số bộ lọc của câu hỏi; kết quả sẽ rộng hơn điều bạn hỏi. "
                "Cần bạn xác nhận chấp nhận phạm vi rộng hơn trước khi chạy.",
                {"dropped": [{"field": d.get("field"), "reason": d.get("reason")} for d in unaccepted]},
            )

        from app.services.execution_plan import refuse_foreign_live_sources
        from app.services.semantic_join_resolver import SemanticRefusal

        try:
            refuse_foreign_live_sources(self.db, engine.live_source_ids, datasource, engine.live_source_kinds)
        except SemanticRefusal as exc:
            raise GovernedRefusal("foreign_live_source", str(exc), {"category": getattr(exc, "category", None)}) from exc

        key_probes = tuple(engine.key_probes)
        if key_probes and ds_type == "bigquery":
            # relationship_key_guard runs its probes with the warehouse ceiling,
            # not the AI bytes limit, and GQS cannot pass its bounds to it without
            # editing the protected guard. Until PR-1C bounds them, refuse.
            raise GovernedRefusal(
                "policy_unenforceable",
                "Truy vấn cần kiểm tra khóa quan hệ trên BigQuery mà chưa giới hạn được chi phí kiểm tra.",
                {"reason": "unbounded_key_probes", "probes": len(key_probes)},
            )

        dropped_ids = {str(d.get("field")) for d in dropped}
        policy_fp = _sha({
            "principal": principal.ref, "datasets": dataset_ids,
            "ceiling": sorted(self.authz.ceiling.dataset_ids) if self.authz.ceiling.dataset_ids is not None else None,
            "excluded_columns": sorted(excluded_cols), "excluded_measures": sorted(excluded_measures),
            "accepted_drops": sorted(accepted),
        })
        return CompiledQuery(
            query_id=query_id,
            request=request,
            sql=sql,
            dialect=dialect,
            ds_type=ds_type,
            datasource=datasource,
            dataset_ids=dataset_ids,
            bounds=bounds,
            semantic_epoch=self._semantic_epoch(explore, model, dataset.id),
            sql_fingerprint=hashlib.sha256(sql.encode("utf-8")).hexdigest(),
            policy_fingerprint=policy_fp,
            # A drop names a filter ref, or (no_join_path) the filter's VIEW.
            filters_applied=tuple(sorted(k for k in filters
                                         if k not in dropped_ids and k.partition(".")[0] not in dropped_ids)),
            filters_dropped=tuple({"field": d.get("field"), "reason": d.get("reason"), "accepted_by_user": True}
                                  for d in dropped),
            columns=self._column_meta(out_columns, ask, engine),
            freshness=Freshness(mode=str(getattr(table, "query_mode", None) or "unknown")),
            key_probes=key_probes,
            warnings=tuple(str(w) for w in (engine.warnings or [])),
        )

    # ── execute: audit first, then the warehouse ────────────────────────────
    def execute(self, request: GovernedQueryRequest) -> GovernedQueryResult:
        if self.audit is None:
            # By construction until PR-1E: no durable ledger, no execution (I-7).
            refusal = GovernedRefusal(
                "audit_unavailable",
                "Chưa ghi được nhật ký truy vấn nên chưa chạy truy vấn.",
                {"reason": "no_ledger"},
            )
            raise refusal
        compiled = self.plan(request)
        try:
            self.audit.begin(compiled)
        except GovernedRefusal:
            raise  # a budget refusal: the ledger recorded it as refused
        except Exception as exc:  # noqa: BLE001 - any failure: the row is not there
            raise GovernedRefusal(
                "audit_unavailable",
                "Chưa ghi được nhật ký truy vấn nên chưa chạy truy vấn.",
                {"error": type(exc).__name__},
            ) from exc

        started = time.monotonic()
        try:
            columns, rows = self._run(compiled)
            self._refuse_unexpected_output(compiled, columns)
        except GovernedRefusal as refusal:
            self._finish(compiled, _AUDIT_STATUS.get(refusal.code, "refused"),
                         refusal_code=refusal.code, started=started)
            raise
        except Exception:
            self._finish(compiled, "error", started=started)
            raise

        b = compiled.bounds
        truncated = len(rows) > b.max_rows
        rows = rows[: b.max_rows]
        duration_ms = int((time.monotonic() - started) * 1000)
        self._finish(compiled, "ok", rows_returned=len(rows), started=started)
        evidence = QueryEvidence(
            query_id=compiled.query_id,
            principal_ref=compiled.request.principal.ref,
            relations=(compiled.request.relation,),
            datasets=compiled.dataset_ids,
            datasource_id=int(compiled.datasource.id),
            semantic_epoch=compiled.semantic_epoch,
            dialect=compiled.dialect,
            sql_fingerprint=compiled.sql_fingerprint,
            policy_fingerprint=compiled.policy_fingerprint,
            filters_applied=compiled.filters_applied,
            filters_dropped=compiled.filters_dropped,
            bounds=b,
            rows_returned=len(rows),
            truncated=truncated,
            bytes_processed=None,
            duration_ms=duration_ms,
            freshness=compiled.freshness,
            warnings=compiled.warnings,
        )
        return GovernedQueryResult(columns=compiled.columns, rows=rows, truncated=truncated, evidence=evidence)

    # ── steps ───────────────────────────────────────────────────────────────
    @staticmethod
    def _refuse_escape_hatches(ask) -> None:
        """I-5 / spec §2.3. SQL-bearing parts of a request are not accepted in the
        first release, whoever sends them: the calculated-field allow-list
        (PR-0C) protects the Direct Semantic API, but a governed read for an
        answer has no need to carry expression text, and AI-authored SQL is the
        escape hatch this boundary exists to close."""
        named = [k for k, v in (("calculated_fields", ask.calculated_fields),
                                ("window_functions", ask.window_functions),
                                ("measure_agg_overrides", ask.measure_agg_overrides)) if v]
        if named:
            raise GovernedRefusal(
                "unsupported_expression",
                "Truy vấn có quản trị không nhận biểu thức SQL tự viết; hãy dùng chỉ số đã định nghĩa.",
                {"fields": named},
            )

    @staticmethod
    def _normalized_filters(ask) -> dict:
        """I-5 + I-6 on the way IN. Each filter becomes exactly `{operator, value}`:
        internal engine keys a caller could send (`calendarField`, `_calendar_fan`,
        `_authoritative`, ...) are never forwarded, because they move or collapse a
        filter without a drop record. Only the operators the Direct Semantic API
        accepts are allowed, and a value the engine would silently skip (None,
        an empty list, a blank string, a non-finite number) is refused here, so
        no filter can disappear without a refusal."""
        import math

        out: dict = {}
        for ref, cond in (ask.filters or {}).items():
            if hasattr(cond, "model_dump"):
                cond = cond.model_dump()
            if not isinstance(ref, str) or not isinstance(cond, dict):
                raise GovernedRefusal("invalid_filter", "Bộ lọc không hợp lệ.", {"field": str(ref)})
            op, value = cond.get("operator"), cond.get("value")
            if op not in _FILTER_OPERATORS:
                raise GovernedRefusal("invalid_filter", "Phép lọc này không được hỗ trợ trong truy vấn có quản trị.",
                                      {"field": ref, "operator": str(op)})
            values = value if isinstance(value, list) else [value]
            empty = (value is None or (isinstance(value, list) and not value)
                     or (op not in ("in", "not_in") and isinstance(value, list))
                     or any(v is None or (isinstance(v, str) and not v.strip()) for v in values)
                     or any(isinstance(v, float) and not math.isfinite(v) for v in values)
                     or any(isinstance(v, (dict, list)) for v in values))
            if empty:
                raise GovernedRefusal("invalid_filter",
                                      "Bộ lọc thiếu giá trị hợp lệ; một bộ lọc rỗng sẽ bị bỏ qua nên không chạy.",
                                      {"field": ref, "operator": op})
            out[ref] = {"operator": op, "value": value}
        return out

    @staticmethod
    def _checked_time_grains(ask) -> dict:
        """I-5: a grain is one of five words. The engine interpolates it into
        `DATE_TRUNC('<grain>', ...)` on Postgres/DuckDB, so anything else is SQL."""
        out: dict = {}
        for ref, grain in (ask.time_grains or {}).items():
            if not isinstance(ref, str) or grain not in _GRAINS:
                raise GovernedRefusal("invalid_time_grain", "Độ chi tiết thời gian không hợp lệ.",
                                      {"field": str(ref), "allowed": sorted(_GRAINS)})
            out[ref] = grain
        return out

    @staticmethod
    def _not_authorized(relation) -> GovernedRefusal:
        """One refusal for 'missing', 'owned by no Dataset' and 'not yours': the
        same code, message and detail, so existence is not disclosed."""
        return GovernedRefusal("not_authorized", "Bạn không có quyền truy vấn dữ liệu này.",
                               {"relation_id": relation.id})

    def _explore(self, relation):
        from app.models.semantic import SemanticExplore, SemanticModel

        explore = self.db.get(SemanticExplore, int(relation.id))
        if explore is None or (relation.model_id is not None and explore.model_id != relation.model_id):
            return None, None
        model = self.db.get(SemanticModel, explore.model_id) if explore.model_id is not None else None
        return explore, model

    def _dataset(self, dataset_id):
        from app.models.dataset import Dataset

        return self.db.get(Dataset, dataset_id) if dataset_id is not None else None

    def _dataset_of(self, model):
        if model is None or getattr(model, "dataset_id", None) is None:
            return None
        return self._dataset(model.dataset_id)

    def _ancestors(self, dataset_id: int) -> set[int]:
        """Every Dataset this one is composed from, transitively (the same edges
        `dataset_grants_service.require_view_lineage` walks)."""
        from app.services import dataset_composition_service as comp

        seen: set[int] = set()
        stack = list(comp._direct_parents(self.db, dataset_id))
        while stack:
            pid = stack.pop()
            if pid in seen or pid == dataset_id:
                continue
            seen.add(pid)
            stack.extend(comp._direct_parents(self.db, pid))
        return seen

    def _table_ids(self, dataset_ids) -> list[int]:
        from app.models.dataset import DatasetTable

        return [r[0] for r in self.db.query(DatasetTable.id).filter(DatasetTable.dataset_id.in_(list(dataset_ids))).all()]

    def _datasource_of(self, explore):
        """STRICT, as `/semantic/query`: the base view's table names its source.
        No `DataSource.first()` guess (a wrong source returns wrong numbers)."""
        from app.models.dataset import DatasetTable
        from app.models.models import DataSource
        from app.models.semantic import SemanticView

        view = self.db.get(SemanticView, explore.base_view_id) if explore.base_view_id is not None else None
        table = self.db.get(DatasetTable, view.dataset_table_id) if view is not None and view.dataset_table_id else None
        ds = self.db.get(DataSource, table.datasource_id) if table is not None and table.datasource_id else None
        if ds is None:
            raise GovernedRefusal(
                "not_a_governed_relation",
                "Explore không gắn nguồn dữ liệu xác định (bảng gốc chưa liên kết datasource).",
                {"explore_id": explore.id},
            )
        return ds, table

    def _compile(self, explore, ask, filters: dict, time_grains: dict, dialect: str, bounds):
        """The SAME compile path chart and preview use, fed only the normalized
        filters and checked grains. The LIMIT asks one row past the bound so
        truncation is detected, never assumed."""
        from app.services.chart_contracts import AuthoritativeFilterNotApplied
        from app.services.semantic_query_compiler import SemanticQuerySpec
        from app.services.semantic_query_engine import SemanticQueryEngine

        asked = int(ask.limit) if ask.limit else None
        limit = min(asked, bounds.max_rows + 1) if asked else bounds.max_rows + 1
        spec = SemanticQuerySpec(
            explore_name=explore.name,
            explore_id=explore.id,
            model_id=explore.model_id,
            dimensions=list(ask.dimensions),
            measures=list(ask.measures),
            filters=dict(filters),
            sorts=[{"field": s.get("field"), "direction": s.get("direction")} for s in ask.sorts],
            time_grains=dict(time_grains),
            limit=limit,
        )
        engine = SemanticQueryEngine(self.db, database_type=dialect)
        try:
            sql, columns, _pivots = engine.run(spec)
        except AuthoritativeFilterNotApplied as exc:
            raise GovernedRefusal("filter_would_drop", str(exc), {"reason": exc.reason}) from exc
        except ValueError as exc:
            from app.services.chart_service import refusal_category

            raise GovernedRefusal("semantic_refusal", str(exc), {"category": refusal_category(exc)}) from exc
        return sql, list(columns or []), engine

    def _refuse_unexpected_output(self, compiled: CompiledQuery, columns: Iterable[str]) -> None:
        """The result boundary, by IDENTITY not by name: on any surface whose rows
        may reach a model, every output column must be the engine's alias of a
        ref that was asked for (and therefore passed the AI-scope walk). An
        extra column refuses the whole result: no partial grid."""
        if compiled.request.principal.surface in HUMAN_RENDER_SURFACES:
            return
        expected = {c.name for c in compiled.columns if c.ref is not None}
        extra = [c for c in columns if str(c) not in expected]
        if extra:
            raise GovernedRefusal(
                "column_excluded",
                "Kết quả chứa cột không thuộc câu hỏi; không trả kết quả.",
                {"columns": sorted(str(c) for c in extra)},
            )

    def _run(self, compiled: CompiledQuery):
        from app.services.datasource_service import DataSourceConnectionService
        from app.services.governed_query.cancellation import (
            REGISTRY, BigQueryCanceller, MySQLCanceller, PostgresCanceller,
        )
        from app.services.relationship_key_guard import verify_key_probes

        ds = compiled.datasource
        try:
            verify_key_probes(list(compiled.key_probes), ds_type=compiled.ds_type, config=ds.config,
                              namespace=f"ds:{getattr(ds, 'id', '')}")
        except ValueError as exc:
            raise GovernedRefusal("key_probe_failed", str(exc), {"category": getattr(exc, "category", None)}) from exc
        b = compiled.bounds
        qid = compiled.query_id
        registry = self.cancel_registry if self.cancel_registry is not None else REGISTRY
        # A cancel that arrived while this was still planning stops the query
        # before it reaches the warehouse at all.
        self._refuse_if_cancelled(registry, qid)

        def _register(backend_id):
            # The engine reports which backend runs the statement; from here a
            # cancel arriving on another request can stop it (PR-1D).
            if compiled.ds_type == "mysql":
                cid = backend_id.get("connection_id") if isinstance(backend_id, dict) else None
                registry.register(qid, MySQLCanceller(ds.config, cid))
            elif compiled.ds_type == "bigquery":
                registry.register(qid, BigQueryCanceller(ds.config, backend_id))
            else:
                registry.register(qid, PostgresCanceller(ds.config, backend_id))

        try:
            columns, rows, _elapsed = DataSourceConnectionService.execute_query(
                ds_type=compiled.ds_type,
                config=ds.config,
                sql_query=compiled.sql,
                limit=None,  # the compiled SQL already carries LIMIT bound+1
                timeout_seconds=b.timeout_seconds,
                max_rows=b.max_rows + 1,
                maximum_bytes_billed=b.bq_max_bytes if compiled.ds_type == "bigquery" else None,
                on_backend_id=_register,
                # Attribution on the warehouse side: which governed query ran it.
                job_labels={"appbi_surface": "gqs", "appbi_query": _bq_label(qid)}
                if compiled.ds_type == "bigquery" else None,
            )
        except Exception as exc:  # noqa: BLE001 - classify, then re-raise
            # A cancelled statement surfaces as the driver's "query cancelled"
            # error. It is reported as cancelled, not as a timeout.
            self._refuse_if_cancelled(registry, qid)
            name = type(exc).__name__.lower()
            if "querycanceled" in name or "timeout" in name or "statement timeout" in str(exc).lower():
                raise GovernedRefusal("timeout", "Truy vấn vượt quá thời gian cho phép.",
                                      {"timeout_seconds": b.timeout_seconds}) from exc
            raise
        finally:
            registry.unregister(qid)
        # Rows can arrive a moment after the cancel was asked for: a cancelled
        # query never returns a completed result.
        self._refuse_if_cancelled(registry, qid)
        return list(columns or []), list(rows or [])

    @staticmethod
    def _refuse_if_cancelled(registry, query_id: str) -> None:
        if registry.is_cancelled(query_id):
            raise GovernedRefusal("cancelled", "Truy vấn đã được huỷ.", {"query_id": query_id})

    # ── evidence helpers ────────────────────────────────────────────────────
    def _semantic_epoch(self, explore, model, dataset_id: int) -> str:
        """A content marker of the definitions this answer was computed from: the
        model, the explore and every view of the dataset's tables, by id and
        last change, plus the engine's result-cache version. A definition edit
        changes it; the same definitions give the same epoch (I-9)."""
        from app.models.dataset import DatasetTable
        from app.models.semantic import SemanticView
        from app.services.query_cache import SEMANTIC_RESULT_CACHE_VERSION

        views = (self.db.query(SemanticView.id, SemanticView.updated_at)
                 .join(DatasetTable, DatasetTable.id == SemanticView.dataset_table_id)
                 .filter(DatasetTable.dataset_id == dataset_id).order_by(SemanticView.id).all())
        return _sha({
            "engine": SEMANTIC_RESULT_CACHE_VERSION,
            "model": [getattr(model, "id", None), getattr(model, "updated_at", None)],
            "explore": [explore.id, explore.updated_at],
            "views": [[v.id, v.updated_at] for v in views],
        })[:32]

    @staticmethod
    def _column_meta(out_columns: list, ask, engine) -> tuple[ColumnMeta, ...]:
        """Each output column by IDENTITY: the engine's own alias for a ref."""
        by_alias = {}
        for refs, role in ((ask.dimensions, "dimension"), (ask.measures, "measure")):
            for r in refs:
                alias = engine._safe_alias(r)
                if alias in by_alias and by_alias[alias][0] != r:
                    # Two refs, one output column: the answer could not say which.
                    raise GovernedRefusal("semantic_refusal", "Hai trường của câu hỏi trùng tên cột kết quả.",
                                          {"fields": sorted({by_alias[alias][0], r})})
                by_alias[alias] = (r, role)
        out = []
        for c in out_columns:
            ref, role = by_alias.get(str(c), (None, "unknown"))
            out.append(ColumnMeta(name=str(c), ref=ref, role=role))
        return tuple(out)

    def _finish(self, compiled: CompiledQuery, status: str, *, refusal_code: Optional[str] = None,
                rows_returned: Optional[int] = None, started: float) -> None:
        self.audit.finish(compiled.query_id, status=status, refusal_code=refusal_code,
                          rows_returned=rows_returned, bytes_processed=None,
                          duration_ms=int((time.monotonic() - started) * 1000))

    def _audit_refusal(self, request: GovernedQueryRequest, query_id: str, code: str) -> None:
        if self.audit is None:
            return
        try:
            self.audit.refused(query_id=query_id, principal_ref=request.principal.ref,
                               relation=request.relation, code=code)
        except Exception:  # noqa: BLE001 - already refusing; the refusal stands
            pass
