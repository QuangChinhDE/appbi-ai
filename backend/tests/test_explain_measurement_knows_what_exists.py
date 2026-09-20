""""Undocumented" and "does not exist" were one answer, and they are not.

Measured before the fix:

    explain_measurement("ty_le_giao_dung_hen")  -> ok, ANSWERABLE, 6 passages
    explain_measurement("chi_so_khong_ton_tai") -> ok, NOT_ENOUGH_EVIDENCE

Both `ok`. Retrieval always succeeds at returning nothing, so a typo, an invented
name and a genuinely undocumented KPI produced the same sentence — "chưa có đủ
thông tin trong tài liệu". That sends a reader off to write documentation for a
metric nobody ever defined, and it hides the case where the model made the name
up. With two metrics in the dictionary, the invented case is the common one.
"""
from __future__ import annotations

import pytest

from app.services.dashboard_ai_bot import govern_tools as G


def _known():
    return {
        "ty_le_giao_dung_hen": "ty_le_giao_dung_hen",
        "ty le giao dung hen": "Tỷ lệ giao đúng hẹn",
        "gmv": "gmv",
        "doanh thu san pham": "Doanh thu sản phẩm",
    }


def test_folding_lets_an_unaccented_name_resolve():
    """A model writes `ty_le_giao_dung_hen`; a person writes "Tỷ lệ giao đúng hẹn"."""
    assert G._fold_measure("Tỷ lệ giao đúng hẹn") == "ty le giao dung hen"
    assert G._fold_measure("  GMV  ") == "gmv"


def test_a_near_miss_is_offered_the_real_name():
    """The failure in practice is a plausible business phrase, not a typo.

    So suggestions come from shared words. "doanh thu" reaches "Doanh thu sản
    phẩm" even though no character-level distance would rank them close.
    """
    assert "Doanh thu sản phẩm" in G._closest_measures("doanh thu", _known())


def test_common_short_words_do_not_generate_suggestions():
    """Vietnamese business names are built from very common short words.

    At a two-character threshold, "chi_so_khong_ton_tai" matched on "so" and "chi"
    and suggested five unrelated names — which reads as a system that cannot tell
    what it holds. Suggesting nothing is better than suggesting noise.
    """
    known = {"so dong hang": "Số dòng hàng", "so luot thanh toan": "Số lượt thanh toán"}

    assert G._closest_measures("chi_so_khong_ton_tai", known) == []


def test_an_unknown_measure_is_refused_and_says_how_to_recover(monkeypatch):
    """The whole point: a name nothing defines must not look like a missing doc."""
    monkeypatch.setattr(G, "_known_measure_names", lambda _ctx: _known())

    out = G.tool_explain_measurement(object(), {"measure": "chi_so_khong_ton_tai"})

    assert out["ok"] is False
    assert "not a metric or field this report knows" in out["error"]
    assert "search_business_assets" in out["error"]
    # And it forbids the specific wrong conclusion, not just the wrong answer.
    assert "Do NOT report this as a missing document" in out["error"]


def test_a_known_measure_still_goes_through_retrieval(monkeypatch):
    """A real metric with no documentation must still reach NOT_ENOUGH_EVIDENCE.

    That verdict is the honest one for a defined-but-unwritten KPI, and the guard
    exists to make it MEAN something — not to replace it. A guard that swallowed
    this case would trade one indistinguishable pair for another.
    """
    monkeypatch.setattr(G, "_known_measure_names", lambda _ctx: _known())
    monkeypatch.setattr(G, "_visible_doc_ids", lambda _ctx: set())

    out = G.tool_explain_measurement(object(), {"measure": "ty_le_giao_dung_hen"})

    # It got PAST the existence check — the refusal it hits is the document one.
    assert out["ok"] is False
    assert "not a metric or field this report knows" not in out["error"]
    assert "no documents" in out["error"]


def test_being_unable_to_check_never_becomes_an_accusation(monkeypatch):
    """An empty known-set means "could not look", not "you invented this".

    Both metric scope and the semantic layer can fail to load. Treating that as
    proof the name is fake would turn a transient outage into the system calling
    a correct question wrong.
    """
    monkeypatch.setattr(G, "_known_measure_names", lambda _ctx: {})
    monkeypatch.setattr(G, "_visible_doc_ids", lambda _ctx: set())

    out = G.tool_explain_measurement(object(), {"measure": "bat_ky_cai_gi"})

    assert "not a metric or field this report knows" not in out["error"]


@pytest.mark.parametrize("measure", ["", "   ", None])
def test_a_missing_argument_is_still_its_own_error(measure):
    """Unchanged behaviour, asserted so the new guard cannot swallow it."""
    out = G.tool_explain_measurement(object(), {"measure": measure})

    assert out["ok"] is False
    assert "'measure' is required" in out["error"]
