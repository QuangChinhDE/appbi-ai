"""A flow declares which surface it was built for, and both sides honour it.

WHY THIS IS A TYPE AND NOT A PREFERENCE
---------------------------------------
The two surfaces hand a flow different things:

    bot   an anonymous viewer on a report, so `dashboard_id` and the link's
          filters ALWAYS arrive. A step may assume there is a report.
    chat  a signed-in reader typing, so only text arrives. Nothing supplies "the
          report", and a step that assumes one reads a field that is not there.

So assigning a chat flow to a link is not a policy violation — it is a step
reading a field nobody sent. It would not even fail loudly: a chat flow has no
`report_read` and no chart tools, so it would answer every question about the
report from documents alone, confidently, never mentioning it had not looked.

WHAT WAS ACTUALLY WRONG
-----------------------
`_usable_flow` — the gate for assigning a flow to a public link — asked exactly two
questions: is this flow shared with you, and does it have a published version. It
had no concept of type at all. Meanwhile the Chat side inferred eligibility from
the flow's SHAPE at the door, so an author learned their assistant was unusable
only after building it.
"""
from __future__ import annotations

import types

import pytest

from app.services.agent_flows import direct_chat, permissions
from app.services.agent_flows.contract import DEFAULT_FLOW_TYPE, Flow, upgrade_body


def _flow(nodes, answer="a"):
    body = {"nodes": nodes, "answer_node": answer}
    return Flow.model_validate(
        {**upgrade_body(body, key="t", name="t"), "key": "t", "name": "t"}
    )


def _agent(key="a", tools=()):
    return {"key": key, "type": "agent", "prompt": "Trả lời.",
            "tools": [{"tool": t} for t in tools]}


# ── the default, and why it is that one ─────────────────────────────────────


def test_anything_without_a_type_is_a_bot():
    """Every flow written before the type existed was seeded `report_read → agent`.

    So it was authored against a report whether or not anybody said so, and `bot`
    is the reading of history rather than an arbitrary default.
    """
    assert DEFAULT_FLOW_TYPE == "bot"


# ── the chat door ───────────────────────────────────────────────────────────


def test_a_bot_flow_is_refused_at_the_chat_door_by_its_type(monkeypatch):
    """Refused for WHAT IT IS, not for what it happens to contain.

    A knowledge-only bot flow would pass every shape check — no report step, no
    chart tools — and still must not appear in Chat: its author built it for a
    report, and the picker is a list of assistants someone meant to offer here.
    """
    row = types.SimpleNamespace(flow_type="bot", brain_key="k", status="published")
    monkeypatch.setattr(
        direct_chat, "usable_brains",
        lambda db, user: types.SimpleNamespace(
            filter=lambda *a: types.SimpleNamespace(
                filter=lambda *b: types.SimpleNamespace(first=lambda: row))),
        raising=False,
    )
    import app.services.agent_flows.permissions as perms

    monkeypatch.setattr(perms, "usable_brains", lambda db, user: _Q(row))

    got_row, flow, problem = direct_chat.resolve_for_chat(None, object(), "k")

    assert problem == "direct_chat_disabled"
    assert flow is None


class _Q:
    """A query stub that answers `.filter(...).filter(...).first()`."""

    def __init__(self, row):
        self._row = row

    def filter(self, *_a):
        return self

    def first(self):
        return self._row


def test_the_refusal_says_it_was_never_a_chat_assistant():
    """"Đã được tắt" would send someone looking for a switch that does not exist.

    The flow was built for a report. That is a different fact from having been
    switched off, and it points at a different fix.
    """
    message = direct_chat.BLOCK_MESSAGES["direct_chat_disabled"]

    assert "Bot trên báo cáo" in message
    assert "tắt" not in message


# ── the shape check, now a safety net rather than the gate ──────────────────


def test_a_report_step_still_makes_a_chat_flow_unrunnable():
    """The type says what the author meant; this says whether it still works.

    A `report_read` in a chat flow has nothing to read — it returns
    `{"charts": [], "read_ok": false}` and the answering step carries on and
    answers from nothing, which is worse than refusing.
    """
    flow = _flow([
        {"key": "r", "type": "report_read", "output_var": "ctx"},
        _agent(),
    ])
    reasons = direct_chat.ineligibility_reasons(flow)

    assert reasons
    assert "đọc báo cáo" in reasons[0]


