"""One shape for evidence: what every consumer is entitled to receive."""
from __future__ import annotations

import os

os.environ.setdefault("DATABASE_URL", "sqlite:///./test_knowledge_hit.db")
os.environ.setdefault("DATA_DIR", ".testdata")

from datetime import date, timedelta

from app.services.dashboard_ai_bot import knowledge_hit


ROW = {
    "chunk_id": 1243, "doc_id": 27, "title": "Vận hành & Giao vận",
    "chunk_index": 3, "content": "Mục tiêu ≥ 92%.",
    "heading_path": "Vận hành & Giao vận > Cam kết giao đúng hẹn",
    "page": None, "block_kind": "paragraph", "block_from": 3, "block_to": 3,
    "section_index": 1, "section_content": "Toàn bộ mục SLA.",
    "source_version": 6, "trust": "authored", "similarity": 0.52,
    "rrf_score": 0.032, "rerank_score": 13.94, "bm25": 17.7,
    "term_coverage": 0.85, "matched_by": "both", "is_metric_home": False,
    "embedding_model": "text-embedding-3-small", "owner": "Đội BA",
    "last_verified_at": None, "review_date": None, "importance": "normal",
    "sensitivity": "internal", "updated_at": None, "doc_type": "process",
}


# ── the shape itself ───────────────────────────────────────────────────────────

def test_every_declared_field_is_present_even_when_null():
    """A missing key and a null value read the same to a model and completely
    differently to code — `"page" in hit` was how one consumer decided whether to
    show a page number, and it was True for every hit."""
    hit = knowledge_hit.from_chunk(ROW)
    for name in knowledge_hit.FIELDS:
        assert name in hit, "thiếu trường %s" % name


def test_the_fields_a_citation_needs_survive():
    hit = knowledge_hit.from_chunk(ROW)
    assert hit["doc_id"] == 27
    assert hit["document_version"] == 6
    assert hit["heading_path"].endswith("Cam kết giao đúng hẹn")


def test_the_passage_is_addressable():
    """`chunk_id` was dropped by the hand-built dict, so nothing could point at
    one passage and check it later — which is what a citation is for."""
    assert knowledge_hit.from_chunk(ROW)["chunk_id"] == 1243


def test_the_renames_are_gone():
    """content/snippet, doc_id/id, source_version/version, rerank_score/rank_score,
    matched_by/retrieved_by, section_content/section — six fields that meant the
    same thing under two names, one per side of the boundary."""
    hit = knowledge_hit.from_chunk(ROW)
    assert hit["content"] == "Mục tiêu ≥ 92%."
    assert hit["section_content"] == "Toàn bộ mục SLA."
    assert hit["rerank_score"] == 13.94
    assert hit["retrieval_method"] == "both"
    assert "snippet" not in hit and "rank_score" not in hit


def test_both_scores_are_carried_under_their_own_names():
    """RRF ranks the pool, the reranker reorders it. Reporting one number beside
    the other's ordering hands the reader two scores and one sequence that do not
    explain each other."""
    hit = knowledge_hit.from_chunk(ROW)
    assert hit["hybrid_score"] == 0.032
    assert hit["rerank_score"] == 13.94


# ── content is not cut by character count ──────────────────────────────────────

def test_a_normal_passage_is_carried_whole():
    """`content[:320]` cut 27% of this corpus's passages mid-sentence."""
    long_passage = "Câu văn dài. " * 30          # ~390 characters
    hit = knowledge_hit.from_chunk({**ROW, "content": long_passage})
    assert hit["content"] == long_passage
    assert hit["content_truncated"] is False


def test_a_pathological_passage_is_clipped_and_says_so():
    """A consumer that thinks it received the whole passage will summarise a
    fragment as though it were the point."""
    huge = "x" * 20_000
    hit = knowledge_hit.from_chunk({**ROW, "content": huge})
    assert hit["content_truncated"] is True
    assert len(hit["content"]) < len(huge)
    assert hit["content"].endswith("…")


# ── the reason a passage is here ───────────────────────────────────────────────

def test_the_retrieval_channel_is_said_in_words():
    """`matched_by: "both"` is a code. A model reading it has to guess what the
    two were."""
    hit = knowledge_hit.from_chunk(ROW)
    assert "meaning" in hit["reason_retrieved"] and "keyword" in hit["reason_retrieved"]


