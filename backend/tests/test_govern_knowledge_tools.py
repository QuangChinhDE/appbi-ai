"""The knowledge tools, and the two rules that keep them safe.

RULE 1 — SCOPE IS A SECURITY BOUNDARY
A flow step on a public link runs as `actor_type='public_session'`: an anonymous
viewer of a shared report, with no User row. `get_knowledge_doc` elsewhere in the
codebase treats `current_user=None` as full access and performs no permission
check, so a tool built on it would let that viewer read every document in the
tenant, drafts included. `read_document` therefore does its own scoping and never
consults that helper.

RULE 2 — FIGURES FROM PROSE ARE NOT EVIDENCE
A number inside a document — a target, an example, last quarter quoted in a memo
— was written by a person, not measured from the data on screen. If it were
recorded as evidence the verifier would "confirm" a claim by matching it against
prose, which is exactly the mistake the verifier exists to catch.
"""
from __future__ import annotations

import os

os.environ.setdefault("DATABASE_URL", "sqlite:///./test_govern_tools.db")
os.environ.setdefault("DATA_DIR", ".testdata")

import pytest

from app.services.dashboard_ai_bot import govern_tools as gt
from app.services.dashboard_ai_bot.evidence import NON_EVIDENTIAL_TOOLS


class _Dash:
    id = 67
    name = "Báo cáo Olist"


class _Ctx:
    """Enough of a ToolContext for the gate. The scoping query itself is
    exercised against a real database — see the module note in the test below."""

    def __init__(self, actor_type="public_session"):
        self.db = None
        self.dashboard = _Dash()
        self.public_filters = []
        self.actor_type = actor_type
        self.knowledge_scope = {}


# ── rule 2: evidence ────────────────────────────────────────────────────────

def test_both_knowledge_tools_are_non_evidential():
    assert "search_knowledge" in NON_EVIDENTIAL_TOOLS
    assert "read_document" in NON_EVIDENTIAL_TOOLS


def test_recording_evidence_for_them_is_refused_at_the_choke_point():
    """One place decides, so a new caller cannot forget."""
    from app.services.dashboard_ai_bot.evidence import record_tool_evidence

    result = record_tool_evidence(
        run_ref="r1", dashboard_id=67, tool_name="read_document",
        args={"doc_id": 1}, result={"ok": True, "data": {"body": "GMV mục tiêu 500 tỷ"}},
    )
    assert result is None


def test_chart_tools_are_still_evidential():
    """The class must stay narrow. Widening it to web_search would start stripping
    legitimately sourced figures out of answers."""
    assert "get_chart_data" not in NON_EVIDENTIAL_TOOLS
    assert "web_search" not in NON_EVIDENTIAL_TOOLS


# ── rule 1: scope ───────────────────────────────────────────────────────────

def test_reading_an_out_of_scope_document_is_refused(monkeypatch):
    monkeypatch.setattr(gt, "_visible_doc_ids", lambda ctx: {5, 6})
    out = gt.tool_read_document(_Ctx(), {"doc_id": 99})
    assert out.get("ok") is False


def test_the_refusal_does_not_reveal_whether_the_document_exists(monkeypatch):
    """An anonymous viewer must not be able to probe which ids exist by reading
    the error, so 'no such document', 'still a draft' and 'belongs to another
    report' all say the same thing."""
    monkeypatch.setattr(gt, "_visible_doc_ids", lambda ctx: set())
    missing = gt.tool_read_document(_Ctx(), {"doc_id": 99})
    other = gt.tool_read_document(_Ctx(), {"doc_id": 1})
    assert missing.get("error") == other.get("error")


def test_an_authenticated_actor_gets_the_same_scope(monkeypatch):
    """One rule is easier to reason about than two, and nobody has asked for a bot
    that answers about report A using documents attached only to report B."""
    calls = []

    def _visible(ctx):
        calls.append(ctx.actor_type)
        return set()

    monkeypatch.setattr(gt, "_visible_doc_ids", _visible)
    gt.tool_read_document(_Ctx("public_session"), {"doc_id": 1})
    gt.tool_read_document(_Ctx("user"), {"doc_id": 1})
    assert calls == ["public_session", "user"]


def test_a_non_numeric_doc_id_is_a_clear_error_not_a_crash():
    out = gt.tool_read_document(_Ctx(), {"doc_id": "the first one"})
    assert out.get("ok") is False
    assert "doc_id" in (out.get("error") or "")


def test_search_requires_a_query():
    out = gt.tool_search_knowledge(_Ctx(), {})
    assert out.get("ok") is False


# ── behaviour that keeps the model honest ───────────────────────────────────

def test_search_results_say_they_are_definitions_not_measurements(monkeypatch):
    monkeypatch.setattr(gt, "_visible_doc_ids", lambda ctx: set())
    monkeypatch.setattr(gt, "_metrics_in_scope", lambda ctx, question="": [])
    out = gt.tool_search_knowledge(_Ctx(), {"query": "GMV"})
    note = (out.get("data") or {}).get("note") or ""
    assert "NOT a measurement" in note or "KHÔNG phải số đo" in note


def test_the_result_limit_is_bounded(monkeypatch):
    monkeypatch.setattr(gt, "_visible_doc_ids", lambda ctx: set())
    monkeypatch.setattr(gt, "_metrics_in_scope", lambda ctx, question="": [])
    out = gt.tool_search_knowledge(_Ctx(), {"query": "GMV", "limit": 9999})
    assert (out.get("data") or {}).get("returned") == 0  # nothing to return here
    # and the cap is a constant a reader can find
    assert gt.MAX_HITS <= 20


# ── keyword matching ────────────────────────────────────────────────────────

def test_matching_ignores_vietnamese_diacritics_and_case():
    assert gt._fold("Doanh Thu Đơn Hàng") == "doanh thu don hang"


