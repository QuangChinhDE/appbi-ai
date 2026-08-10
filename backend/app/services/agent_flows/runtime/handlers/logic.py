"""Control-flow node types.

These have no handler on purpose: running an IF means walking a child body, and the
thing that walks bodies is the executor. Registering them as `structural` keeps the
one rule this module lives by — a type is offered in the builder only if something
can run it — without pretending branching is a plug-in.

`filter` is here rather than with the utilities because stopping a branch IS control
flow: it raises `BranchStopped`, which the executor catches at the enclosing body so
the siblings after the branch still run.
"""
from __future__ import annotations

from app.services.agent_flows.runtime.nodes import NodeSpec

SPECS = [
    NodeSpec(
        type="if",
        label_vi="IF / Else",
        label_en="IF / Else",
        description_vi="Chia nhánh theo điều kiện. Nhánh đầu tiên khớp sẽ chạy.",
        category="logic",
        icon="◇",
        structural=True,
    ),
    NodeSpec(
        type="switch",
        label_vi="Switch",
        label_en="Switch",
        description_vi="Rẽ theo một giá trị, nhiều case và một nhánh dự phòng.",
        category="logic",
        icon="⑂",
        structural=True,
    ),
    NodeSpec(
        type="loop",
        label_vi="Loop / For Each",
        label_en="Loop / For Each",
        description_vi="Chạy phần thân cho từng phần tử. Bước tốn kém nhất — có giới hạn vòng lặp.",
        category="logic",
        icon="↻",
        structural=True,
    ),
    NodeSpec(
        type="filter",
        label_vi="Filter",
        label_en="Filter",
        description_vi="Dừng nhánh hiện tại nếu điều kiện không khớp.",
        category="logic",
        icon="⌁",
        structural=True,
    ),
]
