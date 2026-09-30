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

WHAT CHANGED (stored AI keys). A step no longer holds a key at all: it holds a
`credential_id` reference to an encrypted `AiProviderCredential` row. The same
invariant is now asserted on the new mechanism — a legacy per-step key anywhere in
the tree is dropped on read (so it can never be emitted), and every pass over a
step's `credential_id` (export strip, carry-forward on save, usage) reaches the
nested lanes too. The former `_redact_credentials` is gone: there is nothing left
in a body to redact.
"""
from app.services.agent_flows.contract import upgrade_body
from app.services.agent_flows.credentials import (
    _model_nodes_raw,
    apply_assignments,
    strip_assignments,
)
from app.services.agent_flows.registry import _walk_raw


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


# ── the leak: a legacy per-step key is never emitted, at any depth ───────────

def test_a_nested_specialist_credential_is_never_emitted():
    out = upgrade_body(body_with_nested_secret())
    assert "NESTED_SECRET" not in blob(out), (
        "ciphertext from inside specialists[].body reached the API payload"
    )


def test_a_coordinate_fallback_credential_is_never_emitted():
    out = upgrade_body(body_with_nested_secret())
    assert "FALLBACK_SECRET" not in blob(out)


def test_the_coordinators_own_credential_is_never_emitted():
    out = upgrade_body(body_with_nested_secret())
    assert "COORDINATOR_OWN_SECRET" not in blob(out)


def test_no_credential_field_survives_anywhere_in_the_tree():
    out = upgrade_body(body_with_nested_secret())
    text = blob(out)
    for field in ("api_key_enc", "api_key_clear", "'api_key'", "has_api_key"):
        assert field not in text, f"{field} survived the upgrade"


# ── the reference: every pass over credential_id reaches nested lanes ───────

def body_with_nested_refs():
    """Coordinate (own key) -> Specialist -> Agent (key), plus a fallback Agent."""
    return {"nodes": [{
        "type": "coordinate", "key": "coord", "name": "coord", "prompt": "p",
        "provider": "openai", "model": "gpt-4o-mini",
        "credential_id": 11, "credential_granted_by": "owner@x",
        "specialists": [
            {"key": "sp1", "name": "sp1", "when": "khi hỏi doanh thu",
             "body": [agent("nested", provider="openai", model="gpt-4o-mini",
                            credential_id=12, credential_granted_by="owner@x")]},
            {"key": "sp2", "name": "sp2", "when": "khi hỏi tài liệu", "body": []},
        ],
        "fallback": [agent("fb", provider="openai", model="gpt-4o-mini",
                           credential_id=13, credential_granted_by="owner@x")],
    }]}


def test_every_model_step_is_found_inside_specialists_and_fallback():
    keys = {n.get("key") for n in _model_nodes_raw(body_with_nested_refs()["nodes"])}
    assert keys == {"coord", "nested", "fb"}, keys


def test_export_strips_the_key_reference_at_every_depth():
    out = strip_assignments(body_with_nested_refs())
    for n in _model_nodes_raw(out["nodes"]):
        assert n.get("credential_id") is None, n.get("key")
        assert "credential_granted_by" not in n, n.get("key")


def test_an_unchanged_nested_key_is_carried_with_its_grantor():
    """An ordinary save of a co-edited flow must not drop, or re-attribute, the key
    on a step inside a specialist — the old flat pass never reached it at all."""
    prior = body_with_nested_refs()
    sent = body_with_nested_refs()
    # A client may send any grantor; the server ignores it for an unchanged id.
    for n in _model_nodes_raw(sent["nodes"]):
        n["credential_granted_by"] = "attacker@x"

    class _NoDb:
        def query(self, *a, **k):
            return self

        def filter(self, *a, **k):
            return self

        def first(self):
            from types import SimpleNamespace
            return SimpleNamespace(provider="openai", deleted_at=None, name="k")

    out = apply_assignments(_NoDb(), SimpleUser(), prior_body=prior, body=sent)
    got = {n["key"]: (n["credential_id"], n["credential_granted_by"])
           for n in _model_nodes_raw(out["nodes"])}
    assert got == {"coord": (11, "owner@x"), "nested": (12, "owner@x"), "fb": (13, "owner@x")}


class SimpleUser:
    id = "u1"
    email = "editor@x"


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
