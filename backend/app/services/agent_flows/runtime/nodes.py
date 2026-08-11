"""The node registry: what a flow can be built from, declared exactly once.

THE RULE THIS FILE ENFORCES
---------------------------
A node type appears in the builder's library IF AND ONLY IF something here can run
it. The module this replaces shipped ten node types with generated forms while the
executor handled one — adding an HTTP node and publishing produced an agent with an
empty prompt, silently. So the palette is GENERATED from this registry; there is no
second list in the frontend to drift from it.

STRUCTURAL vs LEAF
------------------
Control flow (`if`, `switch`, `loop`) is not a handler — it IS the executor, because
running it means walking child bodies the executor owns. Those types are registered
as `structural` so they still appear in the palette and still cannot be added
without support, but their behaviour lives in `executor.py`.

RETRY AND ERROR HANDLING ARE NOT NODES
--------------------------------------
The mockup's library listed "Retry" and "Error Handler" as node types. They are
node PROPERTIES here (`retry`, `on_error`), because a retry node has to name what it
retries — which is a second recording of the graph, and a second thing to keep in
step with the first. The inspector shows them on every node instead, which is also
where an author looks for them.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable, Literal

#: Matches the library's left-hand nav in the builder.
Category = Literal["ai", "data", "logic", "flow", "utility"]


@dataclass(frozen=True)
class NodeSpec:
    """One node type, declared once."""

    type: str
    label_vi: str
    label_en: str
    description_vi: str
    category: Category
    icon: str
    #: None for structural types — the executor runs those itself.
    handler: Callable[..., Any] | None = None
    structural: bool = False
    #: Whether running this node costs a model call. Nine of the twelve do not, and
    #: that is worth showing in the palette: an author reaching for an AI Agent to
    #: "read the dashboard" is paying for a decision the engine can just make.
    costs_llm: bool = False
    #: Requires the link to allow reaching outside AppBI.
    reaches_outside: bool = False


_REGISTRY: dict[str, NodeSpec] = {}


def register(spec: NodeSpec) -> None:
    if spec.type in _REGISTRY:
        raise ValueError(f"node type '{spec.type}' registered twice")
    if spec.handler is None and not spec.structural:
        # The exact failure this module exists to prevent, refused at import.
        raise ValueError(
            f"node type '{spec.type}' has no handler and is not structural — "
            "it would appear in the builder and do nothing"
        )
    _REGISTRY[spec.type] = spec


def _load() -> None:
    """Import handler modules on first use.

    Late, because handlers pull in the query engine and the knowledge services, and
    this module is also imported by the API layer where that cost is not wanted.
    """
    if _REGISTRY:
        return
    from app.services.agent_flows.runtime.handlers import (  # noqa: F401
        agent as _agent,
        data as _data,
        logic as _logic,
        util as _util,
    )

    for mod in (_agent, _data, _logic, _util):
        for spec in mod.SPECS:
            register(spec)


def all_specs() -> dict[str, NodeSpec]:
    _load()
    return dict(_REGISTRY)


def spec_for(node_type: str) -> NodeSpec | None:
    _load()
    return _REGISTRY.get(node_type)


def handler_for(node_type: str) -> Callable[..., Any] | None:
    spec = spec_for(node_type)
    return spec.handler if spec else None


CATEGORY_LABELS_VI: dict[str, str] = {
    "ai": "AI & Dữ liệu",
    "data": "AI & Dữ liệu",
    "logic": "Logic",
    "flow": "Điều khiển luồng",
    "utility": "Xử lý dữ liệu",
}


def catalogue(*, web_enabled: bool = True) -> list[dict[str, Any]]:
    """What the builder's "Thêm bước" library shows.

    A type that reaches outside is returned WITH a flag rather than omitted, for the
    same reason the tool packs do it: an author who cannot find Web Research should
    learn the link has it off, not conclude the feature does not exist. The gate is
    per LINK, so authoring is always allowed and the run decides.
    """
    _load()
    out: list[dict[str, Any]] = []
    for s in _REGISTRY.values():
        out.append({
            "type": s.type,
            "label_vi": s.label_vi,
            "label_en": s.label_en,
            "description_vi": s.description_vi,
            "category": s.category,
            "category_label_vi": CATEGORY_LABELS_VI.get(s.category, s.category),
            "icon": s.icon,
            "costs_llm": s.costs_llm,
            "reaches_outside": s.reaches_outside,
            "gated_by_link": s.reaches_outside,
            "available": (not s.reaches_outside) or web_enabled,
        })
    return out
