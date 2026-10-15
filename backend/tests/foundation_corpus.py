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
# Semantic Kernel Contract v2 (cross-view derived measures). A formula over measures of other
# views is arithmetic over those measures' OWN answers. History, kept because it must never
# return: customers.n counts 4 customers (C1..C4) whatever the base; inlined in a formula on
# sales (JOIN-before-aggregate, 50d39a55 … 6afc9523) it counted the 5 joined sales rows —
# rev_per_cust was 39 (198 / 5, integer division), and 49 when its dependencies were asked in the
# same chart: one measure, two answers. The v1 freeze (455034e3) refused it (UNSUPPORTED_CONTEXT);
# v2 answers 198 / 4 = 49.5 and inherits every refusal of asking the dependencies together.
#
#   G1 sales  revenue 198 · by customer C1 100, C2 61, C3 30, (none) 7 · by product Pen 141, Ink 57
#      customers n 4 (C1..C4; C4 has no sale) · North C1 C3, South C2 C4
#   G2 north_rev 130 · revenue by customer region North 130, South 61, (none) 7
#   G6 revenue amount 180 · deals value 1420 · activity calls 7
#      by owner   Ann 140 / 1120 · Bob 35 / 300 · (none) 5 / —
#      by year    2024 170 / 1370 / 3 · 2025 10 / 50 / 4
#      deals Won 1300 · revenue owner 1 140 · owner Bob 35 / 300 / 3
#   G7 sales by order year 2024 191, 2025 7 · revenue 2024 170, 2025 10


def _x(cid, model, base, measures, expected, dims=(), filters=None):
    req = {"dims": list(dims), "measures": list(measures)}
    if filters:
        req["filters"] = filters
    return (cid, model, base, req, expected)


def _eq(value, **kw):
    return {"operator": "eq", "value": value, **kw}


