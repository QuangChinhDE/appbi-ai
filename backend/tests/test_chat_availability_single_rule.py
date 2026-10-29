"""The Chat catalogue and the conversation agree on whether an assistant works.

/chat listed "Trợ lý tri thức Olist" as available; opening it showed "This
assistant is no longer active" with the input disabled. Two things kept the two
answers apart:

* the catalogue (`published_chat_brains`) and opening/asking (`resolve_for_chat`)
  each carried their own copy of the availability rule;
* the catalogue opened the most recent conversation for the assistant, even one
  the reader may only READ (shared at `view`, or overseen with `chat: full`), so a
  working assistant opened read-only.

Now one predicate (`chat_row_availability`) decides for both. (The thread-list
`access` test went with the Direct Chat route, `chat_api`, which the unified AI
Chat replaced.)
"""
from __future__ import annotations

import types

import pytest

from app.services.agent_flows import direct_chat


def _row(key: str, flow_type: str = "chat"):
    return types.SimpleNamespace(brain_key=key, flow_type=flow_type, status="published", name=key)


class _Query:
    def __init__(self, rows):
        self.rows = rows

    def filter(self, *a, **k):
        return self

    def order_by(self, *a, **k):
        return self

    def all(self):
        return list(self.rows)

    def first(self):
        return self.rows[0] if self.rows else None


@pytest.fixture
def world(monkeypatch):
    """Rows by key; `parse_flow` returns a flow whose eligibility the test sets."""
    state = {"rows": [], "flows": {}}

    def usable(db, user):
        return _Query(state["rows"])

    monkeypatch.setattr("app.services.agent_flows.permissions.usable_brains", usable)
    monkeypatch.setattr(
        "app.services.agent_flows.registry.parse_flow",
        lambda row: state["flows"].get(row.brain_key),
    )
    monkeypatch.setattr(
        direct_chat, "is_eligible", lambda flow: getattr(flow, "eligible", True),
    )
    return state


@pytest.mark.parametrize("case", ["ok", "unparseable", "report_bound", "bot_flow"])
def test_listed_if_and_only_if_it_opens_writable(world, case):
    row = _row("olist", flow_type="bot" if case == "bot_flow" else "chat")
    world["rows"] = [row]
    if case != "unparseable":
        world["flows"]["olist"] = types.SimpleNamespace(eligible=case != "report_bound")

    listed = [r.brain_key for r, _ in direct_chat.published_chat_brains(None, object())]
    _row_, _flow, problem = direct_chat.resolve_for_chat(None, object(), "olist")

    # The bot-flow row is filtered out by the list QUERY in production
    # (flow_type == "chat"); the fake query does not filter, so the shared
    # predicate must refuse it itself.
    assert (listed == ["olist"]) == (problem == ""), (case, listed, problem)
    if case == "ok":
        assert problem == ""
    else:
        assert problem in direct_chat.BLOCK_MESSAGES


def test_one_predicate_decides_for_both():
    import inspect

    lst = inspect.getsource(direct_chat.published_chat_brains)
    res = inspect.getsource(direct_chat.resolve_for_chat)
    assert "chat_row_availability(" in lst and "chat_row_availability(" in res
    for src in (lst, res):
        assert "is_eligible(" not in src, "a second copy of the availability rule"
