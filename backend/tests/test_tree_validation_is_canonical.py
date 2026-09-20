# -*- coding: utf-8 -*-
"""One tree, one definition of "all descendants".

REPRODUCED DEFECT (P0). `contract.CHILD_SLOTS` / `child_node_lists()` were
introduced as the canonical topology and `all_nodes()` reads them — but
`Flow._sane_tree()` still branched by hand on IfNode / SwitchNode / LoopNode. A
CoordinateNode's `specialists[].body` was therefore invisible to validation:
nodes inside a coordinator escaped the node count, the duplicate-key check, the
depth limit and the in-loop run_policy restriction.

INVARIANT: child DISCOVERY comes from the canonical topology. Loop SEMANTICS
(entering sets in_loop, nested loops refused) stay explicit — they are behaviour,
not discovery.

The last test is the guard that matters: it derives the container list from
CHILD_SLOTS, so a container type added later without teaching the walkers fails
here instead of shipping a blind spot.
"""
import pytest

from app.services.agent_flows.contract import CHILD_SLOTS, Flow, MAX_NODES


def agent(key, **kw):
    return {"type": "agent", "key": key, "name": key, "prompt": "x",
            "output_var": key, **kw}


def specialist(key, body=None):
    return {"key": key, "name": key,
            "when": "khi câu hỏi nói về doanh thu theo tháng " + key,
            "body": body or []}


def coordinator(key="coord", inner=None, fallback=None):
    # Two specialists minimum: a coordinator choosing between one is refused by
    # the contract, and calling that one directly is cheaper anyway.
    return {"type": "coordinate", "key": key, "name": key, "prompt": "p",
            "specialists": [specialist("sp1_" + key, inner or []),
                            specialist("sp2_" + key)],
            "fallback": fallback or []}


def flow(nodes):
    return Flow(key="f", name="f", nodes=nodes)


# ── what escaped ─────────────────────────────────────────────────────────────

def test_duplicate_key_inside_a_specialist_is_caught():
    with pytest.raises(ValueError, match="trùng key"):
        flow([agent("a"), coordinator(inner=[agent("a")])])


def test_duplicate_key_inside_a_coordinate_fallback_is_caught():
    with pytest.raises(ValueError, match="trùng key"):
        flow([agent("a"), coordinator(inner=[], fallback=[agent("a")])])


def test_two_specialists_cannot_reuse_one_key():
    node = coordinator(inner=[agent("dup")])
    node["specialists"][1]["body"] = [agent("dup")]
    with pytest.raises(ValueError, match="trùng key"):
        flow([node])


def test_specialist_nodes_count_towards_the_node_ceiling():
    inner = [agent("n%d" % i) for i in range(MAX_NODES + 5)]
    with pytest.raises(ValueError, match="tối đa"):
        flow([coordinator(inner=inner)])


def test_a_coordinator_inside_a_loop_still_forbids_cross_turn_memory():
    """`run_policy` inside a Loop is incoherent — including two levels down."""
    inner = [agent("deep", run_policy="when_stale")]
    loop = {"type": "loop", "key": "lp", "name": "lp", "over": "{{items}}",
            "item_var": "it", "body": [coordinator(inner=inner)]}
    with pytest.raises(ValueError, match="nằm trong Loop"):
        flow([loop])


# ── loop semantics must survive the refactor ─────────────────────────────────

def test_nested_loop_is_still_refused():
    inner = {"type": "loop", "key": "l2", "name": "l2", "over": "{{x}}",
             "item_var": "j", "body": []}
    outer = {"type": "loop", "key": "l1", "name": "l1", "over": "{{y}}",
             "item_var": "i", "body": [inner]}
    with pytest.raises(ValueError, match="Loop lồng trong Loop"):
        flow([outer])


def test_a_loop_reached_through_a_coordinator_is_still_a_loop():
    """Discovery is generic; the in_loop flag must still propagate through it."""
    inner_loop = {"type": "loop", "key": "l2", "name": "l2", "over": "{{x}}",
                  "item_var": "j", "body": []}
    outer = {"type": "loop", "key": "l1", "name": "l1", "over": "{{y}}",
             "item_var": "i", "body": [coordinator(inner=[inner_loop])]}
    with pytest.raises(ValueError, match="Loop lồng trong Loop"):
        flow([outer])


def test_a_healthy_coordinator_flow_still_validates():
    f = flow([coordinator(inner=[agent("inner")]), agent("outer")])
    assert f.name == "f"


# ── the class: every declared container must be traversed ────────────────────

def test_every_container_in_the_canonical_table_is_seen_by_validation():
    """Derived from CHILD_SLOTS, so a new container type cannot be added without
    teaching validation about it."""
    builders = {
        "if": lambda body: {"type": "if", "key": "c", "name": "c",
                            "paths": [{"key": "p1", "name": "p1",
                                       "kind": "always", "body": body},
                                      {"key": "p2", "name": "p2",
                                       "kind": "fallback", "body": []}]},
        "switch": lambda body: {"type": "switch", "key": "c", "name": "c",
                                "value": "{{x}}",
                                "cases": [{"key": "k1", "name": "k1",
                                           "equals": "1", "body": body},
                                          {"key": "k2", "name": "k2",
                                           "equals": "2", "body": []}],
                                "fallback": []},
        "coordinate": lambda body: coordinator("c", inner=body),
        "loop": lambda body: {"type": "loop", "key": "c", "name": "c",
                              "over": "{{x}}", "item_var": "i", "body": body},
    }
    assert set(builders) == set(CHILD_SLOTS), (
        "CHILD_SLOTS changed — this test must cover every container type"
    )
    for kind, build in builders.items():
        with pytest.raises(ValueError, match="trùng key"):
            flow([agent("clash"), build([agent("clash")])])
