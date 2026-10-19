"""Phase 0 security reproduction suite — AppBI Intelligence foundation.

WHAT THIS FILE IS
-----------------
The architecture review found these defects by READING code. A finding read
from code is not a finding proven at runtime, so each one is turned into an
executable statement of the SAFE behaviour the product needs, and run.

Two kinds of test live here, and the difference is the point of the file:

* ``xfail(strict=True)``. The safe behaviour does NOT hold today: running the
  test reproduces the finding. The marker keeps CI honest about a known defect
  without hiding it. ``strict`` means the day a fix lands the test XPASSes, which
  FAILS the run, and the marker must be removed in that same change. From then
  on the test is the regression lock. Removing the marker without the fix
  fails the run.
* plain tests. The safe behaviour holds today, either because the finding was
  REFUTED as a security issue or because the property needs a guard so a later
  "fix" cannot open it.

Every reproduction is at the level stated in its reason. "compile-level" or
"structural" means no warehouse and no HTTP server was involved: the exploit
path through a live warehouse is NOT VERIFIED by this file. The matrix with
severity, reachability and the verification status of each finding is
``docs/features/intelligence-foundation/security-matrix.md``.

No production system, real credential or customer data is touched. Every test
runs on in-memory SQLite or on stubs.
"""
from __future__ import annotations

import ast
import inspect
import textwrap
from types import SimpleNamespace

import pytest
from sqlalchemy import create_engine
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool


@compiles(JSONB, "sqlite")
def _jsonb_on_sqlite(_type, _compiler, **_kw):
    return "JSON"


@compiles(UUID, "sqlite")
def _uuid_on_sqlite(_type, _compiler, **_kw):
    return "CHAR(36)"


def _session(*models):
    from app.core.database import Base

    engine = create_engine(
        "sqlite://", future=True, poolclass=StaticPool,
        connect_args={"check_same_thread": False},
    )
    Base.metadata.create_all(engine, tables=[m.__table__ for m in models])
    return sessionmaker(bind=engine, future=True)()


#: A reproduction counts only when the test fails at its ASSERTION. Without
#: `raises=`, an import error or a broken fixture would also "reproduce" the
#: finding and the file would report a vulnerability it never exercised.
REPRODUCED = (AssertionError, pytest.fail.Exception)


def _bare_engine():
    """A SemanticQueryEngine with no constructor side effects, for unit-level
    calls into one method."""
    from app.services.semantic_query_engine import SemanticQueryEngine

    eng = SemanticQueryEngine.__new__(SemanticQueryEngine)
    eng.warnings = []
    return eng


# ── SEC-01  calculated-field SQL is guarded by a substring blacklist ─────────


@pytest.mark.xfail(
    strict=True,
    raises=REPRODUCED,
    reason="REPRODUCED SEC-01 (compile-level): a calculated field may embed a "
    "scalar subquery over any table the datasource credential can read; the "
    "blacklist only looks for DDL/DML words",
)
def test_sec01_a_calculated_field_cannot_read_another_table():
    with pytest.raises(ValueError):
        _bare_engine()._validate_calculated_field_safety(
            "(SELECT MAX(salary) FROM hr.payroll)"
        )


@pytest.mark.xfail(
    strict=True,
    raises=ValueError,
    reason="REPRODUCED SEC-01b (compile-level): the same substring test rejects "
    "a legitimate field because 'updated_at' contains 'UPDATE'",
)
def test_sec01b_a_column_named_updated_at_is_not_a_forbidden_keyword():
    _bare_engine()._validate_calculated_field_safety(
        "DATE_DIFF(${orders.updated_at}, ${orders.created_at}, DAY)"
    )


# ── SEC-02  datasource table preview has no row ceiling ──────────────────────

#: The ceiling the fix must enforce. A schema browser preview needs a handful
#: of rows; anything larger is a data export and belongs behind `explore`.
PREVIEW_ROW_CEILING = 100


