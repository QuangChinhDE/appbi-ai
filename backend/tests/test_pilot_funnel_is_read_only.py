# -*- coding: utf-8 -*-
"""The pilot funnel is a REPORT. It must never be able to change what it reports.

WHY THIS TEST AND NOT A TEST OF THE NUMBERS.

`scripts/ops/pilot_funnel.sql` is run by an operator against a pilot database
that holds real readers' runs and ratings. Asserting the aggregates would mean
building a fixture database and would prove only that `count(*)` counts. The
risk worth locking is different and much duller: that somebody edits this file
later — to backfill a column, to clean up test rows, to "just fix" one binding —
and an ops report quietly becomes an ops mutation. By then it has already run.

So this asserts the properties that make it safe to hand to an operator: it only
reads, it cannot wander onto tables it has no business in, and it counts readers
rather than printing what they typed. Plus one contract check: the metrics the
launch brief asked for are actually in it, because a funnel that silently stops
answering "how many readers rated an answer" is the failure that looks like
success.

EVERY ASSERTION HERE WAS MUTATION-TESTED, and that is not a formality. The first
version of the reader-content check stripped aggregates and predicates out of a
whole statement with regexes and searched the remainder. Run against a funnel
that really did select `question_norm`, it passed. A check that cannot catch its
own case is worse than no check, so it was replaced with the narrow question —
what is in the SELECT list — which is trivially right.

WHAT IS DELIBERATELY NOT ASSERTED. Formatting, column order, and the wording of
the psql headings. Those change with every readability pass, and locking them
would make this test fail on work that improved the file.
"""
from __future__ import annotations

import pathlib
import re

import pytest

REPO = pathlib.Path(__file__).resolve().parents[2]
FUNNEL = REPO / "scripts" / "ops" / "pilot_funnel.sql"


@pytest.fixture(scope="module")
def sql() -> str:
    assert FUNNEL.exists(), f"the pilot funnel is missing at {FUNNEL}"
    return FUNNEL.read_text(encoding="utf-8")


@pytest.fixture(scope="module")
def statements(sql: str) -> list[str]:
    """The SQL, with comments and psql directives stripped.

    Comments go first and on purpose: the file EXPLAINS why it does not write, so
    a naive scan for the word `delete` matches the prose that promises there is
    none.
    """
    body = re.sub(r"^[ \t]*--.*$", "", sql, flags=re.M)
    body = re.sub(r"^[ \t]*\\echo.*$", "", body, flags=re.M)
    return [s.strip() for s in body.split(";") if s.strip()]


# ── it only reads ────────────────────────────────────────────────────────────

#: Anything that changes data or schema. `CREATE` is here even for a temp table:
#: a report that needs one has outgrown being a report.
FORBIDDEN = (
    "insert", "update", "delete", "truncate", "drop", "alter", "create",
    "grant", "revoke", "merge", "copy", "vacuum", "refresh",
)


def test_every_statement_is_a_select(statements):
    assert statements, "the funnel contains no statements at all"
    for st in statements:
        first = st.split()[0].lower()
        assert first in ("select", "with"), (
            f"a statement in the pilot funnel starts with {first!r}. This file is "
            "run against a pilot database that holds real readers' runs; it may "
            "only SELECT."
        )


@pytest.mark.parametrize("word", FORBIDDEN)
def test_no_statement_contains_a_mutating_keyword(statements, word):
    for st in statements:
        assert not re.search(rf"\b{word}\b", st, flags=re.I), (
            f"the pilot funnel contains {word.upper()!r}. An ops report that can "
            "write is one bad edit away from changing the pilot it is measuring."
        )


# ── it cannot wander ─────────────────────────────────────────────────────────

#: The three tables the funnel may read. Runs, versions and bindings are the
#: pilot's own records. Reading anything else — users, dashboards, datasets —
#: would put data on an operator's screen that "how is the pilot going" never
#: required.
ALLOWED_TABLES = {"agent_flow_runs", "agent_brain_versions", "agent_flow_bindings"}


def test_it_reads_only_the_pilots_own_tables(statements):
    referenced: set[str] = set()
    for st in statements:
        referenced.update(
            m.lower() for m in re.findall(r"\bFROM\s+([a-z_][a-z0-9_]*)", st, flags=re.I))
        referenced.update(
            m.lower() for m in re.findall(r"\bJOIN\s+([a-z_][a-z0-9_]*)", st, flags=re.I))
    stray = referenced - ALLOWED_TABLES
    assert not stray, (
        f"the pilot funnel reads {sorted(stray)}. It is handed to an operator to "
        "answer how the pilot is going, which needs runs, versions and bindings "
        "and nothing else."
    )


