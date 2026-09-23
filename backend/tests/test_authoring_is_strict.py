# -*- coding: utf-8 -*-
"""Authoring is strict; reading what is already stored stays tolerant.

REPRODUCED DEFECT (P1). Every contract model inherits `extra="ignore"`. That is
right for READING a stored body — an older flow with a field this build no longer
knows must still load. It is wrong as an AUTHORING contract: an author, or an AI
writing a flow through the API, can misspell a field and the system validates
green, stores something different from what was written, and runs the default.

INVARIANT: on the authoring path (validate / import / save) an unknown field is
an actionable error naming the node and the field. Nothing is auto-corrected and
nothing is silently rewritten. The stored-read path is unchanged.
"""
import pytest

from app.services.agent_flows.contract import Flow, strict_authoring_errors


def agent(key="a", **kw):
    return {"type": "agent", "key": key, "name": key, "prompt": "p",
            "output_var": key, **kw}


def body(nodes, **kw):
    return {"key": "f", "name": "f", "nodes": nodes, **kw}


def errs(b):
    return strict_authoring_errors(b)


def one(b):
    e = errs(b)
    assert e, "expected a strict-authoring error"
    return " | ".join(e)


# ── the cases named in the brief ─────────────────────────────────────────────

def test_unknown_top_level_field():
    assert "khong_ton_tai" in one(body([agent()], khong_ton_tai=1))


def test_unknown_agent_field():
    assert "tempurature" in one(body([agent(tempurature=0.7)]))


def test_typo_on_retry_configuration():
    msg = one(body([agent(retires=3)]))
    assert "retires" in msg and "a" in msg


def test_typo_on_error_configuration():
    assert "on_eror" in one(body([agent(on_eror="continue")]))


def test_unknown_nested_if_field():
    node = {"type": "if", "key": "i", "name": "i",
            "paths": [{"key": "p1", "name": "p1", "kind": "always",
                       "body": [agent(modle="gpt-4")]},
                      {"key": "p2", "name": "p2", "kind": "fallback", "body": []}]}
    assert "modle" in one(body([node]))


def test_unknown_switch_field():
    node = {"type": "switch", "key": "s", "name": "s", "value": "{{x}}",
            "cases": [{"key": "c1", "name": "c1", "equals": "1", "body": []},
                      {"key": "c2", "name": "c2", "equals": "2", "body": []}],
            "fallback": [], "defualt": "x"}
    assert "defualt" in one(body([node]))


def test_unknown_loop_field():
    node = {"type": "loop", "key": "l", "name": "l", "over": "{{x}}",
            "item_var": "i", "body": [], "max_iteratons": 3}
    assert "max_iteratons" in one(body([node]))


def test_unknown_coordinate_and_specialist_fields():
    node = {"type": "coordinate", "key": "c", "name": "c", "prompt": "p",
            "specialists": [{"key": "s1", "name": "s1", "when": "khi hỏi doanh thu",
                             "body": [], "piority": 1},
                            {"key": "s2", "name": "s2", "when": "khi hỏi tài liệu",
                             "body": []}],
            "fallback": [], "max_specialist": 2}
    msg = one(body([node]))
    assert "piority" in msg, "a field on a SPECIALIST lane escaped strict checking"
    assert "max_specialist" in msg


def test_unsupported_next_is_reported():
    """The one field that already had a hand-written special case."""
    assert "next" in one(body([agent(next="b")]))


def test_the_error_names_the_node_so_an_author_can_find_it():
    msg = one(body([agent("doc_reader", tempurature=1)]))
    assert "doc_reader" in msg


# ── what must NOT become an error ────────────────────────────────────────────

def test_a_correct_flow_produces_no_errors():
    assert errs(body([agent()])) == []


def test_a_redacted_body_can_be_sent_back_unchanged():
    """The API emits `has_api_key`; the builder round-trips it. Rejecting the
    payload we ourselves produced would make saving impossible."""
    assert errs(body([agent(has_api_key=True)])) == []


def test_reading_a_stored_legacy_body_stays_tolerant():
    """The read path must not inherit the strict rule — an older stored flow with
    a field this build no longer knows still has to load."""
    flow = Flow.model_validate(body([agent(some_retired_field=1)]))
    assert flow.nodes[0].key == "a"


def test_strict_check_does_not_mistake_a_condition_for_a_node():
    node = {"type": "if", "key": "i", "name": "i",
            "paths": [{"key": "p1", "name": "p1", "kind": "rules",
                       "conditions": [{"left": "{{a}}", "op": "eq", "right": "1"}],
                       "body": [agent()]},
                      {"key": "p2", "name": "p2", "kind": "fallback", "body": []}]}
    assert errs(body([node])) == []
