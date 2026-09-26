"""AI Design "Art Director" — the reference-image path.

An attached reference image steers only the PLAN. The planner has no write path,
and the plan it returns is re-validated and compiled by the client before it can
touch a tile, so an image can never change what a chart shows. These tests hold
that boundary at the three seams the feature added:

  • the data-URL split every provider relies on to attach the image;
  • the reference clause that appears in the prompt ONLY when an image is present
    and tells the model to copy the look, never the content;
  • the routing of the planner through the vision-capable design tier with the
    image attached — never the text tier, which would drop the image silently.
"""
from __future__ import annotations

import pytest

import os

os.environ.setdefault("DATABASE_URL", "sqlite:///./test_presentation_planner.db")
os.environ.setdefault("DATA_DIR", ".testdata")

from app.services import dashboard_presentation_planner as planner
from app.services.llm_client import _split_data_url

# A 1×1 PNG as a data URL. It only has to be a well-formed data URL; these tests
# never decode it.
PNG_1x1 = (
    "data:image/png;base64,"
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
)

_SNAPSHOT = {
    "dashboard": {"name": "D", "pageCount": 1},
    "currentPage": {"name": "P"},
    "visuals": [],
    "slicers": [],
    "theme": {},
    "capabilities": {},
}


def test_split_data_url_parses_mime_and_payload():
    mime, b64 = _split_data_url(PNG_1x1)
    assert mime == "image/png"
    assert b64.startswith("iVBOR")
    # A bare base64 string (no data: prefix) is assumed to be a PNG.
    assert _split_data_url("AAAA") == ("image/png", "AAAA")
    # A malformed data URL yields an empty payload the callers skip.
    assert _split_data_url("data:image/png;base64") == ("image/png", "")


def test_prompt_carries_reference_clause_only_when_an_image_is_attached():
    with_ref = planner.build_planner_prompt(
        snapshot=_SNAPSHOT, user_prompt="match this", has_reference=True,
    )
    without = planner.build_planner_prompt(
        snapshot=_SNAPSHOT, user_prompt="make it modern", has_reference=False,
    )
    assert "REFERENCE IMAGE" in with_ref
    assert "never the data" in with_ref.lower() or "never its content" in with_ref.lower()
    assert "REFERENCE IMAGE" not in without


def test_plan_presentation_routes_through_the_vision_tier_with_the_image(monkeypatch):
    captured = {}

    def _fake_multimodal(*, prompt, system, images=None, max_tokens=512):
        captured["images"] = images
        captured["prompt"] = prompt
        return {
            "scope": "page",
            "direction": {"style": "saas", "density": "balanced"},
            "sections": [],
            "visualPreferences": {},
        }

    # Falling back to the text tier would drop the image silently — make that
    # path fail loudly instead of passing a weaker test.
    def _boom(*_args, **_kwargs):
        raise AssertionError("planner used the text tier, dropping the reference image")

    monkeypatch.setattr(planner.LLMClient, "complete_json_multimodal", staticmethod(_fake_multimodal))
    monkeypatch.setattr(planner.LLMClient, "complete_json", staticmethod(_boom))

    out = planner.plan_presentation(snapshot=_SNAPSHOT, user_prompt="match this", images=[PNG_1x1])
    assert out["scope"] == "page"
    assert captured["images"] == [PNG_1x1]
    assert "REFERENCE IMAGE" in captured["prompt"]


def test_blank_images_are_dropped_and_the_call_stays_text_only(monkeypatch):
    captured = {}

    def _fake_multimodal(*, prompt, system, images=None, max_tokens=512):
        captured["images"] = images
        captured["prompt"] = prompt
        return {
            "scope": "page",
            "direction": {"style": "saas", "density": "balanced"},
            "sections": [],
            "visualPreferences": {},
        }

    monkeypatch.setattr(planner.LLMClient, "complete_json_multimodal", staticmethod(_fake_multimodal))
    planner.plan_presentation(snapshot=_SNAPSHOT, user_prompt="make it modern", images=["", "   "])
    # Empty strings are filtered to nothing → a text-only call, no reference clause.
    assert captured["images"] is None
    assert "REFERENCE IMAGE" not in captured["prompt"]


# ── Permission layer + Design Context (AI Design v2) ─────────────────────────
#
# The layer is decided on the client from the user's words and enforced there;
# the server's job is to hand it to the model faithfully and to forward what
# each visual MEANS without widening what leaves the browser.

_RICH_SNAPSHOT = {
    "dashboard": {"name": "Sales", "pageCount": 1, "description": "Monthly sales review"},
    "currentPage": {"name": "Overview"},
    "visuals": [
        {
            "dashboardChartId": 11, "chartType": "LINE", "title": "Revenue trend",
            "currentLayout": {"x": 0, "y": 6, "w": 24, "h": 18}, "displayRoleHint": "primary",
            "isWidget": False, "renderAspect": "wide", "readingOrder": 2, "locked": True,
            "meaning": {
                "measures": [{"label": "Revenue", "agg": "sum", "format": "currency", "sql": "SUM(x)"}],
                "dimensions": [{"label": "Order date", "temporal": True}],
                "temporal": True, "hasBenchmark": False, "description": "Revenue by month",
            },
            "currentStyle": {"tileFrame": "card"},
        },
    ],
    "slicers": [],
    "theme": {},
    "capabilities": {},
}


