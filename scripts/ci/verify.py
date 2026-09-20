#!/usr/bin/env python3
"""Tiered verification for the agent/dev loop — cross-platform, and it RUNS the gates.

WHY THIS EXISTS (and why it is Python, not bash)
------------------------------------------------
`preflight.sh` answers "does the COMMITTED tree build and boot" and guards the
push. This answers "is the change I am making right now sound" and guards the
coding loop.

It was originally `verify.sh`. That made the task-complete gate depend on `bash`,
which on a Windows/VS Code machine without Git Bash simply is not there — and the
Stop hook's response to a missing shell was to exit 0, i.e. to report a verified
completion while having verified nothing. A gate that disables itself silently is
worse than no gate. This entrypoint needs only Python, which the repo already
requires.

THE SECOND REASON: EXECUTING REQUIRED TESTS
-------------------------------------------
The guardrail could always say WHICH tests a change requires. Whether they
actually ran depended on the model remembering to type each command. Here the
task tier resolves the required set from `guardrail_rules.yaml` and runs every
one that can run on this machine.

What it must never do is let a gate that did NOT run look like coverage. Entries
that are `status: missing` / `untracked` / `manual`, or that `requires:` a seeded
database, are executed nowhere and reported as UNVERIFIED or MANUAL, by name, in
the summary and in the process exit status commentary.

There is no second test registry here. Commands, statuses and requirements are
all read from `guardrail_rules.yaml`.

USAGE
-----
    python scripts/ci/verify.py fast    # coding loop: typecheck + touched QA contracts
    python scripts/ci/verify.py task    # before claiming done: everything below

    APPBI_VERIFY_WITH_DB=1              # also run gates needing a seeded Postgres
    python scripts/ci/verify.py task --json

EXIT CODES
----------
    0  everything applicable passed (unverified/manual gates are REPORTED, not fatal)
    1  something failed — the task is not done
    2  usage / environment error
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
GUARDRAIL_DIR = REPO_ROOT / "scripts" / "guardrail"

GREEN, RED, YELLOW, BOLD, OFF = "\033[32m", "\033[31m", "\033[33m", "\033[1m", "\033[0m"
if os.name == "nt" and not os.environ.get("WT_SESSION"):
    try:  # enable ANSI on legacy consoles; fall back to plain text
        import colorama  # type: ignore
        colorama.just_fix_windows_console()
    except Exception:
        GREEN = RED = YELLOW = BOLD = OFF = ""


class Report:
    def __init__(self) -> None:
        self.failed: list[str] = []
        self.passed: list[str] = []
        self.skipped: list[tuple[str, str]] = []
        self.unverified: list[tuple[str, str]] = []

    def section(self, title: str) -> None:
        print(f"\n{BOLD}> {title}{OFF}")

    def ok(self, what: str) -> None:
        self.passed.append(what)
        print(f"{GREEN}  ok{OFF} {what}")

    def bad(self, what: str) -> None:
        self.failed.append(what)
        print(f"{RED}  FAIL{OFF} {what}")

    def skip(self, what: str, why: str) -> None:
        self.skipped.append((what, why))
        print(f"  . skipped - {why}")

    def unverifiable(self, what: str, why: str) -> None:
        """A REQUIRED gate that did not run. Never counts as coverage."""
        self.unverified.append((what, why))
        print(f"{YELLOW}  UNVERIFIED{OFF} {what} - {why}")


def run(argv: list[str], cwd: Path, env: dict | None = None, timeout: int = 900):
    full_env = {**os.environ, **(env or {})}
    try:
        return subprocess.run(argv, cwd=cwd, env=full_env, capture_output=True,
                              text=True, encoding="utf-8", errors="replace",
                              timeout=timeout)
    except FileNotFoundError:
        return None
    except subprocess.TimeoutExpired:
        return subprocess.CompletedProcess(argv, 124, "", f"timed out after {timeout}s")


def git(*args: str) -> str:
    out = run(["git", "-C", str(REPO_ROOT), *args], REPO_ROOT)
    return (out.stdout if out else "") or ""


def changed_files() -> list[str]:
    """Working-tree changes vs HEAD, including untracked."""
    files = []
    for line in git("status", "--porcelain").splitlines():
        path = line[3:].strip()
        if " -> " in path:          # rename
            path = path.split(" -> ", 1)[1]
        if path:
            files.append(path.strip('"'))
    return files


def load_guardrail():
    if not GUARDRAIL_DIR.is_dir():
        return None
    sys.path.insert(0, str(GUARDRAIL_DIR))
    os.environ.setdefault("APPBI_REPO_ROOT", str(REPO_ROOT))
    try:
        import guardrail_core  # type: ignore
        return guardrail_core
    except Exception:
        return None


# ── Resolving a registry entry into something executable ──────────────────
def plan_command(test_id: str, spec: dict) -> tuple[list[str] | None, Path, dict, str]:
    """Turn a registry `run:` string into an argv, or explain why it cannot run.

    Returns (argv | None, cwd, env, reason_if_not_runnable).

    Deliberately conservative: a command this cannot confidently parse is
    reported as unverified rather than guessed at and run wrong.
    """
    status = (spec.get("status") or "").lower()
    if status in {"missing", "untracked", "manual"}:
        return None, REPO_ROOT, {}, {
            "missing": "declared missing in guardrail_rules.yaml (harness not in repo)",
            "untracked": "declared untracked — absent on a fresh clone",
            "manual": "manual verification, not a command",
        }[status]

    requires = (spec.get("requires") or "").strip()
    if requires and not os.environ.get("APPBI_VERIFY_WITH_DB"):
        return None, REPO_ROOT, {}, f"needs {requires}; CI runs it (APPBI_VERIFY_WITH_DB=1 to force)"

    cmd = (spec.get("run") or "").strip()
    if not cmd:
        return None, REPO_ROOT, {}, "no run command in the registry"

    # pytest suites under backend/ — run from backend/ so `import app.*` resolves
    # the way those suites expect.
    m = re.fullmatch(r"pytest\s+(backend/\S+\.py(?:\s+backend/\S+\.py)*)", cmd)
    if m:
        rel = [p[len("backend/"):] for p in m.group(1).split()]
        env = {"PYTHONPATH": str(REPO_ROOT / "backend"),
               "DATABASE_URL": os.environ.get("DATABASE_URL", "sqlite:///./_verify_gate.db")}
        return [sys.executable, "-m", "pytest", "-q", *rel], REPO_ROOT / "backend", env, ""

    # pytest suites anywhere else (scripts/ci/** holds the safety-system tests).
    # Without this the meta-gates report UNVERIFIED purely because the pattern above
    # only matched backend paths - a runnable gate wrongly counted as no coverage.
    m = re.fullmatch(r"pytest\s+((?:\S+\.py)(?:\s+\S+\.py)*)", cmd)
    if m:
        rel = m.group(1).split()
        missing = [r for r in rel if not (REPO_ROOT / r).exists()]
        if missing:
            return None, REPO_ROOT, {}, f"test file(s) not found: {', '.join(missing)}"
        return [sys.executable, "-m", "pytest", "-q", *rel], REPO_ROOT, {}, ""

    # Plain `python <script.py> [args]` with no leading env assignments.
    m = re.fullmatch(r"python\s+(\S+\.py)(\s+.*)?", cmd)
    if m:
        script = REPO_ROOT / m.group(1)
        if not script.exists():
            return None, REPO_ROOT, {}, f"script not found: {m.group(1)}"
        extra = (m.group(2) or "").split()
        return [sys.executable, str(script), *extra], REPO_ROOT, {}, ""

    # The frontend typecheck is already run by the tier itself.
    if "tsc --noEmit" in cmd:
        return None, REPO_ROOT, {}, "covered by this tier's frontend typecheck"

    return None, REPO_ROOT, {}, f"command not auto-runnable here: {cmd}"


def run_required_tests(core, files: list[str], rep: Report) -> None:
    rep.section("Required gates for this change (resolved from guardrail_rules.yaml)")
    try:
        required = core.get_required_tests(files).get("required_tests") or []
    except Exception as exc:
        rep.bad(f"could not resolve required tests: {exc}")
        return
    if not required:
        print("  (none - no guarded feature or protected subsystem touched)")
        return

    registry = core.load_rules().get("tests") or {}
    for entry in required:
        test_id = entry.get("id") if isinstance(entry, dict) else str(entry)
        spec = registry.get(test_id) or {}
        argv, cwd, env, why = plan_command(test_id, spec)
        if argv is None:
            rep.unverifiable(test_id, why)
            continue
        print(f"  running {test_id} ...")
        result = run(argv, cwd, env)
        if result is None:
            rep.unverifiable(test_id, "interpreter/tool not found on PATH")
        elif result.returncode == 0:
            rep.ok(f"{test_id}")
        else:
            tail = (result.stdout or "").strip().splitlines()[-12:]
            print("\n".join("      " + line for line in tail))
            rep.bad(f"{test_id}")


# ── Tier steps ────────────────────────────────────────────────────────────
def frontend_typecheck(rep: Report) -> None:
    rep.section("Frontend typecheck (tsc --noEmit)")
    tsc = REPO_ROOT / "frontend" / "node_modules" / "typescript" / "bin" / "tsc"
    if not tsc.exists():
        rep.skip("tsc", "typescript not installed in frontend/node_modules")
        return
    result = run(["node", str(tsc), "--noEmit", "--incremental", "false"],
                 REPO_ROOT / "frontend")
    if result is None:
        rep.skip("tsc", "node not on PATH")
    elif result.returncode == 0:
        rep.ok("no type errors")
    else:
        print((result.stdout or "")[-2500:])
        rep.bad("frontend type errors")


def frontend_qa(rep: Report, touched) -> None:
    checks = [
        ("check-module-routes.mjs", r"Sidebar\.tsx|moduleRoutes|^frontend/src/app/",
         "every sidebar module page is mapped in moduleRoutes.ts"),
        ("check-theme-presets.mjs", r"theme|Theme", "theme presets in sync"),
        ("check-presentation-contract.mjs", r"presentation|dashboard-presentation|experience",
         "presentation contract v1"),
    ]
    for script, pattern, label in checks:
        if not touched(pattern):
            continue
        path = REPO_ROOT / "frontend" / "scripts" / script
        if not path.exists():
            continue
        rep.section(f"QA contract: {script}")
        result = run(["node", f"scripts/{script}"], REPO_ROOT / "frontend")
        if result is None:
            rep.skip(script, "node not on PATH")
        elif result.returncode == 0:
            rep.ok(label)
        else:
            print((result.stdout or "") + (result.stderr or ""))
            rep.bad(label)


def alembic_chain(rep: Report) -> None:
    rep.section("Alembic chain")
    result = run([sys.executable, "scripts/ci/alembic_chain.py"], REPO_ROOT)
    if result is None:
        rep.skip("alembic chain", "python not available")
    elif result.returncode == 0:
        rep.ok("single head, parents present")
    else:
        print((result.stdout or "") + (result.stderr or ""))
        rep.bad("broken revision graph")


def backend_import_smoke(rep: Report) -> None:
    rep.section("Backend import smoke")
    env = {"DATABASE_URL": "sqlite:///./_verify.db", "PYTHONPATH": str(REPO_ROOT / "backend")}
    result = run([sys.executable, "-c", "import app.main"], REPO_ROOT / "backend", env)
    (REPO_ROOT / "backend" / "_verify.db").unlink(missing_ok=True)
    if result is None:
        rep.skip("import smoke", "python not available")
        return
    out = (result.stdout or "") + (result.stderr or "")
    if result.returncode == 0:
        rep.ok("app.main imports cleanly")
    elif re.search(r"No module named '(fastapi|sqlalchemy|pydantic|alembic|uvicorn|starlette)'", out):
        rep.skip("import smoke", "backend deps not installed locally")
    elif "ImportError" in out or "ModuleNotFoundError" in out:
        print(out[-1200:])
        rep.bad("import break")
    else:
        rep.skip("import smoke", "local env differs from requirements.txt (CI checks fully)")


def backend_tests_reach_ci(rep: Report, files: list[str]) -> None:
    """The allow-list and the CI workflow must agree.

    `.gitignore` blocks test_*.py behind an allow-list and most suites are
    local-only ON PURPOSE, so "every test must be in CI" would be noise. What is
    always wrong is a suite that is allow-listed — therefore committed, therefore
    believed to be a gate — that no CI job runs.
    """
    rep.section("Backend tests reach CI")
    gitignore = (REPO_ROOT / ".gitignore").read_text(encoding="utf-8", errors="replace")
    workflow_path = REPO_ROOT / ".github" / "workflows" / "backend-contract-tests.yml"
    workflow = workflow_path.read_text(encoding="utf-8", errors="replace") if workflow_path.exists() else ""
    broken = []
    for name in re.findall(r"^!backend/tests/(test_[A-Za-z0-9_]+\.py)$", gitignore, re.M):
        if not (REPO_ROOT / "backend" / "tests" / name).exists():
            broken.append(f"{name} — allow-listed but the file does not exist")
        elif f"tests/{name}" not in workflow:
            broken.append(f"{name} — allow-listed (so committed) but CI never runs it")
    if broken:
        for line in broken:
            print(f"    {line}")
        rep.bad("allow-list and CI workflow disagree")
    else:
        rep.ok("every allow-listed suite exists and is run by CI")

    # A brand-new local suite is git-IGNORED, so it never shows in `git status`.
    # Advisory only: most stay local deliberately.
    newer = []
    head = REPO_ROOT / ".git" / "HEAD"
    if head.exists():
        for line in git("ls-files", "--others", "--ignored", "--exclude-standard",
                        "--", "backend/tests").splitlines():
            if not re.search(r"test_.*\.py$", line):
                continue
            name = Path(line).name
            if f"!backend/tests/{name}" in gitignore:
                continue
            try:
                if (REPO_ROOT / line).stat().st_mtime > head.stat().st_mtime:
                    newer.append(name)
            except OSError:
                pass
    if newer:
        print("  local-only test files newer than HEAD: " + ", ".join(newer))
        print("  if one guards this change it needs the .gitignore allow-list AND the workflow.")


def guardrail_steps(core, rep: Report, files: list[str]) -> None:
    rep.section("Guardrail (patch validation)")
    result = run([sys.executable, "scripts/ci/guardrail_check.py", "--diff"], REPO_ROOT)
    if result is None:
        rep.skip("guardrail", "python not available")
    else:
        print((result.stdout or "").rstrip())
        if result.returncode == 1:
            rep.bad("guardrail BLOCK — resolve before reporting done")
        elif result.returncode == 2:
            rep.unverifiable("guardrail verdict", "UNKNOWN — no rule covers this change")
        else:
            rep.ok("no blocking issue")

    if any(re.search(r"^backend/app/services/(semantic_|dataset_model|dataset_calendar|"
                     r"filter_propagation|type_override|chart_contracts|chart_semantic|chart_service)", f)
           for f in files):
        rep.section("Guardrail (rules health + semantic contract)")
        result = run([sys.executable, "scripts/ci/guardrail_check.py", "--health"], REPO_ROOT)
        if result and result.returncode == 0:
            rep.ok("no drift")
        elif result:
            print((result.stdout or "").rstrip())
            rep.bad("contract DRIFT — update guardrail_rules.yaml in this change")

    if core:
        run_required_tests(core, files, rep)


def claude_config(rep: Report) -> None:
    rep.section("Agent contract (Claude + Codex adapters)")
    result = run([sys.executable, "scripts/ci/check_agent_config.py"], REPO_ROOT)
    if result is None:
        rep.skip("agent config", "python not available")
    elif result.returncode == 0:
        rep.ok("agent contract + Claude/Codex adapters valid")
    else:
        print((result.stdout or "") + (result.stderr or ""))
        rep.bad("agent contract invalid")


# ── Entrypoint ────────────────────────────────────────────────────────────
def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("tier", nargs="?", default="fast", choices=["fast", "task"])
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    # With --json the machine-readable payload owns stdout and the human log goes
    # to stderr. Interleaving the two on one stream makes the JSON unparseable for
    # any caller — and the Stop hook is exactly such a caller.
    real_stdout = sys.stdout
    if args.json:
        sys.stdout = sys.stderr

    def finish(code: int, payload: dict) -> int:
        if args.json:
            sys.stdout = real_stdout
            print(json.dumps(payload, indent=2))
        return code

    files = changed_files()
    if not files:
        print(f"verify({args.tier}): working tree clean - nothing to verify.")
        return finish(0, {"tier": args.tier, "clean": True, "passed": [],
                          "failed": [], "unverified": [], "skipped": []})

    def touched(pattern: str) -> bool:
        return any(re.search(pattern, f) for f in files)

    rep = Report()

    if touched(r"^frontend/"):
        frontend_typecheck(rep)
        frontend_qa(rep, touched)
    if touched(r"^backend/alembic/|^backend/app/models/"):
        alembic_chain(rep)

    if args.tier == "task":
        if touched(r"^backend/app/"):
            backend_import_smoke(rep)
        backend_tests_reach_ci(rep, files)
        if touched(r"^\.claude/|^AGENTS\.md$|^scripts/ci/check_(claude|agent)_config\.py$"):
            claude_config(rep)
        guardrail_steps(load_guardrail(), rep, files)

    # ── Summary ──
    print()
    if rep.unverified:
        print(f"{YELLOW}{BOLD}NOT VERIFIED — these required gates did not run:{OFF}")
        for name, why in rep.unverified:
            print(f"  - {name}: {why}")
        print("  Report every line above as unverified. Do NOT present them as coverage.")
        print()

    payload = {"tier": args.tier, "clean": False, "passed": rep.passed,
               "failed": rep.failed, "unverified": rep.unverified, "skipped": rep.skipped}

    if rep.failed:
        print(f"{RED}verify({args.tier}) FAILED - fix the above. The task is not done.{OFF}")
        return finish(1, payload)
    if not rep.passed and not rep.unverified:
        print(f"verify({args.tier}): nothing applicable to the changed paths.")
        return finish(0, payload)
    print(f"{GREEN}verify({args.tier}) passed{OFF}"
          + (f" - with {len(rep.unverified)} unverified gate(s)" if rep.unverified else ""))
    if args.tier == "fast":
        print("  (fast tier only - run 'python scripts/ci/verify.py task' before calling it done)")
    return finish(0, payload)


if __name__ == "__main__":
    sys.exit(main())
