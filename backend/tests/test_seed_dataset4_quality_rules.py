import os
import pathlib
import sys
from types import SimpleNamespace

os.environ.setdefault("DATABASE_URL", "sqlite:///./test_seed_dataset4_quality_rules.db")
os.environ.setdefault("DATA_DIR", ".testdata")

BACKEND_ROOT = pathlib.Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app.scripts.seed_dataset4_quality_rules import DEMO_PREFIX, _build_rules


def _demo_tables():
    return {
        "fifa_world_cup_history": SimpleNamespace(
            id=11,
            source_table_name="fifa_world_cup_history",
            display_name="World Cup History",
        ),
        "fifa_world_cup_top_scorers": SimpleNamespace(
            id=12,
            source_table_name="fifa_world_cup_top_scorers",
            display_name="Top Scorers",
        ),
        "fifa_world_rankings_jan_2026": SimpleNamespace(
            id=13,
            source_table_name="fifa_world_rankings_jan_2026",
            display_name="Rankings Jan 2026",
        ),
        "__generated_calendar__": SimpleNamespace(
            id=14,
            source_table_name="__generated_calendar__",
            display_name="Date",
        ),
    }


def test_demo_rule_seed_covers_all_supported_rule_types():
    rules = _build_rules(4, _demo_tables())
    expected_rule_types = {
        "not_null",
        "not_blank",
        "completeness_pct",
        "accepted_values",
        "pattern_match",
        "range_check",
        "format_check",
        "unique_column",
        "unique_combo",
        "cross_column",
        "cross_table",
        "freshness_days",
        "row_count_range",
        "statistical_range",
        "custom_sql",
    }

    assert len(rules) == len(expected_rule_types)
    assert {rule.rule_type for rule in rules} == expected_rule_types


def test_demo_rule_seed_uses_prefixed_unique_names_and_valid_dimensions():
    rules = _build_rules(4, _demo_tables())
    expected_dimensions = {
        "completeness",
        "validity",
        "uniqueness",
        "consistency",
        "timeliness",
        "accuracy",
    }

    assert all(rule.enabled for rule in rules)
    assert all(rule.name.startswith(DEMO_PREFIX) for rule in rules)
    assert len({rule.name for rule in rules}) == len(rules)
    assert {rule.dimension for rule in rules} == expected_dimensions


def test_demo_rule_seed_spans_multiple_tables_and_severities():
    rules = _build_rules(4, _demo_tables())

    assert {rule.table_id for rule in rules} == {11, 12, 13, 14}
    assert {rule.severity for rule in rules} == {"info", "warning", "error"}

    cross_table_rule = next(rule for rule in rules if rule.rule_type == "cross_table")
    assert cross_table_rule.config.secondary_table_id == 13

    freshness_rule = next(rule for rule in rules if rule.rule_type == "freshness_days")
    assert freshness_rule.table_id == 14
    assert freshness_rule.config.column == "date"