"""Question intent extraction (services/data_core/intent.py).

Sealed set 8 (2026-10-22) refused answerable questions because grounding treated
whole constructions word by word: request framing ("Anh chị cho em hỏi ..."),
rankings ("Top 3", "Xếp hạng ... từ cao xuống thấp") and quantity questions
("bao nhiêu tiền", "mấy cái"). They are recognised as constructions: framing is
removed, a ranking becomes an obligation, a quantity question asks for a measure.
Adversarial cases: a comparison ("ít nhất 5") is not a ranking, "chi phí" is not
the pronoun "chị", and an evaluative "tốt nhất" is not silently read as a metric.
"""
from __future__ import annotations

import pytest

from app.services.data_core.intent import extract


@pytest.mark.parametrize("question, content", [
    ("Anh chị cho em hỏi doanh số kênh Cửa hàng năm 2025 được bao nhiêu ạ?", "doanh so kenh cua hang nam 2025 duoc bao nhieu"),
    ("cho mình xem doanh số theo vùng", "doanh so theo vung"),
    ("Làm ơn cho tôi biết số đơn hàng theo kênh nhé", "so don hang theo kenh"),
    ("Chi phí marketing theo kênh nhé", "chi phi marketing theo kenh"),  # "Chi" is not "chị"
    ("Chi marketing bao nhiêu cho mỗi kênh?", "chi marketing bao nhieu cho moi kenh"),
])
def test_request_framing_is_removed_and_nothing_else(question, content):
    assert extract(question).content == content


@pytest.mark.parametrize("question, ranking", [
    ("Top 3 sản phẩm doanh số cao nhất", {"direction": "desc", "n": 3}),
    ("Top 2 vùng có tiền hoàn trả lớn nhất", {"direction": "desc", "n": 2}),
    ("3 vùng có doanh số thấp nhất", {"direction": "asc", "n": 3}),
    ("Xếp hạng các sản phẩm theo số lượng bán năm 2025, từ cao xuống thấp", {"direction": "desc", "n": None}),
    ("Xếp hạng vùng theo doanh số từ thấp lên cao", {"direction": "asc", "n": None}),
    # "kênh NÀO ... nhiều nhất" asks for one winner (PO 2026-10-22: a Top-N the question
    # implies must be met; the server keeps ties at the cut)
    ("Kênh nào tốn chi phí marketing nhiều nhất năm 2025?", {"direction": "desc", "n": 1}),
    ("Sản phẩm bán chạy nhất", {"direction": "desc", "n": None}),
])
def test_a_ranking_is_an_obligation_with_direction_and_count(question, ranking):
    intent = extract(question)
    assert intent.ranking == ranking
    assert "top" not in intent.content.split() and "nhat" not in intent.content.split()


@pytest.mark.parametrize("question", [
    "Số đơn có ít nhất 5 sản phẩm",          # a comparison, not a ranking
    "Doanh số theo vùng",
    "Kênh bán nào tốt nhất",                 # evaluative: needs the person's choice of metric
    "Doanh số năm 2025",                     # a year is not a count
])
def test_not_a_ranking(question):
    assert extract(question).ranking is None


def test_a_quantity_question_asks_for_a_measure():
    i = extract("Laptop 14 bán được bao nhiêu tiền mỗi tháng?")
    assert i.quantity and "tien" not in i.content.split() and "14" in i.content.split()  # the product keeps its number
    assert extract("Bút ký với Giấy A4 mỗi loại bán được mấy cái?").quantity


def test_the_ranked_words_between_number_and_superlative_stay():
    assert extract("3 vùng có doanh số thấp nhất").content == "vung co doanh so"


def test_a_superlative_split_by_the_metric_is_still_a_ranking():
    """Sealed set 9 S9-023: "2 miền nào có nhiều đơn hàng nhất" listed all 3 regions."""
    i = extract("2 miền nào có nhiều đơn hàng nhất năm 2025?")
    assert i.ranking == {"direction": "desc", "n": 2}
    assert "don hang" in i.content and "nhat" not in i.content.split() and "nhieu" not in i.content.split()
    i = extract("Kênh nào có ít đơn hàng nhất")
    assert i.ranking == {"direction": "asc", "n": 1} and "don hang" in i.content
    assert extract("Số đơn có ít nhất 5 sản phẩm").ranking is None


def test_constructions_with_no_data_meaning_are_recognised():
    assert extract("Tổng doanh số từ trước tới nay là bao nhiêu?").content == "tong doanh so la bao nhieu"
    assert "ty" not in extract("Năm 2025 công ty có tổng cộng bao nhiêu đơn hàng?").content.split()
    assert "ngoai" not in extract("Doanh số các kênh ngoại trừ Đại lý").content.split()
    # follow-up continuation words only count in a follow-up
    assert extract("Chia tiếp theo nhóm hàng giúp mình", followup=True).content == "chia theo nhom hang"
    assert "tiep" in extract("Chia tiếp theo nhóm hàng giúp mình").content.split()
    # "doanh nghiệp" as a customer segment value is not the company
    assert "doanh nghiep" in extract("Doanh số khách doanh nghiệp").content


def test_an_opening_interjection_is_framing():
    assert extract("Ê cho xem doanh số nhóm Thiết bị").content == "doanh so nhom thiet bi"
    assert extract("Alo, doanh số theo vùng").content == "doanh so theo vung"
    assert extract("Ếch xanh bán chạy không").content.startswith("ech")   # a word starting with e is not one

