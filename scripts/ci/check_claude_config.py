#!/usr/bin/env python3
"""Validate the project's Claude Code workflow configuration.

WHY THIS EXISTS
---------------
The rule files under `.claude/rules/` carried a `paths`-like key spelled `globs:`.
Claude Code does not read that key, and a rule with no `paths` field loads
UNCONDITIONALLY — so all five rules were in context every session, which is the
precise opposite of what their frontmatter appeared to say. Nothing failed,
nothing warned, and the YAML parsed perfectly. Only a check that knows the
supported schema can catch that.

This validates what is mechanically checkable about the workflow config:

  1. `.claude/settings.json` is valid JSON with a hook schema Claude Code accepts,
     and every hook command it names actually exists on disk.
  2. Every `.claude/rules/*.md` has parseable frontmatter, uses `paths:` (not a
     look-alike), and each glob matches at least one real file — a glob that
     matches nothing is a rule that silently never loads.
  3. Every `.claude/skills/*/SKILL.md` has the `name` + `description` frontmatter
     that makes it discoverable.

It does NOT verify that Claude Code actually loaded a rule at runtime; only a
session can show that (`/context`, or an `InstructionsLoaded` hook). The gap is
stated in the output rather than glossed over.

    python scripts/ci/check_claude_config.py         # 0 = valid, 1 = problems

Reference: https://code.claude.com/docs/en/memory  (path-specific rules)
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
CLAUDE = REPO_ROOT / ".claude"

# Keys other tools use for the same idea. Spelling one of these instead of
# `paths` is silent: the rule just becomes unconditional.
LOOKALIKE_PATH_KEYS = {"globs", "glob", "path", "files", "include", "applyTo", "apply_to"}

problems: list[str] = []
notes: list[str] = []


def fail(msg: str) -> None:
    problems.append(msg)


def split_frontmatter(text: str):
    """Return (frontmatter_text, had_frontmatter). No YAML dependency needed."""
    if not text.startswith("---"):
        return "", False
    end = text.find("\n---", 3)
    if end == -1:
        return "", False
    return text[3:end], True


def parse_simple_yaml(block: str) -> dict:
    """Parse the flat `key: value` / `key:\\n  - item` subset frontmatter uses.

    Deliberately not PyYAML: this must run in preflight before any pip install,
    and the frontmatter schema is small and flat.
    """
    data: dict = {}
    key = None
    for raw in block.splitlines():
        if not raw.strip() or raw.lstrip().startswith("#"):
            continue
        item = re.match(r"\s*-\s+(.*)$", raw)
        if item and key:
            data.setdefault(key, []).append(item.group(1).strip().strip('"\''))
            continue
        kv = re.match(r"([A-Za-z_][\w-]*)\s*:\s*(.*)$", raw)
        if kv:
            key, value = kv.group(1), kv.group(2).strip()
            data[key] = value.strip('"\'') if value else []
    return data


def check_settings() -> None:
    path = CLAUDE / "settings.json"
    if not path.exists():
        notes.append("no .claude/settings.json (hooks not configured)")
        return
    try:
        settings = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        fail(f"settings.json is not valid JSON: {exc}")
        return

    hooks = settings.get("hooks") or {}
    if not isinstance(hooks, dict):
        fail("settings.json: `hooks` must be an object")
        return

    before = len(problems)
    count = 0
    for event, matchers in hooks.items():
        if not isinstance(matchers, list):
            fail(f"settings.json: hooks.{event} must be a list")
            continue
        for matcher in matchers:
            for hook in (matcher.get("hooks") or []):
                count += 1
                if hook.get("type") != "command":
                    fail(f"hooks.{event}: unsupported hook type {hook.get('type')!r}")
                    continue
                command = hook.get("command", "")
                args = hook.get("args")
                # Exec form (command + args) is spawned WITHOUT a shell, which is
                # the only form that behaves the same on Windows without Git Bash.
                if args is None:
                    fail(f"hooks.{event}: {command!r} uses shell form (no `args`). "
                         "On Windows without Git Bash this runs under PowerShell, "
                         "where $VAR expansion differs — use exec form with `args`.")
                    continue
                for arg in args:
                    if "${CLAUDE_PROJECT_DIR}" in arg:
                        rel = arg.replace("${CLAUDE_PROJECT_DIR}/", "").replace("${CLAUDE_PROJECT_DIR}\\", "")
                        if not (REPO_ROOT / rel).exists():
                            fail(f"hooks.{event}: script not found: {rel}")
    notes.append(f"settings.json: {count} hook command(s)"
                 + ("" if len(problems) > before else ", exec form, targets exist"))


def check_rules() -> None:
    rules_dir = CLAUDE / "rules"
    if not rules_dir.is_dir():
        notes.append("no .claude/rules/ directory")
        return
    files = sorted(rules_dir.rglob("*.md"))
    if not files:
        notes.append(".claude/rules/ is empty")
        return

    unconditional = []
    for path in files:
        rel = path.relative_to(REPO_ROOT).as_posix()
        text = path.read_text(encoding="utf-8", errors="replace")
        block, had = split_frontmatter(text)
        if not had:
            unconditional.append(rel)
            continue
        data = parse_simple_yaml(block)

        wrong = LOOKALIKE_PATH_KEYS & set(data)
        if wrong:
            fail(f"{rel}: uses {sorted(wrong)} — Claude Code only reads `paths:`. "
                 "The rule is loading unconditionally.")
            continue

        paths = data.get("paths")
        if not paths:
            unconditional.append(rel)
            continue
        if isinstance(paths, str):
            fail(f"{rel}: `paths` must be a list of globs")
            continue

        for pattern in paths:
            if "[" in pattern and "]" not in pattern:
                fail(f"{rel}: glob {pattern!r} has an unclosed '[' — matches nothing")
                continue
            try:
                matched = any(True for _ in REPO_ROOT.glob(pattern))
            except (ValueError, OSError) as exc:
                fail(f"{rel}: glob {pattern!r} is invalid ({exc})")
                continue
            if not matched:
                fail(f"{rel}: glob {pattern!r} matches no file in the repo — "
                     "this rule can never load")

    if unconditional:
        notes.append("loaded every session (no `paths`): " + ", ".join(unconditional))
    notes.append(f"rules: {len(files)} file(s), {len(files) - len(unconditional)} path-scoped")


def check_skills() -> None:
    skills_dir = CLAUDE / "skills"
    if not skills_dir.is_dir():
        notes.append("no .claude/skills/ directory")
        return
    found = 0
    for skill in sorted(skills_dir.iterdir()):
        if not skill.is_dir():
            continue
        manifest = skill / "SKILL.md"
        if not manifest.exists():
            fail(f".claude/skills/{skill.name}/: no SKILL.md — not discoverable")
            continue
        block, had = split_frontmatter(manifest.read_text(encoding="utf-8", errors="replace"))
        if not had:
            fail(f".claude/skills/{skill.name}/SKILL.md: no YAML frontmatter")
            continue
        data = parse_simple_yaml(block)
        for field in ("name", "description"):
            if not data.get(field):
                fail(f".claude/skills/{skill.name}/SKILL.md: missing `{field}` frontmatter")
        if data.get("name") and data["name"] != skill.name:
            fail(f".claude/skills/{skill.name}/SKILL.md: name {data['name']!r} "
                 f"does not match its directory")
        found += 1
    notes.append(f"skills: {found} discoverable")


def main() -> int:
    check_settings()
    check_rules()
    check_skills()

    for note in notes:
        print(f"  - {note}")
    if problems:
        print("\nClaude workflow config problems:")
        for problem in problems:
            print(f"  x {problem}")
        return 1
    print("\n  Static config is valid. Runtime loading is NOT proven here — run /context "
          "in a session, or an InstructionsLoaded hook, to see what actually loaded.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
