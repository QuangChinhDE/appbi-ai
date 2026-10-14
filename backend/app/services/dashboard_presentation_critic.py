"""Visual review of a RENDERED AI Design preview.

The deterministic critic (frontend `critic.ts` / `render-audit.ts`) measures
what geometry can: clipping, overflow, overlap, empty plots. It cannot say that
a page has no clear hierarchy or that three accents compete. This asks a vision
model to look at the actual pixels of the preview and answer against a fixed
rubric, and to propose repairs ONLY from a closed list of presentation keys.

What this is not:
  * a certificate — the scores are advice shown to the author, never a gate;
  * a write path — it returns suggestions; the client coerces each one through
    the same allow-list and validator as every other design change, inside the
    permission the user granted, and drops what does not fit;
  * a loop — one call per preview (bounded cost); no model → no review.
"""
from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional

from app.services.llm_client import LLMClient

logger = logging.getLogger(__name__)

RUBRIC = ("hierarchy", "legibility", "composition", "balance", "consistency", "density", "emphasis")

#: The only repairs a review may propose, and their value domains. Mirrors the
#: frontend's allow-list; the client re-checks every value anyway.
REPAIR_KEYS: Dict[str, Any] = {
    "tileFrame": ["card", "subtle", "flush"],
    "showGrid": [True, False],
    "showDataLabels": [True, False],
    "legendPosition": ["top", "bottom", "right", "none"],
    "chartTitleFontSize": (12, 22),
    "fontSize": (10, 16),
    "kpiValueFontSize": (20, 44),
}

MAX_ISSUES = 6
MAX_CRITIQUE_TOKENS = 900

SYSTEM_PROMPT = """You are a senior report designer reviewing a RENDERED dashboard \
preview (the attached image). Judge only what you can SEE: visual hierarchy, \
legibility, composition, balance, consistency, information density and whether \
emphasis is purposeful. You do not judge the data or the numbers, and you never \
suggest changing a chart's data, type, title text or order.

Score each rubric item 1-5 (5 = professional publication quality). Then list at \
most six concrete issues. For an issue that one of the allowed repairs fixes, \
name the tile id (from the tile list) and the repair key and value; otherwise \
leave "fix" out. Allowed repairs: tileFrame (card|subtle|flush), showGrid \
(true|false), showDataLabels (true|false), legendPosition (top|bottom|right|none), \
chartTitleFontSize (12-22), fontSize (10-16), kpiValueFontSize (20-44).

Return only JSON: {"scores": {"hierarchy": n, ...}, "summary": "one sentence", \
"issues": [{"visual": id, "problem": "...", "fix": {"key": "...", "value": ...}}]}"""


class CritiqueUnavailable(RuntimeError):
    """No vision-capable model answered."""


def _clean_fix(fix: Any) -> Optional[Dict[str, Any]]:
    if not isinstance(fix, dict):
        return None
    key = fix.get("key")
    value = fix.get("value")
    domain = REPAIR_KEYS.get(key)
    if domain is None:
        return None
    if isinstance(domain, tuple):
        try:
            number = float(value)
        except (TypeError, ValueError):
            return None
        lo, hi = domain
        return {"key": key, "value": max(lo, min(hi, round(number)))}
    return {"key": key, "value": value} if value in domain else None


def normalize_critique(raw: Any, tile_ids: List[int]) -> Dict[str, Any]:
    """The review in its one shape; anything outside the rubric or the repair
    list is dropped here, before the client sees it."""
    known = set(tile_ids)
    raw = raw if isinstance(raw, dict) else {}
    scores: Dict[str, int] = {}
    for key in RUBRIC:
        try:
            scores[key] = max(1, min(5, int(round(float((raw.get("scores") or {}).get(key))))))
        except (TypeError, ValueError):
            continue
    issues = []
    for issue in (raw.get("issues") or [])[:MAX_ISSUES]:
        if not isinstance(issue, dict):
            continue
        problem = str(issue.get("problem") or "").strip()[:240]
        if not problem:
            continue
        entry: Dict[str, Any] = {"problem": problem}
        try:
            visual = int(issue.get("visual"))
        except (TypeError, ValueError):
            visual = None
        if visual in known:
            entry["visual"] = visual
            fix = _clean_fix(issue.get("fix"))
            if fix:
                entry["fix"] = fix
        issues.append(entry)
    overall = round(sum(scores.values()) / len(scores), 1) if scores else None
    return {
        "scores": scores,
        "overall": overall,
        "summary": str(raw.get("summary") or "").strip()[:300],
        "issues": issues,
    }


def critique_rendered_preview(*, image: str, tiles: List[Dict[str, Any]], direction: Optional[str]) -> Dict[str, Any]:
    """One vision pass over the preview image. Raises CritiqueUnavailable."""
    tile_lines = "\n".join(
        f"- {t.get('id')}: {str(t.get('kind') or 'visual')} — {str(t.get('title') or '')[:80]}"
        for t in tiles[:60] if isinstance(t, dict)
    )
    prompt = (
        f"Design direction the author chose: {direction or 'unspecified'}.\n"
        f"Tiles on the page (id: kind — title):\n{tile_lines}\n\n"
        "Review the attached rendering against the rubric and return the JSON."
    )
    result = LLMClient.complete_json_multimodal(
        prompt=prompt, system=SYSTEM_PROMPT, images=[image], max_tokens=MAX_CRITIQUE_TOKENS,
    )
    if not isinstance(result, dict):
        raise CritiqueUnavailable("No vision model returned a review.")
    ids = []
    for t in tiles:
        try:
            ids.append(int(t.get("id")))
        except (TypeError, ValueError, AttributeError):
            continue
    return normalize_critique(result, ids)
