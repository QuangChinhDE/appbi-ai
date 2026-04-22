from __future__ import annotations

import argparse
from typing import TYPE_CHECKING, Dict, List

from app.schemas.dataset import QualityRuleConfig, QualityRuleCreate

if TYPE_CHECKING:
    from app.models.dataset import DatasetTable


DEMO_PREFIX = "QA Demo - "


def _table_map(db, dataset_id: int) -> Dict[str, DatasetTable]:
    from app.models.dataset import DatasetTable

    tables = (
        db.query(DatasetTable)
        .filter(DatasetTable.dataset_id == dataset_id)
        .all()
    )
    return {str(table.source_table_name or ""): table for table in tables}


def _build_rules(dataset_id: int, tables: Dict[str, DatasetTable]) -> List[QualityRuleCreate]:
    history = tables["fifa_world_cup_history"]
    scorers = tables["fifa_world_cup_top_scorers"]
    rankings = tables["fifa_world_rankings_jan_2026"]
    calendar = tables.get("__generated_calendar__")

    return [
        QualityRuleCreate(
            table_id=rankings.id,
            column_name="Country",
            dimension="completeness",
            rule_type="not_null",
            name=f"{DEMO_PREFIX}Country must be present",
            config=QualityRuleConfig(),
            severity="error",
            enabled=True,
        ),
        QualityRuleCreate(
            table_id=history.id,
            column_name="Best_WC_Finish",
            dimension="completeness",
            rule_type="not_blank",
            name=f"{DEMO_PREFIX}Best finish should not be blank",
            config=QualityRuleConfig(),
            severity="warning",
            enabled=True,
        ),
        QualityRuleCreate(
            table_id=scorers.id,
            column_name="Player",
            dimension="completeness",
            rule_type="completeness_pct",
            name=f"{DEMO_PREFIX}Player completeness above 100%",
            config=QualityRuleConfig(threshold=100),
            severity="warning",
            enabled=True,
        ),
        QualityRuleCreate(
            table_id=history.id,
            column_name="Confederation",
            dimension="validity",
            rule_type="accepted_values",
            name=f"{DEMO_PREFIX}Confederation uses approved values",
            config=QualityRuleConfig(values=["UEFA", "CONMEBOL", "CONCACAF", "CAF", "AFC"]),
            severity="warning",
            enabled=True,
        ),
        QualityRuleCreate(
            table_id=scorers.id,
            column_name="Country",
            dimension="validity",
            rule_type="pattern_match",
            name=f"{DEMO_PREFIX}Country should be alphabetic",
            config=QualityRuleConfig(pattern=r"^[A-Za-z]+(?: [A-Za-z]+)*$"),
            severity="warning",
            enabled=True,
        ),
        QualityRuleCreate(
            table_id=rankings.id,
            column_name="Points",
            dimension="validity",
            rule_type="range_check",
            name=f"{DEMO_PREFIX}Ranking points stay within expected range",
            config=QualityRuleConfig(min=1500, max=1900),
            severity="info",
            enabled=True,
        ),
        QualityRuleCreate(
            table_id=rankings.id,
            column_name="Best_WC_Finish",
            dimension="validity",
            rule_type="format_check",
            name=f"{DEMO_PREFIX}Best finish is not a raw date field",
            config=QualityRuleConfig(format="date"),
            severity="warning",
            enabled=True,
        ),
        QualityRuleCreate(
            table_id=rankings.id,
            column_name="Rank",
            dimension="uniqueness",
            rule_type="unique_column",
            name=f"{DEMO_PREFIX}Rank is unique",
            config=QualityRuleConfig(),
            severity="error",
            enabled=True,
        ),
        QualityRuleCreate(
            table_id=scorers.id,
            dimension="uniqueness",
            rule_type="unique_combo",
            name=f"{DEMO_PREFIX}Year and host define one scorer record",
            config=QualityRuleConfig(columns=["Year", "Host"]),
            severity="error",
            enabled=True,
        ),
        QualityRuleCreate(
            table_id=scorers.id,
            dimension="consistency",
            rule_type="cross_column",
            name=f"{DEMO_PREFIX}Goals and scorer identity stay populated",
            config=QualityRuleConfig(expression='"Goals" >= 4 AND "Player" IS NOT NULL AND "Country" IS NOT NULL'),
            severity="warning",
            enabled=True,
        ),
        QualityRuleCreate(
            table_id=scorers.id,
            dimension="consistency",
            rule_type="cross_table",
            name=f"{DEMO_PREFIX}Scorer countries should exist in rankings",
            config=QualityRuleConfig(
                secondary_table_id=rankings.id,
                join_condition='src."Country" = ref."Country"',
                expression='ref."Country" IS NOT NULL',
            ),
            severity="error",
            enabled=True,
        ),
        QualityRuleCreate(
            table_id=calendar.id if calendar is not None else scorers.id,
            dimension="timeliness",
            rule_type="freshness_days",
            name=f"{DEMO_PREFIX}Calendar table should remain current",
            config=QualityRuleConfig(column="date" if calendar is not None else "Year", max_days=7 if calendar is not None else 365),
            severity="error",
            enabled=True,
        ),
        QualityRuleCreate(
            table_id=rankings.id,
            dimension="accuracy",
            rule_type="row_count_range",
            name=f"{DEMO_PREFIX}Ranking row count stays within expected band",
            config=QualityRuleConfig(min=25, max=35),
            severity="warning",
            enabled=True,
        ),
        QualityRuleCreate(
            table_id=scorers.id,
            column_name="Goals",
            dimension="accuracy",
            rule_type="statistical_range",
            name=f"{DEMO_PREFIX}Goal totals stay near the normal distribution",
            config=QualityRuleConfig(min_z=-1.25, max_z=1.25),
            severity="warning",
            enabled=True,
        ),
        QualityRuleCreate(
            table_id=scorers.id,
            dimension="accuracy",
            rule_type="custom_sql",
            name=f"{DEMO_PREFIX}Shared-country scorer rows are tracked explicitly",
            config=QualityRuleConfig(
                sql=(
                    'SELECT COUNT(*) AS rows_checked, '
                    'COALESCE(SUM(CASE WHEN "Country" IN (\'Multiple\', \'West Germany\', \'Russia / Bulgaria\') '
                    'THEN 1 ELSE 0 END), 0) AS rows_failed '
                    'FROM {{ table }}'
                )
            ),
            severity="info",
            enabled=True,
        ),
    ]


