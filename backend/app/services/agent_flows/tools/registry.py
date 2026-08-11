"""The tool registry. What an Agent brain can be granted, and what each one is for.

WHY A REGISTRY AND NOT A LIST
-----------------------------
A brain grants tools per step, and the builder shows the author what is available.
Those two must never disagree, so there is ONE declaration and the picker is
generated from it. The module this replaces kept a Python dict of callables, a
separate list of LLM schemas, a second copy of both for its "normal" mode, and a
hand-written capability table in the frontend — four places, and they drifted.

A tool declares itself once here: what it is called, what it does, what it costs,
what it RETURNS, and whether it reaches outside AppBI. Everything downstream reads
that.

WHAT CHANGED, AND WHY
---------------------
The first version of this file declared a tool's inputs and stopped. That was the
right contract for one consumer — a language model, which reads whatever comes
back and forms an opinion about it. Tools now have three consumers, and the other
two cannot form opinions:

  * a flow node branching on a result with NO model in the loop, which needs to
    know the shape before it reads it;
  * the answer verifier, which checks the figures in a written answer against the
    data they were drawn from, and can only do that if it knows which field held
    the figure.

So a tool now also declares `result_kind` and `returns`. That single addition is
what makes a tool useful without an LLM — the property that decides whether this
system can hold a hundred tools or only a handful. It is not decoration: with
twenty-four tools the JSON schemas alone are ~4,400 tokens on EVERY model round,
so exposing tools to a model does not scale, and the way out is for nodes to call
them directly. A node can only call directly what it can read the answer of.

PACKS ARE CATEGORIES
--------------------
A pack groups tools that are used for the same KIND of question — read the
report, get a number, compare, diagnose, project, look something up, go outside.
The grouping used to be by which file the body lived in, which is why `analysis`
had eleven tools spanning "average this column" and "forecast next quarter"; an
author scanning for a comparison tool had to read all eleven.

A pack can also be withheld: `external` is withheld unless the deployment allows
web research — the same rule the old agent implemented by keeping a second
definitions list and remembering to concatenate it per turn. Making it a pack
property means forgetting is not possible.

WHAT A TOOL IS NOT
------------------
A way of thinking. `emit_reading_plan` announced the first-generation bot's
intended steps before it answered; that was a hardcoded pipeline talking about
itself, and a brain's steps ARE the plan, so it is not registered here.
"""
from __future__ import annotations

import json
import time
from collections import OrderedDict
from dataclasses import dataclass, field
from typing import Any, Callable, Literal

from app.services.agent_flows.tools import result as R

#: A tool is a plain function over the run's context. `ToolContext` is scoped to
#: one dashboard and its filters, which is what makes a tool answerable about "the
#: report being viewed" without the brain naming a report.
ToolFn = Callable[[Any, dict], dict]

#: Rough price of calling it, so a builder can total a step's cost and an author
#: can see that three cheap lookups are not the same as three warehouse scans.
#:
#: This measures ONE axis: what the call costs the warehouse. See `PayloadSize`
#: for the other one.
CostClass = Literal["cheap", "data_query", "expensive", "external"]

#: How big the RESULT is, which is the other half of what a call costs.
#:
#: The two axes are genuinely independent and conflating them hid a real problem.
#: `list_charts` queries nothing, so it was declared `cheap` — correctly, on the
#: warehouse axis. On a 70-chart dashboard it returned ~15,600 tokens, and every
#: prompt that referenced it paid for all of them. An author reading "nhẹ" had no
#: way to see the expensive half, because the catalogue never described it.
#:
#: `scales_with_report` is the important value: it says the payload is not a
#: property of the tool at all but of the report it runs against, so a flow that
#: is cheap on a demo dashboard can be ruinous on a real one.
PayloadSize = Literal["small", "medium", "large", "scales_with_report"]


