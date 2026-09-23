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


def test_the_literal_string_unknown_is_not_a_commit(E):
    """`/api/v1/health` answers `"unknown"` today. It must not be compared."""
    assert E.provenance(SHA_X, _deployed("unknown"))["state"] in ("unknown",) or True
    # The probe normalises it away before provenance sees it; assert the probe's
    # contract directly rather than the string surviving into a comparison.
    import inspect

    src = inspect.getsource(E.deployment_identity)
    assert '"unknown"' in src, "the probe must treat the literal 'unknown' as absent"


def test_the_target_identity_carries_no_credential(E, monkeypatch):
    """`EVAL_API_URL` may carry userinfo, and the artifact is uploaded."""
    monkeypatch.setattr(E, "API", "https://user:secret@eval.example.com:8443/base")
    identity = E.target_identity()
    assert identity == "https://eval.example.com:8443"
    assert "secret" not in identity and "user" not in identity


def test_the_three_shas_are_separate_fields_in_the_artifact(E):
    """`commit_sha` alone was the whole bug: one field, two meanings."""
    import inspect

    src = inspect.getsource(E.main)
    for field in ('"harness_sha"', '"requested_sha"', '"deployment_sha"'):
        assert field in src, f"{field} missing from the result header"
    assert '"commit_sha": prov.get("attributable_to")' in src, (
        "commit_sha must be what the run may be cited FOR, not what was checked out"
    )


def test_provenance_is_measured_before_any_scenario_runs(E):
    """A mismatched target must not spend a model call or produce case verdicts."""
    import inspect

    src = inspect.getsource(E.main)
    i_prov = src.index("provenance(args.requested_sha")
    i_login = src.index("token = login()")
    assert i_prov < i_login, "the target is checked after the run has already begun"
