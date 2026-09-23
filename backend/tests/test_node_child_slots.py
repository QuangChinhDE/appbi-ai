# -*- coding: utf-8 -*-
"""A node that holds nodes must say where it keeps them.

THE BUG THIS LOCKS
------------------
`coordinate` was added to the contract, the executor and the builder — and not to
`all_nodes()`, which is what the flow knows about itself. Everything downstream
reads that method, so a specialist's lane became invisible to all of it at once:
`warnings()`, `coverage.granted_tools()`, `node_count`, `unreachable_nodes()`,
`produced_vars()` / `referenced_vars()`, and the binding's loop-variable scan.

The measured cost, from a live run: the "số liệu" specialist held `get_chart_data`,
`total_measure` and `compare_periods` — three tools that all require a `chart_id` —
and nothing that can produce one. The check for that exact case was already written
and simply never looked inside the lane. Asked which product category earned the
most, the flow answered

    13,591,643.70

which is the report's grand total. No category named, no notice raised, run `ok`.

WHY THE TEST IS SHAPED THIS WAY
-------------------------------
The rule used to live in a docstring: "a node that holds nodes must be walked here,
and adding one is not finished until it is". A comment cannot fail a build. This
derives the set of container types from the pydantic models themselves, so a
fifteenth container is caught the moment it is declared — without anyone
remembering to extend a list.

It deliberately does NOT key off `NodeSpec.structural`: that flag means "the
executor runs this itself, it has no handler", and `filter` is structural while
holding nothing. Conflating the two is what the first version of this guard got
wrong.
"""
from __future__ import annotations

import os
import typing

import pytest

if not os.environ.get("DATABASE_URL"):
    os.environ["DATABASE_URL"] = "sqlite:///./test_child_slots.db"
if not os.environ.get("DATA_DIR"):
    os.environ["DATA_DIR"] = ".testdata"

from app.services.agent_flows import contract as C  # noqa: E402


def _node_models() -> dict[str, type]:
    """Every concrete node model, keyed by its `type` literal."""
    out: dict[str, type] = {}
    for name in dir(C):
        obj = getattr(C, name)
        if not isinstance(obj, type) or not issubclass(obj, C.BaseNode):
            continue
        if obj is C.BaseNode:
            continue
        field = obj.model_fields.get("type")
        if field is None:
            continue
        args = typing.get_args(field.annotation)
        if args and isinstance(args[0], str):
            out[args[0]] = obj
    return out


def _classes_in(annotation: object, _depth: int = 0) -> list[type]:
    """Every concrete class reachable inside a type annotation.

    A node list is annotated `list[Annotated[Union[AgentNode, ...], FieldInfo]]`,
    so the interesting classes sit two unwrappings down and behind a Union — which
    is not itself a `type`. Walking the tree handles that without this test caring
    how pydantic chooses to spell a discriminated union.
    """
    if _depth > 6:
        return []
    if isinstance(annotation, type):
        return [annotation]
    out: list[type] = []
    for arg in typing.get_args(annotation):
        out.extend(_classes_in(arg, _depth + 1))
    return out


def _holds_nodes(model: type) -> list[str]:
    """Fields on this model that contain nodes, directly or inside a group.

    Derived from the annotations rather than a hand-kept list, because a
    hand-kept list is the thing that was forgotten.
    """
    holding: list[str] = []
    for fname, field in model.model_fields.items():
        if fname == "type":
            continue
        for candidate in _classes_in(field.annotation):
            # a list of nodes — `loop.body`, `*.fallback`
            if issubclass(candidate, C.BaseNode):
                holding.append(fname)
            # a list of groups that each carry a `body` — `if.paths`,
            # `switch.cases`, `coordinate.specialists`
            elif "body" in getattr(candidate, "model_fields", {}):
                holding.append(fname)
    return sorted(set(holding))


CONTAINERS = {t: m for t, m in _node_models().items() if _holds_nodes(m)}


def test_there_are_containers_to_check():
    """A discovery bug would make every assertion below vacuously true."""
    assert CONTAINERS, "no container node types discovered — the introspection is wrong"
    assert {"if", "switch", "loop", "coordinate"} <= set(CONTAINERS), CONTAINERS


@pytest.mark.parametrize("node_type", sorted(CONTAINERS))
def test_every_container_declares_its_child_slots(node_type):
    """THE RULE, AS A FAILING BUILD RATHER THAN A COMMENT."""
    assert node_type in C.CHILD_SLOTS, (
        f"'{node_type}' holds nodes in {_holds_nodes(CONTAINERS[node_type])} but "
        f"declares no entry in contract.CHILD_SLOTS. Every traversal reads that "
        f"declaration, so its children would be invisible to all_nodes(), the "
        f"authoring checks, the canvas and the edge generator at once."
    )


