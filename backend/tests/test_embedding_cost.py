"""What one retrieval costs, and where that cost actually was.

The analysis node's budget was being spent on network. Every query embedding
opened a fresh TLS connection to OpenAI, and query expansion embedded each
alternative on its own trip: four round trips for one question, measured between
0.4 and 7.4 seconds each.

These tests pin the two things that fixed it — one reused connection, and one
request for the alternatives — and the third thing, that a saving may never
quietly cost the caller more than it saves.
"""
from __future__ import annotations

import os

os.environ.setdefault("DATABASE_URL", "sqlite:///./test_embed_cost.db")
os.environ.setdefault("DATA_DIR", ".testdata")

import pytest

from app.services import embedding_service as es


# ── what retrieval costs ───────────────────────────────────────────────────────

def test_the_same_query_is_bought_once(monkeypatch):
    """Measured at 0.4-7.4s per call, so a repeat is not a rounding error."""
    es._query_cache.clear()
    calls = []
    monkeypatch.setattr(es, "_openai_embed",
                        lambda content, model=None, **k: calls.append(content) or [0.1])
    monkeypatch.setattr(es.settings, "OPENAI_API_KEY", "sk-test", raising=False)

    first = es.EmbeddingService.generate_query_embedding("tỷ lệ giao đúng hẹn")
    second = es.EmbeddingService.generate_query_embedding("tỷ lệ giao đúng hẹn")
    assert first == second == [0.1]
    assert len(calls) == 1


def test_a_failed_embedding_is_not_remembered_as_an_answer(monkeypatch):
    """Caching None would turn one bad minute into a permanently unsearchable
    query for the life of the worker."""
    es._query_cache.clear()
    monkeypatch.setattr(es, "_openai_embed", lambda content, model=None, **k: None)
    monkeypatch.setattr(es.settings, "OPENAI_API_KEY", "sk-test", raising=False)

    assert es.EmbeddingService.generate_query_embedding("q") is None
    assert not es._query_cache


def test_the_cache_is_bounded():
    es._query_cache.clear()
    for i in range(es._QUERY_CACHE_MAX + 50):
        es._cache_put(("m", f"q{i}"), [0.1])
    assert len(es._query_cache) == es._QUERY_CACHE_MAX


def test_the_alternatives_travel_in_one_request(monkeypatch):
    """Query expansion runs a pass per alternative and each embedded its own
    query. The endpoint takes a list; the passes then find their vectors already
    bought and nothing about them changes."""
    es._query_cache.clear()
    batches = []

    def fake_many(contents, model=None, **k):
        batches.append(list(contents))
        return [[float(i)] for i in range(len(contents))]

    monkeypatch.setattr(es, "_openai_embed_many", fake_many)
    monkeypatch.setattr(es, "_openai_embed",
                        lambda *a, **k: pytest.fail("phai di theo lo, khong goi le"))
    monkeypatch.setattr(es.settings, "OPENAI_API_KEY", "sk-test", raising=False)

    primed = es.EmbeddingService.prime_query_embeddings(["a", "b", "c"])
    assert primed == 3
    assert batches == [["a", "b", "c"]]
    # And the pass that follows pays nothing.
    assert es.EmbeddingService.generate_query_embedding("b") == [1.0]


def test_a_batch_never_costs_more_than_it_saves():
    """If the batch fails the passes embed individually anyway, so a slow batch is
    added on top rather than replacing anything. Measured once at 12s before this
    bound existed."""
    assert es._PRIME_TIMEOUT_S < es._QUERY_TIMEOUT_S < es._TIMEOUT_S


def test_a_query_may_not_wait_as_long_as_an_indexing_job():
    """Indexing runs in the background; a query sits inside a node with 45
    seconds for the whole run."""
    assert es._QUERY_TIMEOUT_S <= 15.0


def test_the_batch_trusts_the_returned_index_not_the_order(monkeypatch):
    """The endpoint does not promise input order, and silently mismatched vectors
    would attach each query to somebody else's meaning."""
    class _Response:
        status_code = 200

        def raise_for_status(self):
            return None

        def json(self):
            return {"data": [
                {"index": 1, "embedding": [2.0] * 768},
                {"index": 0, "embedding": [1.0] * 768},
            ]}

    monkeypatch.setattr(es, "_http", lambda: type(
        "C", (), {"post": lambda *a, **k: _Response()})())
    monkeypatch.setattr(es.settings, "OPENAI_API_KEY", "sk-test", raising=False)

    out = es._openai_embed_many(["first", "second"])
    assert out[0][0] == 1.0 and out[1][0] == 2.0


def test_a_short_batch_is_refused_rather_than_misaligned(monkeypatch):
    class _Response:
        def raise_for_status(self):
            return None

        def json(self):
            return {"data": [{"index": 0, "embedding": [1.0] * 768}]}

    monkeypatch.setattr(es, "_http", lambda: type(
        "C", (), {"post": lambda *a, **k: _Response()})())
    monkeypatch.setattr(es.settings, "OPENAI_API_KEY", "sk-test", raising=False)

    assert es._openai_embed_many(["a", "b"]) is None


def test_one_connection_is_kept_rather_than_opened_per_call():
    """MEASURED, five calls to the same endpoint:

        a new connection each call   1177, 1467, 399, 390, 785 ms
        one client, keep-alive        750,  260, 265, 261, 264 ms

    The handshake is where the variance lived, and the variance is what a
    timeout is made of.
    """
    es._client = None
    assert es._http() is es._http()
    assert es._http().__class__.__name__ == "Client"


def test_importing_the_module_opens_no_sockets():
    """It is imported by tests, by alembic and by workers that never embed."""
    import importlib

    es._client = None
    importlib.reload(es)
    assert es._client is None


# ── the guard that was built, measured, and taken back out ─────────────────────

def test_no_shared_cross_encoder_deadline_across_passes():
    """A wallet shared by a question's passes was tried. Measured over three runs
    of a two-clause question it skipped 2 of 4 passes, once discarded 1101ms of
    work it had already done, and left 0 of 6 rows with a cross-encoder score.

    The relevance floor decides whether a question is ANSWERABLE. Unscored rows
    make that verdict blind, so the saving came out of the one signal measured at
    0.978 against 0.844 for its nearest alternative. The cost it was aimed at was
    the network, and that is fixed where it lives.
    """
    import inspect

    from app.services.dashboard_ai_bot import doc_rerank_semantic

    assert not hasattr(doc_rerank_semantic, "open_budget")
    from app.services.dashboard_ai_bot import govern_doc_embeddings

    source = inspect.getsource(govern_doc_embeddings.search_doc_chunks)
    assert "open_budget" not in source
