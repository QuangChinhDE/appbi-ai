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

from app.services.governed_query.audit import AuditSink
from app.services.governed_query.bounds import effective_bounds
from app.services.governed_query.contracts import (
    ColumnMeta, CompiledQuery, Freshness, GovernedQueryRequest, GovernedQueryResult, QueryEvidence,
)
from app.services.governed_query.principal import AuthorizationContext, GovernedRefusal

#: Surfaces whose rows reach a model. GovernAIScope applies to them (spec §1, I-1
#: policy constraints); a person's own chart render is not an AI surface.
AI_SURFACES = frozenset({"analyst", "agent_flow", "studio_test"})

_FIELD_REF = re.compile(r"\$\{(?:TABLE|[A-Za-z_][A-Za-z0-9_]*)\}\.([A-Za-z_][A-Za-z0-9_]*)"
                        r"|\$\{[A-Za-z_][A-Za-z0-9_]*\.([A-Za-z_][A-Za-z0-9_]*)\}")
_BARE_IDENT = re.compile(r"^\s*([A-Za-z_][A-Za-z0-9_]*)\s*$")


def _fold(name: Any) -> str:
    from app.core.text_fold import fold_text

    return fold_text(name)


def _sha(obj: Any) -> str:
    return hashlib.sha256(json.dumps(obj, sort_keys=True, default=str).encode("utf-8")).hexdigest()