def test_a_chat_flow_may_be_granted_chart_tools():
    """THE RULE THAT WAS TOO STRICT.

    Chart tools were banned from chat flows because chat had no charts to reach —
    true when the chat path hardcoded an empty allowlist, and it froze Chat at
    "documents only" by banning 20 of 36 tools. A chat flow resolves its chart at
    run time from what its author granted; the tool is how it does that, not
    evidence that it cannot.
    """
    flow = _flow([_agent(tools=("search_business_assets", "rank_values"))])

    assert direct_chat.ineligibility_reasons(flow) == []
    assert direct_chat.is_eligible(flow) is True


def test_a_chart_requirement_still_blocks():
    """A `chart` requirement is positional — only a binding resolves it, and chat
    has no binding to resolve it against."""
    body = {
        "nodes": [_agent()],
        "answer_node": "a",
        "requirements": {"items": [
            {"key": "main", "kind": "chart", "label": "Biểu đồ chính", "required": True},
        ]},
    }
    flow = Flow.model_validate(
        {**upgrade_body(body, key="t", name="t"), "key": "t", "name": "t"}
    )

    assert direct_chat.ineligibility_reasons(flow)


@pytest.mark.parametrize("kind", ["measure", "dimension"])
def test_other_report_bound_requirements_block_too(kind):
    body = {
        "nodes": [_agent()],
        "answer_node": "a",
        "requirements": {"items": [
            {"key": "m", "kind": kind, "label": "X", "required": True},
        ]},
    }
    flow = Flow.model_validate(
        {**upgrade_body(body, key="t", name="t"), "key": "t", "name": "t"}
    )

    assert direct_chat.ineligibility_reasons(flow)


def test_a_metric_requirement_does_not_block():
    """A metric requirement is a unique machine name, not a position on one report.

    It resolves the same way everywhere, so it is the one report-ish requirement a
    chat flow can carry.
    """
    body = {
        "nodes": [_agent()],
        "answer_node": "a",
        "requirements": {"items": [
            {"key": "gmv", "kind": "metric", "label": "GMV", "required": True},
        ]},
    }
    flow = Flow.model_validate(
        {**upgrade_body(body, key="t", name="t"), "key": "t", "name": "t"}
    )

    assert direct_chat.ineligibility_reasons(flow) == []


# ── the charts a chat flow may measure ──────────────────────────────────────


class _Rows:
    """Enough of a SQLAlchemy query to answer `.filter(...).all()` with fixed rows."""

    def __init__(self, rows: list[int], seen: list):
        self._rows, self._seen = rows, seen

    def filter(self, *criteria):
        self._seen.append(criteria)
        return self

    def all(self):
        return [(r,) for r in self._rows]


class _DB:
    """Answers each `query(...)` with the next prepared row set, and remembers
    every filter it was handed so a test can check WHAT was asked, not only what
    came back."""

    def __init__(self, *answers: list[int]):
        self._answers = list(answers)
        self.seen: list = []

    def query(self, *_cols):
        if not self._answers:
            raise AssertionError("queried more times than the test prepared for")
        return _Rows(self._answers.pop(0), self.seen)


def _in_values(criterion) -> list:
    """The list handed to `.in_(...)`, dug out of the compiled criterion."""
    return list(criterion.right.value)


def test_a_chat_flow_that_attached_nothing_measures_nothing():
    """ATTACHING IS THE GATE, and an empty grant keeps it shut.

    Sharing an assistant lends its author's reading rights — it does not lend the
    warehouse. So the widening in this change has a floor: a flow whose author
    attached no dataset reaches zero charts, exactly as it did when the allowlist
    was hardcoded empty.

    It must also not ASK: a query here would be a query per turn that can only
    return something the caller is about to discard.
    """
    db = _DB()  # any query at all raises

    assert permissions.chart_scope(db, {"dataset_ids": []}) == set()
    assert permissions.chart_scope(db, {}) == set()
    assert permissions.chart_scope(db, None) == set()


