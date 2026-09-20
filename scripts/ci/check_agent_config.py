#!/usr/bin/env python3
"""Validate the provider-neutral agent contract and every provider adapter.

WHY THIS SITS ON TOP OF check_claude_config.py
----------------------------------------------
`check_claude_config.py` knows Claude Code's schema and keeps doing exactly that; it is
called by preflight, CI and the meta-tests, so renaming it would churn call sites for
cosmetics. What it cannot know is whether the *adapters agree*: whether `AGENTS.md`
exists for Codex, whether Claude's `CLAUDE.md` actually imports it rather than carrying a
second copy that drifts, and whether the commands both files promise are real.

That is this file's job. It runs the Claude validator and adds the provider-neutral
checks around it, so one command proves the whole agent layer.

WHAT IT PROVES
--------------
  1. Claude config is valid          (delegated to check_claude_config.py)
  2. AGENTS.md exists at the git root, is non-empty, and fits Codex's 32 KiB
     `project_doc_max_bytes` budget — past that Codex silently stops concatenating.
  3. The Claude adapter IMPORTS AGENTS.md instead of duplicating it, and the import
     resolves. One copy cannot drift from itself; two copies always do.
  4. Every repo path and every command the agent files promise actually exists. A
     contract that tells an agent to run a script that is gone is worse than silence.
  5. The canonical Definition-of-Done command is the same one in every adapter.

WHAT IT CANNOT PROVE
--------------------
That an agent actually loaded any of it at runtime. Only a session shows that (`/context`
in Claude Code). Said in the output rather than glossed over.

    python scripts/ci/check_agent_config.py        # 0 = valid, 1 = problems

References: https://code.claude.com/docs/en/memory
            https://developers.openai.com/codex/guides/agents-md.md
"""
from __future__ import annotations

import re
import subprocess
import sys
from functools import lru_cache
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
AGENTS = REPO_ROOT / "AGENTS.md"
CLAUDE_MD = REPO_ROOT / ".claude" / "CLAUDE.md"

# Codex stops concatenating project docs once the combined size passes
# `project_doc_max_bytes`, 32 KiB by default. A file over that is not an error
# anywhere — it just stops being read, which is the failure mode worth catching.
CODEX_DOC_MAX_BYTES = 32 * 1024

# The one command every adapter must name, so "done" means the same thing whoever
# is driving.
CANONICAL_DOD = "scripts/ci/verify.py task"

problems: list[str] = []
notes: list[str] = []


def fail(msg: str) -> None:
    problems.append(msg)


def check_claude_delegate() -> None:
    script = REPO_ROOT / "scripts" / "ci" / "check_claude_config.py"
    if not script.exists():
        fail("scripts/ci/check_claude_config.py is missing — the Claude adapter is unvalidated")
        return
    result = subprocess.run([sys.executable, str(script)], cwd=REPO_ROOT,
                            capture_output=True, text=True, encoding="utf-8",
                            errors="replace")
    for line in (result.stdout or "").splitlines():
        stripped = line.strip()
        if stripped.startswith("- "):
            notes.append("claude: " + stripped[2:])
        elif stripped.startswith("x "):
            fail("claude: " + stripped[2:])
    if result.returncode != 0 and not any(p.startswith("claude:") for p in problems):
        fail(f"check_claude_config.py exited {result.returncode}:\n{result.stdout}{result.stderr}")


def check_agents_md() -> None:
    if not AGENTS.exists():
        fail("AGENTS.md is missing from the repository root — Codex has no project "
             "instructions (it reads <git-root>/AGENTS.md)")
        return
    raw = AGENTS.read_bytes()
    if not raw.strip():
        fail("AGENTS.md is empty")
        return
    if len(raw) > CODEX_DOC_MAX_BYTES:
        fail(f"AGENTS.md is {len(raw)} bytes, over Codex's {CODEX_DOC_MAX_BYTES}-byte "
             "project_doc_max_bytes — the tail is silently dropped")
    notes.append(f"AGENTS.md: {len(raw)} bytes "
                 f"({100 * len(raw) // CODEX_DOC_MAX_BYTES}% of Codex's budget)")


def check_adapter_imports_canonical() -> None:
    """The Claude adapter must IMPORT AGENTS.md, not re-state it."""
    if not CLAUDE_MD.exists():
        fail(".claude/CLAUDE.md is missing — Claude Code has no project instructions")
        return
    text = CLAUDE_MD.read_text(encoding="utf-8", errors="replace")

    # Claude Code resolves @-imports relative to the importing file, so from
    # .claude/CLAUDE.md the repo-root file is `../AGENTS.md`.
    imports = re.findall(r"^@(\S+)", text, re.M)
    resolved = [(spec, (CLAUDE_MD.parent / spec).resolve()) for spec in imports]
    if not any(target == AGENTS.resolve() for _, target in resolved):
        fail(".claude/CLAUDE.md does not import AGENTS.md (expected a line `@../AGENTS.md`). "
             "Without the import the two adapters are separate copies and will drift.")
    for spec, target in resolved:
        if not target.exists():
            fail(f".claude/CLAUDE.md imports @{spec}, which does not resolve to a file")
        try:
            target.relative_to(REPO_ROOT)
        except ValueError:
            fail(f".claude/CLAUDE.md imports @{spec}, which resolves OUTSIDE the repo — "
                 "Claude Code treats that as an external import and asks each user to "
                 "approve it, so it will silently not load for anyone who declines")
    if resolved:
        notes.append(f"claude adapter imports: {', '.join(s for s, _ in resolved)}")