def test_a_keyword_only_hit_says_it_had_no_semantic_match():
    hit = knowledge_hit.from_chunk({**ROW, "matched_by": "keyword"})
    assert "no semantic match" in hit["reason_retrieved"]


def test_an_unknown_channel_is_passed_through_rather_than_blanked():
    hit = knowledge_hit.from_chunk({**ROW, "matched_by": "graph"})
    assert hit["reason_retrieved"] == "graph"


# ── governance signals ─────────────────────────────────────────────────────────

def test_governance_reaches_the_consumer():
    """Ranking by authority and warning that a policy is overdue both need these,
    and both were impossible: the retriever selected content and stopped."""
    hit = knowledge_hit.from_chunk(ROW)
    assert hit["owner"] == "Đội BA"
    assert hit["importance"] == "normal"
    assert hit["sensitivity"] == "internal"


def test_an_overdue_review_is_flagged():
    yesterday = date.today() - timedelta(days=1)
    assert knowledge_hit.from_chunk({**ROW, "review_date": yesterday})["review_overdue"] is True


def test_a_future_review_is_not_overdue():
    tomorrow = date.today() + timedelta(days=1)
    assert knowledge_hit.from_chunk({**ROW, "review_date": tomorrow})["review_overdue"] is False


def test_no_review_scheduled_is_not_the_same_as_not_overdue():
    """A consumer that cannot tell them apart reports an unreviewed document as
    current."""
    assert knowledge_hit.from_chunk(ROW)["review_overdue"] is None


# ── the other kinds of evidence share the spine ────────────────────────────────

class _Metric:
    name = "gmv"
    display_name = "GMV"
    definition = "Tổng giá trị giao dịch"
    owner = "CFO"


class _Term:
    name = "aov"
    display_name = "AOV"
    description = "Giá trị đơn trung bình"


def test_a_metric_is_authoritative_because_governing_it_is_what_that_means():
    hit = knowledge_hit.from_metric(_Metric(), home_doc_id=26)
    assert hit["source_type"] == "metric"
    assert hit["authority"] is True
    assert hit["doc_id"] == 26


def test_a_glossary_term_is_vocabulary_not_authority():
    """Knowing what a word means is not the same as owning its definition."""
    hit = knowledge_hit.from_term(_Term())
    assert hit["source_type"] == "term"
    assert hit["authority"] is False


def test_every_kind_carries_the_same_field_names():
    """The point of the contract: a consumer ranking or citing evidence should not
    need to know which table it came out of."""
    kinds = [
        knowledge_hit.from_chunk(ROW),
        knowledge_hit.from_metric(_Metric()),
        knowledge_hit.from_term(_Term()),
    ]
    for hit in kinds:
        assert set(knowledge_hit.FIELDS) <= set(hit)


def test_a_kind_specific_field_may_be_added_on_top():
    """"One contract" means the SHARED facts share names, not that a KPI must
    pretend to be a paragraph."""
    hit = knowledge_hit.from_metric(_Metric())
    hit["formula"] = "SUM(price)"
    assert hit["formula"] == "SUM(price)" and hit["title"] == "GMV"


# ── read_document's passages are hits too ──────────────────────────────────────

def test_read_document_long_branch_reads_the_contract_field_names():
    """A LATENT BUG, caught by reading rather than by a test run: when
    `_rank_doc_chunks` started returning contract hits, the long-document branch
    of read_document still joined `p["text"]` — a KeyError that nothing exercised,
    because the branch only fires on a document over 6000 characters and the
    fixtures are all shorter.

    Pinned structurally: the branch must read the names the contract declares.
    """
    import inspect

    from app.services.dashboard_ai_bot import govern_tools

    source = inspect.getsource(govern_tools.tool_read_document)
    assert 'p["text"]' not in source, "doc lai ten cu"
    assert 'p["content"]' in source or 'p.get("content")' in source
    assert 'p["heading_path"]' in source or 'p.get("heading_path")' in source


def test_read_document_serves_the_published_body():
    """Retrieval has always served `published_body()`; this tool read `doc.body`,
    so an agent that SEARCHED got the published text and an agent that READ the
    same document got whatever the author had typed since."""
    import inspect

    from app.services.dashboard_ai_bot import govern_tools

    source = inspect.getsource(govern_tools.tool_read_document)
    assert "GovernanceService.published_body" in source
    assert "_plain(doc.body" not in source
