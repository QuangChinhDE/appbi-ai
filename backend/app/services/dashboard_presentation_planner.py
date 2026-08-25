"""Ask a model how a report should be arranged, and nothing else.

This module is deliberately thin. It holds a system prompt and a call to the
existing `LLMClient`; it does not know what a dataset is, cannot reach the
database, and returns a plan rather than applying one. Everything that decides
whether a plan is legal — the capability allow-lists, the identity checks, the
grid arithmetic — lives in the frontend, next to the renderer that has to honour
it (§22). The server is a proxy so the API key stays server-side, and that is
the whole of its job.

The consequence worth stating plainly: a compromised or hallucinating model
cannot damage a dashboard from here. It has no write path. The worst it can do
is return a plan the validator refuses.
"""
from __future__ import annotations

import json
import logging
from typing import Any, Dict, List, Optional

from app.services.llm_client import LLMClient

logger = logging.getLogger(__name__)

# The planner is asked for structure, not prose, and the schema it must fill is
# supplied with every call. 3000 tokens is comfortably above the largest plan a
# 20-visual page produces and well below the point where a runaway response
# costs real money.
MAX_PLAN_TOKENS = 3000

SYSTEM_PROMPT = """You are the AppBI Presentation Designer.

Your task is to redesign the PRESENTATION of an existing dashboard using only \
the capabilities explicitly supplied to you.

You are NOT a dashboard generator.

The dashboard already contains trusted charts, metrics, data bindings, filters \
and pages. You must preserve every existing data visual.

Never delete, duplicate, replace or change the type of an existing data chart.
Never change datasets, dimensions, measures, aggregations, filters, queries, \
parameters or semantic bindings.
Never move a visual to another page.
Never change the meaning of a slicer.

You may only:
- reorganize existing visuals;
- assign presentation roles;
- request supported grid compositions;
- resize visuals;
- change supported theme intents;
- change supported per-tile presentation options;
- change supported slicer presentation/layout;
- suggest supported decorative elements.

Use ONLY values contained in the supplied capability schema.

Do not generate HTML. Do not generate CSS. Do not generate React. Do not invent \
capability keys. Do not emit x/y/w/h coordinates — the compiler decides \
geometry from the roles and primitives you choose.

When a user's request cannot be represented by the provided capabilities, \
choose the nearest supported presentation, and say so in `rationale`.

Prefer strong visual hierarchy over decorating every element. A good report \
normally has one obvious visual hierarchy, limited competing colours, \
consistent spacing, intentional whitespace, clear primary and secondary \
visuals, compact controls, readable KPI emphasis and predictable sections.

Avoid making every card equally loud. Avoid unnecessary gradients. Avoid \
excessive shadows. Avoid turning every element into a floating card.

Preserve the user's existing information architecture unless their prompt \
explicitly requests reorganization.

Every visual in the snapshot must appear in exactly one section. Decorative \
elements are only appropriate when the user asks for sections, a header or a \
report-style layout — do not add them merely to rearrange. Decorative text must \
be a structural heading; never state a finding about the data, never quote a \
number, never claim something grew or fell.

If the user asks to change a chart's TYPE, a metric, a filter's field, or \
anything about the data, do not attempt it. Return the current arrangement \
unchanged and explain in `rationale` that this belongs in the Chart Editor.

Return only a valid PresentationPlan JSON object matching the supplied schema.
"""

PLAN_SCHEMA_HINT: Dict[str, Any] = {
    "scope": "page | report",
    "direction": {
        "style": "executive | saas | editorial | operations | finance | minimal | presentation",
        "density": "compact | balanced | spacious",
    },
    "sections": [
        {
            "primitive": "one of capabilities.composition.primitives",
            "visuals": ["dashboardChartId, in the order they should appear"],
            "title": "only for section_break",
        }
    ],
    "visualPreferences": {
        "<dashboardChartId>": {
            "role": "one of capabilities.visual.roles",
            "span": "one of capabilities.visual.spans",
            "emphasis": "one of capabilities.visual.emphasis",
        }
    },
    "slicerPresentation": {
        "dock": "one of capabilities.slicer.docks",
        "variant": "one of capabilities.slicer.variants",
        "style": "one of capabilities.slicer.styles",
    },
    "themeIntent": {
        "template": "one of capabilities.theme.templates",
        "colorway": "one of capabilities.theme.colorways",
        "mode": "light | dark",
    },
    "decorativeElements": [
        {"widgetType": "section_header | callout | hero_strip", "text": "structural heading", "beforeSection": 0}
    ],
    "tileStyles": {"<dashboardChartId>": {"<key from capabilities.tileStyle.allowedKeys>": "value"}},
    "rationale": "one sentence on what you changed and why",
}


def _visual_digest(snapshot: Dict[str, Any]) -> List[Dict[str, Any]]:
    """The visual list, trimmed to what a composition decision needs.

    The snapshot the client builds is already free of data-source detail; this
    trims further, because every field sent is a field the model may try to
    reason about. A planner that can see `styleCapabilities` for all 20 tiles
    starts suggesting per-tile styling nobody asked for.
    """
    out: List[Dict[str, Any]] = []
    for visual in snapshot.get("visuals") or []:
        layout = visual.get("currentLayout") or {}
        out.append({
            "id": visual.get("dashboardChartId"),
            "type": visual.get("chartType"),
            "title": visual.get("title"),
            "currentRole": visual.get("displayRoleHint"),
            "isDecorative": bool(visual.get("isWidget")),
            "currentSize": {"w": layout.get("w"), "h": layout.get("h")},
        })
    return out


