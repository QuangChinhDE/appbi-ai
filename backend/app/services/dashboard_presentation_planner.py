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

SYSTEM_PROMPT = """You are the AppBI Presentation Designer — a design copilot.

The person who built this dashboard owns its content AND its layout. You change \
how it LOOKS, and you move things only as far as they allowed.

You are NOT a dashboard generator. Every existing data visual is trusted and \
must be preserved. Never delete, duplicate, replace or change the type of a \
chart. Never change datasets, dimensions, measures, aggregations, filters, \
queries, parameters or semantic bindings. Never move a visual to another page. \
Never change what a slicer filters.

PERMISSION. The input carries `permission.layer` — how much of the page the \
user's own words handed over. You may answer with that layer or a SMALLER one, \
never a larger one; anything beyond it is discarded by the client.
- "style": appearance only. Return `themeIntent`, `tileStyles` and/or \
  `slicerPresentation` (variant/style only — no dock). Do NOT return \
  `sections` or `structure`. Not one visual moves or resizes. This is the \
  default: "make it prettier / premium / modern / SaaS / dark / clean" is style.
- "structure": the user asked for a specific arrangement ("KPIs on top", \
  "make the trend bigger", "filters on the left"). Return \
  `structure.operations` naming ONLY the visuals the request is about; \
  everything else stays where the author put it. Do not return `sections`.
- "redesign": the user handed over the page ("redesign for the CEO", \
  "rearrange everything"). Return `sections` recomposing the page.
If `permission.targets` is non-empty the user SELECTED those visuals: change only \
them, and leave the report theme alone. Visuals with `locked: true` never move \
at any layer — do not name them in operations or sections.

Use ONLY values in the supplied capability schema. Do not generate HTML, CSS or \
React. Do not invent keys. Do not emit x/y/w/h — geometry is computed by code.

READ WHAT EACH VISUAL SAYS. `meaning` lists its measures, dimensions, whether it \
is over time, its description and intent. Hierarchy follows meaning: the \
headline business numbers first, the series that carries the argument (usually \
the temporal one about the main measure) as the hero, compositions and \
rankings as support, detail tables last. `readingOrder` is where the author \
placed it — respect it unless the request is to rearrange.

A good report has one obvious hierarchy, a limited palette, consistent \
spacing, intentional whitespace and compact controls. Not everything should be \
a card: `tileFrame` "flush" lets a KPI or chart sit directly on the canvas, \
"subtle" gives a quiet tinted panel without a border, "card" is the contained \
tile. Premium/editorial/minimal looks usually mean flush KPIs and fewer borders; \
dense operational looks keep cards. Commit to the look that was asked for.

Theme: pick a colorway whose `mode` matches a dark/light request, a template \
whose `skin` is modern for a modern look, and the colorway whose `accent` is \
closest to a named colour. For an exact brand colour also set \
`themeIntent.accent` to the #RRGGBB; a second brand colour goes in \
`dataColors`. Fonts: inter, roboto, dm-sans, jakarta, grotesk, serif, mono. \
Choosing a template changes the look, never the layout.

Size to shape when you arrange: `aspect` "square" (gauge/pie/donut) wants a \
compact slot, "wide" (line/bar/table) wants width, "tall" (funnel) wants height.

WHAT THE REPORT SAYS. `INPUT.findings` lists facts the page's charts support right now, computed from their live rows under the current filters: "says" is how a reader would read it, "key" is how you cite it. Use them to decide what LEADS — the verdict, the hero, the order. Each visual lists `findingKinds` it can back.

BLOCKS (redesign only). A report is more than tiles: you may add `blocks` — a `headline` (the verdict, one or two findings), a `summary` beside the hero ("what moved", up to four findings), a `chapter` before a chart (a heading and the findings that chart shows), a `takeaway` card (the latest period of one series). A block cites findings BY KEY and never contains a number: every figure is filled in from live data and changes with the filters. Headings are plain words with no digits. Place blocks in `sections` by their id ("b1"). Do not repeat a block that `visuals[].block` shows is already there.

DIRECTIONS. `direction.style` "executive", "operations" or "editorial" names a reading experience AppBI composes for you — verdict-first brief; status, exceptions and density; or a chaptered story. Choose one when the request is about who reads the report; you may leave `sections` and `blocks` empty and AppBI builds the composition, keeping your palette choices.

HONESTY: claim in `rationale` only what the plan actually does. If the user \
asks for something not expressible (an unlisted font, a gradient, an image, a \
section header outside a redesign), say briefly it is not available. If a different chart TYPE or \
metric would tell the story better, you may say so in `suggestions` — a list of \
{"visual": id, "text": "..."} that is shown to the user and never applied. \
Never type a number or say in your own words that something grew or fell: \
cite a finding key and let AppBI state it from the data.

If a REFERENCE IMAGE is attached, read its COMPOSITION and SURFACE, never its \
content: where headline numbers sit, the density, dark or light, the accent. \
Reproduce the MOOD with this report's visuals within the permission layer. Do \
not copy the image's numbers, labels, words, series or chart types.

Return only a valid PresentationPlan JSON object matching the supplied schema.
"""