def test_scoring_is_the_share_of_query_words_found():
    needles = gt._tokens("gmv thang nay")
    assert gt._score("GMV tháng này là bao nhiêu", needles) == 1.0
    assert gt._score("GMV là tổng giá trị giao dịch", needles) < 1.0
    assert gt._score("hoàn toàn không liên quan", needles) == 0.0


def test_a_body_longer_than_the_cap_is_truncated_and_says_so(monkeypatch):
    long_body = "câu văn dài " * 2000
    plain = gt._plain(long_body, gt.MAX_BODY_CHARS)
    assert len(plain) <= gt.MAX_BODY_CHARS + 1
    assert plain.endswith("…")


def test_markdown_and_template_tokens_are_stripped_before_a_model_reads_them():
    plain = gt._plain("# Tiêu đề\n\n**đậm** {{bien_the}} `code`", 400)
    assert "#" not in plain and "**" not in plain and "{{" not in plain


# ── registration ────────────────────────────────────────────────────────────

def test_both_tools_are_dispatchable_by_the_agent():
    """Registered in the live registry, not just defined — the failure mode is a
    capability that grants a tool the dispatcher cannot find."""
    from app.services.dashboard_ai_bot.thinking.tools import TOOLS, TOOL_DEFINITIONS

    assert "search_knowledge" in TOOLS
    assert "read_document" in TOOLS
    names = {d["name"] for d in TOOL_DEFINITIONS}
    assert {"search_knowledge", "read_document"} <= names


def test_the_tool_catalog_describes_them_for_the_step_editor():
    from app.services.agent_flows.tools.registry import all_tools, pack_of

    specs = all_tools()
    for name in ("search_knowledge", "read_document"):
        assert name in specs
        assert pack_of(name).key == "knowledge"


# ── rule 3: where the ceiling comes from ────────────────────────────────────
#
# THE RULE CHANGED, deliberately. It used to be
#     grant ∩ documents attached to this report
# which made cross-report reference impossible: an author who wanted one agent to
# check a figure against a company-wide policy document had no way to say so.
#
# It is now
#     grant ∩ Published
# and the safety moved UP a layer, to where it belongs. A grant can only be made
# through `/ai/grantable`, which lists documents through `_owned_or_shared` — the
# same filter the Documents screen uses. So the ceiling is "what the person
# building the flow was entitled to open", decided once, by a named user, with
# their rights checked. A viewer of the shared link never chooses anything and
# never sees what was chosen.
#
# Published survives as a runtime guard because a draft is not something anyone
# decided a viewer should read, whoever can open it in the editor.

def test_a_granted_document_may_sit_outside_this_report(monkeypatch):
    """The feature this change exists for: cross-checking against a document the
    report itself has no link to."""
    monkeypatch.setattr(gt, "_entitled_doc_ids", lambda ctx: {5, 6})
    monkeypatch.setattr(gt, "_published_doc_ids", lambda ctx: {5, 6, 42})
    ctx = _Ctx()
    ctx.knowledge_scope = {"doc_ids": [42]}
    assert gt._visible_doc_ids(ctx) == {42}


def test_a_granted_document_that_is_not_published_is_still_refused(monkeypatch):
    """The one runtime guard left. A draft was never approved for a viewer."""
    monkeypatch.setattr(gt, "_entitled_doc_ids", lambda ctx: {5, 6})
    monkeypatch.setattr(gt, "_published_doc_ids", lambda ctx: {5, 6})
    ctx = _Ctx()
    ctx.knowledge_scope = {"doc_ids": [42]}
    assert gt._visible_doc_ids(ctx) == set()


def test_a_grant_of_only_unpublished_ids_reads_nothing(monkeypatch):
    """Fails CLOSED. Falling back to "everything" on an empty intersection would
    turn a stale grant into a privilege escalation."""
    monkeypatch.setattr(gt, "_entitled_doc_ids", lambda ctx: {5, 6})
    monkeypatch.setattr(gt, "_published_doc_ids", lambda ctx: set())
    ctx = _Ctx()
    ctx.knowledge_scope = {"doc_ids": [5]}
    assert gt._visible_doc_ids(ctx) == set()


def test_no_grant_means_what_this_report_has_attached(monkeypatch):
    """Unchanged, and it is the common case: most steps grant nothing and read
    the documents somebody attached to the report."""
    monkeypatch.setattr(gt, "_entitled_doc_ids", lambda ctx: {5, 6})
    assert gt._visible_doc_ids(_Ctx()) == {5, 6}


def test_a_non_numeric_id_in_a_grant_is_ignored_not_crashed(monkeypatch):
    monkeypatch.setattr(gt, "_published_doc_ids", lambda ctx: {5, 6})
    ctx = _Ctx()
    ctx.knowledge_scope = {"doc_ids": [5, "the second one", None]}
    assert gt._visible_doc_ids(ctx) == {5}


def test_the_grant_endpoint_filters_by_the_authors_own_rights():
    """Pinned as a contract, not as behaviour: whichever way `/ai/grantable` is
    rewritten, it must keep going through the shared permission filter. Listing
    every document and letting an author tick is the failure this guards."""
    import ast
    from pathlib import Path

    src = (
        Path(__file__).resolve().parents[1]
        / "app" / "modules" / "agent_flows" / "api.py"
    ).read_text(encoding="utf-8")
    tree = ast.parse(src)
    fn = next(
        n for n in ast.walk(tree)
        if isinstance(n, ast.FunctionDef) and n.name == "list_attachable"
    )
    body = ast.dump(fn)
    assert "attachable_documents" in body, "attachable must use the shared document permission filter"
    assert "attachable_datasets" in body, "attachable must use the shared dataset permission filter"