@pytest.mark.xfail(
    strict=True,
    raises=REPRODUCED,
    reason="REPRODUCED SEC-02 (handler-level): preview_rows reaches the "
    "connector unbounded, so `data_sources: view` reads a whole table",
)
def test_sec02_table_preview_is_bounded(monkeypatch):
    from app.api import datasources as api

    seen: dict = {}
    ds = SimpleNamespace(id=1, type=SimpleNamespace(value="postgresql"), config={})
    monkeypatch.setattr(api.DataSourceCRUDService, "get_by_id", staticmethod(lambda db, i: ds))
    monkeypatch.setattr(api, "require_view_access", lambda *a, **k: None)
    monkeypatch.setattr(api, "_require_tabular", lambda *a, **k: None)

    def fake_detail(ds_type, config, schema, table, preview_rows):
        seen["rows"] = preview_rows
        return {"columns": [], "preview": []}

    monkeypatch.setattr(
        api.DataSourceConnectionService, "get_table_detail", staticmethod(fake_detail)
    )
    try:
        api.get_table_detail(
            1, "public", "orders", preview_rows=1_000_000,
            db=None, current_user=SimpleNamespace(id=1),
        )
    except Exception:  # a refusal is an acceptable fix
        return
    assert seen["rows"] <= PREVIEW_ROW_CEILING


# ── SEC-03  studio "test as chat" drops the caller from the scope ────────────


def _run_scope_calls(fn) -> list[ast.Call]:
    tree = ast.parse(textwrap.dedent(inspect.getsource(fn)))
    out = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Call):
            f = node.func
            name = f.id if isinstance(f, ast.Name) else getattr(f, "attr", "")
            if name.endswith("run_scope") and not name.startswith("public"):
                out.append(node)
    return out


def test_sec03_studio_preview_scope_keeps_the_caller_term():
    """FIXED in PR-0B1 (was REPRODUCED SEC-03, structural)."""
    from app.services.agent_flows import dispatch

    calls = _run_scope_calls(dispatch.run_preview)
    assert calls, "run_preview no longer derives a scope — re-check SEC-03"
    assert all(any(k.arg == "caller" for k in c.keywords) for c in calls)


def test_sec03_live_chat_scope_does_keep_the_caller_term():
    """The reference behaviour SEC-03 is measured against. If this fails the
    live path regressed, which is worse than the finding."""
    from app.services.agent_flows import dispatch

    calls = _run_scope_calls(dispatch.run_for_chat_thread)
    assert calls and all(any(k.arg == "caller" for k in c.keywords) for c in calls)


# ── SEC-04  capabilities default to ALLOWED when a context never declared them


def _registered_tool(kind: str):
    """A REAL registered tool with the property under test. Building one with
    `dataclasses.replace` trips ToolSpec's own validation before the gate runs."""
    from app.services.agent_flows.tools import registry as reg

    for spec in reg.all_tools().values():
        if spec.risk != "read_only":
            continue
        if kind == "web_search" and spec.reaches_outside:
            return spec
        if kind == "read_rows" and spec.data_exposure == "raw_rows":
            return spec
    pytest.fail(f"no registered read-only tool needs {kind}; re-check SEC-04")


@pytest.mark.xfail(
    strict=True,
    raises=REPRODUCED,
    reason="REPRODUCED SEC-04 (unit-level): `getattr(ctx, cap, True)` admits a "
    "web or raw-row tool on any context that never set the capability. PR-0B1 "
    "closed the known production path (Studio Test now declares the binding's "
    "capabilities); flipping the DEFAULT is blocked: "
    "test_tool_capability_gates.py::test_a_context_that_never_heard_of_the_"
    "capability_is_not_punished locks 'absent means permitted' and needs an "
    "explicit decision to replace",
)
@pytest.mark.parametrize("capability", ["web_search", "read_rows"])
def test_sec04_an_undeclared_capability_is_denied(capability):
    from app.services.agent_flows.tools import registry as reg
    from app.services.agent_flows.tools.context import ToolContext

    ctx = ToolContext(db=None, dashboard=None, public_filters=[])
    assert reg._capability_refusal(ctx, _registered_tool(capability)) is not None