@pytest.mark.parametrize("node_type", sorted(CONTAINERS))
def test_declared_slots_name_real_fields(node_type):
    """A slot pointing at a field that does not exist walks nothing, silently."""
    model = CONTAINERS[node_type]
    for field, kind in C.CHILD_SLOTS[node_type]:
        assert field in model.model_fields, (
            f"CHILD_SLOTS['{node_type}'] names '{field}', which {model.__name__} "
            f"does not have"
        )
        assert kind in ("nodes", "groups"), f"unknown slot kind {kind!r}"


@pytest.mark.parametrize("node_type", sorted(CONTAINERS))
def test_slots_cover_every_child_bearing_field(node_type):
    """Declaring SOME of a container's lanes is the coordinate bug again.

    `switch` keeps children in `cases` and in `fallback`; declaring only `cases`
    would lose the fallback lane exactly the way `coordinate` lost its specialists.
    """
    declared = {field for field, _ in C.CHILD_SLOTS[node_type]}
    actual = set(_holds_nodes(CONTAINERS[node_type]))
    missing = actual - declared
    assert not missing, (
        f"'{node_type}' holds nodes in {sorted(missing)} and does not declare them"
    )


def test_child_node_lists_walks_a_coordinator_lane():
    """The historical bug, at the function every traversal now uses."""
    flow = C.Flow.model_validate({
        "key": "kiem_thu_lane", "name": "Kiểm thử lane",
        "nodes": [
            {
                "key": "dieu_phoi", "type": "coordinate", "name": "Điều phối",
                "specialists": [
                    {"key": "so_lieu", "name": "CG số liệu",
                     "when": "câu hỏi hỏi một CON SỐ cụ thể trên báo cáo",
                     "body": [{"key": "trong_lane", "type": "set_var",
                               "var": "x", "value": "1"}]},
                    # Two, because a coordinator with one specialist is refused —
                    # "gọi thẳng nó rẻ hơn".
                    {"key": "dinh_nghia", "name": "CG định nghĩa",
                     "when": "câu hỏi hỏi một chỉ số NGHĨA LÀ GÌ hoặc tính thế nào",
                     "body": [{"key": "lane_hai", "type": "set_var",
                               "var": "z", "value": "3"}]},
                ],
                "fallback": [{"key": "du_phong", "type": "set_var",
                              "var": "y", "value": "2"}],
            },
            {"key": "answer", "type": "agent", "name": "Trả lời", "prompt": "x"},
        ],
        "answer_node": "answer",
    })

    keys = [n.key for n in flow.all_nodes()]

    # The node inside the lane, and the fallback, are both the flow's own nodes.
    assert "trong_lane" in keys, (
        "a specialist's lane is invisible to all_nodes() — this is the exact bug "
        "that answered a category question with the report's grand total"
    )
    assert "lane_hai" in keys, "only the first specialist's lane was walked"
    assert "du_phong" in keys, "the coordinator's fallback lane is not walked"
    assert keys.count("trong_lane") == 1, "a lane was walked twice"

    # And the grouping survives, which is what the canvas and the edge generator
    # need: three lists — two specialist lanes and the fallback.
    groups = C.child_node_lists(flow.nodes[0])
    assert len(groups) == 3, [[n.key for n in g] for g in groups]


def test_a_leaf_node_declares_nothing():
    """The control. Without it a walker that returned everything would pass above."""
    assert "agent" not in C.CHILD_SLOTS
    assert "filter" not in C.CHILD_SLOTS, (
        "`filter` is structural because it has no handler, not because it holds "
        "nodes — conflating those two is what the first guard got wrong"
    )
    leaf = C.Flow.model_validate({
        "key": "la", "name": "Lá",
        "nodes": [{"key": "a", "type": "agent", "name": "x", "prompt": "p"}],
        "answer_node": "a",
    })
    assert C.child_node_lists(leaf.nodes[0]) == []


def test_the_registry_serves_slots_to_the_builder():
    """The frontend walkers read this; if it stops being served they re-derive."""
    from app.services.agent_flows.runtime.nodes import catalogue

    by_type = {n["type"]: n for n in catalogue()}
    for node_type in CONTAINERS:
        served = by_type[node_type]["child_slots"]
        assert served, f"/nodes serves no child_slots for '{node_type}'"
        assert {s["field"] for s in served} == {
            f for f, _ in C.CHILD_SLOTS[node_type]
        }
    assert by_type["agent"]["child_slots"] == [], "a leaf type should serve no slots"
