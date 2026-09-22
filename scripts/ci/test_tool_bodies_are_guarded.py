# -*- coding: utf-8 -*-
"""Every file that defines a registered tool must be owned by a guardrail feature.

WHAT WENT UNGUARDED, and for how long. `tools/packs/_source.py` is a deliberate
seam: the packs DECLARE what a tool is, while the BODY is still imported from
`app/services/dashboard_ai_bot/`. That package was never listed under any feature
in `guardrail_rules.yaml`, so:

    guardrail_check.py --files backend/app/services/dashboard_ai_bot/thinking/advanced_tools.py
      -> guardrail impact scope: ok
      -> (no features touched, no required tests)

Measured on all six analytical files. The file that produces every number the
product states could be edited with the guardrail reporting `ok` and naming no
gate at all — and `unknown` is not `safe`.

WHY THIS IS COMPUTED AND NOT A LIST. A list goes stale the first time a tool body
moves or a new pack imports from somewhere else, and it goes stale silently,
which is the failure mode it exists to prevent. So the corpus is derived from the
registry: every `ToolSpec.fn` knows the module it was defined in, and that module
knows its file. If a future tool body lands in an unclaimed file, this fails
naming the file and the tool.

It asserts OWNERSHIP, not which feature owns it — a body legitimately belonging to
another feature passes, because the requirement is that something is on the hook,
not that Agent Flow is.
"""
from __future__ import annotations

import importlib.util
import os
import pathlib
import sys

import pytest

REPO = pathlib.Path(__file__).resolve().parents[2]
BACKEND = REPO / "backend"
GUARDRAIL = REPO / "scripts" / "guardrail"


@pytest.fixture(scope="module")
def core():
    sys.path.insert(0, str(GUARDRAIL))
    spec = importlib.util.spec_from_file_location(
        "guardrail_core", GUARDRAIL / "guardrail_core.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="module")
def tool_body_files():
    """The real file behind every registered tool, from the real registry."""
    os.environ.setdefault("DATABASE_URL", "sqlite:///./_guard_probe.db")
    os.environ.setdefault("DATA_DIR", ".testdata")
    sys.path.insert(0, str(BACKEND))
    try:
        from app.services.agent_flows.tools.registry import all_tools
    except Exception as exc:                                    # noqa: BLE001
        pytest.skip(f"backend not importable here: {exc}")

    out: dict[str, set[str]] = {}
    for name, spec in all_tools().items():
        fn = getattr(spec, "fn", None)
        module = sys.modules.get(getattr(fn, "__module__", "") or "")
        path = getattr(module, "__file__", None)
        if not path:
            continue
        try:
            rel = pathlib.Path(path).resolve().relative_to(REPO).as_posix()
        except ValueError:
            continue                    # site-packages or outside the repo
        out.setdefault(rel, set()).add(name)
    if not out:
        pytest.skip("no tool bodies resolved — the registry did not import")
    return out


def test_the_registry_resolves_to_real_files(tool_body_files):
    """The control. If this returned nothing the assertions below would pass by
    having no corpus, which is the shape of a test that guards nothing."""
    assert len(tool_body_files) >= 3, tool_body_files
    assert sum(len(v) for v in tool_body_files.values()) >= 20


def test_every_tool_body_file_is_owned_by_a_feature(core, tool_body_files):
    orphans = []
    for rel, tools in sorted(tool_body_files.items()):
        features = core.get_impact_scope([rel]).get("features") or []
        if not features:
            orphans.append(f"{rel} — defines {', '.join(sorted(tools))}")
    assert not orphans, (
        "these files define registered tools and no guardrail feature claims "
        "them, so changing them reports `ok` with no required tests:\n  "
        + "\n  ".join(orphans)
    )


def test_every_tool_body_file_pulls_in_required_tests(core, tool_body_files):
    """Ownership without a gate is a label. Each body must resolve to at least
    one runnable test group."""
    bare = []
    for rel in sorted(tool_body_files):
        tests = core.get_required_tests([rel]).get("required_tests") or []
        if not tests:
            bare.append(rel)
    assert not bare, (
        "owned by a feature but requiring no test:\n  " + "\n  ".join(bare)
    )


def test_the_seam_itself_is_named(core):
    """The specific files the seam imports today, called out so a reviewer can
    see the boundary rather than infer it from a computed set."""
    seam = [
        "backend/app/services/dashboard_ai_bot/thinking/tools.py",
        "backend/app/services/dashboard_ai_bot/thinking/advanced_tools.py",
        "backend/app/services/dashboard_ai_bot/tool_context.py",
        "backend/app/services/dashboard_ai_bot/govern_tools.py",
        "backend/app/services/dashboard_ai_bot/verifier.py",
        "backend/app/services/dashboard_ai_bot/web_search.py",
    ]
    missing = [p for p in seam if not (REPO / p).exists()]
    assert not missing, f"the seam moved; update this list: {missing}"
    unowned = [p for p in seam if not (core.get_impact_scope([p]).get("features"))]
    assert not unowned, unowned


def test_runtime_support_is_deliberately_not_claimed(core):
    """The other half of "smallest correct set". Claiming the event dataclass or
    the LLM adapters would make Agent Flow the owner of code it only consumes,
    and a boundary that grows by default stops meaning anything."""
    events = "backend/app/services/dashboard_ai_bot/events.py"
    if not (REPO / events).exists():
        pytest.skip("events.py moved")
    features = core.get_impact_scope([events]).get("features") or []
    assert not features, (
        f"{events} is now claimed by {features}. That may be right — but it is a "
        "widening of the ownership boundary and should be a deliberate, "
        "documented change rather than a side effect."
    )