class GovernedQueryService:
    """Built per request around ONE `AuthorizationContext` (never cached across
    requests, so a revoked grant is honoured on the next question)."""

    def __init__(self, authz: AuthorizationContext, *, audit: Optional[AuditSink] = None):
        self.authz = authz
        self.db = authz.db
        self.audit = audit

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

        relation = request.relation
        if relation.kind != "semantic_explore":
            raise GovernedRefusal(
                "not_a_governed_relation",
                "Chỉ truy vấn được qua mô hình ngữ nghĩa đã quản trị.",
                {"relation_kind": relation.kind},
            )
        explore, model = self._explore(relation)
        dataset = self._dataset_of(model)
        if dataset is None:
            raise GovernedRefusal(
                "not_a_governed_relation",
                "Explore này không thuộc Dataset nào nên không có chủ sở hữu dữ liệu để kiểm soát quyền.",
                {"explore_id": explore.id},
            )
        if str(getattr(dataset, "purpose", None) or "reporting").strip().lower() == "operational":
            # Operational (Workboard) data carries row-level rules that live in
            # rls_service, which this path does not apply. Refuse rather than
            # read it without them (ADR-002).
            raise GovernedRefusal(
                "policy_unenforceable",
                "Dữ liệu vận hành có quy tắc theo dòng mà đường truy vấn này chưa áp được.",
                {"dataset_id": dataset.id},
            )
        self.authz.require(Action.EXPLORE, dataset)

        excluded_cols, excluded_measures = (set(), set())
        if principal.surface in AI_SURFACES:
            excluded_cols, excluded_measures = self.authz.ai_scope_exclusions([dataset.id])
            self._refuse_excluded_refs(ask, excluded_cols, excluded_measures)

        datasource, table = self._datasource_of(explore)
        ds_type = datasource.type if isinstance(datasource.type, str) else datasource.type.value
        from app.services.live_query_service import _dialect_for_ds_type

        dialect = _dialect_for_ds_type(ds_type)
        bounds = effective_bounds(request.requested_bounds)

        sql, out_columns, engine = self._compile(explore, ask, dialect, bounds)
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

        dataset_ids = (int(dataset.id),)
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
            filters_applied=tuple(sorted(str(k) for k in (ask.filters or {})
                                         if str(k) not in {str(d.get("field")) for d in dropped})),
            filters_dropped=tuple({"field": d.get("field"), "reason": d.get("reason"), "accepted_by_user": True}
                                  for d in dropped),
            columns=self._column_meta(out_columns, ask, engine),
            freshness=Freshness(mode=str(getattr(table, "query_mode", None) or "unknown")),
            key_probes=tuple(engine.key_probes),
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
        except Exception as exc:  # noqa: BLE001 - any failure: the row is not there
            raise GovernedRefusal(
                "audit_unavailable",
                "Chưa ghi được nhật ký truy vấn nên chưa chạy truy vấn.",
                {"error": type(exc).__name__},
            ) from exc

        started = time.monotonic()
        try:
            columns, rows = self._run(compiled)
            self._refuse_excluded_output(compiled, columns)
        except GovernedRefusal as refusal:
            self._finish(compiled, "timeout" if refusal.code == "timeout" else "refused",
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

    def _explore(self, relation):
        from app.models.semantic import SemanticExplore, SemanticModel

        explore = self.db.get(SemanticExplore, int(relation.id))
        if explore is None or (relation.model_id is not None and explore.model_id != relation.model_id):
            # Same code and message as "no right": existence is not disclosed.
            raise GovernedRefusal("not_authorized", "Bạn không có quyền truy vấn dữ liệu này.",
                                  {"relation_id": relation.id})
        model = self.db.get(SemanticModel, explore.model_id) if explore.model_id is not None else None
        return explore, model

    def _dataset_of(self, model):
        from app.models.dataset import Dataset

        if model is None or getattr(model, "dataset_id", None) is None:
            return None
        return self.db.get(Dataset, model.dataset_id)

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

    def _compile(self, explore, ask, dialect: str, bounds):
        """The SAME compile path chart and preview use. The LIMIT asks one row past
        the bound so truncation is detected, never assumed."""
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
            filters={k: (v.model_dump() if hasattr(v, "model_dump") else v) for k, v in (ask.filters or {}).items()},
            sorts=[dict(s) for s in ask.sorts],
            time_grains=dict(ask.time_grains or {}),
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

    def _refuse_excluded_refs(self, ask, excluded_cols: set, excluded_measures: set) -> None:
        """GovernAIScope before compile: a requested, filtered or sorted field that
        is, or reads, an excluded column (or is an excluded measure) is refused.
        Filtering on a hidden column leaks it as surely as selecting it."""
        if not excluded_cols and not excluded_measures:
            return
        refs = list(ask.dimensions) + list(ask.measures) + [str(k) for k in (ask.filters or {})] \
            + [str(s.get("field") or "") for s in ask.sorts]
        hits = []
        for ref in {r for r in refs if r}:
            view_name, _, name = ref.partition(".")
            name = name or view_name
            # `excluded_measures` holds semantic measure AND dimension names (model).
            if _fold(name) in excluded_cols or _fold(name) in excluded_measures:
                hits.append(ref)
                continue
            if any(_fold(c) in excluded_cols for c in self._physical_columns(view_name, name)):
                hits.append(ref)
        if hits:
            raise GovernedRefusal(
                "column_excluded",
                "Câu hỏi dùng dữ liệu nằm ngoài phạm vi AI được phép (Phạm vi dữ liệu AI trong Govern).",
                {"fields": sorted(hits)},
            )

    def _physical_columns(self, view_name: str, field_name: str) -> set[str]:
        """The source columns a semantic field's SQL reads (`${TABLE}.col`,
        `${view.col}` or a bare identifier). Every view of that name is read: an
        ambiguous name widens the check, never narrows it."""
        from app.models.semantic import SemanticView

        out: set[str] = set()
        for view in self.db.query(SemanticView).filter(SemanticView.name == view_name).all():
            for f in list(view.dimensions or []) + list(view.measures or []):
                if not isinstance(f, dict) or f.get("name") != field_name:
                    continue
                sql = str(f.get("sql") or "")
                out |= {a or b for a, b in _FIELD_REF.findall(sql)}
                bare = _BARE_IDENT.match(sql)
                if bare:
                    out.add(bare.group(1))
        return out

    def _refuse_excluded_output(self, compiled: CompiledQuery, columns: Iterable[str]) -> None:
        """The second gate, at the result boundary: an output column named for an
        excluded column refuses the whole result (no partial grid)."""
        if compiled.request.principal.surface not in AI_SURFACES:
            return
        excluded_cols, _ = self.authz.ai_scope_exclusions(compiled.dataset_ids)
        hits = [c for c in columns if _fold(c) in excluded_cols
                or _fold(str(c).rsplit(".", 1)[-1]) in excluded_cols]
        if hits:
            raise GovernedRefusal(
                "column_excluded",
                "Kết quả chứa cột nằm ngoài phạm vi AI được phép.",
                {"columns": sorted(hits)},
            )

    def _run(self, compiled: CompiledQuery):
        from app.services.datasource_service import DataSourceConnectionService
        from app.services.relationship_key_guard import verify_key_probes

        ds = compiled.datasource
        try:
            verify_key_probes(list(compiled.key_probes), ds_type=compiled.ds_type, config=ds.config,
                              namespace=f"ds:{getattr(ds, 'id', '')}")
        except ValueError as exc:
            raise GovernedRefusal("key_probe_failed", str(exc), {"category": getattr(exc, "category", None)}) from exc
        b = compiled.bounds
        try:
            columns, rows, _elapsed = DataSourceConnectionService.execute_query(
                ds_type=compiled.ds_type,
                config=ds.config,
                sql_query=compiled.sql,
                limit=None,  # the compiled SQL already carries LIMIT bound+1
                timeout_seconds=b.timeout_seconds,
                max_rows=b.max_rows + 1,
                maximum_bytes_billed=b.bq_max_bytes if compiled.ds_type == "bigquery" else None,
            )
        except Exception as exc:  # noqa: BLE001 - classify, then re-raise
            name = type(exc).__name__.lower()
            if "querycanceled" in name or "timeout" in name or "statement timeout" in str(exc).lower():
                raise GovernedRefusal("timeout", "Truy vấn vượt quá thời gian cho phép.",
                                      {"timeout_seconds": b.timeout_seconds}) from exc
            raise
        return list(columns or []), list(rows or [])

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
                by_alias[engine._safe_alias(r)] = (r, role)
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
