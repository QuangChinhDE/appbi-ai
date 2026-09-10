"""What actually keeps a draft — or another report's document — out of an answer.

THE GUARANTEE THAT WAS WRITTEN DOWN AND IS NOT IN FORCE
-------------------------------------------------------
`authoring_scope()` used to say: "Row-level security defaults `govern_doc_chunk`
to published rows only, so a retrieval path that forgets its filter returns
nothing rather than drafts."

The policy exists and is written correctly:

    govern_doc_chunk_read:
      doc_status = 'Published' OR current_setting('appbi.chunk_scope') = 'authoring'

`relrowsecurity` and `relforcerowsecurity` are both true. And it never runs,
because Postgres skips RLS entirely for a SUPERUSER or BYPASSRLS role and the
application connects as one. Measured against this deployment with no scope set:

    tong chunk doc duoc: 64
    trong do thuoc tai lieu NHAP: 31

So the second line of defence is decorative, and the first line is the only one.
These tests pin the first line, and pin that nothing quietly starts depending on
the second again.
"""
from __future__ import annotations

import os

os.environ.setdefault("DATABASE_URL", "sqlite:///./test_chunk_scope.db")
os.environ.setdefault("DATA_DIR", ".testdata")

from app.services.dashboard_ai_bot.govern_doc_embeddings import (
    _scoped_chunk_filter,
    authoring_scope,
    restricted_scope,
)


def build(**over):
    kwargs = {"dashboard_id": None, "doc_ids": None, "published_only": True}
    kwargs.update(over)
    # `db` is never touched on the paths under test: every one of them decides
    # from its arguments alone and returns before it would query.
    return _scoped_chunk_filter(None, **kwargs)


# ── fail closed, which is the whole guarantee ─────────────────────────────────

def test_naming_no_scope_at_all_produces_no_query():
    """Not "search everything" and not "search the published set" — nothing. A
    caller that forgot to say what it may read has not asked a question yet."""
    assert build() is None


def test_an_empty_document_list_is_not_an_invitation():
    """`doc_ids=set()` means "these zero documents", which is different from
    "unspecified" and must never widen to the corpus."""
    assert build(doc_ids=set()) is None
    assert build(doc_ids=[]) is None


def test_a_dashboard_with_no_attached_documents_produces_no_query():
    """Resolving the dashboard is allowed to come back empty; what it must not do
    is fall through to an unfiltered scan."""
    class _NoDocs:
        def execute(self, *a, **k):
            return self

        def fetchall(self):
            return []

    assert _scoped_chunk_filter(
        _NoDocs(), dashboard_id=99, doc_ids=None, published_only=True) is None


# ── and what the query says when there IS a scope ─────────────────────────────

def test_the_document_list_is_bound_as_a_parameter_not_interpolated():
    sql, params = build(doc_ids={7, 3})
    assert "c.doc_id = ANY(:allowed)" in sql
    assert params["allowed"] == [3, 7]


def test_published_only_is_a_predicate_in_the_sql():
    """The half of the RLS policy that still has to hold, held in the one place
    that does hold: the query itself."""
    sql, _ = build(doc_ids={1})
    assert "d.status = 'Published'" in sql


def test_the_authoring_console_can_ask_for_drafts_explicitly():
    sql, _ = build(doc_ids={1}, published_only=False)
    assert "d.status = 'Published'" not in sql


def test_only_chunks_with_a_vector_and_a_current_index_are_searched():
    """A document whose index predates the current hash version is not merely
    ranked lower — it is not searched, and that is deliberate."""
    sql, _ = build(doc_ids={1})
    assert "c.embedding IS NOT NULL" in sql
    assert "d.embedded_hash LIKE" in sql


def test_a_chunk_from_another_vector_space_is_excluded():
    """`IS NOT DISTINCT FROM`, not `=`: `embedding_model` is nullable and null
    means "the deployment's active model", so `=` evaluates to NULL and silently
    drops every chunk of those documents from BOTH branches."""
    sql, _ = build(doc_ids={1})
    assert "c.model_version IS NOT DISTINCT FROM d.embedding_model" in sql


# ── nobody re-asserts the guarantee that is not in force ──────────────────────

def test_the_scope_helpers_do_not_claim_rls_protects_the_store():
    """This is a docstring test on purpose. The false sentence lived in exactly
    the place a reader goes to find out what protects the data, and it cost
    nothing to write and would cost a security review its conclusion."""
    for fn in (authoring_scope, restricted_scope):
        doc = (fn.__doc__ or "").lower()
        claims_protection = (
            "row-level security defaults" in doc
            or "returns nothing rather than drafts" in doc
        )
        assert not claims_protection, (
            f"{fn.__name__} claims RLS filters the chunk store; it does not while "
            "the application connects as a SUPERUSER/BYPASSRLS role"
        )


def test_the_health_report_can_say_whether_rls_is_really_on():
    """A protection assumed to be on is worse than one known to be off."""
    import inspect

    from app.services.governance_service import GovernanceService

    source = inspect.getsource(GovernanceService.vector_store_health)
    assert "rls_in_force" in source
    assert "rolbypassrls" in source and "rolsuper" in source
