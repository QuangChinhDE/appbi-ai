"""Meta-tests for the provider-neutral AI-SDLC layer.

These test the safety system, not the product. Happy paths are the least interesting
part: what matters is that the failure modes actually fail, and that an agent editing the
protection system cannot edit its way out of being checked.

The adversarial cases build a throwaway git repository, commit a `base`, commit a `head`
that weakens something, then check out BASE and run the BASE copy of the checker — which
is exactly what CI does. A PR that rewrites the checker never gets to run its own audit.

    python -m pytest scripts/ci/test_agent_sdlc.py -q
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
CI = REPO_ROOT / "scripts" / "ci"
GUARDRAIL = REPO_ROOT / "scripts" / "guardrail"

# The bootstrap commit carries the TRUSTED PROTECTION LAYER only: the agent-contract
# layer (AGENTS.md, the Claude adapter, check_agent_config.py) arrives in the PR that
# follows it. Those tests skip while it is absent and begin running on their own the
# moment it lands — no flag to remember to flip.
AGENT_CONTRACT_PRESENT = (REPO_ROOT / "AGENTS.md").exists() and (CI / "check_agent_config.py").exists()
needs_agent_contract = pytest.mark.skipif(
    not AGENT_CONTRACT_PRESENT,
    reason="agent-contract layer not present yet (bootstrap commit): trusted protection only",
)


def run(argv, cwd=REPO_ROOT, env=None, timeout=300):
    return subprocess.run([sys.executable, *argv], cwd=str(cwd), capture_output=True,
                          text=True, encoding="utf-8", errors="replace",
                          env={**os.environ, **(env or {})}, timeout=timeout)


def git(*args, cwd):
    return subprocess.run(["git", *args], cwd=str(cwd), capture_output=True, text=True,
                          encoding="utf-8", errors="replace")


# ── 1. Provider adapters ──────────────────────────────────────────────────
def test_claude_adapter_is_still_valid():
    """The Claude side must keep working — the neutral layer sits on top, not instead."""
    result = run([str(CI / "check_claude_config.py")])
    assert result.returncode == 0, result.stdout + result.stderr


@needs_agent_contract
def test_codex_adapter_is_detected_and_within_its_budget():
    agents = REPO_ROOT / "AGENTS.md"
    assert agents.exists(), "Codex reads <git-root>/AGENTS.md; it is missing"
    size = len(agents.read_bytes())
    assert 0 < size <= 32 * 1024, (
        f"AGENTS.md is {size} bytes; Codex stops concatenating project docs past "
        "project_doc_max_bytes (32 KiB) and the tail is silently dropped")


@needs_agent_contract
def test_both_adapters_resolve_to_one_contract():
    """CLAUDE.md must IMPORT AGENTS.md. Two copies drift; one cannot."""
    text = (REPO_ROOT / ".claude" / "CLAUDE.md").read_text(encoding="utf-8")
    assert "@../AGENTS.md" in text
    assert (REPO_ROOT / ".claude" / ".." / "AGENTS.md").resolve().exists()
    result = run([str(CI / "check_agent_config.py")])
    assert result.returncode == 0, result.stdout + result.stderr


@needs_agent_contract
def test_the_definition_of_done_command_is_the_same_for_every_agent():
    agents = (REPO_ROOT / "AGENTS.md").read_text(encoding="utf-8")
    assert "scripts/ci/verify.py task" in agents
    assert run([str(CI / "verify.py"), "--help"]).returncode == 0


# ── 2. Server-side diff actually sees the change ──────────────────────────
def test_server_side_diff_sees_the_files_changed_between_base_and_head():
    """The bug this closes: on a CI checkout the working tree is clean, so a
    working-tree diff reviews nothing and reports 'no changes to validate'."""
    base = git("merge-base", "HEAD", "HEAD~1", cwd=REPO_ROOT).stdout.strip() or "HEAD~1"
    result = run([str(CI / "guardrail_check.py"), "--diff", "--base", base,
                  "--head", "HEAD", "--json"])
    assert result.returncode in (0, 1, 2), result.stderr
    payload = json.loads(result.stdout)
    changed = payload.get("changed_files") or payload.get("files") or []
    if not changed:  # shape varies by verdict; fall back to the raw report
        changed = [str(payload)]
    expected = git("diff", "--name-only", f"{base}...HEAD", cwd=REPO_ROOT).stdout.split()
    assert expected, "the fixture needs at least one changed file"
    blob = json.dumps(payload)
    assert any(name in blob for name in expected), (
        "the guardrail did not see any of the files that actually changed between "
        f"base and head: {expected[:5]}")


def test_a_clean_checkout_reviews_nothing_but_base_head_reviews_the_change(tmp_path):
    """Both halves of the bug, on a genuinely clean checkout.

    Asserted in a throwaway repo rather than this one, because the real working tree
    is rarely clean and the property under test is precisely what CI sees.
    """
    repo = make_repo(tmp_path)
    rules = repo / "scripts" / "guardrail" / "guardrail_rules.yaml"
    rules.write_text(rules.read_text(encoding="utf-8") + "\n# touched\n", encoding="utf-8")
    commit_head(repo)
    git("checkout", "-q", "pr-base", cwd=repo)       # clean tree, like a CI checkout

    checker = str(repo / "scripts" / "ci" / "guardrail_check.py")
    clean = subprocess.run([sys.executable, checker, "--diff"], cwd=str(repo),
                           capture_output=True, text=True, encoding="utf-8",
                           errors="replace", timeout=300)
    assert "no changes to validate" in clean.stdout.lower(), (
        "a clean checkout must report that it reviewed nothing - this is exactly why "
        "CI needs --base/--head:\n" + clean.stdout)

    reviewed = subprocess.run([sys.executable, checker, "--diff",
                               "--base", "pr-base", "--head", "pr-head"],
                              cwd=str(repo), capture_output=True, text=True,
                              encoding="utf-8", errors="replace", timeout=300)
    assert "no changes to validate" not in reviewed.stdout.lower(), (
        "--base/--head reviewed nothing on a real change:\n" + reviewed.stdout)
    # Seeing the change is the point, and here it does more than see it: touching the
    # rule base is a protected-subsystem change and comes back with its required gates.
    assert "pr-base...pr-head" in reviewed.stdout
    assert "engineering_infrastructure" in reviewed.stdout
    assert "agent_sdlc_meta" in reviewed.stdout


# ── 3. The rule engine still refuses the things it must refuse ────────────
def test_an_architecture_violation_fails_the_gate():
    """A model importing a service inverts the layering the rule base pins."""
    sys.path.insert(0, str(GUARDRAIL))
    import guardrail_core as core  # noqa: E402

    verdict = core.check_architecture_violation(
        ["backend/app/models/thing.py"],
        {"backend/app/models/thing.py": ["app.services.chart_service"]},
    )
    blob = json.dumps(verdict).lower()
    assert "violation" in blob or verdict.get("violations"), (
        f"models importing services was not flagged: {verdict}")


def test_unknown_scope_is_not_reported_as_safe():
    sys.path.insert(0, str(GUARDRAIL))
    import guardrail_core as core  # noqa: E402

    scope = core.get_impact_scope(["some/unmapped/place/file.py"])
    blob = json.dumps(scope).lower()
    assert "unknown" in blob, f"an unmapped path must read as UNKNOWN, got {scope}"
    assert "safe" not in blob


def test_protection_paths_are_no_longer_unmapped():
    """They classified as UNKNOWN before this layer existed, which meant touching
    the gates dragged in no impact and no required tests at all."""
    sys.path.insert(0, str(GUARDRAIL))
    import guardrail_core as core  # noqa: E402

    for path in ("scripts/ci/verify.py", "scripts/guardrail/guardrail_rules.yaml",
                 ".github/workflows/preflight.yml", ".claude/settings.json", "AGENTS.md"):
        assert (core.classify_file(path) or {}).get("id") == "repo_infra", path
    required = core.get_required_tests(["scripts/ci/verify.py"]).get("required_tests") or []
    assert {t["id"] for t in required} >= {"agent_sdlc_meta", "stop_gate_decision"}


# ── 4. Infrastructure failure is never a pass ─────────────────────────────
def test_verifier_infrastructure_failure_is_not_reported_as_pass(tmp_path):
    """Covered in depth by test_stop_gate.py; asserted here so the SDLC meta-suite
    fails too if the Stop gate is ever made fail-open."""
    hook = REPO_ROOT / ".claude" / "hooks" / "stop_gate.py"
    result = subprocess.run(
        [sys.executable, str(hook)],
        input=json.dumps({"stop_hook_active": True}),
        capture_output=True, text=True, cwd=str(REPO_ROOT),
        env={**os.environ, "APPBI_STOP_GATE_VERIFY": str(tmp_path / "absent.py")},
        timeout=120,
    )
    assert result.returncode == 2, (
        "a missing verifier must BLOCK even on the retry - 'we could not check' is not "
        "'it passed'")


# ── 5. Adversarial: can a PR edit its way past the protection? ────────────
def make_repo(tmp_path: Path) -> Path:
    """A throwaway repo carrying the real protection files, with a `base` commit."""
    repo = tmp_path / "repo"
    (repo / "scripts" / "ci").mkdir(parents=True)
    (repo / "scripts" / "guardrail").mkdir(parents=True)
    (repo / ".github" / "workflows").mkdir(parents=True)
    (repo / ".claude" / "hooks").mkdir(parents=True)

    def copy_if_present(source: Path, dest_dir: Path) -> None:
        # Whatever this commit actually has. On the bootstrap commit the
        # agent-contract files do not exist yet, and the adversarial cases must
        # still run - they are the reason the bootstrap exists.
        if source.exists():
            shutil.copy(source, dest_dir)

    for name in ("check_protection_integrity.py", "verify.py", "guardrail_check.py",
                 "check_claude_config.py", "check_agent_config.py", "preflight.sh",
                 "alembic_chain.py"):
        copy_if_present(CI / name, repo / "scripts" / "ci")
    for name in ("guardrail_rules.yaml", "guardrail_core.py"):
        copy_if_present(GUARDRAIL / name, repo / "scripts" / "guardrail")
    for name in ("preflight.yml", "backend-contract-tests.yml", "change-guardrail.yml"):
        copy_if_present(REPO_ROOT / ".github" / "workflows" / name,
                        repo / ".github" / "workflows")
    copy_if_present(REPO_ROOT / ".claude" / "hooks" / "stop_gate.py", repo / ".claude" / "hooks")
    copy_if_present(REPO_ROOT / ".claude" / "settings.json", repo / ".claude")
    copy_if_present(REPO_ROOT / ".claude" / "CLAUDE.md", repo / ".claude")
    copy_if_present(REPO_ROOT / "AGENTS.md", repo)

    git("init", "-q", cwd=repo)
    git("config", "user.email", "t@t", cwd=repo)
    git("config", "user.name", "t", cwd=repo)
    git("add", "-A", cwd=repo)
    git("commit", "-qm", "base", cwd=repo)
    git("branch", "-M", "pr-base", cwd=repo)
    return repo


def commit_head(repo: Path) -> None:
    git("checkout", "-q", "-b", "pr-head", cwd=repo)
    git("add", "-A", cwd=repo)
    git("commit", "-qm", "head", cwd=repo)


def audit_from_base(repo: Path):
    """Simulate CI: check out BASE, run the BASE checker, head is data only."""
    git("checkout", "-q", "pr-base", cwd=repo)
    return subprocess.run(
        [sys.executable, str(repo / "scripts" / "ci" / "check_protection_integrity.py"),
         "--base", "pr-base", "--head", "pr-head"],
        cwd=str(repo), capture_output=True, text=True, encoding="utf-8",
        errors="replace", timeout=300,
    )


def test_a_pr_that_neuters_the_checker_is_still_caught_by_the_base_copy(tmp_path):
    """THE case this design exists for.

    The PR rewrites check_protection_integrity.py to always succeed AND deletes an
    invariant. Running the head copy would pass its own audit; running the BASE copy
    catches the deletion.
    """
    repo = make_repo(tmp_path)
    checker = repo / "scripts" / "ci" / "check_protection_integrity.py"
    checker.write_text("import sys\nsys.exit(0)\n", encoding="utf-8")

    rules = repo / "scripts" / "guardrail" / "guardrail_rules.yaml"
    import yaml
    data = yaml.safe_load(rules.read_text(encoding="utf-8"))
    removed = data["invariants"].pop(0)["id"]
    rules.write_text(yaml.safe_dump(data, sort_keys=False), encoding="utf-8")
    commit_head(repo)

    # The head copy would wave it through...
    neutered = subprocess.run([sys.executable, str(checker), "--base", "pr-base", "--head", "pr-head"],
                              cwd=str(repo), capture_output=True, text=True)
    assert neutered.returncode == 0, "fixture: the neutered checker should pass itself"

    # ...the trusted base copy does not.
    result = audit_from_base(repo)
    assert result.returncode == 1, result.stdout + result.stderr
    assert removed in result.stdout


def test_a_pr_that_deletes_the_protecting_workflow_is_still_caught(tmp_path):
    repo = make_repo(tmp_path)
    workflow = repo / ".github" / "workflows" / "preflight.yml"
    if not workflow.exists():
        pytest.skip("preflight.yml not present in the fixture")
    workflow.unlink()
    commit_head(repo)

    result = audit_from_base(repo)
    assert result.returncode == 1, result.stdout
    assert "preflight.yml" in result.stdout and "DELETED" in result.stdout


def test_a_pr_that_downgrades_a_required_gate_is_caught(tmp_path):
    repo = make_repo(tmp_path)
    rules = repo / "scripts" / "guardrail" / "guardrail_rules.yaml"
    import yaml
    data = yaml.safe_load(rules.read_text(encoding="utf-8"))
    target = next(name for name, entry in data["tests"].items()
                  if isinstance(entry, dict) and not entry.get("status"))
    data["tests"][target]["status"] = "manual"          # silently stop running it
    rules.write_text(yaml.safe_dump(data, sort_keys=False), encoding="utf-8")
    commit_head(repo)

    result = audit_from_base(repo)
    assert result.returncode == 1, result.stdout
    assert target in result.stdout and "status_reason" in result.stdout


def test_a_declared_downgrade_is_allowed_through(tmp_path):
    """Weakening is sometimes right. It must be visible, not impossible."""
    repo = make_repo(tmp_path)
    rules = repo / "scripts" / "guardrail" / "guardrail_rules.yaml"
    import yaml
    data = yaml.safe_load(rules.read_text(encoding="utf-8"))
    target = next(name for name, entry in data["tests"].items()
                  if isinstance(entry, dict) and not entry.get("status"))
    data["tests"][target]["status"] = "manual"
    data["tests"][target]["status_reason"] = "harness retired 2026-09; replaced by X"
    rules.write_text(yaml.safe_dump(data, sort_keys=False), encoding="utf-8")
    commit_head(repo)

    result = audit_from_base(repo)
    assert result.returncode == 0, result.stdout
    assert "declared" in result.stdout


def test_a_pr_that_makes_the_stop_gate_fail_open_is_caught(tmp_path):
    repo = make_repo(tmp_path)
    hook = repo / ".claude" / "hooks" / "stop_gate.py"
    hook.write_text("import sys\n\ndef decide(*a, **k):\n    return 0, ''\n"
                    "sys.exit(0)\n", encoding="utf-8")
    commit_head(repo)

    result = audit_from_base(repo)
    assert result.returncode == 1, result.stdout
    assert "fail-open" in result.stdout


def test_removing_a_protected_subsystem_is_caught(tmp_path):
    repo = make_repo(tmp_path)
    rules = repo / "scripts" / "guardrail" / "guardrail_rules.yaml"
    import yaml
    data = yaml.safe_load(rules.read_text(encoding="utf-8"))
    removed = data["protected"].pop(0)["id"]
    rules.write_text(yaml.safe_dump(data, sort_keys=False), encoding="utf-8")
    commit_head(repo)

    result = audit_from_base(repo)
    assert result.returncode == 1, result.stdout
    assert removed in result.stdout


# ── 6. Ordinary work is not punished ──────────────────────────────────────
def test_an_ordinary_change_is_not_blocked(tmp_path):
    """A safety system that blocks normal work gets switched off. Editing a README
    touches nothing protected and must pass cleanly."""
    repo = make_repo(tmp_path)
    (repo / "README.md").write_text("# hello\n", encoding="utf-8")
    commit_head(repo)

    result = audit_from_base(repo)
    assert result.returncode == 0, result.stdout
    assert "no mechanically detectable weakening" in result.stdout


# ── 7. UNKNOWN is risk-based, not uniformly fatal or uniformly ignored ────
def _head_sha(repo: Path) -> str:
    return git("rev-parse", "pr-head", cwd=repo).stdout.strip()


def review_from_head(repo: Path):
    """Layer 2: the head guardrail reviewing the real base..head diff."""
    git("checkout", "-q", "pr-head", cwd=repo)
    return subprocess.run(
        [sys.executable, str(repo / "scripts" / "ci" / "guardrail_check.py"),
         "--diff", "--base", "pr-base", "--head", "pr-head"],
        cwd=str(repo), capture_output=True, text=True, encoding="utf-8",
        errors="replace", timeout=300,
    )


def test_unknown_on_a_runtime_path_fails_the_server_gate(tmp_path):
    """A new module the rule engine has never heard of must not merge on an
    annotation. This is the case an agent creates by inventing a package."""
    repo = make_repo(tmp_path)
    new = repo / "backend" / "app" / "brandnewthing"
    new.mkdir(parents=True)
    (new / "svc.py").write_text("x = 1\n", encoding="utf-8")
    commit_head(repo)

    result = review_from_head(repo)
    assert result.returncode == 1, result.stdout
    assert "backend/app/brandnewthing/svc.py" in result.stdout
    assert "UNMAPPED ON A PATH WHERE THAT BLOCKS" in result.stdout


def test_unknown_on_a_low_risk_path_does_not_fail(tmp_path):
    """The other half. Failing every unmapped docs file is bureaucracy, and a
    gate that blocks ordinary work gets switched off."""
    repo = make_repo(tmp_path)
    docs = repo / "docs" / "notes"
    docs.mkdir(parents=True)
    (docs / "meeting.md").write_text("# notes\n", encoding="utf-8")
    commit_head(repo)

    result = review_from_head(repo)
    assert result.returncode == 0, result.stdout
    assert "UNMAPPED ON A PATH WHERE THAT BLOCKS" not in result.stdout


def test_widening_the_exemption_list_is_itself_a_protection_change(tmp_path):
    """Deleting a path from blocking_globs to make a change pass is the obvious
    escape. It edits guardrail_rules.yaml, so the trusted layer sees it."""
    repo = make_repo(tmp_path)
    rules = repo / "scripts" / "guardrail" / "guardrail_rules.yaml"
    import yaml
    data = yaml.safe_load(rules.read_text(encoding="utf-8"))
    data["protected"] = [p for p in data["protected"]
                         if p["id"] != "engineering_infrastructure"]
    rules.write_text(yaml.safe_dump(data, sort_keys=False), encoding="utf-8")
    commit_head(repo)

    result = audit_from_base(repo)
    assert result.returncode == 1
    assert "engineering_infrastructure" in result.stdout


# ── 8. The removal override is scoped to one exact commit ─────────────────
def _remove_an_invariant(repo: Path) -> str:
    rules = repo / "scripts" / "guardrail" / "guardrail_rules.yaml"
    import yaml
    data = yaml.safe_load(rules.read_text(encoding="utf-8"))
    removed = data["invariants"].pop(0)["id"]
    rules.write_text(yaml.safe_dump(data, sort_keys=False), encoding="utf-8")
    return removed


def audit_from_base_with(repo: Path, env_extra: dict):
    git("checkout", "-q", "pr-base", cwd=repo)
    return subprocess.run(
        [sys.executable, str(repo / "scripts" / "ci" / "check_protection_integrity.py"),
         "--base", "pr-base", "--head", "pr-head"],
        cwd=str(repo), capture_output=True, text=True, encoding="utf-8",
        errors="replace", env={**os.environ, **env_extra}, timeout=300,
    )


def test_removal_override_applies_only_to_the_exact_approved_commit(tmp_path):
    repo = make_repo(tmp_path)
    removed = _remove_an_invariant(repo)
    commit_head(repo)
    head = _head_sha(repo)

    approved = audit_from_base_with(repo, {"APPBI_ALLOW_PROTECTION_REMOVAL_SHA": head})
    assert approved.returncode == 0, approved.stdout
    assert "allowed for this exact commit" in approved.stdout


def test_an_approval_for_a_different_commit_does_not_carry_over(tmp_path):
    """The reason this is a SHA and not a boolean: approving one protection change
    must not leave a standing bypass for the next push or another PR."""
    repo = make_repo(tmp_path)
    removed = _remove_an_invariant(repo)
    commit_head(repo)

    stale = audit_from_base_with(
        repo, {"APPBI_ALLOW_PROTECTION_REMOVAL_SHA": "0" * 40})
    assert stale.returncode == 1, stale.stdout
    assert removed in stale.stdout
    assert "does NOT apply to this commit" in stale.stdout


def test_no_override_still_blocks_a_removal(tmp_path):
    repo = make_repo(tmp_path)
    removed = _remove_an_invariant(repo)
    commit_head(repo)

    env = {k: v for k, v in os.environ.items() if k != "APPBI_ALLOW_PROTECTION_REMOVAL_SHA"}
    result = subprocess.run(
        [sys.executable, str(repo / "scripts" / "ci" / "check_protection_integrity.py"),
         "--base", "pr-base", "--head", "pr-head"],
        cwd=str(repo), capture_output=True, text=True, env=env, timeout=300)
    assert result.returncode == 1
    assert "REMOVAL_SHA" in result.stdout


# ── 9. Local and CI must agree about what "exists" ────────────────────────
def test_referenced_paths_are_checked_against_git_not_the_filesystem(tmp_path):
    """The remote-only failure this locks out.

    `check_agent_config.py` verified that every path the agent contract names
    exists. It asked the FILESYSTEM, which on a developer's machine also contains
    untracked and gitignored files - so AGENTS.md could cite a gitignored tree,
    pass locally, and fail on CI's fresh clone. A gate that answers differently on
    two machines is not a gate.

    Proven by citing a path that exists on disk and is NOT tracked: the validator
    must reject it, and say why.
    """
    import importlib.util
    spec = importlib.util.spec_from_file_location("cac", CI / "check_agent_config.py")
    cac = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(cac)

    untracked = REPO_ROOT / "scripts" / "ci" / "_untracked_probe_dir"
    untracked.mkdir(exist_ok=True)
    try:
        rel = "scripts/ci/_untracked_probe_dir"
        assert (REPO_ROOT / rel).exists(), "fixture: the path must exist on disk"
        assert not cac.path_is_in_the_repository(rel), (
            "a path that exists on disk but is not tracked must NOT count as present - "
            "that is exactly the local-passes/CI-fails divergence")
        # and a genuinely tracked path still counts
        assert cac.path_is_in_the_repository("scripts/ci/verify.py")
        assert cac.path_is_in_the_repository("scripts/ci")   # tracked directory
    finally:
        untracked.rmdir()


def test_the_agent_contract_validates_on_a_tracked_files_only_tree(tmp_path):
    """End to end in CI's actual condition: export the tracked tree and validate it.

    This is the check that would have caught the failure before it reached the
    server, rather than after.

    NOTE: it archives HEAD, not the working tree - deliberately, because HEAD is
    what CI will clone. So while a fix is still uncommitted this test reports the
    committed state and fails; that is the same contract as preflight, which also
    judges HEAD rather than your dirty tree. Commit, then re-run.
    """
    export = tmp_path / "tracked"
    export.mkdir()
    archive = subprocess.run(["git", "-C", str(REPO_ROOT), "archive", "HEAD"],
                             capture_output=True, timeout=300)
    assert archive.returncode == 0, archive.stderr.decode(errors="replace")
    tar = subprocess.run(["tar", "-x", "-C", str(export)], input=archive.stdout,
                         capture_output=True, timeout=300)
    assert tar.returncode == 0, tar.stderr.decode(errors="replace")

    subprocess.run(["git", "init", "-q"], cwd=export, capture_output=True)
    subprocess.run(["git", "add", "-A"], cwd=export, capture_output=True)
    subprocess.run(["git", "-c", "user.email=t@t", "-c", "user.name=t",
                    "commit", "-qm", "tracked"], cwd=export, capture_output=True)

    result = subprocess.run([sys.executable, "scripts/ci/check_agent_config.py"],
                            cwd=export, capture_output=True, text=True,
                            encoding="utf-8", errors="replace", timeout=300)
    assert result.returncode == 0, (
        "the agent contract does not validate on a tracked-files-only tree - CI "
        "will fail even though a local run passes:\n" + result.stdout + result.stderr)