PLAN_SCHEMA_HINT: Dict[str, Any] = {
    "layer": "style | structure | redesign  (never above permission.layer)",
    "direction": {
        "style": "executive | saas | editorial | operations | finance | minimal | presentation",
        "density": "compact | balanced | spacious",
    },
    "themeIntent": {
        "template": "one of capabilities.theme.templates",
        "colorway": "one of capabilities.theme.colorways",
        "accent": "optional exact brand colour as #RRGGBB",
        "dataColors": "optional array of #RRGGBB for the chart series palette",
        "fontFamily": "optional: inter | roboto | dm-sans | jakarta | grotesk | serif | mono",
        "mode": "light | dark",
        "density": "compact | balanced | spacious",
        "cardTreatment": "one of capabilities.theme.cardTreatments",
    },
    "tileStyles": {"<dashboardChartId>": {"<key from capabilities.tileStyle.allowedKeys>": "value from capabilities.tileStyle.values / ranges"}},
    "slicerPresentation": {
        "dock": "structure/redesign only — one of capabilities.slicer.docks",
        "variant": "one of capabilities.slicer.variants",
        "style": "one of capabilities.slicer.styles",
    },
    "structure": {
        "operations": [
            {"op": "one of capabilities.structure.operations", "visuals": ["dashboardChartId"], "size": "resize only: larger | smaller | full_width"}
        ]
    },
    "sections": [
        {"primitive": "redesign only — one of capabilities.composition.primitives", "visuals": ["dashboardChartId, in order"]}
    ],
    "visualPreferences": {
        "<dashboardChartId>": {"role": "one of capabilities.visual.roles", "emphasis": "low | normal | high"}
    },
    "blocks": [
        {
            "id": "b1 (redesign only — place it in a section like a visual: \"b1\")",
            "variant": "headline | summary | chapter | takeaway | callout",
            "eyebrow": "optional short label, NO digits",
            "title": "optional heading in plain words, NO digits",
            "findings": ["finding keys from INPUT.findings / visuals[].findingKinds, e.g. trend:12"],
        }
    ],
    "proposals": [
        {"kind": "retitle", "visual": "dashboardChartId", "title": "a clearer title in plain words, NO digits — the author must accept it"}
    ],
    "suggestions": [{"visual": "dashboardChartId", "text": "a non-presentation idea, shown not applied"}],
    "referenceStructure": {
        "headline": "only with a reference image: true if it opens with a headline or text band",
        "summary": "true if it has an explanatory paragraph",
    },
    "referenceReport": {
        "converted": ["only with a reference image: traits of its look you reproduced, in plain words, NO digits"],
        "approximated": ["traits you could only approximate, and how"],
        "unsupported": ["traits this report cannot reproduce (e.g. a photo band, a custom font)"],
    },
    "rationale": "one sentence on what you changed and why",
}


