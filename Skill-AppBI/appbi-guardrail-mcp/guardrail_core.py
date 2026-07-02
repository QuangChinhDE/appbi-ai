"""AppBI Engineering Guardrail — read-only analysis core.

Rule-driven, side-effect-free. Every answer comes from guardrail_rules.yaml;
anything not covered returns UNKNOWN. This module NEVER writes code, never calls
the AppBI API, and never invents a rule.
"""
from __future__ import annotations

import os
import re
import sys
from functools import lru_cache
from pathlib import Path
from typing import Any

try:
    import yaml
except Exception as exc:  # pragma: no cover
    print("PyYAML is required (pip install pyyaml)", file=sys.stderr)
    raise

_HERE = Path(__file__).resolve().parent
_RULES_PATH = Path(os.getenv("APPBI_GUARDRAIL_RULES") or (_HERE / "guardrail_rules.yaml"))


def _default_repo_root() -> Path:
    # MCP lives at <repo>/Skill-AppBI/appbi-guardrail-mcp/ → repo is two up.
    env = os.getenv("APPBI_REPO_ROOT")
    if env:
        return Path(env).resolve()
    cand = _HERE.parent.parent
    return cand.resolve()


REPO_ROOT = _default_repo_root()


@lru_cache(maxsize=1)
def load_rules() -> dict[str, Any]:
    with open(_RULES_PATH, "r", encoding="utf-8") as fh:
        return yaml.safe_load(fh) or {}


# ── path + glob helpers ──────────────────────────────────────────────────────

def norm_path(p: str) -> str:
    """Normalise a path to repo-relative, forward-slash form.

    Accepts absolute paths, diff `a/`,`b/` prefixes, `./`, and backslashes.
    """
    s = str(p or "").strip().replace("\\", "/")
    for pre in ("a/", "b/", "./"):
        if s.startswith(pre):
            s = s[len(pre):]
    # strip repo-root prefix if an absolute path was given
    root = str(REPO_ROOT).replace("\\", "/").rstrip("/")
    low = s.lower()
    if root and low.startswith(root.lower() + "/"):
        s = s[len(root) + 1:]
    return s.lstrip("/")


def _glob_to_regex(glob: str) -> str:
    g = str(glob).replace("\\", "/")
    out: list[str] = []
    i = 0
    while i < len(g):
        if g[i:i + 3] == "**/":
            out.append("(?:.*/)?")
            i += 3
        elif g[i:i + 2] == "**":
            out.append(".*")
            i += 2
        elif g[i] == "*":
            out.append("[^/]*")
            i += 1
        elif g[i] in ".+()[]{}^$|?\\":   # [] () etc are LITERAL (Next.js [token] dirs)
            out.append("\\" + g[i])
            i += 1
        else:
            out.append(g[i])
            i += 1
    return "^" + "".join(out) + "$"


@lru_cache(maxsize=4096)
def _match(glob: str, path: str) -> bool:
    return re.match(_glob_to_regex(glob), path) is not None


def match_any(path: str, globs: list[str]) -> bool:
    p = norm_path(path)
    return any(_match(g, p) for g in (globs or []))


# ── layer classification ─────────────────────────────────────────────────────

def classify_file(path: str) -> dict[str, Any] | None:
    """Return the first layer whose glob matches, or None (→ UNKNOWN)."""
    p = norm_path(path)
    for layer in load_rules().get("layers", []):
        if any(_match(g, p) for g in layer.get("match", [])):
            return layer
    return None


def _read_repo_file(path: str) -> str | None:
    fp = REPO_ROOT / norm_path(path)
    try:
        if fp.is_file():
            return fp.read_text(encoding="utf-8", errors="replace")
    except Exception:
        return None
    return None


# ── import extraction + resolution ───────────────────────────────────────────

_PY_IMPORT = re.compile(r"^\s*(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))", re.M)
# TS/JS import/export clauses. Layer boundaries are about RUNTIME dependency
# direction, so we must distinguish runtime imports from type-only ones:
# `import type … from 'x'` / `export type … from 'x'` are ERASED at compile
# time (TS isolatedModules / verbatimModuleSyntax) and create NO runtime
# dependency — they MUST NOT count for layering (else every FE module that
# imports an interface from `@/types/*` looks like a layer violation). Captures
# an optional leading `type`, and the specifier of a `… from 'x'` clause, a
# side-effect `import 'x'`, or a dynamic `import('x')` (always runtime).
_TS_IMPORT_CLAUSE = re.compile(
    r"""(?:^|[\n;])\s*(?:import|export)\s+(?P<typ>type\s+)?"""   # import/export [type]
    r"""(?:[^'"();]*?\bfrom\s+)?"""                               # optional  … from
    r"""['"](?P<spec>[^'"]+)['"]"""                               # 'specifier'
    r"""|\bimport\s*\(\s*['"](?P<dynspec>[^'"]+)['"]\s*\)""",     # dynamic import('x')
    re.S | re.M,
)


