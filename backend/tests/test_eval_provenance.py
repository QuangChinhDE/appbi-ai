# -*- coding: utf-8 -*-
"""A verdict has to belong to the commit it names.

THE BUG THIS LOCKS.

The live-eval workflow checked out SHA X and wrote `commit_sha = X`. Every model
call went to `EVAL_API_URL`, a deployment that may be serving SHA Y. The artifact
then said "evaluated X" about a run that never touched X.

That is worse than having no nightly. A green run becomes evidence for a commit
nobody exercised, and — the expensive direction — a red one gets read as a
product regression in X when the truth is that Y was deployed and X was never
tested at all.

FOUR OUTCOMES, AND ONLY ONE OF THEM IS A PRODUCT SIGNAL.

    verified    a commit was requested and the deployment is running it
    deployed    nothing specific was requested; the nightly measures whatever is
                deployed, and the DEPLOYMENT sha is the tested sha
    unknown     the deployment will not say, so scenarios still score but the
                run attributes to nothing
    mismatch    a commit was requested and a different one is serving

A mismatch must never be reported as a semantic FAIL. The product under test is
not the artifact that was asked about, so its answers say nothing about that
artifact in either direction. It is an EVAL TARGET failure.

WHY `unknown` IS NOT A FAILURE. `/api/v1/health` reports `git_sha` from the build
environment and answers `"unknown"` when the deployment does not populate it,
which is every deployment today — `docker-compose.yml` only started passing
`GIT_SHA` in this change. A nightly that refuses to run until every environment
is re-plumbed would just be switched off. It runs, scores, and declines to
attribute.
"""
from __future__ import annotations

import importlib.util
import pathlib

import pytest

_PATH = pathlib.Path(__file__).resolve().parents[1] / "scripts" / "agent_flow_eval.py"


