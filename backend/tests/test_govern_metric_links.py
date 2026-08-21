"""Metric mentions resolve through the governance graph, not through search."""
from __future__ import annotations

import os

os.environ.setdefault("DATABASE_URL", "sqlite:///./test_govern_metric_links.db")
os.environ.setdefault("DATA_DIR", ".testdata")

from app.services.dashboard_ai_bot.govern_metric_links import _aliases, metrics_in_question


class _Db:
    """Returns one governed metric: GMV, defined in document 26."""

    def __init__(self, rows=None):
        self.rows = rows if rows is not None else [(
            101, "GMV — Tổng giá trị giao dịch", "gmv_tong_gia_tri_giao_dich",
            ["GMV", "tổng giá trị giao dịch", "gross merchandise value"],
            26, "Draft", "Doanh thu, GMV & Giá trị đơn",
        )]

    def execute(self, *a, **k):
        return self

    def fetchall(self):
        return self.rows


def test_aliases_are_folded_and_longest_first():
    """Longest first so the most SPECIFIC alias present is the one reported:
    with "gmv" tested first, every mention would be blamed on the acronym."""
    aliases = _aliases(_Db().rows[0])
    assert aliases == sorted(aliases, key=lambda a: (-len(a), a))
    assert "gross merchandise value" in aliases
    assert "tong gia tri giao dich" in aliases
    assert aliases[-1] == "gmv", "the shortest alias must be tested last"


def test_a_multi_word_alias_matches_as_a_phrase():
    """This is the case the feature exists for: 'Gross Merchandise Value' appears
    in the GLOSSARY document, while the document that DEFINES GMV is a different
    one. Text search sends a reader to the glossary; the graph does not."""
    found = metrics_in_question(_Db(), "Gross Merchandise Value được định nghĩa ở đâu?")
    assert len(found) == 1
    assert found[0]["home_doc_id"] == 26
    assert found[0]["matched_alias"] == "gross merchandise value"


def test_a_short_alias_must_match_a_whole_token():
    """'gmv' as a substring would fire inside unrelated words."""
    assert metrics_in_question(_Db(), "Chỉ số GMV là gì?")
    assert metrics_in_question(_Db(), "Số liệu gmvxyz không liên quan") == []


def test_matching_ignores_diacritics():
    assert metrics_in_question(_Db(), "tong gia tri giao dich tinh the nao")


def test_a_question_naming_nothing_resolves_nothing():
    assert metrics_in_question(_Db(), "Chính sách nghỉ phép của công ty?") == []


def test_a_deprecated_metric_is_not_an_authority():
    """Filtered in SQL — a retired definition must not outrank a live passage."""
    import inspect

    source = inspect.getsource(metrics_in_question)
    assert "<> 'Deprecated'" in source
    # A DRAFT one still counts: it is the best pointer anyone recorded, and
    # "being written" is not the same as "wrong".
    assert "'Draft'" not in source


def test_home_doc_lookup_stays_inside_the_search_scope():
    """Naming a metric must not grant access to the document that defines it."""
    import inspect

    from app.services.dashboard_ai_bot.govern_metric_links import home_doc_chunk_ids

    source = inspect.getsource(home_doc_chunk_ids)
    assert "{sql_filter}" in source
    assert "AND c.doc_id = ANY(:home_docs)" in source


def test_a_lookup_failure_never_breaks_retrieval():
    class _Broken:
        def execute(self, *a, **k):
            raise RuntimeError("no such table")

    assert metrics_in_question(_Broken(), "GMV") == []