def extract_imports(path: str, text: str | None = None) -> list[str]:
    """RUNTIME module specifiers imported by a file. Type-only TS imports
    (`import type … from`) are excluded — they are erased at compile time and
    carry no layer dependency, so counting them produces false layering
    violations. Runtime detection (e.g. the public-client guard on
    `@/lib/api-client`) is unaffected."""
    p = norm_path(path)
    src = text if text is not None else _read_repo_file(p)
    if not src:
        return []
    if p.endswith((".py",)):
        specs: list[str] = []
        for m in _PY_IMPORT.finditer(src):
            specs.append(m.group(1) or m.group(2))
        return [s for s in specs if s]
    if p.endswith((".ts", ".tsx", ".js", ".jsx")):
        specs = []
        for m in _TS_IMPORT_CLAUSE.finditer(src):
            dyn = m.group("dynspec")
            if dyn:                     # dynamic import() is always runtime
                specs.append(dyn)
                continue
            if m.group("typ"):          # `import type` / `export type` → erased
                continue
            spec = m.group("spec")
            if spec:
                specs.append(spec)
        return specs
    return []


def resolve_import_to_path(spec: str, from_file: str) -> str | None:
    """Map an import specifier to a repo-relative path (best-effort), or None
    when it is external (fastapi, react, @tanstack, …) — external ⇒ no layer."""
    s = str(spec or "").strip()
    if not s:
        return None
    frm = norm_path(from_file)
    # Python: app.services.foo  /  app.core.config
    if frm.endswith(".py"):
        if s.startswith("app.") or s == "app":
            rel = s.replace(".", "/")
            return f"backend/{rel}.py"
        return None  # stdlib / 3rd-party
    # TS: @/lib/filters  → frontend/src/lib/filters
    if s.startswith("@/"):
        return f"frontend/src/{s[2:]}"
    # relative import → resolve against the importing file's dir
    if s.startswith("."):
        base = Path(frm).parent
        resolved = os.path.normpath(str(base / s)).replace("\\", "/")
        return resolved
    return None  # bare package (react, next, zod, …) → external


def import_layer(spec: str, from_file: str) -> dict[str, Any] | None:
    tgt = resolve_import_to_path(spec, from_file)
    if not tgt:
        return None
    # try the path + common suffixes for TS/py packages
    for cand in (tgt, tgt + ".ts", tgt + ".tsx", tgt + "/index.ts", tgt + ".py", tgt + "/__init__.py"):
        layer = classify_file(cand)
        if layer:
            return layer
    return classify_file(tgt)


# ── diff parsing ─────────────────────────────────────────────────────────────

def parse_diff(diff: str) -> dict[str, dict[str, list[str]]]:
    """Return {repo_rel_path: {'added': [...], 'removed': [...]}}."""
    files: dict[str, dict[str, list[str]]] = {}
    cur: str | None = None
    for line in str(diff or "").splitlines():
        if line.startswith("+++ "):
            path = line[4:].strip()
            if path and path != "/dev/null":
                cur = norm_path(path)
                files.setdefault(cur, {"added": [], "removed": []})
            continue
        if line.startswith("--- ") or line.startswith("diff --git") or line.startswith("@@") or line.startswith("index "):
            continue
        if cur is None:
            continue
        if line.startswith("+"):
            files[cur]["added"].append(line[1:])
        elif line.startswith("-"):
            files[cur]["removed"].append(line[1:])
    return files


def changed_files_from_diff(diff: str) -> list[str]:
    return list(parse_diff(diff).keys())


# ── 1. module boundaries ─────────────────────────────────────────────────────