def _visual_digest(snapshot: Dict[str, Any]) -> List[Dict[str, Any]]:
    """The visual list, trimmed to what a design decision needs.

    The client builds the snapshot and has already removed every data-source
    detail (no SQL, dataset ids, rows). This keeps the fields a designer reads —
    what the visual SAYS (`meaning`), where the author put it, whether it is
    locked, what it currently wears — and drops the rest. Each `meaning` list is
    capped so a 30-tile page stays a small prompt.
    """
    out: List[Dict[str, Any]] = []
    for visual in snapshot.get("visuals") or []:
        layout = visual.get("currentLayout") or {}
        meaning = visual.get("meaning") or {}
        entry: Dict[str, Any] = {
            "id": visual.get("dashboardChartId"),
            "type": visual.get("chartType"),
            "title": visual.get("title"),
            "role": visual.get("displayRoleHint"),
            "isDecorative": bool(visual.get("isWidget")),
            "readingOrder": visual.get("readingOrder"),
            "position": {"x": layout.get("x"), "y": layout.get("y"), "w": layout.get("w"), "h": layout.get("h")},
            "locked": bool(visual.get("locked")),
            "aspect": visual.get("renderAspect"),
        }
        compact_meaning: Dict[str, Any] = {}
        measures = [m for m in (meaning.get("measures") or [])[:3] if isinstance(m, dict)]
        if measures:
            compact_meaning["measures"] = [
                {k: v for k, v in m.items() if k in ("label", "agg", "format", "description") and v}
                for m in measures
            ]
        dims = [d for d in (meaning.get("dimensions") or [])[:3] if isinstance(d, dict)]
        if dims:
            compact_meaning["dimensions"] = [
                {k: v for k, v in d.items() if k in ("label", "temporal") and v} for d in dims
            ]
        for key in ("temporal", "hasBenchmark"):
            if meaning.get(key):
                compact_meaning[key] = True
        for key in ("description", "intent", "goodDirection"):
            if meaning.get(key):
                compact_meaning[key] = str(meaning[key])[:200]
        if compact_meaning:
            entry["meaning"] = compact_meaning
        style = visual.get("currentStyle") or {}
        if style:
            entry["currentStyle"] = style
        kinds = [str(k) for k in (visual.get("findingKinds") or []) if isinstance(k, str)][:8]
        if kinds:
            # What this visual can back up. A block cites `kind:id`.
            entry["findingKinds"] = kinds
        block = visual.get("block")
        if isinstance(block, dict):
            entry["block"] = {k: block.get(k) for k in ("variant", "origin") if block.get(k)}
        out.append(entry)
    return out


def _findings_digest(snapshot: Dict[str, Any]) -> List[Dict[str, str]]:
    """The findings the page's tiles support right now, as a reader reads them.

    Aggregates computed in the browser from the rows the tiles already show —
    the sentence is context for deciding what leads; the KEY is what a block
    cites. No rows ever reach the model."""
    out: List[Dict[str, str]] = []
    for f in (snapshot.get("findings") or [])[:40]:
        if not isinstance(f, dict):
            continue
        key = str(f.get("key") or "")
        sentence = str(f.get("sentence") or "")[:220]
        if key and sentence:
            out.append({"key": key, "says": sentence})
    return out