def _candidate_paths(text: str) -> set[str]:
    """Repo paths a contract promises, taken from inline code spans.

    Only spans that look like a path into a directory this repo has: a bare word in
    backticks is prose, and guessing would make the check noisy enough to ignore.
    """
    roots = ("scripts/", "backend/", "frontend/", "e2e/", "qa/", "docs/", ".claude/",
             ".github/", ".githooks/", "DA-Test/")
    found = set()
    for span in re.findall(r"`([^`\n]+)`", text):
        span = span.strip()
        if not span.startswith(roots):
            continue
        # Templated placeholders (`docs/features/<feature>/{intent,spec}.md`) name a
        # shape, not a file. Checking them would only teach people to ignore this.
        if any(ch in span for ch in "<>{}"):
            continue
        # Commands: keep the first path-looking token ("pytest backend/tests/x.py").
        token = next((t for t in span.split() if t.startswith(roots)), span.split()[0])
        token = token.rstrip(".,;:)")
        found.add(token)
    return found


@lru_cache(maxsize=1)
def tracked_paths() -> frozenset[str]:
    """Every path git tracks, as the repo-relative POSIX strings git prints.

    Deliberately NOT the filesystem: a developer's checkout also holds untracked
    and gitignored files, so a filesystem check passes locally and fails in CI on
    a fresh clone. That exact divergence is what this function exists to remove.
    """
    out = subprocess.run(["git", "-C", str(REPO_ROOT), "ls-files"],
                         capture_output=True, text=True, encoding="utf-8",
                         errors="replace")
    return frozenset(out.stdout.split()) if out.returncode == 0 else frozenset()


def path_is_in_the_repository(rel: str) -> bool:
    """A file git tracks, or a directory git tracks something under."""
    tracked = tracked_paths()
    if not tracked:                      # not a git checkout (a tarball, say)
        return (REPO_ROOT / rel).exists()
    if rel in tracked:
        return True
    prefix = rel.rstrip("/") + "/"
    return any(p.startswith(prefix) for p in tracked)


def check_referenced_paths() -> None:
    for source in (AGENTS, CLAUDE_MD):
        if not source.exists():
            continue
        text = source.read_text(encoding="utf-8", errors="replace")
        rel = source.relative_to(REPO_ROOT).as_posix()
        for candidate in sorted(_candidate_paths(text)):
            # Strip glob tails: `backend/app/services/**` names a directory.
            concrete = candidate.split("*")[0].rstrip("/")
            if not concrete:
                continue
            if not path_is_in_the_repository(concrete):
                extra = (" (it exists here but git does not track it, so it is absent "
                         "from a fresh clone and from CI)"
                         if (REPO_ROOT / concrete).exists() else "")
                fail(f"{rel} references `{candidate}`, which is not in the repository{extra}")


def check_canonical_dod() -> None:
    """Every adapter must point at the same Definition-of-Done command."""
    missing = []
    for source in (AGENTS, CLAUDE_MD):
        if not source.exists():
            continue
        text = source.read_text(encoding="utf-8", errors="replace")
        # CLAUDE.md inherits the statement through its @import; only require the
        # command to be named somewhere in the pair.
        if CANONICAL_DOD in text:
            return
        missing.append(source.relative_to(REPO_ROOT).as_posix())
    if missing:
        fail(f"no adapter names the canonical Definition-of-Done command "
             f"`{CANONICAL_DOD}` (checked {', '.join(missing)})")


def check_dod_command_runs() -> None:
    verify = REPO_ROOT / "scripts" / "ci" / "verify.py"
    if not verify.exists():
        fail("scripts/ci/verify.py is missing — the canonical Definition-of-Done "
             "command cannot run, so no agent can prove a task complete")
        return
    result = subprocess.run([sys.executable, str(verify), "--help"], cwd=REPO_ROOT,
                            capture_output=True, text=True)
    if result.returncode != 0:
        fail("scripts/ci/verify.py does not run (`--help` failed) — the Definition of "
             "Done is unexecutable")
    else:
        notes.append("canonical DoD: `python scripts/ci/verify.py task` is executable")


def main() -> int:
    check_claude_delegate()
    check_agents_md()
    check_adapter_imports_canonical()
    check_referenced_paths()
    check_canonical_dod()
    check_dod_command_runs()

    for note in notes:
        print(f"  - {note}")
    if problems:
        print("\nAgent contract problems:")
        for problem in problems:
            print(f"  x {problem}")
        return 1
    print("\n  Agent contract is valid: one canonical entrypoint, adapters import it, "
          "referenced paths exist.")
    print("  Runtime loading is NOT proven here - run /context in a Claude session to "
          "see what actually loaded.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