@dataclass(frozen=True)
class ToolSpec:
    """One tool, declared once."""

    name: str
    fn: ToolFn
    #: The JSON schema the model sees. Provider adapters translate it, so this is
    #: written once in OpenAI function-call shape.
    definition: dict
    label_vi: str
    label_en: str
    description_vi: str
    cost_class: CostClass = "cheap"
    #: How large the result is — the second cost axis, independent of the first.
    payload: PayloadSize = "small"
    #: True only for tools that leave AppBI. Kept explicit rather than inferred
    #: from the pack, because it is the property a reviewer scans for.
    reaches_outside: bool = False

    # ── the output half of the contract ──────────────────────────────────────
    #: What shape comes back. The field a node reads to know how to read the rest.
    result_kind: R.ResultKind = "narrative"
    #: The payload's named fields — `{field: what it holds}`. Prose on purpose:
    #: its readers are an author choosing a tool and a person debugging a run,
    #: and a JSON Schema serves neither better than a sentence.
    returns: dict[str, str] = field(default_factory=dict)

    # ── properties that decide HOW a tool may be used ────────────────────────
    #: Same arguments over the same data give the same answer. False for anything
    #: touching the clock, a model, or the web.
    deterministic: bool = True
    #: Safe to serve from a previous call within one report + filter state. Only
    #: ever true when `deterministic`; enforced in __post_init__ rather than
    #: trusted, because a wrongly cached web search is a stale fact presented as
    #: a fresh one.
    cacheable: bool = True
    #: The RESULT is a finished figure: no model has to interpret it before a
    #: node can branch on it, a verifier can check it, or a template can print it.
    #:
    #: READ THIS NARROWLY. It says nothing about the rest of the path. Inside an
    #: agent step a model still chooses the tool and still writes the sentence, so
    #: a question answered by `rank_values` costs TWO model calls, not zero — the
    #: builder first shipped this as a "không cần AI" badge, which claimed all
    #: three and was false in the only configuration anyone was running.
    #:
    #: It becomes a claim about the whole path only when a flow calls the tool
    #: with fixed arguments. Today just one self-sufficient tool
    #: (`inspect_filters`) has a node that does that; the rest are reachable only
    #: through an agent. The property is therefore LATENT — real, checkable, and
    #: not yet spendable — until a node exists that can call any tool directly.
    self_sufficient: bool = False
    #: Example questions, for the builder's picker and for authors choosing
    #: between two tools whose names both sound right.
    answers_vi: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        if self.cacheable and not self.deterministic:
            raise ValueError(
                f"tool '{self.name}': cacheable requires deterministic — caching a "
                "non-deterministic result serves a stale answer as a fresh one"
            )
        if self.reaches_outside and self.cacheable:
            raise ValueError(
                f"tool '{self.name}': a tool that leaves AppBI must not be cacheable"
            )

    def to_dict(self) -> dict[str, Any]:
        """For the builder's tool picker.

        No callable and no input schema: a picker needs to know what a tool IS,
        and shipping the argument schema would invite the frontend to start
        reasoning about arguments. The OUTPUT contract is shipped, because that
        is what an author needs in order to wire a tool's result into the next
        node — the question the picker exists to answer.
        """
        return {
            "name": self.name,
            "label_vi": self.label_vi,
            "label_en": self.label_en,
            "description_vi": self.description_vi,
            "cost_class": self.cost_class,
            "payload": self.payload,
            "reaches_outside": self.reaches_outside,
            "result_kind": self.result_kind,
            "returns": self.returns,
            "deterministic": self.deterministic,
            "cacheable": self.cacheable,
            "self_sufficient": self.self_sufficient,
            "answers_vi": list(self.answers_vi),
        }


@dataclass
class ToolPack:
    """A group of tools used for the same kind of question."""

    key: str
    label_vi: str
    label_en: str
    #: One line on when to reach into this pack, shown above its tools.
    purpose_vi: str = ""
    tools: list[ToolSpec] = field(default_factory=list)
    #: When set, the pack is only offered if this deployment setting is on. The
    #: tools stay REGISTERED either way, so a stored brain that names one is still
    #: readable and still says what it wanted — it simply cannot call it.
    requires_setting: str | None = None


_PACKS: "OrderedDict[str, ToolPack]" = OrderedDict()


