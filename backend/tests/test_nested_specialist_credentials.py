# -*- coding: utf-8 -*-
"""A credential nested in a coordinator is exactly as sensitive as a top-level one.

REPRODUCED DEFECT (P0, security). `_redact_credentials`, `_carry_credentials` and
`_walk_raw` each walked `body`, `fallback`, `paths` and `cases` — and none of them
walked `specialists[].body`. So for

    Coordinate -> Specialist -> Agent(api_key)

the API EMITTED the stored ciphertext, the save path never carried the credential
forward (every ordinary edit wiped it), `api_key_clear` did nothing, and the node
was invisible to every raw-tree count and key scan.

INVARIANT: there is ONE raw-tree traversal and it is shape-driven, so a lane a
future container type introduces is walked without anyone remembering to add it.
"""
from app.services.agent_flows.registry import _redact_credentials, _walk_raw


def agent(key, **kw):
    return {"type": "agent", "key": key, "name": key, "prompt": "p",
            "output_var": key, **kw}


def body_with_nested_secret():
    """Coordinate -> Specialist -> Agent holding a stored credential."""
    return {"nodes": [{
        "type": "coordinate", "key": "coord", "name": "coord", "prompt": "p",
        "api_key_enc": "_enc:COORDINATOR_OWN_SECRET",
        "specialists": [
            {"key": "sp1", "name": "sp1", "when": "khi hỏi doanh thu",
             "body": [agent("nested", api_key_enc="_enc:NESTED_SECRET")]},
            {"key": "sp2", "name": "sp2", "when": "khi hỏi tài liệu", "body": []},
        ],
        "fallback": [agent("fb", api_key_enc="_enc:FALLBACK_SECRET")],
    }]}


def blob(x):
    return repr(x)


# ── the leak ─────────────────────────────────────────────────────────────────

def test_a_nested_specialist_credential_is_never_emitted():
    out = _redact_credentials(body_with_nested_secret())
    assert "NESTED_SECRET" not in blob(out), (
        "ciphertext from inside specialists[].body reached the API payload"
    )


def test_a_coordinate_fallback_credential_is_never_emitted():
    out = _redact_credentials(body_with_nested_secret())
    assert "FALLBACK_SECRET" not in blob(out)


def test_the_coordinators_own_credential_is_never_emitted():
    out = _redact_credentials(body_with_nested_secret())
    assert "COORDINATOR_OWN_SECRET" not in blob(out)


def test_no_credential_field_survives_anywhere_in_the_tree():
    out = _redact_credentials(body_with_nested_secret())
    text = blob(out)
    for field in ("api_key_enc", "api_key_clear", "'api_key'"):
        assert field not in text, f"{field} survived redaction"


def test_the_nested_node_still_reports_that_it_has_a_key():
    """Redaction must not also hide that a credential EXISTS — the builder shows
    "đã lưu" from this flag, and losing it looks like the key was deleted."""
    out = _redact_credentials(body_with_nested_secret())
    nested = [n for n in _walk_raw(out["nodes"]) if n.get("key") == "nested"]
    assert nested, "the nested agent was not even present in the redacted body"
    assert nested[0].get("has_api_key") is True


# ── the walker every other guard is built on ─────────────────────────────────

def test_walk_raw_sees_nodes_inside_a_specialist():
    keys = {n.get("key") for n in _walk_raw(body_with_nested_secret()["nodes"])}
    assert {"coord", "nested", "fb"} <= keys, f"walker missed nodes: {keys}"


def test_walk_raw_still_sees_the_older_container_lanes():
    raw = [{
        "type": "switch", "key": "sw", "name": "sw", "value": "{{x}}",
        "cases": [{"key": "c1", "name": "c1", "equals": "1",
                   "body": [agent("in_case")]}],
        "fallback": [agent("in_fallback")],
    }, {
        "type": "if", "key": "iff", "name": "iff",
        "paths": [{"key": "p1", "name": "p1", "kind": "always",
                   "body": [agent("in_path")]}],
    }, {
        "type": "loop", "key": "lp", "name": "lp", "over": "{{x}}",
        "item_var": "i", "body": [agent("in_loop")],
    }]
    keys = {n.get("key") for n in _walk_raw(raw)}
    assert {"in_case", "in_fallback", "in_path", "in_loop"} <= keys


def test_the_walker_does_not_mistake_non_nodes_for_nodes():
    """Shape-driven traversal must not sweep up conditions, measures, or any other
    list of dicts that merely lives on a node."""
    raw = [{
        "type": "if", "key": "iff", "name": "iff",
        "paths": [{"key": "p1", "name": "p1", "kind": "rules",
                   "conditions": [{"left": "{{a}}", "op": "eq", "right": "1"}],
                   "body": [agent("real")]},
                  {"key": "p2", "name": "p2", "kind": "fallback", "body": []}],
    }]
    keys = {n.get("key") for n in _walk_raw(raw)}
    assert keys == {"iff", "real"}, f"walker picked up a non-node: {keys}"
