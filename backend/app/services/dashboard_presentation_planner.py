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

When the user asks for a specific look, a named style, or a full redesign — \
"make this a modern SaaS analytics report", "dark dashboard", "redesign like \
this reference" — commit to it, do not merely nudge. Build the composition that \
reads that way: put the headline numbers in a `kpi_strip`, give the argument one \
large hero with a vertical rail of two or three secondary charts beside it using \
the `hero_with_rail` primitive, and send tables to the bottom. Choose a \
`themeIntent` that matches the words: a colorway whose `mode` is dark for a \
dark or night look, a template whose `skin` is modern for a modern look, and \
the colorway whose `accent` is closest to any colour they name (the \
capabilities `theme.colorwayGuide` and `theme.templateGuide` give you the mode, \
accent and skin of every option). When the user names a SPECIFIC colour — a hex \
like "#1E3A8A" or a precise brand colour ("deep blue", "electric orange") — do \
NOT settle for the nearest named colorway: still pick the closest colorway for \
the data palette and surface, and ALSO set `themeIntent.accent` to the exact \
`#RRGGBB` so the report shows the real colour, not an approximation. `accent` \
must be a 6-digit hex or it is refused. When the user names TWO brand colours \
("deep blue AND electric orange"), the first is the `accent` (KPIs, bars, \
buttons) and BOTH go into `dataColors` as `#RRGGBB` so the chart series show the \
pair — that is the only place a second colour lands. For a FONT, set `fontFamily` \
to one of inter, roboto, dm-sans, jakarta, grotesk, serif, mono (map "Inter" or \
"modern sans-serif" -> inter; "Georgia/serif" -> serif; "monospace" -> mono). \
HONESTY: claim in `rationale` ONLY what you actually put in the plan; if the user \
asks for something not expressible here (an unlisted font, a gradient, an image), \
do NOT say you applied it — state briefly that it is not available. \
A bold composition is still a restrained \
one: commit to the arrangement, keep the hierarchy singular and the palette limited.

If a REFERENCE IMAGE is attached, read its COMPOSITION and SURFACE, never its \
content. Take from it where the headline numbers sit, whether there is one hero \
with a rail of smaller charts beside it, how dense the grid is, whether it is \
dark or light, and its accent colour — and reproduce that ARRANGEMENT and MOOD \
using THIS report's existing visuals. Do not copy the image's numbers, labels, \
words, series or chart types; they belong to someone else's data. You are \
matching how a report looks, not what it says. Map what you see to the supplied \
primitives and theme options — an image can never justify a capability that is \
not in the schema.

Avoid making every card equally loud. Avoid unnecessary gradients. Avoid \
excessive shadows. Avoid turning every element into a floating card.

Size a chart to the shape it renders in — each visual carries an `aspect`:
- `square` (a gauge, pie or donut) draws a circle that shrinks to the shorter \
side, so a full-width band turns it into a dot in a field of whitespace. Give \
it a COMPACT, roughly-square slot — put several across in a `three_equal`, a \
`kpi_strip`, or a rail; never `full_width` or `table_full`.
- `wide` (a line, time series, bar or table) needs horizontal room for its axis \
or columns — give it a `full_width`, `two_one` lead, or the hero of a \
`hero_with_rail`.
- `tall` (a funnel) wants height, not width — a narrower column reads better \
than a wide strip.
Do NOT stretch a single square chart across the whole page.

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
        "accent": "optional exact brand colour as #RRGGBB (overrides the colorway accent)",
        "dataColors": "optional array of #RRGGBB for the chart series palette (home for a SECOND brand colour)",
        "fontFamily": "optional report font: inter | roboto | dm-sans | jakarta | grotesk | serif | mono",
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
            # The shape this chart renders best in — size it accordingly.
            "aspect": visual.get("renderAspect"),
        })
    return out