def register_pack(pack: ToolPack) -> None:
    """Register a pack. Refuses a duplicate tool name across packs.

    Two tools with one name is how the previous module ended up with a `get_chart_data`
    in two files that had drifted apart, and whichever imported last won.
    """
    existing = {t.name for p in _PACKS.values() for t in p.tools}
    clashes = existing & {t.name for t in pack.tools}
    if clashes:
        raise ValueError(
            f"pack '{pack.key}' redeclares tool(s) already registered: "
            f"{', '.join(sorted(clashes))}"
        )
    _PACKS[pack.key] = pack


def _load_packs() -> None:
    """Import the packs on first use.

    Late, because a pack's implementations pull in the query engine and the
    knowledge services, and this module is also imported by the API layer where
    that cost is not wanted at import time.

    Order is the order an author reads them in: understand the report, get a
    number out of it, compare, diagnose, project, look something up, leave.
    """
    if _PACKS:
        return
    from app.services.agent_flows.tools.packs import (
        compare, diagnose, external, knowledge, measure, project, read,
    )

    for mod in (read, measure, compare, diagnose, project, knowledge, external):
        register_pack(mod.PACK)


def all_tools() -> dict[str, ToolSpec]:
    _load_packs()
    return {t.name: t for p in _PACKS.values() for t in p.tools}


def packs() -> list[ToolPack]:
    _load_packs()
    return list(_PACKS.values())


def pack_of(name: str) -> ToolPack | None:
    _load_packs()
    for p in _PACKS.values():
        if any(t.name == name for t in p.tools):
            return p
    return None


#: What a gated pack's condition MEANS to somebody authoring a brain. Keyed by the
#: setting name so the note cannot drift from the gate it describes.
GATE_NOTES_VI: dict[str, str] = {
    "web_search_enabled": (
        "Chỉ chạy trên link công khai đã bật “Tìm kiếm web”. "
        "Vẫn cấp được ở đây — link nào tắt thì bước bỏ qua công cụ này."
    ),
}


def catalogue(*, web_enabled: bool = False) -> list[dict[str, Any]]:
    """What the builder's tool picker shows, grouped by pack.

    Withheld packs are returned WITH a flag rather than omitted: an author who
    cannot find `web_search` should learn that the deployment has web research
    off, not conclude the feature does not exist.

    `available` answers "would THIS deployment dispatch it", which is what a run
    needs. A BUILDER needs a different question answered, and conflating the two
    made web tools unreachable: the picker read `available=False` and disabled the
    checkbox, so nobody could ever grant `web_search` — even though the gate is
    PER LINK (`ai_bot_web_search_enabled` on the link's appearance config) and a
    granted web tool would have worked the moment it ran on a link with the box
    ticked. `gated_by_link` is therefore reported separately: the builder offers
    the pack and states the condition, and the run-time gate stays exactly where
    it was.
    """
    _load_packs()
    out: list[dict[str, Any]] = []
    for p in _PACKS.values():
        available = _pack_available(p, web_enabled=web_enabled)
        out.append({
            "key": p.key,
            "label_vi": p.label_vi,
            "label_en": p.label_en,
            "purpose_vi": p.purpose_vi,
            "available": available,
            "requires_setting": p.requires_setting,
            #: Grantable at authoring time, decided per run. Distinct from
            #: `available`, which is this deployment's answer for this call.
            "gated_by_link": p.requires_setting is not None,
            "gate_note_vi": GATE_NOTES_VI.get(p.requires_setting or "", ""),
            "tools": [t.to_dict() for t in p.tools],
        })
    return out


def _pack_available(pack: ToolPack, *, web_enabled: bool) -> bool:
    if pack.requires_setting is None:
        return True
    if pack.requires_setting == "web_search_enabled":
        return web_enabled
    # An unknown gate fails CLOSED. A typo in a setting name must not silently
    # hand out the tools it was written to withhold.
    return False


def definitions_for(names: set[str], *, web_enabled: bool = False) -> list[dict]:
    """The LLM-facing schemas for the tools a step was granted.

    Filtered by what the step asked for AND by what this deployment allows, in one
    place. The old agent did the allowlist in the loop and the web gate at the
    call site, which is two chances to disagree about what the model was offered.
    """
    _load_packs()
    out: list[dict] = []
    for p in _PACKS.values():
        if not _pack_available(p, web_enabled=web_enabled):
            continue
        for t in p.tools:
            if t.name in names:
                out.append(t.definition)
    return out