_RPC, _ROD = "p2_sales.rev_per_cust", "p2_revenue.rev_over_deals"
XVIEW_CASES = [
    _x("F7.dependencies_asked_separately", "G1_star", "p2_sales", ["p2_sales.revenue", "p2_customers.n"],
       [{"p2_sales.revenue": 198, "p2_customers.n": 4}]),
    # ── scalar / KPI ──
    _x("F7.cross_view_formula.kpi", "G1_star", "p2_sales", [_RPC], [{_RPC: 49.5}]),
    _x("F7.cross_view_formula.kpi_base_customers", "G1_star", "p2_customers", [_RPC], [{_RPC: 49.5}]),
    _x("F7.cross_view_formula.kpi_base_products", "G1_star", "p2_products", [_RPC], [{_RPC: 49.5}]),
    _x("F7.cross_view_formula.with_dependencies", "G1_star", "p2_sales",
       ["p2_sales.revenue", "p2_customers.n", _RPC],
       [{"p2_sales.revenue": 198, "p2_customers.n": 4, _RPC: 49.5}]),
    _x("F7.formula_of_another_views_measures.kpi", "G1_star", "p2_sales", ["p2_sales.cust_half"],
       [{"p2_sales.cust_half": 2}]),
    _x("F7.cross_fact_formula.kpi", "G6_three_facts", "p2_revenue", [_ROD], [{_ROD: 180 / 1420}]),
    _x("F7.cross_fact_formula.kpi_base_deals", "G6_three_facts", "p2_deals", [_ROD], [{_ROD: 180 / 1420}]),
    _x("F7.cross_fact_formula.kpi_base_owners", "G6_three_facts", "p2_owners", [_ROD], [{_ROD: 180 / 1420}]),
    _x("F7.cross_fact_formula.declared_on_other_fact", "G6_three_facts", "p2_revenue",
       ["p2_deals.rev_over_deals_d"], [{"p2_deals.rev_over_deals_d": 180 / 1420}]),
    _x("F7.cross_fact_formula.with_dependencies", "G6_three_facts", "p2_revenue",
       ["p2_revenue.amount", "p2_deals.value", _ROD],
       [{"p2_revenue.amount": 180, "p2_deals.value": 1420, _ROD: 180 / 1420}]),
    _x("F7.nested_cross_view_formula.kpi", "G6_three_facts", "p2_revenue", ["p2_revenue.rev_per_call"],
       [{"p2_revenue.rev_per_call": (180 / 1420) / 7}]),
    _x("F7.repeated_dependency.kpi", "G6_three_facts", "p2_revenue", ["p2_revenue.rev_sq_over_deals"],
       [{"p2_revenue.rev_sq_over_deals": 180 * 180 / 1420}]),
    _x("F7.zero_denominator_other_fact.kpi", "G6_three_facts", "p2_revenue", ["p2_revenue.rev_over_zero"],
       [{"p2_revenue.rev_over_zero": None}]),
    _x("F7.null_dependency_other_fact.kpi", "G6_three_facts", "p2_revenue", ["p2_revenue.rev_over_none"],
       [{"p2_revenue.rev_over_none": None}]),
    _x("F7.cross_table_dependency.kpi", "G6_three_facts", "p2_revenue", ["p2_revenue.rev_over_deal_value"],
       [{"p2_revenue.rev_over_deal_value": 180 / 1420}]),
    _x("F7.measure_filter_dependency.kpi", "G2_snowflake", "p2_sales", ["p2_sales.north_per_cust"],
       [{"p2_sales.north_per_cust": 32.5}]),
    # ── dimensions ──
    _x("F7.cross_fact_formula.by_owner", "G6_three_facts", "p2_revenue", [_ROD],
       [{"p2_owners.name": "Ann", _ROD: 140 / 1120}, {"p2_owners.name": "Bob", _ROD: 35 / 300},
        {"p2_owners.name": None, _ROD: None}], dims=["p2_owners.name"]),
    _x("F7.cross_fact_formula.by_year", "G6_three_facts", "p2_revenue", [_ROD],
       [{"p2_cal.year": 2024, _ROD: 170 / 1370}, {"p2_cal.year": 2025, _ROD: 0.2}], dims=["p2_cal.year"]),
    _x("F7.nested_cross_view_formula.by_year", "G6_three_facts", "p2_revenue", ["p2_revenue.rev_per_call"],
       [{"p2_cal.year": 2024, "p2_revenue.rev_per_call": (170 / 1370) / 3},
        {"p2_cal.year": 2025, "p2_revenue.rev_per_call": 0.05}], dims=["p2_cal.year"]),
    _x("F7.cross_view_formula.by_customer", "G1_star", "p2_sales", [_RPC],
       [{"p2_customers.name": "C1", _RPC: 100}, {"p2_customers.name": "C2", _RPC: 61},
        {"p2_customers.name": "C3", _RPC: 30}, {"p2_customers.name": "C4", _RPC: None},
        {"p2_customers.name": None, _RPC: None}], dims=["p2_customers.name"]),
    _x("F7.formula_of_another_views_measures.by_customer", "G1_star", "p2_sales", ["p2_sales.cust_half"],
       [{"p2_customers.name": c, "p2_sales.cust_half": 0.5} for c in ("C1", "C2", "C3", "C4")],
       dims=["p2_customers.name"]),
    _x("F7.cross_view_formula.by_snowflake_region", "G2_snowflake", "p2_sales", [_RPC],
       [{"p2_regions.name": "North", _RPC: 65}, {"p2_regions.name": "South", _RPC: 30.5},
        {"p2_regions.name": None, _RPC: None}], dims=["p2_regions.name"]),
    _x("F7.conformed_calendar.by_year", "G7_roles_main", "p2_revenue", ["p2_sales.rev_over_revenue"],
       [{"p2_cal.year": 2024, "p2_sales.rev_over_revenue": 191 / 170},
        {"p2_cal.year": 2025, "p2_sales.rev_over_revenue": 0.7}], dims=["p2_cal.year"]),
    # a dimension one dependency cannot answer by: refused like asking the dependencies together
    _x("F7.cross_view_formula.by_product", "G1_star", "p2_sales", [_RPC], "FANOUT_RISK",
       dims=["p2_products.name"]),
    _x("F7.cross_fact_formula.by_deal_stage", "G6_three_facts", "p2_revenue", [_ROD], "FANOUT_RISK",
       dims=["p2_deals.stage"]),
    _x("F7.cross_fact_formula.by_revenue_id", "G6_three_facts", "p2_revenue", [_ROD], "FANOUT_RISK",
       dims=["p2_revenue.id"]),
    _x("F7.conformed_calendar.tied_roles", "G7_roles_only", "p2_revenue", ["p2_sales.rev_over_revenue"],
       "AMBIGUOUS_ROUTE", dims=["p2_cal.year"]),
    # two meanings of the sale's region: the stitch of the dependencies refuses (FANOUT_RISK, naming
    # both routes) — the category the kernel gives revenue + customers.n by region asked together
    _x("F7.cross_view_formula.ambiguous_route", "G3_diamond", "p2_sales", [_RPC], "FANOUT_RISK",
       dims=["p2_regions.name"]),
    _x("F7.cross_view_formula.route_limit", "G14_lattice", "p2_lat_fact", ["p2_lat_top.lat_half"],
       "ROUTE_LIMIT", dims=["p2_lat_top.name"]),
    _x("F7.cross_view_formula.invalid_relationship", "F10_invalid", "p2_sales", [_RPC],
       "INVALID_RELATIONSHIP"),
    # a formula that is not measure arithmetic cannot be combined across views
    _x("F7.cross_view_formula.reads_a_column", "G6_three_facts", "p2_revenue",
       ["p2_revenue.rev_col_over_deals"], "UNSUPPORTED_CONTEXT"),
    # ── filters (each dependency receives the filter as when asked on its own) ──
    _x("F7.cross_fact_formula.deal_filter", "G6_three_facts", "p2_revenue", [_ROD], [{_ROD: 180 / 1300}],
       filters={"p2_deals.stage": [_eq("Won")]}),
    _x("F7.cross_fact_formula.conformed_owner_filter", "G6_three_facts", "p2_revenue", [_ROD],
       [{_ROD: 35 / 300}], filters={"p2_owners.name": [_eq("Bob")]}),
    _x("F7.cross_fact_formula.calendar_filter", "G6_three_facts", "p2_revenue", [_ROD],
       [{_ROD: 170 / 1370}], filters={"p2_cal.year": [_eq(2024)]}),
    _x("F7.cross_fact_formula.two_predicates_one_field", "G6_three_facts", "p2_revenue", [_ROD],
       [{_ROD: 140 / 1120}],
       filters={"p2_owners.name": [{"operator": "in", "value": ["Ann", "Bob"]},
                                   {"operator": "neq", "value": "Bob"}]}),
    _x("F7.cross_view_formula.related_dimension_filter", "G2_snowflake", "p2_sales", [_RPC],
       [{_RPC: 65}], filters={"p2_regions.name": [_eq("North")]}),
    _x("F7.cross_fact_formula.formula_filter_by_owner", "G6_three_facts", "p2_revenue", [_ROD],
       [{"p2_owners.name": "Ann", _ROD: 0.125}], dims=["p2_owners.name"],
       filters={_ROD: [{"operator": "gt", "value": 0.12}]}),
    _x("F7.cross_fact_formula.authoritative_deal_filter", "G6_three_facts", "p2_revenue", [_ROD], "REFUSED",
       filters={"p2_deals.stage": [_eq("Won", _authoritative=True)]}),
]
CASES += XVIEW_CASES
# a formula over its OWN view's measures is answered at that view's grain from any base (unchanged)
CASES += [
    ("F7.formula_on_dimension_view.kpi", "G1_star", "p2_sales",
     {"dims": [], "measures": ["p2_customers.cust_ratio"]}, [{"p2_customers.cust_ratio": 2}]),
    ("F7.formula_on_dimension_view.by_customer", "G1_star", "p2_sales",
     {"dims": ["p2_customers.name"], "measures": ["p2_customers.cust_ratio"]},
     [{"p2_customers.name": c, "p2_customers.cust_ratio": 0.5} for c in ("C1", "C2", "C3", "C4")]),
]
# a filter only one dependency can reach is a RECORDED soft drop for the other (F11)
XVIEW_SOFT_DROPS = [
    ("F7.cross_fact_formula.own_fact_filter", "G6_three_facts", "p2_revenue",
     {"dims": [], "measures": [_ROD], "filters": {"p2_revenue.owner_id": [_eq(1)]}},
     {"rows": [{_ROD: 140 / 1420}], "dropped": ["p2_revenue.owner_id"]}),
]
# executed refusal: the one side of a dependency's relationship is not unique (key guard)
XVIEW_EXECUTED_REFUSALS = [
    ("F7.cross_view_formula.duplicate_one_side", "F10_dup_key", "p2_sales",
     {"dims": ["p2_customers_dup.name"], "measures": ["p2_sales.rev_per_dupcust"]}, "FANOUT_RISK"),
]
EXECUTED_REFUSALS += XVIEW_EXECUTED_REFUSALS

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
SOFT_DROP_CASES = list(XVIEW_SOFT_DROPS) + [
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