def get_module_boundaries() -> dict[str, Any]:
    rules = load_rules()
    layers = []
    for l in rules.get("layers", []):
        layers.append({
            "id": l.get("id"),
            "label": l.get("label"),
            "match": l.get("match"),
            "may_depend_on": l.get("may_depend_on"),
        })
    return {
        "layers": layers,
        "protected": [{"id": p.get("id"), "label": p.get("label"),
                       "files": p.get("files"), "directive": p.get("directive"),
                       "required_tests": p.get("required_tests")}
                      for p in rules.get("protected", [])],
        "note": "A file may import a layer ONLY if that layer is in its may_depend_on "
                "('*' = any). A file matching no layer glob → UNKNOWN. Rules are in "
                "guardrail_rules.yaml (read-only).",
    }


# ── 2. architecture violation ────────────────────────────────────────────────

def check_architecture_violation(changed_files: list[str],
                                  imports: dict[str, list[str]] | None = None) -> dict[str, Any]:
    violations: list[dict[str, Any]] = []
    unknown_files: list[str] = []
    checked: list[dict[str, Any]] = []
    for raw in changed_files or []:
        f = norm_path(raw)
        layer = classify_file(f)
        if layer is None:
            unknown_files.append(f)
            continue
        allowed = set(layer.get("may_depend_on") or [])
        specs = (imports or {}).get(raw) or (imports or {}).get(f) or extract_imports(f)
        file_viol = []
        for spec in specs:
            il = import_layer(spec, f)
            if il is None:
                continue  # external or unresolved-internal → not judged
            lid = il.get("id")
            if "*" in allowed or lid in allowed:
                continue
            file_viol.append({
                "import": spec, "import_layer": lid,
                "reason": f"{layer['id']} must not depend on {lid} "
                          f"(allowed: {sorted(allowed)})",
            })
        checked.append({"file": f, "layer": layer["id"], "violations": len(file_viol)})
        violations.extend([{**v, "file": f, "file_layer": layer["id"]} for v in file_viol])
    verdict = "block" if violations else ("unknown" if unknown_files and not checked else "ok")
    return {
        "verdict": verdict,
        "violations": violations,
        "checked": checked,
        "unknown_files": unknown_files,
        "note": "UNKNOWN files matched no layer glob — add a layer to rules to judge them.",
    }


# ── 3. impact scope ──────────────────────────────────────────────────────────

def get_impact_scope(changed_files: list[str]) -> dict[str, Any]:
    rules = load_rules()
    feats = rules.get("features", [])
    prot = rules.get("protected", [])
    hit_features: dict[str, dict[str, Any]] = {}
    hit_protected: list[str] = []
    unmapped: list[str] = []
    per_file: list[dict[str, Any]] = []
    for raw in changed_files or []:
        f = norm_path(raw)
        fset = []
        for feat in feats:
            if match_any(f, feat.get("files", [])):
                fid = feat["id"]
                fset.append(fid)
                hit_features.setdefault(fid, {
                    "id": fid, "label": feat.get("label"),
                    "invariants": feat.get("invariants", []),
                    "required_tests": feat.get("required_tests", []),
                })
        pset = [p["id"] for p in prot if match_any(f, p.get("files", []))]
        hit_protected.extend(pset)
        layer = classify_file(f)
        if not fset and not pset:
            unmapped.append(f)
        per_file.append({"file": f, "layer": layer["id"] if layer else "UNKNOWN",
                         "features": fset, "protected": pset})
    return {
        "features": list(hit_features.values()),
        "protected_subsystems": sorted(set(hit_protected)),
        "unmapped_files": unmapped,
        "per_file": per_file,
        "note": "unmapped_files own no feature in the rule base → impact UNKNOWN for them "
                "(review manually or add a feature mapping).",
    }


# ── 4. required tests ────────────────────────────────────────────────────────