#: Columns that may be COUNTED but never LISTED.
SENSITIVE_COLUMNS = ("question_norm", "session_key")


def _select_lists(statements: list[str]) -> list[str]:
    """The text between SELECT and FROM — exactly where "listed" happens."""
    out = []
    for st in statements:
        m = re.search(r"\bSELECT\b(.*?)\bFROM\b", st, flags=re.I | re.S)
        if m:
            out.append(m.group(1))
    return out


@pytest.mark.parametrize("column", SENSITIVE_COLUMNS)
def test_no_reader_content_is_listed_as_a_column(statements, column):
    """`count(DISTINCT session_key)` is fine. `SELECT session_key` is not.

    `question_norm` holds the reader's actual question, and it is exactly the
    column a later edit reaches for to make a report "more useful". Printing what
    a reader typed onto an operator's screen is a different decision from
    counting runs, and it is not one this file gets to make quietly.
    """
    for select_list in _select_lists(statements):
        # An aggregate COUNTS the column and a FILTER clause is a predicate about
        # which rows to count. Neither prints it. Both are removed before asking
        # what is left standing on its own as a column — which caught a real case
        # on the first run: `count(DISTINCT session_key) FILTER (WHERE ...
        # session_key IS NOT NULL)` is correct usage twice over.
        listed = re.sub(
            r"\b(?:count|sum|avg|min|max)\s*\([^()]*\)", " ", select_list, flags=re.I)
        listed = re.sub(r"\bFILTER\s*\([^()]*\)", " ", listed, flags=re.I)
        assert not re.search(rf"\b{column}\b", listed, flags=re.I), (
            f"{column!r} is listed as a column in the pilot funnel: "
            + " ".join(select_list.split())[:200]
            + " — a funnel counts readers; it does not print what they typed."
        )


def test_every_grouped_listing_is_bounded(statements):
    """A GROUP BY over a pilot table returns a row per flow.

    Fine on a fixture, not fine on a database that has been running for months,
    so each listing carries its own LIMIT rather than trusting a terminal to
    scroll.
    """
    for st in statements:
        if re.search(r"\bGROUP\s+BY\b", st, flags=re.I):
            assert re.search(r"\bLIMIT\s+\d+", st, flags=re.I), (
                "a GROUP BY in the pilot funnel has no LIMIT: "
                + " ".join(st.split())[:200]
            )


# ── it answers what the launch asked it to ───────────────────────────────────

@pytest.mark.parametrize("metric", [
    # Authoring
    "flows_total", "flows_published", "versions_saved",
    # Activation — a published flow a reader can actually reach
    "bindings_active", "reports_with_an_assistant",
    # Runs, by outcome
    "runs_total", "runs_ok", "runs_partial", "runs_failed", "runs_blocked",
    # An author trying it vs a reader using it
    "runs_author_test", "runs_reader",
    # Feedback
    "rated", "positive", "negative", "unrated",
    # Recency and reach
    "runs_7d", "distinct_reader_sessions", "distinct_authors",
])
def test_the_funnel_reports_the_metric(sql: str, metric: str):
    assert re.search(rf"\bAS\s+{metric}\b", sql, flags=re.I), (
        f"the pilot funnel no longer reports {metric!r}. Every metric here was "
        "named in the V1 launch contract; dropping one makes the report quietly "
        "stop answering a question somebody is still asking of it."
    )


def test_a_test_run_is_never_counted_as_a_reader(sql: str):
    """The single most misleading thing this report could do.

    Most runs on a development database are an author pressing Test. A funnel
    that counted those as pilot usage would report a product nobody is using as
    a success.
    """
    assert re.search(r"\bNOT\s+is_test\b", sql, flags=re.I), (
        "nothing in the funnel distinguishes an author's test from a reader's "
        "question, so every 'reader' number would include author tests."
    )


def test_the_checks_above_have_no_dead_escape_characters():
    """A guard against the way this file broke while it was being written.

    An edit applied through a shell heredoc turned every word-boundary escape in
    these regexes into a literal backspace (0x08). The tests still passed — they
    were searching for a control character that appears in no SQL file ever
    written — and the mutation that should have failed sailed straight through.
    Nothing about reading the code showed it.
    """
    source = pathlib.Path(__file__).read_text(encoding="utf-8")
    for bad in ("\x08", "\x0b", "\x0c", "\x07"):
        assert bad not in source, (
            f"this test file contains the control character {bad!r}, which means "
            "an escape sequence was written literally instead of as regex syntax. "
            "Every assertion using it silently matches nothing."
        )
