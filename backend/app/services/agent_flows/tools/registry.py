"""The tool registry. What an Agent brain can be granted, and what each one is for.

WHY A REGISTRY AND NOT A LIST
-----------------------------
A brain grants tools per step, and the builder shows the author what is available.
Those two must never disagree, so there is ONE declaration and the picker is
generated from it. The module this replaces kept a Python dict of callables, a
separate list of LLM schemas, a second copy of both for its "normal" mode, and a
hand-written capability table in the frontend — four places, and they drifted.

A tool declares itself once here: what it is called, what it does, what it costs,
and whether it reaches outside AppBI. Everything downstream reads that.

PACKS
-----
Tools arrive in packs, and a pack can be withheld. `external` is withheld unless
the deployment allows web research — the same rule the old agent implemented by
keeping a second definitions list and remembering to concatenate it per turn.
Making it a pack property means forgetting is not possible.

Adding a different KIND of tool list later — tools for a workboard, tools calling
an outside system, tools for one customer — is writing a pack and registering it.
No executor change, no frontend change.

WHAT A TOOL IS NOT
------------------
A way of thinking. `emit_reading_plan` announced the first-generation bot's
intended steps before it answered; that was a hardcoded pipeline talking about
itself, and a brain's steps ARE the plan, so it is not registered here.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable, Literal

#: A tool is a plain function over the run's context. `ToolContext` is scoped to
#: one dashboard and its filters, which is what makes a tool answerable about "the
#: report being viewed" without the brain naming a report.
ToolFn = Callable[[Any, dict], dict]

#: Rough price of calling it, so a builder can total a step's cost and an author
#: can see that three cheap lookups are not the same as three warehouse scans.
CostClass = Literal["cheap", "data_query", "expensive", "external"]


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
    #: True only for tools that leave AppBI. Kept explicit rather than inferred
    #: from the pack, because it is the property a reviewer scans for.
    reaches_outside: bool = False

    def to_dict(self) -> dict[str, Any]:
        """For the builder's tool picker. No callable, no schema — a picker needs
        to know what a tool IS, and shipping the schema would invite the frontend
        to start reasoning about arguments."""
        return {
            "name": self.name,
            "label_vi": self.label_vi,
            "label_en": self.label_en,
            "description_vi": self.description_vi,
            "cost_class": self.cost_class,
            "reaches_outside": self.reaches_outside,
        }


@dataclass
class ToolPack:
    """A group of tools that ship and are withheld together."""

    key: str
    label_vi: str
    label_en: str
    tools: list[ToolSpec] = field(default_factory=list)
    #: When set, the pack is only offered if this deployment setting is on. The
    #: tools stay REGISTERED either way, so a stored brain that names one is still
    #: readable and still says what it wanted — it simply cannot call it.
    requires_setting: str | None = None


_PACKS: dict[str, ToolPack] = {}


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
    """
    if _PACKS:
        return
    from app.services.agent_flows.tools.packs import analysis, external, knowledge, report

    for mod in (report, analysis, knowledge, external):
        register_pack(mod.PACK)


def all_tools() -> dict[str, ToolSpec]:
    _load_packs()
    return {t.name: t for p in _PACKS.values() for t in p.tools}


def packs() -> list[ToolPack]:
    _load_packs()
    return list(_PACKS.values())


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


def execute(ctx: Any, name: str, args: dict | None, *, allowed: set[str] | None = None) -> dict:
    """Run one tool.

    `allowed` is enforced HERE, not only where the schemas are built. A model can
    name a tool it was never offered — some do, when a prompt mentions one — and
    the only safe place to refuse is the moment before the call.
    """
    tools = all_tools()
    if allowed is not None and name not in allowed:
        return {"ok": False, "error": f"tool '{name}' không được cấp cho bước này"}
    spec = tools.get(name)
    if spec is None:
        return {"ok": False, "error": f"unknown tool: {name}"}
    try:
        return spec.fn(ctx, args or {})
    except Exception as exc:  # noqa: BLE001
        # Never hand a traceback to the model: it wastes context and occasionally
        # gets quoted into the answer.
        return {"ok": False, "error": f"tool '{name}' raised {type(exc).__name__}: {str(exc)[:200]}"}