@pytest.fixture(scope="module")
def E():
    spec = importlib.util.spec_from_file_location("agent_flow_eval", _PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


SHA_X = "a" * 40
SHA_Y = "b" * 40


def _probe(E, monkeypatch, body):
    """Drive `deployment_identity()` against a stubbed health response."""
    import json

    class _Resp:
        def __init__(self, payload):
            self._b = json.dumps(payload).encode()

        def read(self):
            return self._b

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    monkeypatch.setattr(E.U, "urlopen", lambda url, timeout=0: _Resp(body))
    return E.deployment_identity()

def _deployed(sha, *, reachable=True, error=None):
    return {"reachable": reachable, "sha": sha, "code_version": "v1", "error": error}


def test_a_requested_commit_that_is_actually_deployed_is_verified(E):
    p = E.provenance(SHA_X, _deployed(SHA_X))
    assert p["state"] == "verified"
    assert p["attributable_to"] == SHA_X


def test_a_short_ref_still_matches_the_full_deployment_sha(E):
    """CI hands a 40-char SHA; a person dispatching by hand types seven."""
    p = E.provenance(SHA_X[:7], _deployed(SHA_X))
    assert p["state"] == "verified"


def test_a_mismatch_is_a_target_failure_and_not_a_product_failure(E):
    p = E.provenance(SHA_X, _deployed(SHA_Y))
    assert p["state"] == "mismatch"
    assert p["attributable_to"] == SHA_Y, (
        "the run still happened against Y; it simply is not evidence about X"
    )
    assert SHA_X[:12] in p["reason"] and SHA_Y[:12] in p["reason"]


def test_no_requested_commit_means_the_deployment_sha_is_the_tested_sha(E):
    """The nightly mode. `github.sha` must NOT replace what is deployed."""
    p = E.provenance(None, _deployed(SHA_Y))
    assert p["state"] == "deployed"
    assert p["attributable_to"] == SHA_Y
    p2 = E.provenance("", _deployed(SHA_Y))
    assert p2["state"] == "deployed"


def test_a_deployment_that_will_not_say_attributes_to_nothing(E):
    p = E.provenance(SHA_X, _deployed(None))
    assert p["state"] == "unknown"
    assert p["attributable_to"] is None
    assert "git_sha" in p["reason"]


def test_an_unreachable_health_endpoint_is_reported_as_unknown_not_as_a_match(E):
    p = E.provenance(SHA_X, _deployed(None, reachable=False, error="URLError"))
    assert p["state"] == "unknown"
    assert p["attributable_to"] is None
    assert "unreachable" in p["reason"]


def test_the_literal_string_unknown_is_not_a_commit(E, monkeypatch):
    """`/api/v1/health` answers "unknown" when nothing set GIT_SHA.

    This used to end in a clause that made the assertion unfailable. It now
    drives the real probe against a stubbed health response, so a regression
    that lets the literal string through to a comparison turns red here.
    """
    dep = _probe(E, monkeypatch, {"status": "healthy", "git_sha": "unknown",
                                  "code_version": "v1"})
    assert dep["reachable"] is True
    assert dep["sha"] is None, "the literal unknown survived as a commit"

    p = E.provenance(SHA_X, dep)
    assert p["state"] == "unknown"
    assert p["attributable_to"] is None


def test_a_blank_git_sha_is_also_absent(E, monkeypatch):
    assert _probe(E, monkeypatch, {"git_sha": "   "})["sha"] is None


def test_a_real_git_sha_is_carried_through(E, monkeypatch):
    """The positive control: without it the two above pass on a broken probe."""
    dep = _probe(E, monkeypatch, {"git_sha": SHA_Y, "code_version": "v2"})
    assert dep["sha"] == SHA_Y
    assert dep["code_version"] == "v2"
    assert E.provenance(SHA_Y, dep)["state"] == "verified"

def test_the_target_identity_carries_no_credential(E, monkeypatch):
    """`EVAL_API_URL` may carry userinfo, and the artifact is uploaded."""
    monkeypatch.setattr(E, "API", "https://user:secret@eval.example.com:8443/base")
    identity = E.target_identity()
    assert identity == "https://eval.example.com:8443"
    assert "secret" not in identity and "user" not in identity


def _run_main(E, monkeypatch, tmp_path, *, health, argv):
    """Run the harness end to end with a stubbed deployment.

    BEHAVIOURAL, not source inspection. The two tests this replaced read
    `inspect.getsource(main)` for field names and for the ORDER of two lines.
    Both would pass against a `main()` that had the right text and the wrong
    control flow, and one of them broke when a variable was renamed — proving it
    was pinning the prose rather than the behaviour.
    """
    import json as _json
    import sys

    calls = {"login": 0, "ask": 0}

    class _Resp:
        def __init__(self, payload):
            self._b = _json.dumps(payload).encode()

        def read(self):
            return self._b

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    def _urlopen(url, timeout=0, **kw):
        if health is None:
            raise OSError("unreachable")
        return _Resp(health)

    def _login():
        calls["login"] += 1
        return "token"

    def _ask(*a, **kw):
        calls["ask"] += 1
        return 200, {"envelope": {}}

    monkeypatch.setattr(E.U, "urlopen", _urlopen)
    monkeypatch.setattr(E, "login", _login)
    monkeypatch.setattr(E, "ask", _ask)
    out = tmp_path / "result.json"
    monkeypatch.setattr(sys, "argv", ["agent_flow_eval.py", "--out", str(out), *argv])
    code = E.main()
    payload = _json.loads(out.read_text(encoding="utf-8")) if out.exists() else None
    return code, payload, calls


def test_a_requested_ref_with_an_unknown_deployment_fails_before_any_model_call(
        E, monkeypatch, tmp_path):
    """`unknown` used to score the scenarios and warn. That is green-shaped."""
    code, payload, calls = _run_main(
        E, monkeypatch, tmp_path,
        health={"git_sha": "unknown"},
        argv=["--requested-ref", "HEAD", "--require-provenance"])
    assert code == 2
    assert calls["login"] == 0, "the harness logged in before settling provenance"
    assert calls["ask"] == 0, "a model call was spent on an unattributable run"
    assert payload["provenance"]["state"] == "unknown"
    assert payload["counts"]["total"] == 0


def test_a_requested_ref_with_an_unreachable_deployment_fails_before_any_model_call(
        E, monkeypatch, tmp_path):
    code, payload, calls = _run_main(
        E, monkeypatch, tmp_path,
        health=None,
        argv=["--requested-ref", "HEAD"])
    assert code == 2
    assert calls["login"] == 0 and calls["ask"] == 0
    assert payload["provenance"]["state"] == "unknown"


def test_a_mismatched_deployment_fails_before_any_model_call(
        E, monkeypatch, tmp_path):
    code, payload, calls = _run_main(
        E, monkeypatch, tmp_path,
        health={"git_sha": SHA_Y},
        argv=["--requested-sha", SHA_X])
    assert code == 2
    assert calls["login"] == 0 and calls["ask"] == 0
    assert payload["provenance"]["state"] == "mismatch"


def test_an_unresolvable_ref_is_not_treated_as_nightly_mode(
        E, monkeypatch, tmp_path):
    """Asking about a ref that does not exist must not silently become
    "measure whatever is deployed" — that answers a different question."""
    code, payload, calls = _run_main(
        E, monkeypatch, tmp_path,
        health={"git_sha": SHA_Y},
        argv=["--requested-ref", "no-such-ref-exists-here"])
    assert code == 2
    assert calls["login"] == 0
    assert payload["provenance"]["state"] == "unresolved"


def test_the_artifact_names_the_four_commits_separately(E, monkeypatch, tmp_path):
    _, payload, _ = _run_main(
        E, monkeypatch, tmp_path,
        health={"git_sha": SHA_Y},
        argv=["--requested-sha", SHA_X])
    for field in ("harness_sha", "requested_ref", "requested_sha_resolved",
                  "deployment_sha"):
        assert field in payload, field
    assert payload["requested_sha_resolved"] == SHA_X
    assert payload["deployment_sha"] == SHA_Y


def test_a_branch_name_resolves_instead_of_being_compared_as_a_string(E):
    """`ref = demo` used to be compared against a 40-char SHA and mismatch."""
    resolved = E.resolve_ref("HEAD")
    assert resolved and len(resolved) == 40
    assert E.provenance(resolved, _deployed(resolved),
                        requested_ref="HEAD")["state"] == "verified"


def test_a_short_sha_resolves_to_the_full_one(E):
    full = E.resolve_ref("HEAD")
    assert E.resolve_ref(full[:8]) == full



# ── the deployment side: nothing populated GIT_SHA ─────────────────────────

def _run_sh() -> str:
    return (pathlib.Path(__file__).resolve().parents[2] / "run.sh").read_text(encoding="utf-8")


def test_the_repo_launch_script_supplies_the_commit_it_is_serving():
    """`docker-compose.yml` forwards GIT_SHA; nothing set it.

    `run.ps1` is a thin wrapper that execs `run.sh`, so one place covers both.
    """
    src = _run_sh()
    assert "export GIT_SHA" in src
    assert "git rev-parse HEAD" in src


def test_an_externally_supplied_commit_wins():
    """Real deployment infrastructure knows the artifact better than this script."""
    import re
    src = _run_sh()
    guard = re.search(r"if \[ -z \"\$\{GIT_SHA:-\}\" \]", src)
    assert guard, "the script overwrites an externally supplied GIT_SHA"


def test_the_commit_is_not_derived_from_the_working_tree():
    """A dirty checkout reports the commit it is based on, which is true.

    Hashing local edits would produce an identifier that matches nothing and
    cannot be looked up.
    """
    src = _run_sh()
    for forbidden in ("git stash", "sha256sum", "git diff | ", "md5"):
        assert forbidden not in src, forbidden


def test_compose_forwards_it_to_the_backend():
    compose = (pathlib.Path(__file__).resolve().parents[2] / "docker-compose.yml")
    assert "GIT_SHA: ${GIT_SHA:-}" in compose.read_text(encoding="utf-8")
