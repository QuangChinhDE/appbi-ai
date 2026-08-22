"""A citation that still opens the right text after the document moves on.

The last third of this file deliberately tests ACROSS phases. A citation is built
by the retriever (phase 1's contract), carried by the assembler, turned into an
envelope citation by the flow runtime, and checked by the answer verifier — and a
change to its shape can break any of those without breaking this module.
"""
from __future__ import annotations

import os

os.environ.setdefault("DATABASE_URL", "sqlite:///./test_citation.db")
os.environ.setdefault("DATA_DIR", ".testdata")

from app.services.dashboard_ai_bot import govern_doc_citation as cite


ROW = {
    "doc_id": 27, "source_version": 6, "title": "Vận hành & Giao vận",
    "heading_path": "Vận hành & Giao vận > Cam kết giao đúng hẹn",
    "page": None, "block_from": 3, "block_to": 4, "block_kind": "paragraph",
    "chunk_id": 1243, "content": "Mục tiêu ≥ 92%.",
}


class _Db:
    """A database with one document at version 6 and a kept snapshot of version 3."""

    CURRENT = [
        (0, "section", "Vận hành", "Vận hành", None),
        (3, "paragraph", "Mục tiêu ≥ 92%.", "Vận hành > SLA", None),
        (4, "paragraph", "Đo theo tháng.", "Vận hành > SLA", None),
    ]
    V3_BODY = "# Vận hành\n\n## SLA\n\nMục tiêu ≥ 90%.\n\nĐo theo quý."

    def __init__(self, *, doc_exists=True, keep_v3=True, published=6):
        self.doc_exists, self.keep_v3, self.published = doc_exists, keep_v3, published
        self._last = ""

    def execute(self, stmt, params=None):
        self._last = str(stmt)
        self._params = params or {}
        return self

    def first(self):
        if "FROM govern_knowledge_docs" in self._last:
            return (27, "Vận hành & Giao vận", self.published, None) if self.doc_exists else None
        if "govern_knowledge_doc_versions" in self._last:
            return (self.V3_BODY,) if (self.keep_v3 and self._params.get("v") == 3) else None
        return None

    def fetchall(self):
        return self.CURRENT if "govern_doc_block" in self._last else []


# ── the fingerprint ────────────────────────────────────────────────────────────

def test_reformatting_a_paragraph_is_not_a_content_change():
    """The check exists to catch a citation pointing at different CONTENT, not at
    different whitespace — otherwise every re-wrap reads as "the source changed"."""
    assert cite.fingerprint("Mục tiêu  ≥ 92%.\n") == cite.fingerprint("Mục tiêu ≥ 92%.")


def test_different_text_fingerprints_differently():
    assert cite.fingerprint("Mục tiêu ≥ 92%.") != cite.fingerprint("Mục tiêu ≥ 95%.")


def test_empty_text_has_no_fingerprint():
    """An empty fingerprint means "not recorded", and a resolver must not treat it
    as a match against every empty block."""
    assert cite.fingerprint("") == "" and cite.fingerprint(None) == ""


# ── what a citation carries ────────────────────────────────────────────────────

def test_a_citation_names_the_version_it_was_made_against():
    assert cite.build(ROW)["document_version"] == 6


def test_a_citation_records_the_whole_block_span():
    """A chunk can cover several blocks, joined with a blank line. Recording only
    `block_from` made every citation to a multi-block chunk report "source changed"
    against its own unmodified document."""
    built = cite.build(ROW)
    assert built["block"] == 3 and built["block_to"] == 4


def test_a_single_block_chunk_spans_itself():
    built = cite.build({**ROW, "block_to": None})
    assert built["block_to"] == built["block"]


def test_a_citation_carries_a_content_fingerprint():
    assert cite.build(ROW)["content_fingerprint"] == cite.fingerprint("Mục tiêu ≥ 92%.")


# ── anchors are per source type ────────────────────────────────────────────────

def test_a_pdf_is_anchored_by_page():
    out = cite.anchor({"page": 4, "heading_path": "Chương 2"}, "file")
    assert out["page"] == 4 and "trang 4" in out["label"]


def test_a_pdf_keeps_its_bounding_box_when_the_layout_pass_found_one():
    out = cite.anchor({"page": 2, "meta": {"bbox": [10, 20, 300, 40]}}, "file")
    assert out["bbox"] == [10, 20, 300, 40]