def get_required_tests(changed_files: list[str],
                       touched_features: list[str] | None = None) -> dict[str, Any]:
    rules = load_rules()
    tests_reg = rules.get("tests", {})
    want: set[str] = set()
    reasons: dict[str, list[str]] = {}

    def add(tid: str, why: str):
        want.add(tid)
        reasons.setdefault(tid, []).append(why)

    impact = get_impact_scope(changed_files)
    for feat in impact["features"]:
        for t in feat.get("required_tests", []):
            add(t, f"feature:{feat['id']}")
    for pid in impact["protected_subsystems"]:
        p = next((x for x in rules.get("protected", []) if x["id"] == pid), None)
        for t in (p or {}).get("required_tests", []):
            add(t, f"protected:{pid}")
    for fid in touched_features or []:
        feat = next((x for x in rules.get("features", []) if x["id"] == fid), None)
        if feat:
            for t in feat.get("required_tests", []):
                add(t, f"declared-feature:{fid}")
    # any FE file → tsc; any changed file at all → import_smoke suggestion
    for raw in changed_files or []:
        f = norm_path(raw)
        if f.startswith("frontend/"):
            add("tsc", "frontend change")

    required = []
    for tid in sorted(want):
        meta = tests_reg.get(tid, {})
        required.append({"id": tid, "run": meta.get("run", "UNKNOWN"),
                         "locks": meta.get("locks", "UNKNOWN"), "why": reasons.get(tid, [])})
    unknown = [t["id"] for t in required if t["run"] == "UNKNOWN"]
    return {
        "required_tests": required,
        "unknown_tests": unknown,
        "note": "Run ALL required tests before commit. UNKNOWN 'run' = test id referenced "
                "but not in the registry (add it to rules).",
    }


# ── 5. logic invariants ──────────────────────────────────────────────────────

def _scan_file_invariants(f: str, added: list[str], removed: list[str]) -> list[dict[str, Any]]:
    hits = []
    added_blob = "\n".join(added)
    removed_blob = "\n".join(removed)
    for inv in load_rules().get("invariants", []):
        if not match_any(f, inv.get("scope", [])):
            continue
        matched: list[str] = []
        kind = None
        for pat in inv.get("added_patterns", []) or []:
            try:
                if re.search(pat, added_blob):
                    kind = "added"
                    matched += [ln.strip()[:160] for ln in added if re.search(pat, ln)][:3]
            except re.error:
                continue
        for pat in inv.get("removed_patterns", []) or []:
            try:
                if re.search(pat, removed_blob):
                    kind = "removed"
                    matched += [ln.strip()[:160] for ln in removed if re.search(pat, ln)][:3]
            except re.error:
                continue
        if matched:
            hits.append({
                "invariant": inv["id"], "label": inv.get("label"),
                "file": f, "trigger": kind, "severity": inv.get("severity", "medium"),
                "message": inv.get("message"), "tests": inv.get("tests", []),
                "matched_lines": matched[:3],
            })
    return hits


def check_logic_invariants(diff: str) -> dict[str, Any]:
    per = parse_diff(diff)
    hits: list[dict[str, Any]] = []
    for f, d in per.items():
        hits.extend(_scan_file_invariants(f, d["added"], d["removed"]))
    # files in scope of some invariant but no hit → note the ones we DID check
    scoped_files = sorted({f for f in per})
    sev_order = {"high": 0, "medium": 1, "low": 2}
    hits.sort(key=lambda h: sev_order.get(h["severity"], 3))
    return {
        "risk_signals": hits,
        "high_severity": [h for h in hits if h["severity"] == "high"],
        "files_scanned": scoped_files,
        "note": "Signals are HEURISTIC (pattern match on the diff), not proofs. A hit → run "
                "the named tests. No hit ≠ safe (only means no KNOWN pattern matched). "
                "Invariants not in the rule base can't be checked → UNKNOWN.",
    }


# ── 6. validate fix plan ─────────────────────────────────────────────────────

def _match_features_by_text(text: str) -> list[dict[str, Any]]:
    t = (text or "").lower()
    out = []
    for feat in load_rules().get("features", []):
        kws = [k.lower() for k in feat.get("keywords", [])]
        matched = [k for k in kws if k in t]
        if matched:
            out.append({"id": feat["id"], "label": feat.get("label"),
                        "files": feat.get("files", []), "matched_keywords": matched,
                        "required_tests": feat.get("required_tests", []),
                        "invariants": feat.get("invariants", [])})
    return out