@pytest.mark.parametrize("capability", ["web_search", "read_rows"])
def test_sec04_an_explicitly_denied_capability_is_refused(capability):
    """What already works and must keep working: an explicit False refuses."""
    from app.services.agent_flows.tools import registry as reg
    from app.services.agent_flows.tools.context import ToolContext

    ctx = ToolContext(db=None, dashboard=None, public_filters=[])
    setattr(ctx, capability, False)
    assert reg._capability_refusal(ctx, _registered_tool(capability)) is not None


# ── SEC-05  AI column scope fails OPEN when the lookup fails ─────────────────


def _broken_scope_lookup(monkeypatch):
    from app.services.governance_ai_service import GovernanceAIService

    def boom(*_a, **_k):
        raise RuntimeError("governance store unavailable")

    monkeypatch.setattr(GovernanceAIService, "scope_exclusions", boom)


def test_sec05_a_failed_scope_lookup_does_not_mean_nothing_is_excluded(monkeypatch):
    """FIXED in PR-0B1 (was REPRODUCED SEC-05): the lookup raises."""
    from app.services.agent_flows.tools import context as C

    _broken_scope_lookup(monkeypatch)
    try:
        out = C._exclusions_for_datasets(object(), [1])
    except Exception:  # refusing the turn is the fail-closed answer
        return
    pytest.fail(f"lookup failure returned {out!r}: every column is exposed")


def test_sec03_studio_preview_derives_the_scope_for_the_person_testing(monkeypatch):
    """Behavioural half of SEC-03: the scope `run_preview` computes is the
    caller's, the datasets it adds are the caller-bounded ones, and the capability
    ceiling is the binding's — not whatever the context defaulted to."""
    import asyncio

    from app.services.agent_flows import dispatch, permissions
    from app.services.agent_flows.tools.context import ToolContext

    class _Stop(Exception):
        pass

    caller = SimpleNamespace(id="editor", email="editor@appbi.io")
    seen: dict = {}
    caps = SimpleNamespace(max_rows_per_call=50, max_result_tokens=900,
                           read_rows=False, web_search=False)
    info = SimpleNamespace(
        knowledge=SimpleNamespace(model_dump=lambda: {}, dataset_ids=[1, 2]),
        allowed_chart_ids=[], capabilities=caps,
    )

    def fake_run_scope(db, row, flow, binding_scope=None, caller=None):
        seen["caller"] = caller
        return {"doc_ids": [], "dataset_ids": [2], "metric_names": []}

    def stop(_binding):
        raise _Stop()

    monkeypatch.setattr(dispatch, "build_report_info", lambda *_a, **_k: None)
    monkeypatch.setattr(dispatch.binding_service, "build_binding_info", lambda *_a, **_k: info)
    monkeypatch.setattr(dispatch.binding_service, "contract_of", stop)
    monkeypatch.setattr(permissions, "run_scope", fake_run_scope)
    monkeypatch.setattr(permissions, "chart_scope", lambda *_a, **_k: set())

    ctx = ToolContext(db=None, dashboard=None, public_filters=[])
    adopted: dict = {}
    monkeypatch.setattr(ctx, "adopt_scope", lambda charts, ds: adopted.setdefault("ds", list(ds)))

    gen = dispatch.run_preview(
        None, flow=SimpleNamespace(), version=1, binding=object(), link=None,
        dashboard=None, ctx=ctx, brain_row=object(), caller=caller, question="q",
    )
    with pytest.raises(_Stop):
        asyncio.run(gen.__anext__())

    assert seen["caller"] is caller
    assert adopted["ds"] == [2], "the flow attached [1, 2]; the caller may read [2]"
    assert ctx.read_rows is False and ctx.web_search is False
    assert ctx.max_rows_per_call == 50