def test_a_web_page_is_anchored_by_url():
    out = cite.anchor({"heading_path": "Giới thiệu", "source_url": "https://base.vn/"}, "web")
    assert out["url"] == "https://base.vn/"


def test_a_google_doc_is_anchored_by_heading_because_it_has_no_pages():
    out = cite.anchor({"heading_path": "A > B"}, "google_doc")
    assert out["label"] == "A > B" and "page" not in out


def test_a_spreadsheet_is_anchored_by_sheet_not_by_an_invented_cell_range():
    """`_extract_xlsx` flattens each sheet to one markdown table under a `## sheet`
    heading and keeps no cell coordinates. A range would be invented."""
    out = cite.anchor({"heading_path": "Plan 2026"}, "file")
    assert "range" not in out and "cell" not in out


# ── resolution ─────────────────────────────────────────────────────────────────

def test_the_current_version_resolves_and_verifies():
    built = cite.build({**ROW, "block_to": 3, "content": "Mục tiêu ≥ 92%."})
    out = cite.resolve(_Db(), built)
    assert out["status"] == cite.RESOLVED and out["verified"] is True
    assert out["text"] == "Mục tiêu ≥ 92%."


def test_a_multi_block_span_is_rebuilt_the_way_the_chunker_joined_it():
    built = cite.build({**ROW, "content": "Mục tiêu ≥ 92%.\n\nĐo theo tháng."})
    out = cite.resolve(_Db(), built)
    assert out["status"] == cite.RESOLVED and out["verified"] is True


def test_an_older_version_is_rebuilt_from_its_stored_body():
    """`govern_doc_block` holds ONE version — persist_ast deletes and rewrites — so
    without this the only readable text is today's."""
    out = cite.resolve(_Db(), {"doc_id": 27, "document_version": 3, "block": 2})
    assert out["status"] == cite.RESOLVED
    assert out["version"] == 3
    assert "90%" in out["text"], "phai la noi dung ban 3, khong phai ban 6"


def test_the_same_ordinal_means_different_text_in_different_versions():
    """THE reason a fingerprint is not optional. Block 3 holds "Mục tiêu ≥ 92%." in
    the live tree and "Đo theo quý." in version 3 — same coordinate, different
    sentence. A resolver that trusted the ordinal alone would hand a reader the
    wrong paragraph with full confidence."""
    live = cite.resolve(_Db(), {"doc_id": 27, "document_version": 6, "block": 3})
    old = cite.resolve(_Db(), {"doc_id": 27, "document_version": 3, "block": 3})
    assert live["text"] != old["text"]
    assert "92%" in live["text"] and "quý" in old["text"]


def test_a_changed_source_is_reported_and_not_shown_as_the_original():
    """Section 9's actual requirement: không được silently chuyển citation cũ sang
    nội dung document mới."""
    out = cite.resolve(_Db(), {"doc_id": 27, "document_version": 6, "block": 3,
                               "content_fingerprint": "deadbeefcafe"})
    assert out["status"] == cite.CHANGED
    assert out["verified"] is False


def test_a_moved_block_is_found_by_its_content():
    """A file document's live tree can come from structured extraction while a
    historical version rebuilds from markdown, and the two do not number blocks the
    same way. The fingerprint finds the passage wherever it landed."""
    out = cite.resolve(_Db(), {
        "doc_id": 27, "document_version": 6, "block": 99,
        "content_fingerprint": cite.fingerprint("Đo theo tháng."),
    })
    assert out["status"] == cite.RESOLVED and out["verified"] is True
    assert out["block"] == 4
    assert "vị trí đã đổi" in out["note"]


def test_a_version_that_was_not_kept_says_so():
    out = cite.resolve(_Db(keep_v3=False), {"doc_id": 27, "document_version": 3, "block": 3})
    assert out["status"] == cite.MISSING_VERSION
    assert out["text"] is None


def test_a_deleted_document_says_so():
    out = cite.resolve(_Db(doc_exists=False), {"doc_id": 27, "block": 3})
    assert out["status"] == cite.MISSING_DOC


def test_an_ordinal_that_points_at_nothing_says_so():
    out = cite.resolve(_Db(), {"doc_id": 27, "document_version": 6, "block": 999})
    assert out["status"] == cite.NOT_FOUND


