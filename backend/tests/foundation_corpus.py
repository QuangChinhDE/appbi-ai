"""Semantic foundation corpus — oracles computed BY HAND from the rows in
tests/pair2_topology.py (``nums`` / ``thirds``), never from generated SQL.

Numeric meaning (Semantic Kernel Contract v1): ``/`` is TRUE division and a
zero denominator is NULL on every engine; AVG has the same precision on every
engine; values agree to 6 decimals (``_norm``).

  nums  id grp  a  b  z  n     neg flag   big    d     pm
        1  X    5  2  0  NULL  -5  1    30000  2.50   1
        2  X    1  2  0  NULL  -1  0        0  0.25  -1
        3  Y    3  0  0  NULL  -3  0        0  1.00   2
        4  Y    4  3  0  4     -4  0        0  0.10  -2
  thirds flag 1, 0, 0

  totals  sum_a 13 (X 6, Y 7) · sum_b 7 (X 4, Y 3) · rows 4 (2, 2) · sum_d 3.85 (2.75, 1.10)
          sum_neg -13 (-6, -7) · sum_n 4 (X NULL, Y 4) · sum_z 0 · sum_flag 1 (1, 0) · sum_big 30000 (30000, 0)
  per row a / b: 2.5, 0.5, 3 / 0 → NULL, 1.333333 · half_a = a / 2: 2.5, 0.5, 1.5, 2.0
"""
from __future__ import annotations

M = "F1_numeric"
B = "p2_nums"


def _m(*names):
    return [f"{B}.{n}" for n in names]


def kpi(measure, value):
    return {f"{B}.{measure}": value}


def by_grp(measure, x, y):
    return [{f"{B}.grp": "X", f"{B}.{measure}": x}, {f"{B}.grp": "Y", f"{B}.{measure}": y}]


# (id, measure, total, X, Y): every measure asked as a KPI and grouped by grp
_NUMERIC = [
    ("sum_int", "sum_a", 13, 6, 7),
    ("count", "n_rows", 4, 2, 2),
    ("count_distinct", "n_grp", 2, 1, 1),
    ("sum_decimal", "sum_d", 3.85, 2.75, 1.10),
    ("avg_int", "avg_a", 3.25, 3, 3.5),
    # int / int: 13 / 7 — Postgres gave 1 (integer division), MySQL 1.8571 (4 digits)
    ("int_div_int", "ratio_ab", 13 / 7, 1.5, 7 / 3),
    ("int_div_count", "a_per_row", 3.25, 3, 3.5),
    ("int_div_decimal", "a_over_d", 13 / 3.85, 6 / 2.75, 7 / 1.10),
    ("decimal_div_int", "d_over_b", 0.55, 0.6875, 1.10 / 3),
    ("percent", "pct_ab", 100 * 13 / 7, 150, 100 * 7 / 3),
    ("negative", "neg_ratio", -13 / 7, -1.5, -7 / 3),
    # a zero denominator is NULL — Postgres / BigQuery raised, DuckDB returned inf
    ("zero_denominator", "zero_den", None, None, None),
    ("null_numerator", "null_num", 4 / 7, None, 4 / 3),
    ("null_denominator", "null_den", 13 / 4, None, 7 / 4),
    # 1 / 30000 — Postgres 0, MySQL 0.0000; Y is 0 / 0 → NULL
    ("small_ratio", "small_ratio", 1 / 30000, 1 / 30000, None),
    # a formula over formulas (nested depends_on)
    ("nested_formula", "ratio_of_ratio", (13 / 7) / 3.25, 1.5 / 3, (7 / 3) / 3.5),
    # row-level division inside SUM: 2.5 + 0.5 + NULL + 1.333333
    ("row_level_division", "row_ratio", 2.5 + 0.5 + 4 / 3, 3.0, 4 / 3),
    # a measure where_sql with a division: rows 1 (2.5 > 1) and 4 (1.33 > 1); 3 / 0 is NULL, not an error
    ("where_sql_division", "where_ratio", 9, 5, 4),
    # % of total: X 6 / 13, Y 7 / 13
    ("percent_of_total", "pct_a", 100, 100 * 6 / 13, 100 * 7 / 13),
    # % of a total that is 0 (pm sums to 0 overall) → NULL, never an error or inf
    ("percent_of_zero_total", "pct_pm", None, None, None),
]

CASES = []
for cid, measure, total, x, y in _NUMERIC:
    CASES.append((f"F4.{cid}.kpi", M, B, {"dims": [], "measures": _m(measure)}, [kpi(measure, total)]))
    CASES.append((f"F4.{cid}.by_grp", M, B, {"dims": [f"{B}.grp"], "measures": _m(measure)},
                  by_grp(measure, x, y)))