def _payload_of(prompt: str) -> dict:
    import json as _json
    marker = "INPUT — the CURRENT state of the page, after any changes already applied. This is context to read, not content to return.\n"
    start = prompt.index(marker) + len(marker)
    end = prompt.index("\n", start)
    return _json.loads(prompt[start:end])


def test_prompt_carries_the_granted_layer_and_targets():
    prompt = planner.build_planner_prompt(
        snapshot=_RICH_SNAPSHOT, user_prompt="make it premium", granted_layer="style", target_ids=[11],
    )
    payload = _payload_of(prompt)
    assert payload["permission"] == {"layer": "style", "targets": [11]}
    assert "PERMISSION IS STYLE" in prompt
    assert "SELECTION" in prompt


def test_unknown_layer_degrades_to_style_never_upward():
    prompt = planner.build_planner_prompt(
        snapshot=_RICH_SNAPSHOT, user_prompt="x", granted_layer="everything",
    )
    assert _payload_of(prompt)["permission"]["layer"] == "style"


def test_digest_carries_meaning_lock_and_order_but_no_sql():
    digest = planner._visual_digest(_RICH_SNAPSHOT)
    assert len(digest) == 1
    entry = digest[0]
    assert entry["locked"] is True
    assert entry["readingOrder"] == 2
    assert entry["position"] == {"x": 0, "y": 6, "w": 24, "h": 18}
    assert entry["meaning"]["temporal"] is True
    assert entry["meaning"]["measures"] == [{"label": "Revenue", "agg": "sum", "format": "currency"}]
    # An unexpected key a client might add is not forwarded.
    assert "sql" not in str(entry)


def test_style_only_reply_counts_as_a_plan():
    assert planner._looks_like_a_plan({"layer": "style", "direction": {}, "themeIntent": {"mode": "dark"}})
    assert planner._looks_like_a_plan({"layer": "structure", "structure": {"operations": []}})
    # An echo of the input is not a plan.
    assert not planner._looks_like_a_plan({"visuals": [], "capabilities": {}})


def test_request_schema_accepts_layer_and_targets_and_maps_legacy_focus():
    from app.schemas.schemas import PresentationPlanRequest
    req = PresentationPlanRequest(prompt="p", snapshot={}, granted_layer="structure", target_ids=[1, 2])
    assert req.granted_layer == "structure" and req.target_ids == [1, 2]
    legacy = PresentationPlanRequest(prompt="p", snapshot={}, focused_chart_id=7)
    assert legacy.granted_layer == "style" and legacy.focused_chart_id == 7
    import pytest as _pytest
    from pydantic import ValidationError
    with _pytest.raises(ValidationError):
        PresentationPlanRequest(prompt="p", snapshot={}, granted_layer="admin")


# ── Visual review of a rendered preview ──────────────────────────────────────

def test_a_visual_review_keeps_only_the_rubric_and_the_closed_repairs():
    from app.services.dashboard_presentation_critic import normalize_critique
    out = normalize_critique({
        "scores": {"hierarchy": 4.4, "legibility": 9, "made_up": 5},
        "summary": "Clear verdict, crowded bottom half.",
        "issues": [
            {"visual": 7, "problem": "Bars crowd their labels", "fix": {"key": "showDataLabels", "value": False}},
            {"visual": 7, "problem": "Title small", "fix": {"key": "chartTitleFontSize", "value": 40}},
            {"visual": 7, "problem": "Wants a pie", "fix": {"key": "chartType", "value": "PIE"}},
            {"visual": 999, "problem": "Not on the page", "fix": {"key": "tileFrame", "value": "flush"}},
        ],
    }, [7])
    assert out["scores"] == {"hierarchy": 4, "legibility": 5}
    fixes = [i.get("fix") for i in out["issues"]]
    assert fixes[0] == {"key": "showDataLabels", "value": False}
    assert fixes[1] == {"key": "chartTitleFontSize", "value": 22}, "a size outside the range must be clamped"
    assert fixes[2] is None, "a semantic change (chart type) must never be a repair"
    assert "visual" not in out["issues"][3] and fixes[3] is None, "a tile not on the page gets no fix"


def test_no_vision_model_means_no_review_not_a_made_up_one(monkeypatch):
    from app.services import dashboard_presentation_critic as critic
    monkeypatch.setattr(critic.LLMClient, "complete_json_multimodal", staticmethod(lambda **kw: None))
    with pytest.raises(critic.CritiqueUnavailable):
        critic.critique_rendered_preview(image="data:image/jpeg;base64,AAAA", tiles=[{"id": 1}], direction=None)