def validate_fix_plan(issue_description: str, proposed_files: list[str]) -> dict[str, Any]:
    rules = load_rules()
    proposed = [norm_path(f) for f in (proposed_files or [])]
    feats = _match_features_by_text(issue_description)
    findings: list[str] = []
    verdict = "ok"

    if not feats:
        findings.append("UNKNOWN: issue text matched no feature keyword — cannot judge scope. "
                        "Describe the symptom with domain terms, or add keywords to the rules.")
        verdict = "unknown"

    # expected owner files across matched features
    expected: set[str] = set()
    for feat in feats:
        expected.update(feat["files"])
    expected_hit = [f for f in proposed if any(match_any(f, [e]) for e in expected)]
    missing = [feat for feat in feats
               if not any(match_any(pf, feat["files"]) for pf in proposed)]

    # proposed files that belong to no matched feature (possible scope creep / wrong place)
    def _owned_by_matched(pf: str) -> bool:
        return any(match_any(pf, feat["files"]) for feat in feats)
    unexpected = [f for f in proposed if feats and not _owned_by_matched(f)]

    # protected touches
    protected_hit = []
    for p in rules.get("protected", []):
        for pf in proposed:
            if match_any(pf, p.get("files", [])):
                protected_hit.append({"file": pf, "subsystem": p["id"], "directive": p.get("directive")})

    if feats and missing:
        verdict = "warn"
        for feat in missing:
            findings.append(f"SCOPE GAP: the issue points at '{feat['id']}' "
                            f"(owner files {feat['files']}) but the plan doesn't touch them — "
                            f"likely fixing in the wrong place / missing the real owner.")
    if unexpected:
        verdict = "warn" if verdict == "ok" else verdict
        findings.append(f"OUT-OF-SCOPE files (own none of the matched features): {unexpected} — "
                        f"confirm they're needed or you may be widening blast radius.")
    if protected_hit:
        findings.append("PROTECTED subsystem touched — surgical change only, and run its gates: "
                        + ", ".join(sorted({p['subsystem'] for p in protected_hit})))
    # cross-layer sanity: a BE-symptom fixed only in FE (or vice-versa)
    be_feats = [f for f in feats if any(str(x).startswith("backend/") for x in f["files"])]
    fe_only_plan = proposed and all(f.startswith("frontend/") for f in proposed)
    if be_feats and fe_only_plan:
        verdict = "warn" if verdict == "ok" else verdict
        findings.append("LAYER MISMATCH: the issue maps to a BACKEND feature but the plan is "
                        "FRONTEND-only — a data/number/SQL bug is rarely fixed purely in the FE.")

    tests = get_required_tests(proposed, [f["id"] for f in feats])
    if not findings:
        findings.append("Plan scope looks consistent with the matched feature owner files.")
    return {
        "verdict": verdict,
        "matched_features": [{"id": f["id"], "label": f["label"], "matched_keywords": f["matched_keywords"]} for f in feats],
        "expected_owner_files": sorted(expected),
        "proposed_files_in_scope": expected_hit,
        "out_of_scope_files": unexpected,
        "protected_touched": protected_hit,
        "findings": findings,
        "recommended_tests": tests["required_tests"],
    }


# ── 7 + 8. validate patch / explain risk ─────────────────────────────────────

def _policy_flags(changed: list[str]) -> dict[str, Any]:
    pol = load_rules().get("policy", {})
    non_runtime = pol.get("commit_only_runtime", {}).get("non_runtime_globs", [])
    high_blast = pol.get("high_blast_files", {}).get("globs", [])
    runtime = [f for f in changed if not match_any(f, non_runtime)]
    only_non_runtime = bool(changed) and not runtime
    high = [f for f in changed if match_any(f, high_blast)]
    return {
        "only_non_runtime_changes": only_non_runtime,
        "non_runtime_files": [f for f in changed if match_any(f, non_runtime)],
        "high_blast_files": high,
    }


