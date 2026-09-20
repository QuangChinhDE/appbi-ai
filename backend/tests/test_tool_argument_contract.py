# -*- coding: utf-8 -*-
"""Bad arguments, generated from each tool's OWN schema.

WHY GENERATED AND NOT WRITTEN
-----------------------------
The first draft of the test plan said "every tool called with no arguments must
return an error". Four tools would have had to be broken to satisfy it:
`inspect_filters` takes no arguments by design, `list_charts` browses the whole
report when given no query, and `describe_time_coverage` and
`resolve_chart_candidates` are the same shape. A blanket rule would have turned
four correct tools into failing ones so that a test could pass.

So the rule is per-tool and comes from the tool: whatever it declares `required`,
it must refuse when that is missing; whatever it declares optional, it must run
safely and BOUNDED when it is absent. The tool states its contract and the test is
generated from the statement — which also means tool #37 is covered on the day it
is merged.

WHAT "SAFELY AND BOUNDED" MEANS, and why it is not "returns ok"
--------------------------------------------------------------
`get_chart_data` with `top_n` omitted once returned every row of a chart — up to
~1,444,000 tokens in one call. It was `ok`. The bound is the property, not the
success.
"""
from __future__ import annotations

import os

import pytest

os.environ.setdefault("DATABASE_URL", "sqlite:///./test_tool_args.db")
os.environ.setdefault("DATA_DIR", ".testdata")

from app.services.agent_flows.tools.registry import all_tools, execute


def _schema(spec):
    d = spec.definition or {}
    return (d.get("input_schema") or d.get("parameters")
            or (d.get("function") or {}).get("parameters") or {})


def _required(spec) -> list[str]:
    return list(_schema(spec).get("required") or [])


def _props(spec) -> dict:
    return dict(_schema(spec).get("properties") or {})


ALL = sorted(all_tools().items())

#: (tool, missing argument) for every required argument of every tool.
MISSING_CASES = [
    (name, arg) for name, spec in ALL for arg in _required(spec)
]
#: Tools that legitimately require nothing.
FREE_TOOLS = [name for name, spec in ALL if not _required(spec)]

#: A value of the wrong type for each JSON type we declare.
WRONG_TYPE = {
    "integer": "not-a-number", "number": "not-a-number",
    "string": 12345, "boolean": "yes", "array": "not-a-list", "object": "not-an-object",
}


class _Ctx:
    """No dashboard, no capabilities withheld — so a refusal here is the
    argument check speaking, not a gate in front of it."""
    dashboard = None
    read_rows = True
    web_search = True


@pytest.mark.parametrize("name,arg", MISSING_CASES,
                         ids=[f"{n}-no-{a}" for n, a in MISSING_CASES])
def test_a_missing_required_argument_is_refused(name, arg):
    """Every other required argument is supplied, so the only thing wrong is the
    one this case removes."""
    spec = all_tools()[name]
    args = {a: _plausible(p) for a, p in _props(spec).items() if a in _required(spec)}
    args.pop(arg, None)

    out = execute(_Ctx(), name, args, use_cache=False)

    assert out["ok"] is False, f"{name} accepted a call with no {arg!r}"


def _plausible(prop: dict):
    t = prop.get("type")
    if t == "integer" or t == "number":
        return 1
    if t == "boolean":
        return True
    if t == "array":
        return []
    if t == "object":
        return {}
    enum = prop.get("enum")
    if enum:
        return enum[0]
    return "x"


#: Arguments that NAME A RESOURCE. These are the ones where a coercion is not
#: leniency but a different question: `chart_id="all"` read as chart 0 answers
#: about a chart nobody asked for, and possibly one outside the caller's scope.
RESOURCE_TYPE_CASES = [
    (name, arg, _props(spec)[arg].get("type"))
    for name, spec in ALL
    for arg in spec.resource_refs
    if arg in _required(spec) and _props(spec).get(arg, {}).get("type") in WRONG_TYPE
]

