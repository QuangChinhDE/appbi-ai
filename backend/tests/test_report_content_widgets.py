"""The report's content elements store what the author edits.

Manual Report Studio. Two editor paths stored something else than what the
author picked, so the report silently ignored the edit:

  * a callout's tone: the editor offered good/warn/bad, the normalizer kept only
    info/success/warning/danger and turned everything else into "accent";
  * the report header (hero): the editor wrote `title`, the normalizer kept the
    older `headline` first, so after the first save no title edit showed.
"""
from __future__ import annotations

import pytest

from app.services.dashboard_service import normalize_dashboard_widget_config as normalize


@pytest.mark.parametrize("picked, stored", [
    ("good", "good"), ("warn", "warn"), ("bad", "bad"), ("neutral", "neutral"), ("accent", "accent"),
    ("success", "good"), ("warning", "warn"), ("danger", "bad"), ("info", "accent"), ("purple", "accent"),
])
def test_a_callout_keeps_the_tone_the_author_picked(picked, stored):
    assert normalize("callout", {"title": "t", "text": "x", "tone": picked})["tone"] == stored


def test_a_header_title_edit_replaces_the_stored_headline():
    stored = normalize("hero_strip", {"headline": "Old name", "subhead": "Old line"})
    edited = normalize("hero_strip", {**stored, "title": "Q3 review", "description": "Sales, all regions"})
    assert edited["headline"] == "Q3 review" and edited["subhead"] == "Sales, all regions"
    assert "title" not in edited and "description" not in edited, "a second key would shadow the next edit"
    again = normalize("hero_strip", {**edited, "title": "Q4 review"})
    assert again["headline"] == "Q4 review"


def test_an_empty_header_title_means_the_report_name():
    assert normalize("hero_strip", {"title": ""})["headline"] == ""


def test_a_header_keeps_only_known_variants_and_finding_kinds():
    assert normalize("hero_strip", {"variant": "split"})["variant"] == "split"
    assert normalize("hero_strip", {"variant": "neon"})["variant"] == "banner"
    assert normalize("hero_strip", {"finding": "trend:12"})["finding"] == "trend:12"
    assert normalize("hero_strip", {"finding": "made_up:12"})["finding"] == ""
    assert normalize("hero_strip", {"showPeriod": 0, "showContext": "yes"}) | {} == {
        "variant": "banner", "showPeriod": False, "showContext": True}