# a dimension that divides: half_a = a / 2 — Postgres grouped 2 (5/2) with 2 (4/2), 0 and 1
CASES.append(("F4.dimension_division", M, B, {"dims": [f"{B}.half_a"], "measures": _m("sum_b")},
              [{f"{B}.half_a": 2.5, f"{B}.sum_b": 2}, {f"{B}.half_a": 0.5, f"{B}.sum_b": 2},
               {f"{B}.half_a": 1.5, f"{B}.sum_b": 0}, {f"{B}.half_a": 2.0, f"{B}.sum_b": 3}]))
# a filter on a dividing dimension: half_a > 1 → rows 1, 3, 4 (2.5, 1.5, 2.0)
CASES.append(("F4.filter_on_division", M, B,
              {"dims": [], "measures": _m("sum_a"), "filters": {f"{B}.half_a": [{"operator": "gt", "value": 1}]}},
              [kpi("sum_a", 12)]))
# AVG of 0/1 flags: 1/3 — MySQL's AVG(int) gave 0.3333
CASES.append(("F5.avg_of_flags", M, "p2_thirds", {"dims": [], "measures": ["p2_thirds.avg_flag"]},
              [{"p2_thirds.avg_flag": 1 / 3}]))
CASES.append(("F5.rate_formula", M, "p2_thirds", {"dims": [], "measures": ["p2_thirds.rate"]},
              [{"p2_thirds.rate": 1 / 3}]))

# ── F8 — a one-to-one relationship: one extension row per sale ─────────────
# web: sales 1, 3, 4 (100 + 30 + 7) · shop: sales 2, 5 (50 + 11)
CASES += [
    ("F8.one_to_one.by_channel", "F8_one_to_one", "p2_sales",
     {"dims": ["p2_sales_ext.channel"], "measures": ["p2_sales.revenue"]},
     [{"p2_sales_ext.channel": "web", "p2_sales.revenue": 137},
      {"p2_sales_ext.channel": "shop", "p2_sales.revenue": 61}]),
    ("F8.one_to_one.filter_web", "F8_one_to_one", "p2_sales",
     {"dims": [], "measures": ["p2_sales.revenue"],
      "filters": {"p2_sales_ext.channel": [{"operator": "eq", "value": "web"}]}},
     [{"p2_sales.revenue": 137}]),
]

# ── F10 — refusals the engine alone cannot see (asked through the EXECUTING entry points) ──
# An invalid relationship (cardinality "sometimes") used by the query; a many-to-one whose one
# side has C1 twice — the key guard runs on the datasource before the query (sales of C1
# would otherwise be summed twice: C1 200, not 100).
EXECUTED_REFUSALS = [
    ("F10.invalid_relationship", "F10_invalid", "p2_sales",
     {"dims": ["p2_customers.name"], "measures": ["p2_sales.revenue"]}, "INVALID_RELATIONSHIP"),
    ("F10.duplicate_one_side", "F10_dup_key", "p2_sales",
     {"dims": ["p2_customers_dup.name"], "measures": ["p2_sales.revenue"]}, "FANOUT_RISK"),
]

# ── F7 — a formula's dependencies keep their own meaning ─────────────────────
# customers.n counts customers: 4 (C1..C4), whatever the base. Inlined in a formula on sales it
# counted the 5 joined sales rows (198 / 5 = 39.6, silently) — refused instead: each dependency is
# evaluated at its own grain only when asked as its own measure.
CASES += [
    ("F7.dependencies_asked_separately", "G1_star", "p2_sales",
     {"dims": [], "measures": ["p2_sales.revenue", "p2_customers.n"]},
     [{"p2_sales.revenue": 198, "p2_customers.n": 4}]),
    ("F7.cross_view_formula.kpi", "G1_star", "p2_sales",
     {"dims": [], "measures": ["p2_sales.rev_per_cust"]}, "UNSUPPORTED_CONTEXT"),
    ("F7.cross_view_formula.by_product", "G1_star", "p2_sales",
     {"dims": ["p2_products.name"], "measures": ["p2_sales.rev_per_cust"]}, "UNSUPPORTED_CONTEXT"),
    ("F7.cross_fact_formula.kpi", "G6_three_facts", "p2_revenue",
     {"dims": [], "measures": ["p2_revenue.rev_over_deals"]}, "UNSUPPORTED_CONTEXT"),
    # a formula over its OWN view's measures is answered at that view's grain from any base
    ("F7.formula_on_dimension_view.kpi", "G1_star", "p2_sales",
     {"dims": [], "measures": ["p2_customers.cust_ratio"]}, [{"p2_customers.cust_ratio": 2}]),
    ("F7.formula_on_dimension_view.by_customer", "G1_star", "p2_sales",
     {"dims": ["p2_customers.name"], "measures": ["p2_customers.cust_ratio"]},
     [{"p2_customers.name": c, "p2_customers.cust_ratio": 0.5} for c in ("C1", "C2", "C3", "C4")]),
]