def test_the_charts_are_the_ones_built_on_the_granted_datasets():
    """Dataset in, chart ids out, through the tables in between.

    Scoped by DATASET rather than by report because that is the unit a question
    lives in: on this deployment one dataset reaches 184 charts across 8 reports,
    and a question about revenue does not know which report someone drew it on.
    """
    db = _DB([11, 12], [101, 102, 103])

    got = permissions.chart_scope(db, {"dataset_ids": [111], "doc_ids": [9]})

    assert got == {101, 102, 103}
    assert _in_values(db.seen[0][0]) == [111]      # datasets -> tables
    assert _in_values(db.seen[1][0]) == [11, 12]   # tables   -> charts


def test_a_granted_dataset_with_no_tables_stops_there():
    """No second query, because there is nothing to look charts up by — and
    `IN ()` on an empty list is a scan that returns nothing slowly."""
    db = _DB([])

    assert permissions.chart_scope(db, {"dataset_ids": [111]}) == set()


def test_a_scope_carrying_junk_ids_does_not_blow_up():
    """`knowledge_scope` is built from flow attachments, which are strings on the
    wire. A malformed one must be skipped, not raise mid-turn."""
    db = _DB([11], [101])

    got = permissions.chart_scope(db, {"dataset_ids": ["111", "", None, "abc"]})

    assert got == {101}
    assert _in_values(db.seen[0][0]) == [111]


# ── review notes that only make sense on one surface ────────────────────────


def test_the_empty_flow_note_says_the_opposite_thing_on_each_surface():
    """SAME ABSENCE, OPPOSITE CONSEQUENCE.

    A bot with nothing attached still has the open report to fall back on, so
    "nothing attached" is a legitimate choice and the note says so. A chat flow has
    no fallback: it reaches nothing and answers from the model's own memory without
    mentioning it. Telling a chat author their flow is fine is worse than saying
    nothing at all.
    """
    flow = _flow([_agent()])

    bot = flow.warnings("bot")[0]
    chat = flow.warnings("chat")[0]

    assert "chỉ đọc báo cáo đang mở" in bot
    assert "Đúng nếu bạn muốn" in bot        # reassurance
    assert "không có báo cáo nào để đọc thay" in chat
    assert "Đúng nếu bạn muốn" not in chat   # and it must not carry over


def test_a_named_report_gets_advice_that_works_on_this_surface():
    """“Hãy nói ‘báo cáo đang mở’ ” sends a chat author to a phrase that resolves
    to nothing."""
    flow = _flow([{"key": "a", "type": "agent",
                   "prompt": "Đọc báo cáo Olist rồi trả lời.", "tools": []}])

    bot = " ".join(flow.warnings("bot"))
    chat = " ".join(flow.warnings("chat"))

    assert "nên nói “báo cáo đang mở”" in bot
    assert "không có báo cáo nào đang mở" in chat


def test_the_default_reading_is_the_one_history_wrote():
    """Called with no argument — as everything written before the type existed
    does — it must behave exactly as it did."""
    flow = _flow([_agent()])

    assert flow.warnings() == flow.warnings("bot")


def test_a_one_step_flow_is_not_scolded_for_its_only_step_having_tools():
    """THE NOTE THAT FIRED ON THE RECOMMENDED SHAPE.

    "The answering step still has tools" warns that a figure reached the answer
    without passing through a step where it could be checked. That premise needs an
    earlier step to exist. The chat seed is one agent that finds its source and
    answers — the only shape a one-step flow can have — and it was being told off
    for it on creation. Notes that fire on the starting state teach authors that
    notes are noise.
    """
    one = _flow([_agent(tools=("search_business_assets",))])
    two = _flow([
        {"key": "r", "type": "agent", "prompt": "Tìm nguồn.", "tools": []},
        _agent(key="b", tools=("search_business_assets",)),
    ], answer="b")

    assert not any("vẫn có công cụ" in w for w in one.warnings("chat"))
    assert any("vẫn có công cụ" in w for w in two.warnings("chat"))