def test_sec03_run_preview_cannot_be_called_without_a_caller():
    """No default: an omitted caller is a TypeError, never 'run as the owner'."""
    import inspect as _inspect

    from app.services.agent_flows import dispatch

    param = _inspect.signature(dispatch.run_preview).parameters["caller"]
    assert param.default is _inspect.Parameter.empty


def test_sec04_the_studio_test_path_declares_the_binding_capabilities():
    """The part of SEC-04 PR-0B1 does close: the one known production context
    that never declared its capabilities (Studio Test) now carries the binding's,
    so it no longer depends on the registry's default. Asserted on the source of
    `run_preview` because the behavioural test above stubs the binding."""
    from app.services.agent_flows import dispatch

    src = inspect.getsource(dispatch.run_preview)
    for cap in ("read_rows", "web_search", "max_rows_per_call", "max_result_tokens"):
        assert f"ctx.{cap} = binding_info.capabilities.{cap}" in src, cap


def test_sec05_a_context_with_an_unknown_scope_reads_no_chart():
    from app.services.agent_flows.tools.context import ToolContext, ToolError, _fetch_chart_data

    ctx = ToolContext(db=None, dashboard=None, public_filters=[],
                      allowed_chart_ids={5}, ai_scope_unavailable=True)
    with pytest.raises(ToolError) as exc:
        _fetch_chart_data(ctx, 5)
    assert exc.value.code == "policy_unavailable"


def test_sec05_a_context_with_an_unknown_scope_is_never_cached():
    """Its exclusion set is empty, the same key as 'nothing excluded': a warm
    entry would otherwise answer it past the refusal."""
    from app.services.agent_flows.tools import registry as reg
    from app.services.agent_flows.tools.context import ToolContext

    known = ToolContext(db=None, dashboard=SimpleNamespace(id=3), public_filters=[])
    unknown = ToolContext(db=None, dashboard=SimpleNamespace(id=3), public_filters=[],
                          ai_scope_unavailable=True)
    assert reg._cache_key(known, "get_chart_data", {"chart_id": 5}) is not None
    assert reg._cache_key(unknown, "get_chart_data", {"chart_id": 5}) is None


# ── SEC-06  pivot value discovery runs on the METADATA session ───────────────


def test_sec06_pivot_discovery_never_returns_metadata_rows(monkeypatch):
    """REFUTED as data exposure, kept as a guard.

    `_fetch_pivot_values` hands a raw SQL string to the metadata session. Under
    SQLAlchemy 2.x a raw string is refused before it reaches the database, the
    error is swallowed, and the pivot gets no values. So the metadata store is
    not read — but pivots never receive values from the warehouse either, which
    is an open CORRECTNESS defect (tracked as DEF-06, not fixed here).

    The guard matters because the obvious "fix" — wrapping the string in
    `text()` — would run warehouse SQL against the metadata database.
    """
    from sqlalchemy import text

    db = _session()
    db.execute(text("CREATE TABLE secret_meta (v TEXT)"))
    db.execute(text("INSERT INTO secret_meta VALUES ('TOPSECRET')"))
    db.commit()

    eng = _bare_engine()
    eng.db = db
    eng.views_cache = {"v": SimpleNamespace(dimensions=[{"name": "f"}])}
    monkeypatch.setattr(eng, "_parse_field_ref", lambda ref: ("v", "f"), raising=False)
    monkeypatch.setattr(eng, "_render_dimension", lambda ref, view: "v", raising=False)
    monkeypatch.setattr(eng, "_build_from_clause", lambda explore: ("FROM secret_meta", None), raising=False)
    monkeypatch.setattr(eng, "_build_where_clause", lambda filters, extra: "", raising=False)

    values = eng._fetch_pivot_values(None, "v.f", {})
    assert "TOPSECRET" not in values


