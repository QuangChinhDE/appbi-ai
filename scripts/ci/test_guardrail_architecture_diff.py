# -*- coding: utf-8 -*-
"""The architecture check judges what a change ADDS — and still catches it.

Two false blocks, both seen on PR #6:

1. An EMPTY added-import list fell back to scanning the whole file
   (`imports.get(f) or extract_imports(f)` — `[]` is falsy). A PR that added
   one field to `schemas.py` was blocked for an import that file has carried
   since 2026-08-06 and the PR did not touch.
2. `backend/alembic/**` is a blocking glob that no layer described, so every
   new migration blocked the server gate as UNKNOWN.

The fixes must not open a hole, so the tests pin both directions: a NEW
violating import is still caught, a file the diff map does not mention is still
scanned whole, a migration is classified AND still requires the chain check,
and a genuinely unclassified runtime path still blocks.
"""
from __future__ import annotations

import pathlib
import sys

REPO = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "scripts" / "guardrail"))

import guardrail_core as core  # noqa: E402


def _diff(path: str, added: list[str]) -> str:
    body = "\n".join(f"+{line}" for line in added)
    return (
        f"diff --git a/{path} b/{path}\n--- a/{path}\n+++ b/{path}\n"
        f"@@ -1,0 +1,{len(added)} @@\n{body}\n"
    )


def _arch(result: dict) -> dict:
    return result.get("architecture") or {}


def test_a_new_violating_import_is_still_caught():
    diff = _diff("backend/app/schemas/schemas.py", ["from app.services.chart_service import ChartService"])
    arch = _arch(core.validate_patch(diff))
    assert arch.get("verdict") == "block", arch
    assert any(v["import"].startswith("app.services") for v in arch["violations"])


def test_an_old_import_in_a_touched_file_is_not_charged_to_the_change():
    # schemas.py really does import a service already (a pre-existing debt).
    source = (REPO / "backend/app/schemas/schemas.py").read_text(encoding="utf-8")
    assert "app.services" in source, "precondition: the old import this test is about is gone"
    diff = _diff("backend/app/schemas/schemas.py", ["    # a comment, no import"])
    arch = _arch(core.validate_patch(diff))
    assert not arch.get("violations"), arch


def test_a_file_the_diff_map_does_not_mention_is_still_scanned_whole():
    result = core.check_architecture_violation(["backend/app/schemas/schemas.py"], None)
    assert result["violations"], "without a diff map the whole file must be judged"


def test_a_migration_is_classified_and_still_requires_the_chain_check():
    layer = core.classify_file("backend/alembic/versions/20990101_0001_example.py")
    assert layer and layer["id"] == "migrations"
    tests = core.get_required_tests(["backend/alembic/versions/20990101_0001_example.py"])
    names = {t if isinstance(t, str) else t.get("id") for t in (tests.get("tests") or tests.get("required") or [])} \
        if isinstance(tests, dict) else set(tests)
    flat = str(tests)
    assert "alembic_chain" in names or "alembic_chain" in flat, tests


def _server_gate():
    import importlib.util
    spec = importlib.util.spec_from_file_location("guardrail_check", REPO / "scripts" / "ci" / "guardrail_check.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_an_unclassified_runtime_path_still_blocks_the_server_gate():
    # The server gate blocks UNKNOWN on a blocking path through
    # risky_unknown_files — the function change-guardrail.yml's verdict uses.
    path = "backend/app/zz_unclassified_module_for_test/handler.py"
    assert core.classify_file(path) is None, "precondition: this path must be unclassified"
    gate = _server_gate()
    assert gate.risky_unknown_files(core, _diff(path, ["x = 1"])) == [path]
    # …and a migration is no longer UNKNOWN, because a layer now claims it.
    mig = "backend/alembic/versions/20990101_0001_example.py"
    assert gate.risky_unknown_files(core, _diff(mig, ["revision = 'x'"])) == []