#: Every other required argument. Checked for a valid envelope, NOT for refusal.
OTHER_TYPE_CASES = [
    (name, arg, prop.get("type"))
    for name, spec in ALL
    for arg, prop in _props(spec).items()
    if arg in _required(spec) and prop.get("type") in WRONG_TYPE
    and arg not in spec.resource_refs
]


@pytest.mark.parametrize("name,arg,jtype", RESOURCE_TYPE_CASES,
                         ids=[f"{n}-{a}-as-{t}" for n, a, t in RESOURCE_TYPE_CASES])
def test_a_mistyped_RESOURCE_argument_is_refused(name, arg, jtype):
    """THE LINE THAT MATTERS, and it is drawn at governed resources rather than at
    types in general.

    A coerced search string is harmless leniency — `research_web` deliberately
    wraps a bare string into a one-element list, and demanding a refusal there
    would mean breaking a correct tool so a test could pass. A coerced RESOURCE
    id is a different matter: it selects something, and what it selects was not
    checked against the caller's scope by whoever wrote the coercion.
    """
    spec = all_tools()[name]
    args = {a: _plausible(p) for a, p in _props(spec).items() if a in _required(spec)}
    args[arg] = WRONG_TYPE[jtype]

    out = execute(_Ctx(), name, args, use_cache=False)

    assert out["ok"] is False, (
        f"{name} accepted {arg}={WRONG_TYPE[jtype]!r} for a governed resource"
    )
    assert "Traceback" not in str(out.get("error", ""))


@pytest.mark.parametrize("name,arg,jtype", OTHER_TYPE_CASES,
                         ids=[f"{n}-{a}-as-{t}" for n, a, t in OTHER_TYPE_CASES])
def test_a_mistyped_ordinary_argument_still_returns_the_contract(name, arg, jtype):
    """Leniency is allowed here — coercing is often the right answer — but the
    envelope is not. Whatever the body decides, the caller gets `ok` and never a
    traceback."""
    spec = all_tools()[name]
    args = {a: _plausible(p) for a, p in _props(spec).items() if a in _required(spec)}
    args[arg] = WRONG_TYPE[jtype]

    out = execute(_Ctx(), name, args, use_cache=False)

    assert isinstance(out, dict) and out.get("ok") in (True, False)
    assert "Traceback" not in str(out.get("error", ""))


@pytest.mark.parametrize("name", FREE_TOOLS)
def test_a_tool_that_requires_nothing_does_not_fail_on_nothing(name):
    """THE CASE THE BLANKET RULE WOULD HAVE BROKEN.

    These four are called with no arguments on purpose. They may fail for a real
    reason — no dashboard on this bare context — but never with an argument
    complaint, and never by raising.
    """
    out = execute(_Ctx(), name, {}, use_cache=False)

    assert isinstance(out, dict) and "ok" in out
    if not out["ok"]:
        assert out.get("error_code") != "invalid_arg", (
            f"{name} declares no required arguments and complained about one"
        )


@pytest.mark.parametrize("name,spec", ALL, ids=[n for n, _ in ALL])
def test_no_tool_ever_raises_at_the_registry_boundary(name, spec):
    """Whatever a body does with rubbish, `execute` returns the contract. A
    traceback handed to a model wastes context and occasionally gets quoted into
    the answer."""
    out = execute(_Ctx(), name, {"quackery": object()}, use_cache=False)

    assert isinstance(out, dict)
    assert out.get("ok") in (True, False)


def test_the_generated_suite_actually_covers_something():
    """A generator that silently produces zero cases is a green suite that tests
    nothing — the exact failure mode this file was written to avoid elsewhere."""
    assert len(MISSING_CASES) >= 20, f"only {len(MISSING_CASES)} missing-arg cases"
    assert len(RESOURCE_TYPE_CASES) >= 10, (
        f"only {len(RESOURCE_TYPE_CASES)} governed-resource type cases — if this "
        f"dropped, a tool stopped declaring resource_refs"
    )
    assert len(OTHER_TYPE_CASES) >= 3, f"only {len(OTHER_TYPE_CASES)} other type cases"
    assert len(FREE_TOOLS) >= 4, f"only {FREE_TOOLS} require nothing"
