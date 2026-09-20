# -*- coding: utf-8 -*-
"""What the model receives is a PROJECTION of what ran, and it says what it left out.

DEFECTS (P0/P1).

  (a) Each step's result was head-sliced at 2,000 characters — a blind cut, mid
      array, mid number. A green Report Read could hold the right chart and hand
      the answering model a fragment ending in `{"chart_id": 1`.

  (b) The 8,000-character total was spent in run order and then `break`. Three
      specialists computing in sequence meant C vanished entirely because A was
      verbose — the run reported three healthy steps and the answer was built on
      one and a half.

INVARIANT: a green upstream node must imply either that its result reached the
step that needed it, or that its absence is recorded. Allocation is fair and
deterministic; reduction preserves object boundaries; omission is reported.
"""
import json

import pytest

from app.services.agent_flows.runtime import context as C


def step(key, payload, name=None):
    return C.StepView(key=key, name=name or key, text=payload)


def big_json(n_rows, chart_id=1):
    return json.dumps({
        "scope": {"read": 1},
        "selection": {"mode": "question", "status": "semantic"},
        "charts": [{"chart_id": chart_id, "title": "C%d" % chart_id,
                    "read_status": "ok",
                    "data": {"rows": [{"k": "row-%d" % i, "v": i} for i in range(n_rows)]}}],
    }, ensure_ascii=False)


# ── (b) fairness ─────────────────────────────────────────────────────────────

def test_a_late_specialist_is_not_erased_by_an_early_verbose_one():
    """SCENARIO D / §4C. Three lanes, the first enormous. C must still be there."""
    out = C.compile_context([
        step("a", big_json(400)),
        step("b", big_json(400, 2)),
        step("c", "Chuyên gia C kết luận: tỷ lệ giao đúng hẹn là 91,2%."),
    ], budget_chars=3000)
    assert "c" in out.included or "c" in out.reduced, (
        f"step c was dropped entirely: included={out.included} omitted={out.omitted}"
    )
    assert "91,2%" in out.text


def test_a_small_step_keeps_everything_and_donates_its_slack():
    out = C.compile_context([
        step("small", "ngắn gọn"),
        step("huge", big_json(400)),
    ], budget_chars=2000)
    assert "ngắn gọn" in out.text
    assert out.included == ["small"] or "small" in out.included


def test_every_step_appears_somewhere_in_the_accounting():
    steps = [step("a", big_json(200)), step("b", big_json(200)), step("c", big_json(200))]
    out = C.compile_context(steps, budget_chars=1200)
    accounted = set(out.included) | set(out.reduced) | set(out.omitted)
    assert accounted == {"a", "b", "c"}, f"a step vanished from accounting: {accounted}"


# ── (a) boundaries ───────────────────────────────────────────────────────────

def test_a_reduced_json_payload_is_still_parseable():
    out = C.compile_context([step("r", big_json(500))], budget_chars=1200)
    start = out.text.find("{")
    assert start >= 0, out.text[:120]
    fragment = out.text[start:out.text.rfind("}") + 1]
    json.loads(fragment)  # raises if the cut landed mid-object


def test_reduction_keeps_identity_and_drops_bulk():
    """The chart id, its title and its read status are what an answer cites; the
    five-hundredth row is not."""
    out = C.compile_context([step("r", big_json(500, chart_id=1003))], budget_chars=1200)
    assert "1003" in out.text
    assert "read_status" in out.text
    assert "row-499" not in out.text


def test_a_non_json_payload_is_cut_on_a_line_boundary():
    text = "\n".join("dòng %d với nội dung dài vừa phải" % i for i in range(200))
    out = C.compile_context([step("p", text)], budget_chars=600)
    assert not out.text.rstrip().endswith("dòng"), "cut mid-word"


# ── omission is reported, to the model and to the trace ──────────────────────

def test_the_model_is_told_what_was_left_out():
    out = C.compile_context([step("a", big_json(400)), step("b", big_json(400)),
                             step("c", big_json(400))], budget_chars=900)
    assert out.omitted or out.reduced
    # The coverage NOTE specifically — not any stray word. An earlier version of
    # this assertion passed while the note was deleted, because "lược" also
    # appears in the marker left inside a shrunk JSON array.
    assert "Ghi chú phạm vi" in out.text, (
        "the prompt must carry an explicit coverage note"
    )
    for key in out.omitted:
        assert key in out.text.split("Ghi chú phạm vi")[-1], (
            f"omitted step {key} was not named to the model"
        )


def test_the_budget_is_actually_respected():
    out = C.compile_context([step(str(i), big_json(300)) for i in range(5)],
                            budget_chars=2000)
    assert len(out.text) <= 2000 * 1.25, f"budget blown: {len(out.text)}"


def test_nothing_in_means_nothing_out():
    out = C.compile_context([], budget_chars=2000)
    assert out.text == "" and out.included == [] and out.omitted == []


def test_a_step_that_produced_nothing_is_not_reported_as_omitted():
    """An empty result is not a casualty of the budget."""
    out = C.compile_context([step("a", ""), step("b", "có nội dung")], budget_chars=2000)
    assert "a" not in out.omitted