def build_planner_prompt(
    *,
    snapshot: Dict[str, Any],
    user_prompt: str,
    conversation: Optional[List[Dict[str, str]]] = None,
    has_reference: bool = False,
    granted_layer: str = "style",
    target_ids: Optional[List[int]] = None,
) -> str:
    """Assemble the user-side message.

    `conversation` carries earlier turns so "make the main chart bigger" is
    understood against the preview the user is looking at, not the original
    report (§12). The CURRENT snapshot is always the one just built from that
    preview, so the model never has to remember geometry — only intent.
    """
    dashboard = snapshot.get("dashboard") or {}
    page = snapshot.get("currentPage") or {}
    layer = granted_layer if granted_layer in ("style", "structure", "redesign") else "style"
    targets = [int(t) for t in (target_ids or []) if isinstance(t, (int, float, str)) and str(t).lstrip("-").isdigit()]
    payload = {
        "permission": {"layer": layer, "targets": targets},
        "report": {
            "name": dashboard.get("name"),
            "description": dashboard.get("description"),
            "pageCount": dashboard.get("pageCount"),
            "currentPage": page.get("name"),
        },
        "visuals": _visual_digest(snapshot),
        "findings": _findings_digest(snapshot),
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
            '"layer" and "direction", plus whichever of "themeIntent", '
            '"tileStyles", "slicerPresentation", "structure", "sections", '
            '"visualPreferences", "blocks", "suggestions", "rationale" the layer allows. '
            'Do not echo the input. Do not wrap the object in another object. '
            'Start your reply with {"layer":'
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
            "one's. Match the presentation, never the data. Reproduce its STRUCTURE "
            "too: if it opens with a headline or a text band, open with a "
            "\"headline\" block built from INPUT.findings; if it has an explanatory "
            "paragraph, add a \"summary\" block; if it groups numbers in a strip, "
            "use kpi_strip; if one chart dominates, make it the hero. Report what you "
            "saw in \"referenceStructure\" ({headline, summary} as true/false). Then say honestly, in "
            "\"referenceReport\", which traits of the reference you converted, which "
            "you could only approximate and which this report cannot reproduce — "
            "the author decides with that in hand.\n"
        )
    if targets:
        parts.append(
            f"SELECTION: the user selected visual(s) {targets}. Change ONLY those — "
            "their tileStyles, or (if the layer allows) operations naming them. "
            "No themeIntent, no slicerPresentation, nothing about other visuals.\n"
        )
    if layer == "style":
        parts.append(
            "PERMISSION IS STYLE: the layout is the author's and stays exactly as it is. "
            "Answer with themeIntent / tileStyles / slicer look only.\n"
            "To make one chart dark or light set `chartSurface`; to drop or soften its "
            "container set `tileFrame` (card | subtle | flush). `palette` accepts only "
            "the named sets in capabilities.tileStyle.values.palette.\n"
        )
    parts.append(f"THE USER ASKS:\n{user_prompt.strip()}\n")
    parts.append(
        "Now return the PresentationPlan. "
        + ("For a redesign, every unlocked visual id must appear in exactly one section. "
           if layer == "redesign" else "")
        + 'Begin with {"layer":'
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
    if "direction" not in candidate and "layer" not in candidate:
        return False
    # A redesign arranges tiles into `sections`, a structure change answers with
    # `structure`, and a style change legitimately carries only theme/tile/slicer
    # look. Any of those counts as "the model answered" — the client's validator
    # still decides whether the answer is legal.
    return (
        isinstance(candidate.get("sections"), list)
        or isinstance(candidate.get("tileStyles"), dict)
        or isinstance(candidate.get("themeIntent"), dict)
        or isinstance(candidate.get("structure"), dict)
        or isinstance(candidate.get("slicerPresentation"), dict)
    )


class PresentationPlanUnavailable(RuntimeError):
    """No provider answered, or none is configured."""


def plan_presentation(
    *,
    snapshot: Dict[str, Any],
    user_prompt: str,
    conversation: Optional[List[Dict[str, str]]] = None,
    images: Optional[List[str]] = None,
    granted_layer: str = "style",
    target_ids: Optional[List[int]] = None,
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
        has_reference=bool(clean_images), granted_layer=granted_layer, target_ids=target_ids,
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
                'Reply with ONLY the plan object: {"layer": ..., "direction": {...}, '
                '...the keys your layer allows...}.\n\n'
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