# ── SEC-07  a Draft KPI is injected as the OFFICIAL definition ───────────────


def _governance_db():
    from app.models.dataset import Dataset, DatasetTable
    from app.models.governance import (
        GovernDocAssetLink, GovernKnowledgeDoc, GovernMetric, GovernMetricBinding,
    )

    db = _session(Dataset, DatasetTable, GovernMetric, GovernMetricBinding,
                  GovernDocAssetLink, GovernKnowledgeDoc)
    db.add(Dataset(id=1, name="sales"))
    db.add(DatasetTable(id=10, dataset_id=1, display_name="orders"))
    db.commit()
    return db


def _managed_block(monkeypatch, db, *, docs=None):
    from app.services import governance_service
    from app.services.dashboard_ai_bot import govern_doc_context, govern_doc_embeddings
    from app.services.dashboard_ai_bot import knowledge_context as K

    monkeypatch.setattr(K, "dashboard_table_ids", lambda _db, _id: [10])
    monkeypatch.setattr(
        governance_service.GovernanceService, "metric_dataset_ids",
        staticmethod(lambda _db, _m, resolved_only=False: {1}),
    )
    chunks, assembled = docs or ([], {"text": "", "sources": []})
    monkeypatch.setattr(govern_doc_embeddings, "retrieve_doc_chunks", lambda *a, **k: chunks)
    monkeypatch.setattr(govern_doc_context, "assemble", lambda *a, **k: assembled)
    return K._govern_managed_block(db, 99, "doanh thu")


def _section(block: str, header_marker: str) -> str:
    """The lines under the bullet header containing ``header_marker``, up to the
    next bullet header."""
    out, inside = [], False
    for line in block.splitlines():
        if line.startswith("• "):
            inside = header_marker in line
            continue
        if inside:
            out.append(line)
    return "\n".join(out)


def test_sec07_a_draft_metric_is_not_presented_as_official(monkeypatch):
    """FIXED in PR-0B2 (was REPRODUCED SEC-07)."""
    from app.models.governance import GovernMetric

    db = _governance_db()
    db.add(GovernMetric(id=1, name="draft_rev", display_name="Doanh thu nháp",
                        definition="AI đề xuất, chưa duyệt", status="Draft"))
    db.commit()
    block, refs = _managed_block(monkeypatch, db)
    official = _section(block, "ĐỊNH NGHĨA CHÍNH THỐNG")
    assert "Doanh thu nháp" not in official
    # Spec §4: an authored Draft may be shown, but only labelled as not approved.
    for line in block.splitlines():
        if "Doanh thu nháp" in line:
            assert "[NHÁP]" in line, line
    assert all(r.get("status") == "Draft" for r in refs if r.get("ref") == "draft_rev")


def test_sec07_an_approved_metric_is_still_presented(monkeypatch):
    """The fix must not throw away the certified definition with the draft."""
    from app.models.governance import GovernMetric

    db = _governance_db()
    db.add(GovernMetric(id=2, name="rev", display_name="Doanh thu thuần",
                        definition="Doanh thu sau hoàn trả", status="Approved"))
    db.commit()
    block, refs = _managed_block(monkeypatch, db)
    assert "Doanh thu thuần" in block
    assert any(r["kind"] == "metric" and r["ref"] == "rev" for r in refs)


def test_def07b_a_retrieved_document_is_cited_in_the_refs(monkeypatch):
    """FIXED in PR-0B2 (was REPRODUCED DEF-07b)."""
    db = _governance_db()
    chunks = [{"doc_id": 5, "content": "Doanh thu ghi nhận khi giao hàng"}]
    assembled = {"text": "• Doanh thu ghi nhận khi giao hàng",
                 "sources": [{"doc_id": 5, "title": "Chính sách doanh thu"}]}
    _block, refs = _managed_block(monkeypatch, db, docs=(chunks, assembled))
    assert {"kind": "doc", "ref": "5", "name": "Chính sách doanh thu"} in refs