def build_planner_prompt(
    *,
    snapshot: Dict[str, Any],
    user_prompt: str,
    conversation: Optional[List[Dict[str, str]]] = None,
) -> str:
    """Assemble the user-side message.

    `conversation` carries earlier turns so "make the main chart bigger" is
    understood against the preview the user is looking at, not the original
    report (§12). The CURRENT snapshot is always the one just built from that
    preview, so the model never has to remember geometry — only intent.
    """
    dashboard = snapshot.get("dashboard") or {}
    page = snapshot.get("currentPage") or {}
    payload = {
        "report": {
            "name": dashboard.get("name"),
            "pageCount": dashboard.get("pageCount"),
            "currentPage": page.get("name"),
        },
        "visuals": _visual_digest(snapshot),
        "slicers": [
            {"id": s.get("id"), "label": s.get("displayLabel"), "position": s.get("currentPosition")}
            for s in (snapshot.get("slicers") or [])
        ],
        "currentTheme": snapshot.get("theme") or {},
        "capabilities": snapshot.get("capabilities") or {},
        "planSchema": PLAN_SCHEMA_HINT,
    }

    # Order matters more than wording here. The first draft put the snapshot
    # first and the instruction last, and the model answered by echoing the
    # snapshot back -- a large JSON blob followed by "return JSON" reads as
    # "return this JSON". The task goes first, the required top-level keys are
    # named explicitly, and the data is clearly labelled as input.
    parts: List[str] = [
        "TASK: return a PresentationPlan JSON object.",
        (
            'Your entire reply must be one JSON object whose top-level keys are '
            'exactly: "scope", "direction", "sections", "visualPreferences", and '
            'optionally "slicerPresentation", "themeIntent", "decorativeElements", '
            '"tileStyles", "rationale". Do not echo the input. Do not wrap the '
            'object in another object. Start your reply with {"scope":'
        ),
        f"PLAN SCHEMA:\n{json.dumps(PLAN_SCHEMA_HINT, ensure_ascii=False)}\n",
    ]
    if conversation:
        # Only the intent of earlier turns, never their plans — replaying a plan
        # invites the model to re-emit it verbatim instead of building on the
        # state it is now being shown.
        history = "\n".join(
            f"- {turn.get('role', 'user')}: {str(turn.get('text', ''))[:400]}"
            for turn in conversation[-6:]
        )
        parts.append(f"Earlier in this conversation:\n{history}\n")

    parts.append(
        "INPUT — the CURRENT state of the page, after any changes already applied. "
        "This is context to read, not content to return.\n"
        f"{json.dumps(payload, ensure_ascii=False)}\n"
    )
    parts.append(f"THE USER ASKS:\n{user_prompt.strip()}\n")
    parts.append(
        "Now return the PresentationPlan. Every visual id in INPUT.visuals must "
        'appear in exactly one section. Begin with {"scope":'
    )
    return "\n".join(parts)


def _looks_like_a_plan(candidate: Any) -> bool:
    """Transport sanity, not business rules.

    The client's validator decides whether a plan is legal; this only decides
    whether the model answered the question at all. Keeping the bar this low
    matters -- a server that started judging plans would become a second, weaker
    rulebook in the place least able to enforce it.
    """
    if not isinstance(candidate, dict):
        return False
    return isinstance(candidate.get("sections"), list) and "direction" in candidate


class PresentationPlanUnavailable(RuntimeError):
    """No provider answered, or none is configured."""


def plan_presentation(
    *,
    snapshot: Dict[str, Any],
    user_prompt: str,
    conversation: Optional[List[Dict[str, str]]] = None,
) -> Dict[str, Any]:
    """Return a PresentationPlan dict. Raises when no model answered.

    Note what is NOT here: no validation, no repair, no defaulting of missing
    fields. A plan that comes back malformed goes to the client malformed and is
    refused there, by the same validator that guards every other path. Fixing it
    up here would create a second, weaker set of rules in the place least able
    to enforce them.
    """
    prompt = build_planner_prompt(
        snapshot=snapshot, user_prompt=user_prompt, conversation=conversation,
    )
    result = LLMClient.complete_json(
        prompt=prompt,
        system=SYSTEM_PROMPT,
        max_tokens=MAX_PLAN_TOKENS,
    )

    # One corrective retry. A model that echoes its input is not broken, it has
    # misread which of two JSON objects it was being asked for, and saying so
    # plainly fixes it far more often than rewording the original prompt. More
    # than one retry would just be paying twice for the same misunderstanding.
    if result is not None and not _looks_like_a_plan(result):
        logger.warning("presentation plan: first reply was not a plan (keys=%s) — retrying once",
                       list(result.keys())[:8])
        result = LLMClient.complete_json(
            prompt=(
                "Your previous reply was not a PresentationPlan — it repeated the input.\n"
                'Reply with ONLY the plan object: {"scope": ..., "direction": {...}, '
                '"sections": [...], "visualPreferences": {...}}.\n\n'
                + prompt
            ),
            system=SYSTEM_PROMPT,
            max_tokens=MAX_PLAN_TOKENS,
        )

    if not isinstance(result, dict):
        raise PresentationPlanUnavailable(
            "No AI provider returned a presentation plan."
        )
    if not _looks_like_a_plan(result):
        # Returning the echo would hand the client something its validator will
        # refuse with a confusing message. Saying what actually happened is more
        # use to whoever reads the log.
        raise PresentationPlanUnavailable(
            "The model did not return a presentation plan. Try rephrasing the request."
        )
    logger.info(
        "presentation plan: %s sections, %s visual preferences",
        len(result.get("sections") or []),
        len(result.get("visualPreferences") or {}),
    )
    return result