def build_planner_prompt(
    *,
    snapshot: Dict[str, Any],
    user_prompt: str,
    conversation: Optional[List[Dict[str, str]]] = None,
    has_reference: bool = False,
    focused_chart_id: Optional[int] = None,
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
    if has_reference:
        parts.append(
            "A REFERENCE IMAGE is attached to this message. Read its layout and "
            "surface — the arrangement of numbers and charts, the density, the "
            "light/dark mood and the accent colour — and reproduce that look with "
            "INPUT.visuals. Do NOT reproduce anything the image SAYS: its numbers, "
            "labels, words and chart types are another report's content, not this "
            "one's. Match the presentation, never the data.\n"
        )
    if focused_chart_id is not None:
        parts.append(
            f"FOCUSED EDIT: the user clicked ONE visual — id {focused_chart_id} — "
            "and wants to restyle only it. Return a plan whose `tileStyles` has an "
            f"entry for {focused_chart_id} with the requested per-tile presentation "
            "keys, and NOTHING else: no other tileStyles, no themeIntent, no "
            "slicerPresentation, no decorativeElements. Sections/visualPreferences "
            "may be omitted or minimal — the layout is not changing. Only keys in "
            "capabilities.tileStyle.allowedKeys are permitted (they are visual "
            "only; a data/semantic key is refused).\n"
            "To change THIS chart's BACKGROUND / theme / make it dark or light — "
            'for ANY chart type — set `chartSurface`: "dark" or "light". It repaints '
            "the card and keeps the text, axis and grid readable. The `kpi*` keys "
            "(kpiBackgroundMode, kpiAccentColor, kpiGradientBg, …) style a KPI card "
            "ONLY and are ignored on a chart — never use them to darken a chart.\n"
            "For colours, `palette` accepts ONLY these named sets: \"default\", "
            '"vibrant", "classic", "monochrome", "pastel". Never invent a palette '
            "name (e.g. \"emerald\", \"ocean\") — it is silently ignored. There is no "
            "free per-series colour key, so a single-series chart cannot be recoloured "
            "to an arbitrary colour; pick the closest named palette instead.\n"
        )
    parts.append(f"THE USER ASKS:\n{user_prompt.strip()}\n")
    parts.append(
        "Now return the PresentationPlan. "
        + ("" if focused_chart_id is not None
           else "Every visual id in INPUT.visuals must appear in exactly one section. ")
        + 'Begin with {"scope":'
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
    if "direction" not in candidate:
        return False
    # A whole-page plan arranges tiles into `sections`; a focused single-chart
    # restyle legitimately carries none and answers with `tileStyles` alone.
    # Either shape counts as "the model answered" — the client's validator still
    # decides whether the answer is legal.
    return isinstance(candidate.get("sections"), list) or isinstance(candidate.get("tileStyles"), dict)


class PresentationPlanUnavailable(RuntimeError):
    """No provider answered, or none is configured."""


def plan_presentation(
    *,
    snapshot: Dict[str, Any],
    user_prompt: str,
    conversation: Optional[List[Dict[str, str]]] = None,
    images: Optional[List[str]] = None,
    focused_chart_id: Optional[int] = None,
) -> Dict[str, Any]:
    """Return a PresentationPlan dict. Raises when no model answered.

    Runs on the design tier (4o, vision-capable) so it can read an attached
    reference image and reason about layout more capably than the cheap text
    tier. `images` is a list of data URLs; passing none is a normal text-only
    request that still benefits from the smarter model.

    Note what is NOT here: no validation, no repair, no defaulting of missing
    fields. A plan that comes back malformed goes to the client malformed and is
    refused there, by the same validator that guards every other path. Fixing it
    up here would create a second, weaker set of rules in the place least able
    to enforce them. That is also why an image is safe here — this function has
    no write path, and the plan it returns cannot change a chart, only arrange it.
    """
    clean_images = [img for img in (images or []) if isinstance(img, str) and img.strip()]
    prompt = build_planner_prompt(
        snapshot=snapshot, user_prompt=user_prompt, conversation=conversation,
        has_reference=bool(clean_images), focused_chart_id=focused_chart_id,
    )
    result = LLMClient.complete_json_multimodal(
        prompt=prompt,
        system=SYSTEM_PROMPT,
        images=clean_images or None,
        max_tokens=MAX_PLAN_TOKENS,
    )

    # One corrective retry. A model that echoes its input is not broken, it has
    # misread which of two JSON objects it was being asked for, and saying so
    # plainly fixes it far more often than rewording the original prompt. More
    # than one retry would just be paying twice for the same misunderstanding.
    if result is not None and not _looks_like_a_plan(result):
        logger.warning("presentation plan: first reply was not a plan (keys=%s) — retrying once",
                       list(result.keys())[:8])
        result = LLMClient.complete_json_multimodal(
            prompt=(
                "Your previous reply was not a PresentationPlan — it repeated the input.\n"
                'Reply with ONLY the plan object: {"scope": ..., "direction": {...}, '
                '"sections": [...], "visualPreferences": {...}}.\n\n'
                + prompt
            ),
            system=SYSTEM_PROMPT,
            images=clean_images or None,
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
