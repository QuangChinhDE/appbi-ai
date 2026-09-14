"""What the builder tells an author when their flow will not validate.

THE BUG THIS FILE EXISTS FOR
----------------------------
`_first_message` scanned for a line beginning `Value error, ` — which only a
hand-written validator produces — and otherwise returned `text.splitlines()[-1]`.
The last line of every pydantic report is

    For further information visit https://errors.pydantic.dev/2.10/v/…

so every BUILT-IN constraint failure reached the author as a link to pydantic's
website and nothing else. Selecting the contents of "max tool calls" to type a new
number briefly sends `0` (`Number('') === 0`), and the builder's title bar
answered that with a URL.

Two fixes, both pinned here: the message says what is wrong and where, and the
number boxes stop emitting a value outside their own bounds while being edited
(that half lives in `NodeInspector.NumberField` and is covered by the frontend).
"""
from __future__ import annotations

import pytest

from app.services.agent_flows import registry as reg
from app.services.agent_flows.contract import Flow, upgrade_body


def _message(body: dict) -> str:
    """The sentence the builder would put in its header for this body."""
    try:
        Flow.model_validate(
            {**upgrade_body(body, key="t", name="t"), "key": "t", "name": "t"}
        )
    except Exception as exc:  # noqa: BLE001 — that is the thing under test
        return reg._first_message(exc)
    raise AssertionError("expected this body to be rejected")


def _agent(**kw) -> dict:
    return {"nodes": [{"key": "a", "type": "agent", "prompt": "x", **kw}],
            "answer_node": "a"}


@pytest.mark.parametrize("body", [
    _agent(max_tool_calls=0),
    _agent(max_tool_calls=999),
    _agent(output_format="bang"),
    {"nodes": [{"key": "a", "type": "agent"}], "answer_node": "a"},
    {"nodes": [{"key": "a", "type": "khong_co"}], "answer_node": "a"},
])
def test_no_message_is_ever_a_documentation_url(body):
    """THE REGRESSION, stated as the thing a reader must never see.

    Not "the message is right" — that is the tests below. This one says the
    fallback can never again reach for the last line of a pydantic report.
    """
    msg = _message(body)

    assert "pydantic.dev" not in msg
    assert not msg.startswith("For further information")
    assert msg.strip(), "an empty message is the same failure wearing a different hat"


def test_a_number_out_of_range_says_the_bound():
    """`0` in a field that starts at 1 is the exact keystroke that produced the
    bug report — mid-edit, on the way to typing a real number."""
    assert _message(_agent(max_tool_calls=0)) == "bước #1 · max_tool_calls: phải ≥ 1"
    assert _message(_agent(max_tool_calls=999)) == "bước #1 · max_tool_calls: phải ≤ 30"


def test_a_value_outside_a_fixed_set_lists_the_set():
    """A `literal_error` is only actionable if the author is told what WAS allowed."""
    msg = _message(_agent(output_format="bang"))

    assert "output_format" in msg
    assert "'chat'" in msg and "'json'" in msg and "'choice'" in msg


def test_a_missing_field_names_the_field_and_the_step():
    msg = _message({"nodes": [{"key": "a", "type": "agent"}], "answer_node": "a"})

    assert "bước #1" in msg
    assert "prompt" in msg


def test_an_unknown_step_type_says_which_one_arrived():
    """Unreachable from the palette — only a pasted draft can produce it, which is
    exactly the path a confident outside model's JSON arrives by."""
    msg = _message({"nodes": [{"key": "a", "type": "khong_co"}], "answer_node": "a"})

    assert "khong_co" in msg
    assert "loại bước" in msg


def test_the_union_tag_is_not_read_back_to_the_author():
    """Pydantic puts the matched variant in `loc` (`nodes.0.agent.max_tool_calls`).
    An author reading "bước #1 · agent · max_tool_calls" would reasonably ask what
    the middle word is for; it is an implementation detail of the union."""
    assert " agent " not in _message(_agent(max_tool_calls=0))


def test_a_hand_written_validator_still_speaks_for_itself():
    """The `Value error, ` path predates this and carries messages written for
    authors. Nothing above it should be rewriting those."""
    msg = _message({"nodes": [], "answer_node": ""})

    assert "pydantic" not in msg
    assert msg != "Cấu hình không hợp lệ", "the specific message was swallowed"