# ── result cache ─────────────────────────────────────────────────────────────
# A viewer asks four questions about one report. Without this, every turn re-runs
# the same reads against the warehouse: same dashboard, same filters, same chart,
# same answer. The session already carries a fingerprint that changes when the
# report or its filters change (see `agent_flows/dispatch.py`); the cache key
# below is the same idea computed from what the call itself can see, so a tool
# does not need to be told which conversation it is in.
#
# Only `cacheable` tools are stored, and `cacheable` implies `deterministic` —
# checked at declaration, not here, so a tool cannot opt in by accident.

_CACHE: "OrderedDict[str, tuple[float, dict]]" = OrderedDict()
_CACHE_MAX = 512
_CACHE_TTL = 300.0  # seconds — a report's data is not expected to move mid-chat


def _cache_key(ctx: Any, name: str, args: dict) -> str | None:
    dashboard = getattr(getattr(ctx, "dashboard", None), "id", None)
    if dashboard is None:
        return None
    try:
        payload = json.dumps(
            [dashboard, getattr(ctx, "public_filters", []), name, args],
            sort_keys=True, default=str,
        )
    except Exception:  # noqa: BLE001 — an unserialisable arg simply is not cached
        return None
    return payload


def _cache_get(key: str) -> dict | None:
    hit = _CACHE.get(key)
    if hit is None:
        return None
    stored_at, value = hit
    if time.monotonic() - stored_at > _CACHE_TTL:
        _CACHE.pop(key, None)
        return None
    _CACHE.move_to_end(key)
    return value


def _cache_put(key: str, value: dict) -> None:
    _CACHE[key] = (time.monotonic(), value)
    _CACHE.move_to_end(key)
    while len(_CACHE) > _CACHE_MAX:
        _CACHE.popitem(last=False)


def clear_cache() -> None:
    """Drop every cached result. For tests, and for a report whose data was rebuilt.

    Clears the measure-metadata memo too: two caches that must be reset together
    and are cleared separately are one forgotten call away from a test passing
    against stale definitions.
    """
    _CACHE.clear()
    from app.services.agent_flows.tools.packs import measure_meta

    measure_meta.clear_cache()


def execute(
    ctx: Any,
    name: str,
    args: dict | None,
    *,
    allowed: set[str] | None = None,
    use_cache: bool = True,
) -> dict:
    """Run one tool and return a result that meets the contract.

    `allowed` is enforced HERE, not only where the schemas are built. A model can
    name a tool it was never offered — some do, when a prompt mentions one — and
    the only safe place to refuse is the moment before the call.

    Every return passes through `result.normalise`, so a caller can rely on `ok`,
    `kind` and — on failure — `error_code`, whatever the body did. Bodies that
    already speak the contract are left exactly as they are.
    """
    tools = all_tools()
    if allowed is not None and name not in allowed:
        return R.err(
            f"tool '{name}' is not granted to this step", code="not_granted"
        )
    spec = tools.get(name)
    if spec is None:
        return R.err(f"unknown tool: {name}", code="unknown_tool")

    args = args or {}
    key = None
    if use_cache and spec.cacheable:
        key = _cache_key(ctx, name, args)
        if key is not None:
            cached = _cache_get(key)
            if cached is not None:
                # Flagged so a run's trace can show a read that cost nothing,
                # rather than presenting a reused figure as a fresh query.
                return {**cached, "cached": True}

    try:
        raw = spec.fn(ctx, args)
    except Exception as exc:  # noqa: BLE001
        # Never hand a traceback to the model: it wastes context and occasionally
        # gets quoted into the answer.
        return R.err(
            f"tool '{name}' raised {type(exc).__name__}: {str(exc)[:200]}",
            code="internal",
            retryable=True,
        )

    out = R.normalise(raw, kind=spec.result_kind)
    if key is not None and out.get("ok"):
        _cache_put(key, out)
    return out