def validate_patch(diff: str) -> dict[str, Any]:
    per = parse_diff(diff)
    changed = list(per.keys())
    if not changed:
        return {"verdict": "unknown", "reason": "empty or unparseable diff", "changed_files": []}

    # imports from ADDED lines of each file (so we judge NEW dependencies)
    imports: dict[str, list[str]] = {}
    for f, d in per.items():
        added_src = "\n".join(d["added"])
        imports[f] = extract_imports(f, added_src)

    arch = check_architecture_violation(changed, imports)
    inv = check_logic_invariants(diff)
    impact = get_impact_scope(changed)
    tests = get_required_tests(changed)
    policy = _policy_flags(changed)

    reasons: list[str] = []
    verdict = "ok"
    if arch["violations"]:
        verdict = "block"
        reasons.append(f"{len(arch['violations'])} architecture violation(s): "
                       + "; ".join(v["reason"] for v in arch["violations"][:4]))
    if inv["high_severity"]:
        verdict = "block"
        reasons.append("HIGH-severity invariant signal(s): "
                       + "; ".join(h["invariant"] for h in inv["high_severity"]))
    med = [h for h in inv["risk_signals"] if h["severity"] == "medium"]
    if med and verdict != "block":
        verdict = "warn"
        reasons.append("medium invariant signal(s): " + "; ".join(h["invariant"] for h in med))
    if impact["protected_subsystems"]:
        if verdict == "ok":
            verdict = "warn"
        reasons.append("touches protected subsystem(s): " + ", ".join(impact["protected_subsystems"]))
    if policy["only_non_runtime_changes"]:
        reasons.append("NOTE: diff touches ONLY non-runtime files (tests/scripts/docs) — "
                       "a runtime fix should also change backend/app or frontend/src.")
    if policy["high_blast_files"] and verdict == "ok":
        verdict = "warn"
        reasons.append("high-blast-radius file(s): " + ", ".join(policy["high_blast_files"]))
    if arch["unknown_files"]:
        reasons.append("UNKNOWN layer for: " + ", ".join(arch["unknown_files"]))
    if not reasons:
        reasons.append("No architecture violation or known invariant signal detected. "
                       "Still run the recommended tests (absence of a signal ≠ safe).")

    return {
        "verdict": verdict,   # block | warn | ok | unknown
        "reasons": reasons,
        "changed_files": changed,
        "architecture": arch,
        "invariant_signals": inv["risk_signals"],
        "impact": {"features": [f["id"] for f in impact["features"]],
                   "protected": impact["protected_subsystems"],
                   "unmapped_files": impact["unmapped_files"]},
        "required_tests": tests["required_tests"],
        "policy": policy,
    }


def explain_risk(diff: str) -> dict[str, Any]:
    v = validate_patch(diff)
    rules = load_rules()
    lines: list[str] = []
    lines.append(f"VERDICT: {v['verdict'].upper()}")
    lines.append("")
    if v["impact"]["features"]:
        lines.append("Affected features: " + ", ".join(v["impact"]["features"]))
    if v["impact"]["protected"]:
        lines.append("⚠ Protected subsystem(s): " + ", ".join(v["impact"]["protected"])
                     + " — surgical change only; do NOT rewrite.")
    if v["impact"]["unmapped_files"]:
        lines.append("Unmapped files (impact UNKNOWN): " + ", ".join(v["impact"]["unmapped_files"]))
    lines.append("")
    if v["architecture"]["violations"]:
        lines.append("ARCHITECTURE (layering) risk:")
        for viol in v["architecture"]["violations"]:
            lines.append(f"  • {viol['file']}: {viol['reason']} (import: {viol['import']})")
    if v["invariant_signals"]:
        lines.append("INVARIANT / regression risk:")
        for h in v["invariant_signals"]:
            lines.append(f"  • [{h['severity']}] {h['invariant']} in {h['file']} — {h['label']}")
            if h.get("message"):
                lines.append(f"      why: {h['message'].strip()}")
    if not v["architecture"]["violations"] and not v["invariant_signals"]:
        lines.append("No known architecture/invariant pattern matched. Residual risk is UNKNOWN — "
                     "the guardrail only knows the rules in guardrail_rules.yaml.")
    lines.append("")
    dial = rules.get("policy", {}).get("dialect_blindness", {}).get("note")
    if any(f.endswith(".py") and "services" in f for f in v["changed_files"]) and dial:
        lines.append("DIALECT NOTE: " + dial.strip())
    lines.append("Tests to run: " + (", ".join(t["id"] for t in v["required_tests"]) or "none mapped (UNKNOWN)"))
    return {"verdict": v["verdict"], "explanation": "\n".join(lines),
            "required_tests": v["required_tests"]}


# ── extras ───────────────────────────────────────────────────────────────────

_SYMBOL_DEF = r"(?m)^\s*(?:async\s+def|def|class)\s+{}\b"


def _symbol_present(src: str, sym: str) -> bool:
    return re.search(_SYMBOL_DEF.format(re.escape(sym)), src) is not None


