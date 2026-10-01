"""READ-ONLY audit: classify every persisted relationship with the runtime reader.

Runs `read_join_contract` (the one reader every runtime consumer uses) over
every row of `semantic_explores.joins` and prints counts plus every row that is
not plainly valid. It never writes. Run it against each environment before a
deploy that carries the relationship contract:

    DATABASE_URL=postgresql://<ro user>:<pw>@<host>:<port>/<db> \
        PYTHONPATH=backend python backend/scripts/audit_relationship_contract.py [--json out.json]

Exit code 0 = no row would block runtime; 2 = at least one active/unknown-
activation invalid row (every query on that model would be refused).
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from collections import Counter, defaultdict

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import sqlalchemy as sa  # noqa: E402

from app.services.semantic_join_resolver import read_join_contract  # noqa: E402


def classify(rows, views_by_dataset, explore_dataset, chart_datasets, public_datasets):
    counts: Counter = Counter()
    findings: list[dict] = []
    identities: dict = defaultdict(list)
    nodes: dict = defaultdict(set)
    for explore_id, model_id, base, joins in rows:
        dataset_id = explore_dataset.get(explore_id)
        for idx, join in enumerate(joins or []):
            counts["TOTAL"] += 1
            c = read_join_contract(base, join)
            cats: list[str] = []
            if c.valid:
                cats.append("valid_supported_legacy" if c.legacy else "valid_canonical")
                if not c.is_active:
                    cats.append("explicit_inactive_valid")
            elif c.dormant:
                cats.append("explicit_inactive_invalid")
            else:
                cats.append("active_invalid")
            if not c.activation_known:
                cats.append("unknown_activation")
            reasons = " ".join(c.invalid)
            if "cardinality" in reasons or "relationship" in reasons:
                cats.append("unsupported_cardinality")
            if any(w in reasons for w in ("khoá", "biểu thức", "sql_on", "điều kiện", "cột")):
                cats.append("malformed_key_expression")
            known = views_by_dataset.get(dataset_id) if dataset_id is not None else None
            if known is not None and isinstance(join, dict) and join.get("view") and join["view"] not in known:
                cats.append("cross_dataset_or_missing_view")
            if c.valid:
                key = (model_id, c.identity)
                identities[key].append((explore_id, idx))
                if c.alias and c.alias in (known or set()) and c.alias != c.view:
                    cats.append("alias_collision")
                nodes[(model_id, base)].add(c.node)
            for cat in cats:
                counts[cat] += 1
            if not c.valid or c.legacy or set(cats) - {"valid_canonical", "explicit_inactive_valid"}:
                findings.append({
                    "dataset_id": dataset_id, "model_id": model_id, "explore_id": explore_id,
                    "base": base, "index": idx,
                    "view": join.get("view") if isinstance(join, dict) else None,
                    "alias": c.alias, "active": c.is_active if c.activation_known else None,
                    "categories": cats, "invalid": list(c.invalid), "legacy": list(c.legacy),
                    "dataset_has_charts": dataset_id in chart_datasets,
                    "dataset_on_public_link": dataset_id in public_datasets,
                })
    for (model_id, _ident), where in identities.items():
        if len(where) > 1:
            counts["duplicate_semantic_identity"] += len(where)
            findings.append({"model_id": model_id, "duplicate_identity_rows": where,
                             "categories": ["duplicate_semantic_identity"]})
    return counts, findings


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", help="write the full findings here")
    args = ap.parse_args()
    url = os.environ["DATABASE_URL"]
    engine = sa.create_engine(url)
    with engine.connect() as c:
        c.execute(sa.text("SET TRANSACTION READ ONLY")) if url.startswith("postgres") else None
        rows = [(r[0], r[1], r[2], r[3] if not isinstance(r[3], str) else json.loads(r[3]))
                for r in c.execute(sa.text("SELECT id, model_id, base_view_name, joins FROM semantic_explores"))]
        explore_dataset = {r[0]: r[1] for r in c.execute(sa.text(
            "SELECT e.id, m.dataset_id FROM semantic_explores e JOIN semantic_models m ON m.id = e.model_id"))}
        views_by_dataset: dict = defaultdict(set)
        for ds, name in c.execute(sa.text(
                "SELECT t.dataset_id, v.name FROM semantic_views v JOIN dataset_tables t ON t.id = v.dataset_table_id")):
            views_by_dataset[ds].add(name)
        for ds, model_id in c.execute(sa.text("SELECT dataset_id, id FROM semantic_models WHERE dataset_id IS NOT NULL")):
            for (vname,) in c.execute(sa.text(
                    "SELECT DISTINCT jsonb_array_elements(joins::jsonb)->>'view' FROM semantic_explores WHERE model_id=:m"),
                    {"m": model_id}):
                if vname and vname.endswith("__date_dim"):
                    views_by_dataset[ds].add(vname)  # role-played calendar views have no table
        chart_ds_sql = (
            "SELECT c.id, COALESCE(t.dataset_id, CASE WHEN (c.config::jsonb->>'datasetId') ~ '^[0-9]+$' "
            "THEN (c.config::jsonb->>'datasetId')::int END) AS dataset_id "
            "FROM charts c LEFT JOIN dataset_tables t ON t.id = c.dataset_table_id"
        )
        chart_datasets = {r[1] for r in c.execute(sa.text(chart_ds_sql)) if r[1] is not None}
        public_datasets = {r[0] for r in c.execute(sa.text(
            f"SELECT DISTINCT cd.dataset_id FROM ({chart_ds_sql}) cd "
            "JOIN dashboard_charts dc ON dc.chart_id = cd.id JOIN dashboards d ON d.id = dc.dashboard_id "
            "WHERE d.share_token IS NOT NULL OR EXISTS (SELECT 1 FROM dashboard_public_links l "
            "WHERE l.dashboard_id = d.id AND l.is_active)")) if r[0] is not None}
    counts, findings = classify(rows, views_by_dataset, explore_dataset, chart_datasets, public_datasets)
    print(json.dumps({"database": url.split("@")[-1], "counts": dict(counts)}, ensure_ascii=False, indent=1))
    for f in findings:
        if set(f.get("categories", [])) - {"valid_supported_legacy"}:
            print(json.dumps(f, ensure_ascii=False))
    if args.json:
        with open(args.json, "w", encoding="utf-8") as fh:
            json.dump({"counts": dict(counts), "findings": findings}, fh, ensure_ascii=False, indent=1)
    return 2 if counts.get("active_invalid") else 0


if __name__ == "__main__":
    raise SystemExit(main())