# ── review round: the scanner never appends a division to a `--` comment ─────
# unit_a = a / b when b > 0 (the `/` starts the line after a comment): 2.5, 0.5, NULL (b = 0), 1.333
CASES.append(("F4.comment_before_division", M, B, {"dims": [f"{B}.unit_a"], "measures": _m("n_rows")},
              [{f"{B}.unit_a": 2.5, f"{B}.n_rows": 1}, {f"{B}.unit_a": 0.5, f"{B}.n_rows": 1},
               {f"{B}.unit_a": None, f"{B}.n_rows": 1}, {f"{B}.unit_a": 4 / 3, f"{B}.n_rows": 1}]))

# ── dataset-scope measures keep their own grain ───────────────────────────────
CASES += [
    # a customer column + a column of its 1:N child: joining sales in would multiply EVERY measure's
    # rows (customers.n counted 5 for 4 customers) — refused
    ("F7.mixed_grain_child_column", "G1_star", "p2_customers",
     {"dims": [], "measures": ["p2_customers.n", "p2_customers.mixed"]}, "FANOUT_RISK"),
    # a many-to-one parent's column is one row per sale: (100 + 30 + 11) * 1 + (50 + 7) * 2 = 255
    ("F7.parent_column_measure", "G1_star", "p2_sales",
     {"dims": [], "measures": ["p2_sales.revenue", "p2_sales.rev_x_prod"]},
     [{"p2_sales.revenue": 198, "p2_sales.rev_x_prod": 255}]),
    # SUM(deals.value) declared on revenue is deals' measure: the same answer as p2_deals.value —
    # 1420 as a KPI, refused grouped by a revenue-only dimension (it used to repeat 1420 per group)
    ("F7.cross_table_measure.kpi", "G6_three_facts", "p2_revenue",
     {"dims": [], "measures": ["p2_revenue.deal_value"]}, [{"p2_revenue.deal_value": 1420}]),
    ("F7.cross_table_measure.unrelated_dim", "G6_three_facts", "p2_revenue",
     {"dims": ["p2_revenue.id"], "measures": ["p2_revenue.deal_value"]}, "UNRELATED_GRAIN"),
    ("F7.plain_measure.unrelated_dim", "G6_three_facts", "p2_revenue",
     {"dims": ["p2_revenue.id"], "measures": ["p2_deals.value"]}, "UNRELATED_GRAIN"),
]

# ── a filter one measure's fact cannot reach is a RECORDED soft drop on every entry point ──
# revenue's own owner filter (owner 1: 100 + 40) does not filter deals / activity (PowerBI parity)
SOFT_DROP_CASES = [
    ("F11.isolated_measure_unreachable_filter", "G6_three_facts", "p2_revenue",
     {"dims": [], "measures": ["p2_revenue.amount", "p2_deals.value", "p2_activity.calls"],
      "filters": {"p2_revenue.owner_id": [{"operator": "eq", "value": 1}]}},
     {"rows": [{"p2_revenue.amount": 140, "p2_deals.value": 1420, "p2_activity.calls": 7}],
      "dropped": ["p2_revenue.owner_id"]}),
    # deals has no relationship at all: the owner filter (Ann: 100 + 40) filters revenue only, and
    # the isolated deals measure (1420, unfiltered) RECORDS that it left the filter out
    ("F11.unrelated_fact_filter_recorded", "F11_unrelated_fact", "p2_revenue",
     {"dims": [], "measures": ["p2_revenue.amount", "p2_deals.value"],
      "filters": {"p2_owners.name": [{"operator": "eq", "value": "Ann"}]}},
     {"rows": [{"p2_revenue.amount": 140, "p2_deals.value": 1420}], "dropped": ["p2_owners.name"]}),
]

# an unsupported operator is a HARD reason: a text operator on a DATE column is refused (it used
# to be soft-dropped by the engine — and the drop vanished on a cache hit)
CASES.append(("F11.text_operator_on_a_date_refused", "G1_star", "p2_sales",
              {"dims": [], "measures": ["p2_sales.revenue"],
               "filters": {"p2_sales.order_date": [{"operator": "contains", "value": "2024"}]}}, "REFUSED"))