# ── SEC-08  the bot promotes its OWN findings to validated knowledge ─────────


def test_sec08_a_repeated_bot_finding_stays_a_candidate():
    """FIXED in PR-0B2 (was REPRODUCED SEC-08)."""
    from app.models.ai_bot_knowledge import AiBotKnowledge
    from app.services.dashboard_ai_bot import knowledge as KB

    db = _session(AiBotKnowledge)
    finding = {"claim": "Doanh thu tháng 9 giảm 12% so với tháng 8", "confidence": "HIGH"}
    KB.capture_findings(db, dashboard_id=7, findings=[finding])
    KB.capture_findings(db, dashboard_id=7, findings=[finding])
    db.commit()
    rows = db.query(AiBotKnowledge).filter(AiBotKnowledge.dashboard_id == 7).all()
    assert rows, "capture stored nothing — re-check SEC-08"
    assert all(r.status != "validated" for r in rows)


def test_sec08_a_single_bot_finding_is_only_a_candidate():
    from app.models.ai_bot_knowledge import AiBotKnowledge
    from app.services.dashboard_ai_bot import knowledge as KB

    db = _session(AiBotKnowledge)
    KB.capture_findings(
        db, dashboard_id=8,
        findings=[{"claim": "Khu vực miền Nam chiếm 41% đơn hàng", "confidence": "HIGH"}],
    )
    db.commit()
    rows = db.query(AiBotKnowledge).filter(AiBotKnowledge.dashboard_id == 8).all()
    assert [r.status for r in rows] == ["candidate"]


def _kb_row(db, **kw):
    from app.models.ai_bot_knowledge import AiBotKnowledge

    base = dict(dashboard_id=7, kind="insight", content="x", confidence=0.9,
                status="validated", source="bot_finding", support_count=3,
                contradiction_count=0, dedupe_key=kw.get("content", "x"))
    base.update(kw)
    row = AiBotKnowledge(**base)
    db.add(row)
    db.commit()
    return row


def test_sec08_a_bot_finding_promoted_before_the_fix_is_not_injected():
    """Rows an earlier version validated on recurrence stay in the table (no data
    migration) but are never recalled as facts."""
    from app.models.ai_bot_knowledge import AiBotKnowledge
    from app.services.dashboard_ai_bot import knowledge as KB

    db = _session(AiBotKnowledge)
    _kb_row(db, content="Doanh thu tháng 9 giảm 12%", source="bot_finding")
    _kb_row(db, content="GMV không gồm đơn huỷ", source="user_taught", kind="concept")
    recalled = [r.content for r in KB.retrieve(db, dashboard_id=7, question="doanh thu GMV")]
    assert recalled == ["GMV không gồm đơn huỷ"]


def test_sec08_the_daily_pass_promotes_nothing():
    from app.models.ai_bot_knowledge import AiBotKnowledge
    from app.services.dashboard_ai_bot import knowledge as KB

    db = _session(AiBotKnowledge)
    _kb_row(db, content="Miền Bắc tăng trưởng nhanh nhất", status="candidate", support_count=9)
    report = KB.consolidate(db, dashboard_id=7)
    assert report["promoted"] == 0
    assert db.query(AiBotKnowledge).one().status == "candidate"


def test_sec08_a_thumbs_up_does_not_certify_a_stored_claim():
    from app.models.ai_bot_knowledge import AiBotKnowledge
    from app.services.dashboard_ai_bot import knowledge as KB

    db = _session(AiBotKnowledge)
    _kb_row(db, content="Khách hàng mới chiếm 30% doanh thu", status="candidate", confidence=0.5)
    KB.apply_feedback(db, dashboard_id=7, claim_text="Khách hàng mới chiếm 30% doanh thu", positive=True)
    row = db.query(AiBotKnowledge).one()
    assert row.status == "candidate" and row.confidence > 0.5


