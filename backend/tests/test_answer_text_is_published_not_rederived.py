# -*- coding: utf-8 -*-
"""One rendering of an answer, not two that drift.

WHAT THIS IS REALLY PROTECTING.

A reader's thumb reaches `agent_flow_runs.rating` — the column the Runs tab, the
operator and the pilot funnel all read — only if the text the browser sends back
equals the text the server stored. `runs.apply_rating` matches on exactly that,
deliberately: it is what stops a public page rating words the server never said.

The server stores `Answer.plain_text()`. The browser had only `blocks`, so it
built its own text with a second implementation — which dropped metric blocks.
`plain_text` renders a metric as `label: value`; the client rendered nothing. So
every KPI-shaped answer, the common case and the one with the numbers in it,
produced two different strings. The match found nothing. The rating was written
into the session blob and was silently absent from the one table an operator
opens to ask "which answers were bad".

Reproduced on a public link before the fix: the answer rated in the UI, the run
row unrated in the database.

THE FIX IS TO PUBLISH, NOT TO SYNCHRONISE. `Answer.text` is the same
`plain_text()`, serialised, so the client quotes the server instead of guessing
at it. This file pins that it is actually published, that it is byte-identical
to what gets stored, and — the part that would otherwise rot — that a metric
block survives the round trip, because that is the block whose loss caused this.
"""
from __future__ import annotations

import pytest

from app.services.agent_flows.envelope import Answer


def _answer(blocks: list[dict]) -> Answer:
    return Answer.model_validate({"blocks": blocks})


TEXT = {"type": "text", "markdown": "Tổng GMV trên báo cáo này là"}
METRIC = {"type": "metric", "label": "GMV", "value": "15,843,553.24"}
CALLOUT = {"type": "callout", "text": "Dữ liệu chỉ tới hết tháng 8."}


def test_the_text_is_serialised_so_a_client_never_has_to_rebuild_it():
    payload = _answer([TEXT, METRIC]).model_dump(mode="json")
    assert "text" in payload, (
        "`Answer.text` is not serialised, so a client has to re-derive the "
        "answer text — which is the whole defect this exists to prevent."
    )
    assert payload["text"].strip()


def test_the_published_text_is_exactly_what_gets_stored():
    """`runs.record` writes `out.answer.plain_text()`. A rating is matched
    against that string, so the published value has to BE that string — not a
    near-enough rendering of the same blocks."""
    answer = _answer([TEXT, METRIC, CALLOUT])
    assert answer.model_dump(mode="json")["text"] == answer.plain_text()


def test_a_metric_block_survives_the_round_trip():
    """The block whose loss caused the bug.

    Asserted by VALUE, not by counting blocks: a rendering that kept the label
    and dropped the number would pass a structural check and still break every
    match on an answer that quotes a figure.
    """
    text = _answer([TEXT, METRIC]).model_dump(mode="json")["text"]
    assert "GMV" in text
    assert "15,843,553.24" in text
    assert "GMV: 15,843,553.24" in text


@pytest.mark.parametrize("blocks,expected_parts", [
    ([TEXT], ["Tổng GMV"]),
    ([METRIC], ["GMV: 15,843,553.24"]),
    ([CALLOUT], ["Dữ liệu chỉ tới hết tháng 8."]),
    ([TEXT, METRIC, CALLOUT], ["Tổng GMV", "GMV: 15,843,553.24", "tháng 8"]),
])
def test_every_block_kind_a_reader_sees_is_in_the_text(blocks, expected_parts):
    text = _answer(blocks).model_dump(mode="json")["text"]
    for part in expected_parts:
        assert part in text, f"{part!r} missing from {text!r}"


def test_an_empty_answer_publishes_an_empty_string_not_a_missing_field():
    """Absent means absent, never a different shape — rule L1 of this envelope.

    A client reading `answer.text` must not have to distinguish "no answer" from
    "this backend does not publish it"; those have different fallbacks.
    """
    payload = _answer([]).model_dump(mode="json")
    assert payload["text"] == ""


def test_blocks_are_untouched_so_every_existing_consumer_still_works():
    """The change is additive. Anything rendering `blocks` is unaffected."""
    payload = _answer([TEXT, METRIC]).model_dump(mode="json")
    assert len(payload["blocks"]) == 2
    assert payload["blocks"][0]["markdown"] == TEXT["markdown"]
    assert payload["blocks"][1]["value"] == METRIC["value"]


def test_the_frontend_prefers_the_published_text_over_rebuilding_it():
    """The other half of the contract, checked where it actually lives.

    A published field nothing reads fixes nothing, and this is a cross-language
    pair that no type checker spans: the server could keep publishing `text` for
    ever while the client quietly went on rebuilding it. Matched on the source,
    the way `check-node-topology.mjs` matches the two halves of the node model.
    """
    import pathlib

    fe = (pathlib.Path(__file__).resolve().parents[2]
          / "frontend" / "src" / "components" / "dashboards" / "DashboardAiBot.tsx")
    src = fe.read_text(encoding="utf-8")
    assert "envelope.answer?.text" in src, (
        "the reader no longer prefers the server's own answer text, so a rating "
        "is once again matched against a string the client invented."
    )
