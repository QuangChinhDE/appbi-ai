# -*- coding: utf-8 -*-
"""`run.sh` must report the commit it actually builds — including after `--pull`.

THE BUG THIS LOCKS.

`run.sh` resolved `GIT_SHA` from `git rev-parse HEAD` and exported it, and only
THEN ran the optional `--pull` fast-forward. So with the checkout at A and
origin at B:

    ./run.sh --pull      builds and serves B,  exports GIT_SHA=A

and because an explicit runtime `GIT_SHA` outranks the image's baked
`APPBI_BUILD_SHA`, `/api/v1/health` reported A for a service running B. That
is the one lie a deployment identity cannot be allowed to tell: rollback,
support and Live Agent Eval provenance all start from it.

WHY THESE TESTS RUN THE REAL SCRIPT.

The defect is an ORDERING, and a unit test of a helper cannot see ordering. So
each case builds a throwaway origin + checkout, puts a stub `docker` first on
PATH that records the environment it was invoked with, and runs the repository's
actual `run.sh`. The stub's record of `GIT_SHA` at `compose up` time is the
value the service would have been started with.
"""
from __future__ import annotations

import os
import pathlib
import shutil
import subprocess

import pytest

REPO = pathlib.Path(__file__).resolve().parents[2]
RUN_SH = REPO / "run.sh"

BASH = shutil.which("bash")
pytestmark = pytest.mark.skipif(BASH is None, reason="needs bash to execute run.sh")

STUB_DOCKER = r"""#!/usr/bin/env bash
# Records what `run.sh` would have started the stack with, and does nothing else.
case "$*" in
  *"--version"*) echo "Docker version 99.0.0, build stub"; exit 0;;
  "compose version"*) exit 0;;
  "info"*) exit 0;;
  "volume ls"*) exit 0;;
esac
if [[ "$*" == *" up "* || "$*" == *" up" ]]; then
  printf '%s|%s\n' "${GIT_SHA:-}" "$*" >> "$STUB_LOG"
fi
exit 0
"""


def _git(cwd: pathlib.Path, *args: str) -> str:
    out = subprocess.run(["git", "-C", str(cwd), *args], capture_output=True, text=True)
    assert out.returncode == 0, f"git {' '.join(args)}: {out.stderr}"
    return out.stdout.strip()


def _commit(repo: pathlib.Path, name: str) -> str:
    (repo / f"{name}.txt").write_text(name, encoding="utf-8")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", name)
    return _git(repo, "rev-parse", "HEAD")


@pytest.fixture()
def world(tmp_path: pathlib.Path):
    """origin (bare) + `work` checkout at commit A, with the real run.sh in it."""
    origin = tmp_path / "origin.git"
    _git(tmp_path, "init", "-q", "--bare", "-b", "main", str(origin))
    work = tmp_path / "work"
    _git(tmp_path, "clone", "-q", str(origin), str(work))
    for repo in (work,):
        _git(repo, "config", "user.email", "t@t")
        _git(repo, "config", "user.name", "t")
        _git(repo, "checkout", "-q", "-b", "main")

    shutil.copy(RUN_SH, work / "run.sh")
    (work / "scripts").mkdir()
    (work / "scripts" / "bootstrap-env.sh").write_text("exit 0\n", encoding="utf-8")
    a = _commit(work, "A")
    _git(work, "push", "-q", "origin", "main")

    stub = tmp_path / "stub"
    stub.mkdir()
    (stub / "docker").write_text(STUB_DOCKER, encoding="utf-8", newline="\n")
    (stub / "docker").chmod(0o755)
    return {"tmp": tmp_path, "origin": origin, "work": work, "stub": stub, "A": a}


def _advance_origin(world) -> str:
    """Somebody else pushes B to origin while `work` still sits at A."""
    other = world["tmp"] / "other"
    _git(world["tmp"], "clone", "-q", str(world["origin"]), str(other))
    _git(other, "config", "user.email", "t@t")
    _git(other, "config", "user.name", "t")
    b = _commit(other, "B")
    _git(other, "push", "-q", "origin", "main")
    return b


def _run(world, *flags: str, env_extra: dict | None = None) -> str:
    log = world["tmp"] / "docker.log"
    log.unlink(missing_ok=True)
    env = dict(os.environ)
    env.pop("GIT_SHA", None)
    env["PATH"] = str(world["stub"]) + os.pathsep + env["PATH"]
    env["STUB_LOG"] = str(log)
    env.update(env_extra or {})
    out = subprocess.run([BASH, "run.sh", "--skip-validate", *flags], cwd=world["work"],
                         capture_output=True, text=True, env=env, timeout=120)
    assert out.returncode == 0, f"run.sh failed:\n{out.stdout[-800:]}\n{out.stderr[-800:]}"
    assert log.exists(), f"run.sh never reached `compose up`:\n{out.stdout[-800:]}"
    return log.read_text(encoding="utf-8").strip().splitlines()[-1].split("|", 1)[0]


def test_without_pull_the_identity_is_the_checkout(world):
    assert _run(world) == world["A"]


def test_after_pull_the_identity_is_the_commit_that_was_pulled(world):
    """The regression. Old ordering exported A and then built B."""
    b = _advance_origin(world)
    served = _run(world, "--pull")
    assert _git(world["work"], "rev-parse", "HEAD") == b, "the pull did not happen"
    assert served == b, (
        f"run.sh started the stack with GIT_SHA={served[:12]} after fast-forwarding "
        f"to {b[:12]}: /api/v1/health would name a commit that is not running"
    )


def test_an_explicit_external_identity_is_never_replaced(world):
    """Deployment infrastructure knows its artifact better than this script."""
    _advance_origin(world)
    external = "e" * 40
    assert _run(world, "--pull", env_extra={"GIT_SHA": external}) == external


def test_a_dirty_tree_reports_the_commit_it_is_based_on(world):
    (world["work"] / "A.txt").write_text("edited, not committed", encoding="utf-8")
    assert _run(world) == world["A"]


def test_a_pull_that_cannot_fast_forward_reports_the_code_actually_served(world):
    """Diverged: run.sh continues with the local code, so it must claim the local
    commit — not origin's, which is not what gets built."""
    _advance_origin(world)
    c = _commit(world["work"], "C-local-only")
    served = _run(world, "--pull")
    assert _git(world["work"], "rev-parse", "HEAD") == c
    assert served == c


def test_no_build_does_not_claim_the_checkout_for_an_image_it_did_not_build(world):
    """`--no-build` starts whatever image already exists, which may predate HEAD.

    Exporting HEAD would override that image's own baked `APPBI_BUILD_SHA` and
    name a commit the running code may not be. Saying nothing lets the image
    answer for itself.
    """
    assert _run(world, "--no-build") == ""
