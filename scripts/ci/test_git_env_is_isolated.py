"""Running the safety-system tests from inside a git hook must not touch the real repo.

Reproduces the 2026-09-28 incident: the pre-push hook ran these tests with GIT_DIR
inherited, and the tests' throwaway `git init` / `git commit` / `git config`
landed in the real repository (branch deleted, core.bare=true, user.name=t).

The check is end to end: a SENTINEL repository stands in for the real one, GIT_DIR
points at it exactly as a hook would, and the test that did the damage is run in a
child pytest. The sentinel's refs, HEAD and config must come out byte-identical.
"""
import os
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]


def _git(cwd, *args):
    env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
    return subprocess.run(["git", *args], cwd=str(cwd), capture_output=True, text=True, env=env)


def _fingerprint(git_dir: Path) -> dict:
    refs = _git(git_dir.parent, "--git-dir", str(git_dir), "for-each-ref",
                "--format=%(refname) %(objectname)").stdout
    return {"refs": refs, "head": (git_dir / "HEAD").read_text(), "config": (git_dir / "config").read_text()}


def test_a_hooks_git_dir_does_not_reach_the_tests(tmp_path):
    sentinel = tmp_path / "sentinel"
    sentinel.mkdir()
    _git(sentinel, "init", "-q")
    (sentinel / "keep.txt").write_text("keep\n")
    _git(sentinel, "add", "keep.txt")
    _git(sentinel, "-c", "user.email=s@s", "-c", "user.name=sentinel", "commit", "-qm", "sentinel")
    git_dir = sentinel / ".git"
    before = _fingerprint(git_dir)

    env = {**os.environ, "GIT_DIR": str(git_dir)}          # exactly what a hook exports
    # The two modules that failed — and wrote into the real repository — in the incident.
    targets = ["scripts/ci/test_agent_sdlc.py", "scripts/ci/test_guardrail_diff_range.py"]
    subprocess.run([sys.executable, "-m", "pytest", "-q", "-p", "no:cacheprovider", *targets],
                   cwd=str(REPO_ROOT), capture_output=True, text=True, env=env, timeout=600)

    after = _fingerprint(git_dir)
    assert after == before, (
        "a safety-system test wrote into the repository named by the inherited GIT_DIR — "
        "run from the pre-push hook, that repository is the real one")


def test_the_gate_scripts_unset_the_hook_environment_before_anything_runs():
    for script in (".githooks/pre-push", "scripts/ci/preflight.sh"):
        text = (REPO_ROOT / script).read_text(encoding="utf-8")
        assert "unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE" in text, script
        assert text.index("unset GIT_DIR") < text.index("pytest") if "pytest" in text else True, script
