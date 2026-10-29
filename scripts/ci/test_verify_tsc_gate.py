"""The required `tsc` gate IS the tier's frontend typecheck (scripts/ci/verify.py).

It used to be reported UNVERIFIED ("covered by this tier's frontend typecheck") even
right after that typecheck passed, so every turn ended with a gate that had in fact
run. Its result is now the typecheck's result; a tier that did not run it runs it;
only a typecheck that could not run at all stays UNVERIFIED - never counted as passed.
"""
from __future__ import annotations

import importlib.util
import pathlib

_spec = importlib.util.spec_from_file_location("verify_under_test", pathlib.Path(__file__).with_name("verify.py"))
v = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(v)


class _Core:
    def get_required_tests(self, files):
        return {"required_tests": [{"id": "tsc"}]}

    def load_rules(self):
        return {"tests": {"tsc": {"status": "active", "run": "cd frontend && npx tsc --noEmit"}}}


def _run(typecheck, monkeypatch, ran=None):
    rep = v.Report()
    rep.typecheck = typecheck

    def fake_typecheck(r):
        if ran is not None:
            ran.append(1)
        r.typecheck = ("ok", "no type errors")

    monkeypatch.setattr(v, "frontend_typecheck", fake_typecheck)
    v.run_required_tests(_Core(), ["frontend/src/x.ts"], rep)
    return rep


def test_a_passed_typecheck_is_the_tsc_gate_passing(monkeypatch):
    rep = _run(("ok", "no type errors"), monkeypatch)
    assert rep.unverified == [] and any(p.startswith("tsc") for p in rep.passed)


def test_a_failed_typecheck_fails_the_tsc_gate(monkeypatch):
    rep = _run(("fail", "frontend type errors"), monkeypatch)
    assert any(f.startswith("tsc") for f in rep.failed) and rep.unverified == []


def test_a_tier_that_did_not_typecheck_runs_it_for_the_gate(monkeypatch):
    ran: list = []
    rep = _run(None, monkeypatch, ran)
    assert ran == [1] and any(p.startswith("tsc") for p in rep.passed)


def test_a_typecheck_that_could_not_run_stays_unverified(monkeypatch):
    rep = _run(("skip", "node not on PATH"), monkeypatch)
    assert rep.unverified == [("tsc", "node not on PATH")] and not rep.passed
