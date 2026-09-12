"""The step that synthesises has to see everything there is to synthesise.

WHAT WAS MEASURED
-----------------
Three agent steps, run in order, with the third designated as the answering node:

    thu tu goi: ['chuyen_gia_a', 'chuyen_gia_b', 'tong_hop']
    tong hop nhan: "Result of the previous step: KQ-chuyen_gia_b"
    nhac toi ket qua chuyen gia A? False

Every node published its result into `previous`, and `previous` is overwritten by
whoever ran last. So the writer was handed exactly one specialist. A's work was
computed, paid for, and silently dropped — with every step green on the canvas.

The more specialists an author adds, the more of the run is discarded, which is
the opposite of what adding them is for.
"""
from __future__ import annotations

import os

os.environ.setdefault("DATABASE_URL", "sqlite:///./test_synth.db")
os.environ.setdefault("DATA_DIR", ".testdata")

from app.services.agent_flows.envelope import TraceStep
from app.services.agent_flows.runtime.handlers import agent as agent_handler


class _State:
    def __init__(self, steps: list[tuple[str, str, object]]):
        self.trace = [TraceStep(key=k, name=n) for k, n, _ in steps]
        self.outputs = {k: v for k, n, v in steps}
        self.vars: dict = {"previous": steps[-1][2] if steps else None}


class _Rctx:
    answer_key = "tong_hop"

    class inp:
        class conversation:
            history: list = []

        class question:
            @staticmethod
            def text():
                return "Lợi nhuận tháng này thế nào?"


class _Node:
    key = "tong_hop"
    context_policy = "question"


THREE = [
    ("chuyen_gia_a", "Chuyên gia doanh thu", "Doanh thu 4,2 tỷ"),
    ("chuyen_gia_b", "Chuyên gia chi phí", "Chi phí 3,1 tỷ"),
    ("tong_hop", "Tổng hợp", ""),
]


def _gathered(state) -> str:
    return agent_handler._all_step_results(state, _Rctx(), skip="tong_hop")


def test_every_specialist_reaches_the_synthesiser_not_only_the_last():
    out = _gathered(_State(THREE))
    assert "Doanh thu 4,2 tỷ" in out
    assert "Chi phí 3,1 tỷ" in out


def test_each_result_is_attributed_to_the_step_that_produced_it():
    """"The previous step said 91.2%" is unusable when four steps spoke, and a
    synthesiser that cannot attribute a figure cannot cite it either."""
    out = _gathered(_State(THREE))
    assert "Chuyên gia doanh thu" in out and "Chuyên gia chi phí" in out


def test_results_keep_the_order_they_ran_in():
    out = _gathered(_State(THREE))
    assert out.index("Chuyên gia doanh thu") < out.index("Chuyên gia chi phí")


def test_the_synthesiser_is_told_to_combine_and_to_surface_disagreement():
    """Handing over four results without saying what to do with them invites the
    same behaviour by another route: pick one, ignore the rest."""
    out = _gathered(_State(THREE))
    assert "TẤT CẢ" in out
    assert "mâu thuẫn" in out


def test_the_synthesisers_own_slot_is_not_fed_back_to_it():
    assert "### Tổng hợp" not in _gathered(_State(THREE))


def test_a_step_that_produced_nothing_is_omitted_rather_than_shown_empty():
    """A blank line under a heading reads to a model like an answer of "nothing",
    which is not the same as a step that never spoke."""
    out = _gathered(_State([
        ("a", "Bước A", "có kết quả"),
        ("b", "Bước rỗng", ""),
        ("tong_hop", "Tổng hợp", ""),
    ]))
    assert "### Bước rỗng" not in out


def test_dict_results_survive_as_readable_text():
    """`report_read` and `knowledge` hand back a dict — the two steps whose entire
    job is to fetch what the answer is built on."""
    out = _gathered(_State([
        ("read", "Đọc báo cáo", {"rows": [["moveis", 1200]]}),
        ("tong_hop", "Tổng hợp", ""),
    ]))
    assert "moveis" in out


def test_one_enormous_step_cannot_crowd_out_the_others():
    out = _gathered(_State([
        ("a", "Bước A", "x" * 50_000),
        ("b", "Bước B", "kết quả B"),
        ("tong_hop", "Tổng hợp", ""),
    ]))
    assert len(out) < 12_000


def test_a_truncated_gather_says_so_instead_of_ending_mid_thought():
    out = _gathered(_State(
        [(f"s{i}", f"Bước {i}", "y" * 1900) for i in range(12)]
        + [("tong_hop", "Tổng hợp", "")]
    ))
    assert "vượt giới hạn ngữ cảnh" in out


def test_a_flow_with_nothing_before_it_gathers_nothing():
    assert _gathered(_State([("tong_hop", "Tổng hợp", "")])) == ""


# ── the cheap path is kept for every other step ───────────────────────────────

def test_a_non_answering_step_still_gets_only_the_previous_result():
    """Giving every node the full set would restore the "full transcript to every
    step" cost `_messages` exists to avoid: a ten-node flow paid for it ten times."""
    node = _Node()
    node.key = "chuyen_gia_b"
    state = _State(THREE)
    state.vars["previous"] = "Chi phí 3,1 tỷ"   # what B was actually handed
    msgs = agent_handler._messages(node, state, _Rctx())
    joined = " ".join(m["content"] for m in msgs if isinstance(m.get("content"), str))
    assert "Result of the previous step" in joined
    assert "Chuyên gia doanh thu" not in joined