def test_sec08_a_signed_in_user_still_teaches_directly():
    """The allow half: a human source is authoritative and is recalled."""
    from app.models.ai_bot_knowledge import AiBotKnowledge
    from app.services.dashboard_ai_bot import knowledge as KB

    db = _session(AiBotKnowledge)
    row = KB.store_learning(db, dashboard_id=7, kind="concept",
                            content="Đơn hợp lệ là đơn đã giao", source="user_taught")
    db.commit()
    assert row.status == "validated"
    assert [r.content for r in KB.retrieve(db, dashboard_id=7, question="đơn hợp lệ")] == [
        "Đơn hợp lệ là đơn đã giao"
    ]


# ── SEC-09  /semantic/query is gated at `view`, not at `explore` ─────────────


def _semantic_db(verb: str):
    """Dataset 1 with one explore, granted to STRANGER at exactly ``verb``."""
    import uuid

    from app.models.dataset import Dataset, DatasetGrant, DatasetTable
    from app.models.models import Chart
    from app.models.semantic import SemanticExplore, SemanticModel, SemanticView
    from app.models.team import TeamMembership

    owner = uuid.UUID("11111111-1111-1111-1111-111111111111")
    stranger = uuid.UUID("22222222-2222-2222-2222-222222222222")
    db = _session(TeamMembership, DatasetGrant, Dataset, DatasetTable, Chart,
                  SemanticView, SemanticModel, SemanticExplore)
    db.add(Dataset(id=1, name="Sales", owner_id=owner))
    db.add(DatasetTable(id=11, dataset_id=1, display_name="orders", source_table_name="orders"))
    db.add(SemanticView(id=101, name="orders", dataset_table_id=11, sql_table_name="orders",
                        dimensions=[{"name": "status", "type": "string", "sql": "status"}],
                        measures=[]))
    db.add(SemanticModel(id=1, name="sales_model", dataset_id=1))
    db.add(SemanticExplore(id=1, name="orders", model_id=1, base_view_id=101,
                           base_view_name="orders", joins=[]))
    db.add(DatasetGrant(dataset_id=1, user_id=stranger, verb=verb))
    db.commit()
    user = SimpleNamespace(id=stranger, email="stranger@appbi.io",
                           permissions={"datasets": "edit"})
    return db, user


def _semantic_query_refused_by_authorization(db, user) -> bool:
    """True when the request is refused AT THE AUTHORIZATION GATE (existence
    hidden), False when it gets past it — whatever fails afterwards."""
    from fastapi import HTTPException

    from app.routers import semantic as api
    from app.schemas.semantic import SemanticQueryRequest

    req = SemanticQueryRequest(explore="orders", dimensions=["orders.status"], measures=[])
    try:
        api.execute_semantic_query(req, db, user)
    except HTTPException as exc:
        return exc.status_code in (403, 404) and "Explore not found" in str(exc.detail)
    return False


@pytest.mark.xfail(
    strict=True,
    raises=REPRODUCED,
    reason="REPRODUCED SEC-09 (handler-level, real policy on SQLite): a "
    "dataset grant of verb `view` passes the gate of /semantic/query, which "
    "returns warehouse rows; the Dataset policy reserves query for `explore`",
)
def test_sec09_a_view_only_grant_cannot_run_a_semantic_query():
    from app.core.authz.decision import Action, can
    from app.models.dataset import Dataset

    db, user = _semantic_db("view")
    assert not can(db, user, Action.EXPLORE, db.get(Dataset, 1)), "fixture: view must lack explore"
    assert _semantic_query_refused_by_authorization(db, user)


def test_sec09_an_explore_grant_gets_past_the_gate():
    """The allow half: the fix must refuse `view`, not everyone."""
    db, user = _semantic_db("explore")
    assert not _semantic_query_refused_by_authorization(db, user)
