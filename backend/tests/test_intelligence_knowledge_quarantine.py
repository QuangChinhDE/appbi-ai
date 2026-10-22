"""Orphaned Approved knowledge is quarantined, not deleted, not relabelled (SEC-10, ADR-014).

PO decision 2026-10-20: QUARANTINE. Rules, playbooks, Verified Q&A and AI
instructions lost their management screens (routes 404). Their Approved/active
rows were still injected into every prompt as authoritative, and nobody could
revoke them. Until a governed surface can re-review them they are NOT model
context. Three things must hold together, and each one has a test:

* **Negative:** none of the four kinds reaches the prompt or the provenance refs.
* **Positive:** what is still governed keeps working. Data caveats are still
  injected. GovernAIScope, a SECURITY policy, is still enforced: quarantining it
  would WIDEN what the AI reads.
* **Nothing is deleted:** the rows stay and the inventory lists them.

The CONTROL test turns the quarantine off and shows the same fixture DOES inject
all four. That proves the negative tests exercise the real injection path, and
it is the fail-first run of this change.
"""
from __future__ import annotations

import pytest
from sqlalchemy import create_engine
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool


@compiles(JSONB, "sqlite")
def _jsonb(_t, _c, **_k):
    return "JSON"


@compiles(UUID, "sqlite")
def _uuid(_t, _c, **_k):
    return "CHAR(36)"


QUESTION = "doanh thu tháng này thế nào"


@pytest.fixture()
def db(monkeypatch):
    from app.core.database import Base
    from app.models.dataset import Dataset, DatasetTable
    from app.models.governance import (
        GovernAIInstruction, GovernAIScope, GovernDataCaveat, GovernMetric, GovernMetricBinding,
        GovernPlaybook, GovernRule, GovernVerifiedQA,
    )
    from app.services import governance_service
    from app.services.dashboard_ai_bot import knowledge_context as K

    models = (Dataset, DatasetTable, GovernMetric, GovernMetricBinding, GovernRule, GovernPlaybook,
              GovernVerifiedQA, GovernAIInstruction, GovernDataCaveat, GovernAIScope)
    engine = create_engine("sqlite://", future=True, poolclass=StaticPool,
                           connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine, tables=[m.__table__ for m in models])
    s = sessionmaker(bind=engine, future=True)()
    s.add(Dataset(id=1, name="sales"))
    s.add(DatasetTable(id=10, dataset_id=1, display_name="orders"))
    s.add(GovernMetric(id=1, name="revenue", display_name="Doanh thu", status="Approved"))
    s.add(GovernRule(id=1, name="Quy tắc mồ côi", condition_text="doanh thu giảm",
                     conclusion_text="báo động đỏ", applies_to=[{"kind": "dataset", "ref": "1"}],
                     status="Approved"))
    s.add(GovernPlaybook(id=1, name="Playbook mồ côi", trigger_text="khi doanh thu giảm",
                         steps=["bước A"], linked_metrics=["revenue"], status="Approved"))
    s.add(GovernVerifiedQA(id=1, question="Doanh thu tháng này?", trigger_phrases=[QUESTION],
                           answer_md="Đáp án ghim không ai thu hồi được", status="Approved"))
    s.add(GovernAIInstruction(id=1, scope="global", content_md="Luôn nói doanh thu tăng",
                              version=1, status="active"))
    s.add(GovernDataCaveat(id=1, dataset_id=1, title="Lưu ý trễ dữ liệu",
                           content="Dữ liệu trễ 1 ngày", always_inject=True, status="Approved"))
    s.add(GovernAIScope(dataset_id=1, excluded_columns=["salary"], excluded_measures=[]))
    s.commit()
    monkeypatch.setattr(K, "dashboard_table_ids", lambda _db, _id: [10])
    monkeypatch.setattr(governance_service.GovernanceService, "metric_dataset_ids",
                        staticmethod(lambda _db, _m, resolved_only=False: {1}))
    return s


def _blocks(db):
    from app.services.dashboard_ai_bot import knowledge_context as K

    parts, refs = K._intelligence_blocks(db, 99, QUESTION)
    return "\n".join(parts), refs


ORPHANED = {"instruction": "Luôn nói doanh thu tăng", "qa": "Đáp án ghim", "rule": "Quy tắc mồ côi",
            "playbook": "Playbook mồ côi"}


def test_control_without_quarantine_all_four_are_injected(db, monkeypatch):
    """The fail-first run: this is what every prompt received before the change."""
    from app.services import governance_ai_service as G

    monkeypatch.setattr(G, "QUARANTINED_KINDS", frozenset())
    text, refs = _blocks(db)
    for kind, marker in ORPHANED.items():
        assert marker in text, kind
    assert {r["kind"] for r in refs} >= set(ORPHANED)


def test_quarantined_knowledge_never_reaches_the_prompt(db):
    text, refs = _blocks(db)
    for kind, marker in ORPHANED.items():
        assert marker not in text, kind
    assert not {r["kind"] for r in refs} & set(ORPHANED)


def test_governed_caveats_are_still_injected(db):
    text, refs = _blocks(db)
    assert "Dữ liệu trễ 1 ngày" in text
    assert any(r["kind"] == "caveat" for r in refs)


def test_the_ai_scope_security_policy_is_not_quarantined(db):
    from app.services.governance_ai_service import GovernanceAIService, is_quarantined

    cols, _measures = GovernanceAIService.scope_exclusions(db, {1})
    assert "salary" in {c.lower() for c in cols}
    assert not is_quarantined("ai_scope")


def test_nothing_is_deleted_and_the_inventory_lists_it(db):
    from app.models.governance import GovernAIInstruction, GovernPlaybook, GovernRule, GovernVerifiedQA
    from app.services.governance_ai_service import knowledge_quarantine_inventory

    _blocks(db)  # a turn happens
    inv = knowledge_quarantine_inventory(db)
    assert inv["counts"] == {"rule": 1, "playbook": 1, "qa": 1, "instruction": 1}
    assert inv["total"] == 4
    assert all(i["quarantined"] for items in inv["items"].values() for i in items)
    for model in (GovernRule, GovernPlaybook, GovernVerifiedQA, GovernAIInstruction):
        assert db.query(model).count() == 1
    # Names and ids only: the inventory is not a second injection path.
    assert "Đáp án ghim" not in str(inv)
    assert "Luôn nói doanh thu tăng" not in str(inv)
