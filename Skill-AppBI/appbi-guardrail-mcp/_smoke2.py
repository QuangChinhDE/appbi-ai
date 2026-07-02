"""Verify the CORRECTED, code-grounded contract."""
import json, os, sys
try: sys.stdout.reconfigure(encoding="utf-8")
except Exception: pass
sys.path.insert(0, os.path.dirname(__file__))
os.environ.setdefault("APPBI_REPO_ROOT", os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))
import guardrail_core as c

def show(t, o): print("\n=== " + t + " ===\n" + json.dumps(o, ensure_ascii=False, default=str)[:1400])

# A) self-audit: are the rules GROUNDED (no blind removed-pattern markers)?
h = c.check_rules_health()
show("check_rules_health (must be healthy = grounded, not blind)",
     {"status": h["status"], "stale": h["stale_removed_patterns"], "missing": h["missing_files"]})

# B) semantic backbone drift: all files+symbols present, nothing unregistered?
sc = c.verify_semantic_contract()
show("verify_semantic_contract (must be ok)",
     {"status": sc["status"], "missing_files": sc["missing_files"],
      "missing_symbols": sc["missing_symbols"], "unregistered": sc["unregistered_semantic_files"],
      "files_checked": sc["files_checked"]})

# C) corrected distinct guard fires on removing the REAL marker (_appbi_semi_key / UNION DISTINCT)
diff_distinct = """--- a/backend/app/services/dataset_model_service.py
+++ b/backend/app/services/dataset_model_service.py
@@
-                            f"SELECT {inner_expr} AS _appbi_semi_key",
-                keyset = " UNION DISTINCT ".join(in_selects_by_expr[expr])
+                            f"SELECT {inner_expr}",
+                keyset = in_selects_by_expr[expr][0]
"""
r = c.check_logic_invariants(diff_distinct)
show("distinct guard on removing _appbi_semi_key/UNION DISTINCT (expect high)",
     {"ids": [(x["invariant"], x["severity"], x["trigger"]) for x in r["risk_signals"]]})

# D) fanout guard fires on removing _build_filter_exists_clause
diff_fanout = """--- a/backend/app/services/semantic_query_engine.py
+++ b/backend/app/services/semantic_query_engine.py
@@
-        clause = self._build_filter_exists_clause(view, conditions)
+        clause = "LEFT JOIN " + view + " ON ..."
"""
show("fanout guard on removing _build_filter_exists_clause (expect high)",
     {"ids": [(x["invariant"], x["severity"]) for x in c.check_logic_invariants(diff_fanout)["risk_signals"]]})

# E) symmetric-flag guard fires on the REAL config form `: bool = True`
diff_flag = """--- a/backend/app/core/config.py
+++ b/backend/app/core/config.py
@@
-    FEATURE_SYMMETRIC_AGGREGATES: bool = False
+    FEATURE_SYMMETRIC_AGGREGATES: bool = True
"""
show("symmetric flag guard on real ': bool = True' form (expect high)",
     {"ids": [(x["invariant"], x["severity"]) for x in c.check_logic_invariants(diff_flag)["risk_signals"]]})

# F) drift-detection primitive: real symbol present, renamed absent
src = c._read_repo_file("backend/app/services/dataset_model_service.py") or ""
show("drift primitive (_symbol_present)",
     {"real 'get_distinct_field_values'": c._symbol_present(src, "get_distinct_field_values"),
      "renamed 'get_distinct_field_values_X'": c._symbol_present(src, "get_distinct_field_values_X")})

print("\nSMOKE2 OK")