def verify_semantic_contract() -> dict[str, Any]:
    """Read the CURRENT code and assert the semantic-layer backbone still matches
    the contract inventory: every registered file + symbol must still exist
    (removed/renamed = DRIFT), and no NEW semantic-looking service may be
    unregistered. This is what makes the MCP a contract, not a one-off snapshot."""
    sc = load_rules().get("semantic_contract", {})
    files_spec = sc.get("files", {}) or {}
    globs = sc.get("semantic_file_globs", []) or []
    missing_files: list[str] = []
    missing_symbols: list[dict[str, Any]] = []
    checked: list[dict[str, Any]] = []
    for fpath, spec in files_spec.items():
        src = _read_repo_file(fpath)
        if src is None:
            missing_files.append(fpath)
            continue
        absent = [s for s in (spec.get("symbols") or []) if not _symbol_present(src, s)]
        if absent:
            missing_symbols.append({"file": fpath, "missing_symbols": absent})
        checked.append({"file": fpath, "symbols_ok": len((spec.get("symbols") or [])) - len(absent),
                        "symbols_missing": len(absent)})
    registered = {norm_path(f) for f in files_spec}
    unregistered: list[str] = []
    svc_dir = REPO_ROOT / "backend" / "app" / "services"
    if svc_dir.is_dir():
        for p in svc_dir.glob("*.py"):
            rel = norm_path(str(p))
            if rel in registered:
                continue
            if any(_match(g, rel) for g in globs):
                unregistered.append(rel)
    status = "ok" if not (missing_files or missing_symbols or unregistered) else "DRIFT"
    return {
        "status": status,
        "missing_files": missing_files,
        "missing_symbols": missing_symbols,
        "unregistered_semantic_files": sorted(unregistered),
        "files_checked": len(checked),
        "detail": checked,
        "note": "DRIFT = a backbone file/symbol was removed or renamed, or a NEW semantic-looking "
                "service appeared that is not in semantic_contract. When the backbone changes on "
                "purpose, update the contract (rules) in the SAME change so coverage never lapses.",
    }


def _scope_split(scope: list[str]) -> tuple[list[str], bool]:
    concrete, had_glob = [], False
    for s in scope or []:
        if any(ch in s for ch in "*?[]"):
            had_glob = True
        else:
            concrete.append(s)
    return concrete, had_glob


def check_rules_health() -> dict[str, Any]:
    """Self-audit the rule base for BLIND rules — the exact failure mode of a
    hand-written contract. Verifies (a) every `removed_patterns` marker actually
    EXISTS in its scope files today (else the guard matches nothing = blind/stale),
    and (b) every concrete file a rule references exists in the repo."""
    rules = load_rules()
    stale: list[dict[str, Any]] = []
    missing: list[dict[str, Any]] = []
    for inv in rules.get("invariants", []):
        concrete, had_glob = _scope_split(inv.get("scope", []))
        srcs = {f: _read_repo_file(f) for f in concrete}
        for f, src in srcs.items():
            if src is None:
                missing.append({"invariant": inv["id"], "missing_file": f})
        for pat in inv.get("removed_patterns", []) or []:
            try:
                found = any(src and re.search(pat, src) for src in srcs.values())
            except re.error as exc:
                stale.append({"invariant": inv["id"], "bad_regex": pat, "error": str(exc)})
                continue
            if not found and not had_glob and any(v is not None for v in srcs.values()):
                stale.append({"invariant": inv["id"], "removed_pattern": pat,
                              "issue": "marker ABSENT in scope today → guard is blind/stale"})
    for feat in rules.get("features", []):
        for f in feat.get("files", []):
            if not any(ch in f for ch in "*?[]") and _read_repo_file(f) is None:
                missing.append({"feature": feat["id"], "missing_file": f})
    for p in rules.get("protected", []):
        for f in p.get("files", []):
            if not any(ch in f for ch in "*?[]") and _read_repo_file(f) is None:
                missing.append({"protected": p["id"], "missing_file": f})
    healthy = not (stale or missing)
    return {
        "status": "healthy" if healthy else "issues",
        "stale_removed_patterns": stale,
        "missing_files": missing,
        "note": "stale_removed_patterns = a guard keyed on a marker no longer in the code (BLIND — "
                "fix the pattern or drop the rule). missing_files = a rule points at a path not in "
                "the repo. Run this after any semantic-layer change to keep the contract grounded.",
    }


def get_invariants(subsystem: str | None = None) -> dict[str, Any]:
    invs = load_rules().get("invariants", [])
    if subsystem:
        s = subsystem.lower()
        invs = [i for i in invs if s in (i.get("id", "") + " " + i.get("label", "")).lower()
                or any(s in g.lower() for g in i.get("scope", []))]
    return {"invariants": [{"id": i["id"], "label": i.get("label"), "scope": i.get("scope"),
                            "severity": i.get("severity"), "tests": i.get("tests")} for i in invs]}