def _load_demo_context(db, dataset_id: int) -> tuple[Dataset, Dict[str, DatasetTable]]:
    from app.models.dataset import Dataset

    dataset = db.query(Dataset).filter(Dataset.id == dataset_id).first()
    if dataset is None:
        raise ValueError(f"Dataset {dataset_id} not found")

    tables = _table_map(db, dataset_id)
    required = {
        "fifa_world_cup_history",
        "fifa_world_cup_top_scorers",
        "fifa_world_rankings_jan_2026",
    }
    missing = sorted(required - set(tables))
    if missing:
        raise ValueError(f"Dataset {dataset_id} is missing required demo tables: {', '.join(missing)}")

    return dataset, tables


def preview_dataset(dataset_id: int) -> int:
    from app.core.database import SessionLocal

    db = SessionLocal()
    try:
        dataset, tables = _load_demo_context(db, dataset_id)
        rules = _build_rules(dataset_id, tables)
        table_name_by_id = {
            table.id: (table.display_name or table.source_table_name or f"table:{table.id}")
            for table in tables.values()
        }

        print(f"Dataset {dataset_id}: {dataset.name}")
        print(f"Planned QA demo rules: {len(rules)}")
        for idx, rule in enumerate(rules, start=1):
            scope = rule.column_name or "<table-level>"
            table_name = table_name_by_id.get(rule.table_id, f"table:{rule.table_id}")
            print(
                f"{idx:02d}. {rule.rule_type:<17} | dimension={rule.dimension:<12} | "
                f"severity={rule.severity:<7} | table={table_name:<32} | scope={scope}"
            )
        return 0
    finally:
        db.close()


def seed_dataset(dataset_id: int, *, run_after: bool) -> int:
    from app.core.database import SessionLocal
    from app.models.dataset import DatasetQualityRule, DatasetQualityRun
    from app.services.dataset_quality_service import DatasetQualityService

    db = SessionLocal()
    try:
        dataset, tables = _load_demo_context(db, dataset_id)

        existing_demo_rules = (
            db.query(DatasetQualityRule)
            .filter(
                DatasetQualityRule.dataset_id == dataset_id,
                DatasetQualityRule.name.like("QA Demo%"),
            )
            .all()
        )
        if existing_demo_rules:
            for rule in existing_demo_rules:
                db.delete(rule)
            db.commit()

        created = DatasetQualityService.create_rules_bulk(db, dataset_id, _build_rules(dataset_id, tables))
        print(f"Created {len(created)} QA demo rules for dataset {dataset_id}.")

        if not run_after:
            return 0

        trigger_user = str(dataset.owner_id) if dataset.owner_id else None
        run = DatasetQualityService.trigger_run(
            db,
            dataset_id,
            triggered_by_id=trigger_user,
            trigger_source="manual",
            allow_overlap=False,
        )
        if run is None:
            raise RuntimeError("Another quality run is already active for this dataset")

        DatasetQualityService.execute_run(run.id)
        completed = db.query(DatasetQualityRun).filter(DatasetQualityRun.id == run.id).first()
        if completed is None:
            raise RuntimeError("Quality run completed but the run record could not be reloaded")

        print(
            f"Run {completed.id} finished with status={completed.status} "
            f"score={completed.score if completed.score is not None else 'n/a'}"
        )
        return 0
    finally:
        db.close()


def main() -> int:
    parser = argparse.ArgumentParser(description="Seed demo quality rules for a dataset and optionally run them.")
    parser.add_argument("--dataset-id", type=int, default=4)
    parser.add_argument("--plan-only", action="store_true", help="Print the planned rule matrix for the dataset and exit.")
    parser.add_argument("--skip-run", action="store_true")
    args = parser.parse_args()
    if args.plan_only:
        return preview_dataset(args.dataset_id)
    return seed_dataset(args.dataset_id, run_after=not args.skip_run)


if __name__ == "__main__":
    raise SystemExit(main())