def test_resolving_without_a_fingerprint_is_marked_unverified():
    """A citation resolved without verification is a guess that happened to land,
    and the reader is told which one they got."""
    out = cite.resolve(_Db(), {"doc_id": 27, "document_version": 6, "block": 3})
    assert out["status"] == cite.RESOLVED and out["verified"] is False


# ── ACROSS PHASES: the citation has to survive every hop ───────────────────────

def test_phase1_the_contract_carries_the_full_citation():
    """knowledge_hit projects the retriever's row. A citation that loses its
    fingerprint on the way through cannot be verified later."""
    from app.services.dashboard_ai_bot import knowledge_hit

    hit = knowledge_hit.from_chunk({**ROW, "matched_by": "both", "similarity": 0.5})
    assert hit["citation"]["content_fingerprint"]
    assert hit["citation"]["block_to"] == 4
    assert hit["citation"]["source_anchor"]["kind"] == "authored"


def test_phase1_a_hit_built_without_a_retriever_row_still_gets_a_citation():
    """The fallback path: a hand-built row, or a caller assembling a hit from
    something other than a search."""
    from app.services.dashboard_ai_bot import knowledge_hit

    hit = knowledge_hit.from_chunk({"doc_id": 1, "content": "x", "block_from": 0})
    assert hit["citation"]["doc_id"] == 1


def test_phase1_the_assembler_still_reads_the_citation_fields_it_needs():
    """`assemble` builds the numbered source list from these names. Renaming one
    would silently produce citations with no heading and no page."""
    from app.services.dashboard_ai_bot.govern_doc_context import assemble

    out = assemble(_EmptyDb(), [{
        "doc_id": 27, "title": "Vận hành", "content": "Mục tiêu ≥ 92%.",
        "heading_path": "Vận hành > SLA", "page": None, "block_from": 3,
        "block_to": 3, "section_index": 0, "trust": "authored",
        "block_kind": "paragraph", "source_version": 6,
    }])
    citation = out["citations"][0]
    assert citation["doc_id"] == 27 and citation["source_version"] == 6
    assert citation["block"] == 3


def test_phase2_answerability_is_unaffected_by_the_citation_shape():
    """The verdict reads `ce_logit` and `chunk_id`, not the citation — pinned so a
    citation change cannot quietly alter whether the system answers."""
    from app.services.dashboard_ai_bot import govern_doc_answerability as ans

    rows = [{**ROW, "ce_logit": 7.0, "ce_relevant": True,
             "citation": cite.build(ROW)}]
    assert ans.evaluate(None, "q", rows, check_clauses=False)["verdict"] == ans.ANSWERABLE
    assert ans.evaluate(None, "q", rows, check_clauses=False)["evidence_ids"] == [1243]


def test_phase2_conflict_reports_the_version_of_each_side():
    """A reader told two sources disagree needs to know which VERSION each figure
    came from, or they cannot check either."""
    from app.services.dashboard_ai_bot import govern_doc_conflict as conf

    out = conf.detect("Ngưỡng giao đúng hẹn là bao nhiêu?", [
        {"doc_id": 87, "title": "A", "source_version": 1, "ce_relevant": True,
         "heading_path": "Ngưỡng giao đúng hẹn", "content": "là **95%**", "chunk_id": 1},
        {"doc_id": 88, "title": "B", "source_version": 2, "ce_relevant": True,
         "heading_path": "Ngưỡng giao đúng hẹn", "content": "là **88%**", "chunk_id": 2},
    ])
    assert out["conflict"] is True
    assert {s["document_version"] for s in out["sides"]} == {1, 2}


def test_the_runtime_turns_a_tool_citation_into_an_envelope_citation():
    """`_collect_citation` reads the tool's `citations` array. The ref is
    "doc:block" so two passages from one document stay two citations — and the FE
    parses that same shape back to open them."""
    from app.services.agent_flows.runtime.handlers.agent import _collect_citation
    from app.services.agent_flows.runtime.state import RunState

    state = RunState()
    _collect_citation(state, "search_knowledge", {}, {
        "ok": True,
        "citations": [{"n": 1, "doc_id": 27, "block": 3, "title": "Vận hành",
                       "heading_path": "Vận hành > SLA", "source_version": 6}],
    })
    assert state.citations[0].ref == "27:3"
    assert state.citations[0].used == ["1"]


class _EmptyDb:
    def execute(self, *a, **k):
        return self

    def fetchall(self):
        return []
