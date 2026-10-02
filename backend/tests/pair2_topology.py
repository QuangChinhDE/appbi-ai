"""Pair #2 golden topologies — physical data, semantic graphs and value oracles.

Shared by the Postgres golden matrix (test_pair2_golden_topology_pg.py) and
the order-invariance (metamorphic) suite. Every expected value below is
computed BY HAND from the rows in PHYSICAL, never from generated SQL.

Rows (schema `p2g`):

  sales  id cust store prod  order_date  ship_date   close_date  amount
         1  C1   S1    Pen   2024-01-15  2024-02-15  2025-03-15   100
         2  C2   S2    Ink   2024-02-15  2024-02-15  2025-03-15    50
         3  C3   S1    Pen   2024-02-15  2025-03-15  NULL          30
         4  NULL S2    Ink   2025-03-15  2025-03-15  2025-03-15     7
         5  C2   NULL  Pen   2024-01-15  NULL        2024-02-15    11
  customers C1 North, C2 South, C3 North, C4 South (C4: no sales)
  stores    S1 South, S2 North

  customer region: North 130 (C1 100 + C3 30), South 61 (C2 50 + 11), NULL 7
  store region:    South 130 (S1), North 57 (S2 50 + 7), NULL 11
  order year: 2024 191, 2025 7 | ship year: 2024 150, 2025 37, NULL 11
  close year: 2024 11, 2025 157, NULL 30

  revenue R1 d1 O1 100 | R2 d2 O1 40 | R3 d2 O2 25 | R4 d3 O2 10 | R5 d1 NULL 5
  deals   D1 d1 O1 Won 1000 | D2 d2 O2 Won 300 | D3 d3 O1 Lost 50 | D4 d2 O1 Lost 70
  activity A1 d1 O2 3 | A2 d3 O1 4         (d1 2024-01-15, d2 2024-02-15, d3 2025-03-15)
  owners  O1 Ann, O2 Bob

  composite: c_sales (N,1,10) (S,1,25) (N,2,5) (S,1,3) (N,NULL,9)
             c_stores (N,1,N-one) (N,2,N-two) (S,1,S-one); c_regions N North, S South
  bridge:    acct_rev A1 100, A2 50, A3 20; tags A1{VIP,Beta} A2{Beta}
"""
from __future__ import annotations

S = "p2g"

# table -> ([(column, type)], rows). The single source of the physical data:
# DDL/INSERTs (Postgres, DuckDB, MySQL) and inline literals (BigQuery — nothing
# is written to the warehouse) are generated from it.
TABLES = {
    "regions": ([("id", "int"), ("name", "text"), ("country_id", "int"), ("founded", "date")],
                [(1, "North", 1, "2025-03-15"), (2, "South", 2, "2024-01-15")]),
    "countries": ([("id", "int"), ("name", "text")], [(1, "Northland"), (2, "Southland")]),
    "customers": ([("id", "int"), ("name", "text"), ("region_id", "int"), ("signup", "date")],
                  [(1, "C1", 1, "2024-01-15"), (2, "C2", 2, "2025-03-15"), (3, "C3", 1, "2024-02-15"),
                   (4, "C4", 2, None)]),
    "stores": ([("id", "int"), ("name", "text"), ("region_id", "int")], [(1, "S1", 2), (2, "S2", 1)]),
    "products": ([("id", "int"), ("name", "text")], [(1, "Pen"), (2, "Ink")]),
    "sales": ([("id", "int"), ("customer_id", "int"), ("store_id", "int"), ("product_id", "int"),
               ("order_date", "date"), ("ship_date", "date"), ("close_date", "date"), ("amount", "int")],
              [(1, 1, 1, 1, "2024-01-15", "2024-02-15", "2025-03-15", 100),
               (2, 2, 2, 2, "2024-02-15", "2024-02-15", "2025-03-15", 50),
               (3, 3, 1, 1, "2024-02-15", "2025-03-15", None, 30),
               (4, None, 2, 2, "2025-03-15", "2025-03-15", "2025-03-15", 7),
               (5, 2, None, 1, "2024-01-15", None, "2024-02-15", 11)]),
    "owners": ([("id", "int"), ("name", "text")], [(1, "Ann"), (2, "Bob")]),
    "revenue": ([("id", "int"), ("rdate", "date"), ("owner_id", "int"), ("amount", "int")],
                [(1, "2024-01-15", 1, 100), (2, "2024-02-15", 1, 40), (3, "2024-02-15", 2, 25),
                 (4, "2025-03-15", 2, 10), (5, "2024-01-15", None, 5)]),
    "deals": ([("id", "int"), ("ddate", "date"), ("owner_id", "int"), ("stage", "text"), ("value", "int")],
              [(1, "2024-01-15", 1, "Won", 1000), (2, "2024-02-15", 2, "Won", 300),
               (3, "2025-03-15", 1, "Lost", 50), (4, "2024-02-15", 1, "Lost", 70)]),
    "activity": ([("id", "int"), ("adate", "date"), ("owner_id", "int"), ("calls", "int")],
                 [(1, "2024-01-15", 2, 3), (2, "2025-03-15", 1, 4)]),
    "c_regions": ([("region_code", "text"), ("label", "text")], [("N", "North"), ("S", "South")]),
    "c_stores": ([("region_code", "text"), ("store_code", "text"), ("name", "text")],
                 [("N", "1", "N-one"), ("N", "2", "N-two"), ("S", "1", "S-one")]),
    "c_sales": ([("region_code", "text"), ("store_code", "text"), ("amt", "int")],
                [("N", "1", 10), ("S", "1", 25), ("N", "2", 5), ("S", "1", 3), ("N", None, 9)]),
    "accounts": ([("id", "int"), ("name", "text")], [(1, "A1"), (2, "A2"), (3, "A3")]),
    "tags": ([("id", "int"), ("label", "text")], [(1, "VIP"), (2, "Beta")]),
    "account_tags": ([("account_id", "int"), ("tag_id", "int")], [(1, 1), (1, 2), (2, 2)]),
    "ties": ([("id", "int"), ("name", "text"), ("v", "int")],
             [(1, "C", 80), (2, "A", 100), (3, "B", 80), (4, "D", 50), (5, "E", None), (6, "A", 0)]),
    "acct_rev": ([("id", "int"), ("account_id", "int"), ("amount", "int")], [(1, 1, 100), (2, 2, 50), (3, 3, 20)]),
    # route bounds (G14 / G15): a lattice whose 2^7 forward chains exceed the route cap, and a
    # chain longer than the depth bound
    "lat_fact": ([("id", "int"), ("k", "int"), ("amount", "int")], [(1, 1, 5)]),
    "lat": ([("id", "int"), ("name", "text")], [(1, "L")]),
    "chain": ([("id", "int")], [(1,), (2,)]),
    # two pass-through product dimensions that each miss a product (an orphan each): Pen only / Ink only
    "products_a": ([("id", "int"), ("name", "text")], [(1, "Pen")]),
    "products_b": ([("id", "int"), ("name", "text")], [(2, "Ink")]),
    # instants (UTC) under an Asia/Ho_Chi_Minh (+7) calendar: e1 is local 2024-01-01, e3 local 2025-01-01
    "events_tz": ([("id", "int"), ("ts", "timestamp"), ("amount", "int")],
                  [(1, "2023-12-31 20:00:00", 10), (2, "2024-06-01 12:00:00", 5), (3, "2024-12-31 18:00:00", 3)]),
    # Semantic foundation — numeric meaning (tests/foundation_corpus.py): integers that do not
    # divide evenly, a decimal, a zero column, a NULL-mostly column, negatives, a 1-in-30000
    # ratio, and a column whose total is 0 (a zero denominator for % of total)
    "nums": ([("id", "int"), ("grp", "text"), ("a", "int"), ("b", "int"), ("z", "int"), ("n", "int"),
              ("neg", "int"), ("flag", "int"), ("big", "int"), ("d", "dec"), ("pm", "int")],
             [(1, "X", 5, 2, 0, None, -5, 1, 30000, "2.50", 1),
              (2, "X", 1, 2, 0, None, -1, 0, 0, "0.25", -1),
              (3, "Y", 3, 0, 0, None, -3, 0, 0, "1.00", 2),
              (4, "Y", 4, 3, 0, 4, -4, 0, 0, "0.10", -2)]),
    "thirds": ([("id", "int"), ("flag", "int")], [(1, 1), (2, 0), (3, 0)]),
    # foundation F8: one extension row per sale (1:1); F10: customers with C1 twice (a one side that
    # is not unique — the key guard must refuse the join, never sum C1's sales twice)
    "sales_ext": ([("sale_id", "int"), ("channel", "text")],
                  [(1, "web"), (2, "shop"), (3, "web"), (4, "web"), (5, "shop")]),
    "customers_dup": ([("id", "int"), ("name", "text")], [(1, "C1"), (1, "C1-dup"), (2, "C2"), (3, "C3")]),
}

DIALECTS = ("postgresql", "duckdb", "mysql", "bigquery")


def _lit(v, typ, dialect):
    if v is None:
        return "NULL"
    if typ == "int":
        return str(int(v))
    if typ == "date":
        return f"DATE '{v}'"
    if typ == "timestamp":
        return f"TIMESTAMP '{v}'"
    if typ == "dec":
        return f"NUMERIC '{v}'" if dialect == "bigquery" else str(v)
    return "'" + str(v).replace("'", "''") + "'"


_DDL_TYPE = {"dec": "decimal(10,2)"}


def physical_sql(dialect: str) -> list:
    """DDL + INSERTs into schema/database `p2g` (not BigQuery: inline there)."""
    out = []
    for table, (cols, rows) in TABLES.items():
        out.append(f"CREATE TABLE {S}.{table}(" + ", ".join(f"{c} {_DDL_TYPE.get(t, t)}" for c, t in cols) + ")")
        out.append(f"INSERT INTO {S}.{table} VALUES " + ", ".join(
            "(" + ", ".join(_lit(v, t, dialect) for v, (_c, t) in zip(r, cols)) + ")" for r in rows))
    return out


_BQ_TYPE = {"int": "INT64", "text": "STRING", "date": "DATE", "timestamp": "TIMESTAMP", "dec": "NUMERIC"}


def calendar_sql(dialect: str) -> str:
    """The generated calendar of each dialect (recognised by its marker, as the
    engine recognises a generated calendar without a backing table)."""
    if dialect == "bigquery":
        return ("(SELECT d AS date, EXTRACT(YEAR FROM d) AS year, EXTRACT(MONTH FROM d) AS month "
                "FROM UNNEST(GENERATE_DATE_ARRAY(DATE '2024-01-01', DATE '2025-12-31')) AS d)")
    if dialect == "mysql":
        return ("(WITH RECURSIVE calendar_series AS (SELECT DATE '2024-01-01' AS d UNION ALL "
                "SELECT d + INTERVAL 1 DAY FROM calendar_series WHERE d < DATE '2025-12-31') "
                "SELECT d AS date, YEAR(d) AS year, MONTH(d) AS month FROM calendar_series)")
    return ("(SELECT CAST(d AS date) AS date, CAST(EXTRACT(YEAR FROM d) AS int) AS year, "
            "CAST(EXTRACT(MONTH FROM d) AS int) AS month "
            "FROM generate_series(DATE '2024-01-01', DATE '2025-12-31', INTERVAL '1 day') AS t(d))")


def view_relation(spec: str, dialect: str) -> str:
    """`T:<table>` → the table (or BigQuery inline rows); `CAL` → the calendar;
    `CTE:<table>` → the table behind a NESTED-CTE source query, baked the way
    a sql_query dataset table is (`(SELECT * FROM (<user sql>) AS _src)`)."""
    if spec == "CAL":
        return calendar_sql(dialect)
    if spec.startswith("CTE:"):
        inner = view_relation("T:" + spec.split(":", 1)[1], dialect)
        return (f"(SELECT * FROM (WITH a AS (WITH b AS (SELECT * FROM {inner} AS _t) SELECT * FROM b) "
                "SELECT * FROM a) AS _src)")
    table = spec.split(":", 1)[1]
    if dialect != "bigquery":
        return f"{S}.{table}"
    cols, rows = TABLES[table]
    struct = "STRUCT<" + ", ".join(f"{c} {_BQ_TYPE[t]}" for c, t in cols) + ">"
    # STRUCT(...) — a bare `(1)` is the INT64 1, not a one-field struct
    values = ", ".join("STRUCT(" + ", ".join(_lit(v, t, dialect) for v, (_c, t) in zip(r, cols)) + ")" for r in rows)
    return f"(SELECT * FROM UNNEST(ARRAY<{struct}>[{values}]))"


def _dims(*names, types=None):
    types = types or {}
    return [{"name": n, "type": types.get(n, "string"), "sql": f"${{TABLE}}.{n}"} for n in names]


def _sum(name, col):
    return {"name": name, "type": "sum", "sql": f"${{TABLE}}.{col}"}


_DATES = {"order_date": "date", "ship_date": "date", "close_date": "date", "rdate": "date", "ddate": "date",
          "adate": "date", "date": "date", "signup": "date", "founded": "date"}

# view name -> (relation, dimensions, measures)
VIEWS = {
    "p2_regions": ("T:regions", _dims("id", "name", "country_id", "founded", types=_DATES), []),
    "p2_countries": ("T:countries", _dims("id", "name"), []),
    "p2_regions_cte": ("CTE:regions", _dims("id", "name"), []),
    "p2_customers": ("T:customers", _dims("id", "name", "region_id", "signup", types=_DATES),
                     [{"name": "n", "type": "count", "sql": "*"},
                      # foundation F7: a formula over its own view's measure
                      {"name": "cust_ratio", "type": "sum", "expression": "${n} / 2", "depends_on": ["n"]},
                      # foundation A3: a customer column + a column of its 1:N child (sales) — refused
                      {"name": "mixed", "type": "sum", "expression": "${TABLE}.id + ${p2_sales.amount}",
                       "scope": "dataset", "source_columns": [{"view": "p2_sales", "field": "amount"}]}]),
    "p2_stores": ("T:stores", _dims("id", "name", "region_id"), []),
    "p2_products": ("T:products", _dims("id", "name"), []),
    # a pass-through dimension over the same product key (G12 equivalence)
    "p2_products_dim": ("T:products", _dims("id", "name"), []),
    "p2_pda": ("T:products_a", _dims("id", "name"), []),
    "p2_pdb": ("T:products_b", _dims("id", "name"), []),
    "p2_sales": ("T:sales", _dims("id", "customer_id", "store_id", "product_id", "order_date", "ship_date",
                                    "close_date", types=_DATES),
                 [_sum("revenue", "amount"),
                  {"name": "rev_pct", "type": "percent_of_total", "sql": "${TABLE}.amount"},
                  {**_sum("rev_all", "amount"), "context_modifiers": [{"type": "all"}]},
                  # a measure-level filter on a RELATED view (CALCULATE-style)
                  {**_sum("north_rev", "amount"),
                   "filters": [{"field": "p2_regions.name", "operator": "eq", "value": "North"}]},
                  # a measure-level filter on the sale's product
                  {**_sum("pen_rev", "amount"),
                   "filters": [{"field": "p2_products.name", "operator": "eq", "value": "Pen"}]},
                  # foundation F7: a formula over a measure of ANOTHER view (customers) — refused
                  {"name": "rev_per_cust", "type": "sum", "expression": "${revenue} / ${p2_customers.n}",
                   "depends_on": ["revenue", "p2_customers.n"]},
                  # foundation A3: a many-to-one parent's column (one product row per sale) — answered
                  {"name": "rev_x_prod", "type": "sum", "expression": "${TABLE}.amount * ${p2_products.id}",
                   "scope": "dataset", "source_columns": [{"view": "p2_products", "field": "id"}]},
                  # foundation V1: a formula is never re-aggregated (explicit agg ≠ its type → refused)
                  {"name": "rev_share", "type": "number", "expression": "${revenue} / NULLIF(${revenue}, 0)",
                   "depends_on": ["revenue"]}]),
    "p2_owners": ("T:owners", _dims("id", "name"), []),
    "p2_revenue": ("T:revenue", _dims("id", "rdate", "owner_id", types=_DATES),
                   [_sum("amount", "amount"),
                    # foundation F7: a formula over ANOTHER fact's measure — refused
                    {"name": "rev_over_deals", "type": "sum", "expression": "${amount} / ${p2_deals.value}",
                     "depends_on": ["amount", "p2_deals.value"]},
                    # foundation B1: declared on revenue, aggregates deals.value only (its grain is deals)
                    {"name": "deal_value", "type": "sum", "expression": "${p2_deals.value}", "scope": "dataset",
                     "source_columns": [{"view": "p2_deals", "field": "value"}]}]),
    "p2_deals": ("T:deals", _dims("id", "ddate", "owner_id", "stage", types=_DATES), [_sum("value", "value")]),
    "p2_activity": ("T:activity", _dims("id", "adate", "owner_id", types=_DATES), [_sum("calls", "calls")]),
    # the generated calendar (main) and two role-played date dims of sales
    "p2_cal": ("CAL", _dims("date", "year", "month", types={"date": "date", "year": "number", "month": "number"}),
               []),
    "p2_sales__ship_date__date_dim": ("CAL", _dims("date", "year", "month",
                                                     types={"date": "date", "year": "number", "month": "number"}), []),
    "p2_sales__close_date__date_dim": ("CAL", _dims("date", "year", "month",
                                                      types={"date": "date", "year": "number", "month": "number"}), []),
    "p2_c_regions": ("T:c_regions", _dims("region_code", "label"), []),
    "p2_c_stores": ("T:c_stores", _dims("region_code", "store_code", "name"), []),
    "p2_c_sales": ("T:c_sales", _dims("region_code", "store_code"), [_sum("amt", "amt")]),
    "p2_accounts": ("T:accounts", _dims("id", "name"), []),
    "p2_tags": ("T:tags", _dims("id", "label"), []),
    "p2_account_tags": ("T:account_tags", _dims("account_id", "tag_id"), []),
    "p2_acct_rev": ("T:acct_rev", _dims("id", "account_id"), [_sum("amount", "amount")]),
    "p2_ties": ("T:ties", _dims("id", "name"), [_sum("total", "v")]),
    "p2_lat_fact": ("T:lat_fact", _dims("id", "k"), [_sum("amount", "amount")]),
    "p2_lat_top": ("T:lat", _dims("id", "name"), []),
    "p2_events_tz": ("T:events_tz",
                     [{"name": "id", "type": "number", "sql": "${TABLE}.id"},
                      {"name": "ts", "type": "datetime", "source_type": "timestamp", "sql": "${TABLE}.ts"}],
                     [_sum("total", "amount")]),
}


def _formula(name, expression, *deps):
    return {"name": name, "type": "sum", "expression": expression, "depends_on": list(deps)}


# Semantic foundation — numeric meaning. Division is TRUE division and a zero denominator is
# NULL on every engine (app/services/semantic_arithmetic.py); oracles in tests/foundation_corpus.py.
VIEWS["p2_nums"] = (
    "T:nums",
    [{"name": "id", "type": "number", "sql": "${TABLE}.id"},
     {"name": "grp", "type": "string", "sql": "${TABLE}.grp"},
     {"name": "half_a", "type": "number", "sql": "${TABLE}.a / 2"},
     # the `/` starts the line after a `--` comment (the rewrite must never append to the comment)
     {"name": "unit_a", "type": "number",
      "sql": "CASE WHEN ${TABLE}.b > 0 THEN ${TABLE}.a -- per b\n / ${TABLE}.b ELSE NULL END"}],
    [_sum("sum_a", "a"), _sum("sum_b", "b"), _sum("sum_z", "z"), _sum("sum_n", "n"), _sum("sum_neg", "neg"),
     _sum("sum_flag", "flag"), _sum("sum_big", "big"), _sum("sum_d", "d"),
     {"name": "n_rows", "type": "count", "sql": "*"},
     {"name": "n_grp", "type": "count_distinct", "sql": "${TABLE}.grp"},
     {"name": "avg_a", "type": "avg", "sql": "${TABLE}.a"},
     {"name": "row_ratio", "type": "sum", "sql": "${TABLE}.a / ${TABLE}.b"},
     {**_sum("where_ratio", "a"), "where_sql": "${TABLE}.a / ${TABLE}.b > 1"},
     {"name": "pct_a", "type": "percent_of_total", "sql": "${TABLE}.a"},
     {"name": "pct_pm", "type": "percent_of_total", "sql": "${TABLE}.pm"},
     _formula("ratio_ab", "${sum_a} / ${sum_b}", "sum_a", "sum_b"),
     _formula("a_per_row", "${sum_a} / ${n_rows}", "sum_a", "n_rows"),
     _formula("a_over_d", "${sum_a} / ${sum_d}", "sum_a", "sum_d"),
     _formula("d_over_b", "${sum_d} / ${sum_b}", "sum_d", "sum_b"),
     _formula("pct_ab", "100 * ${sum_a} / ${sum_b}", "sum_a", "sum_b"),
     _formula("neg_ratio", "${sum_neg} / ${sum_b}", "sum_neg", "sum_b"),
     _formula("zero_den", "${sum_a} / ${sum_z}", "sum_a", "sum_z"),
     _formula("null_num", "${sum_n} / ${sum_b}", "sum_n", "sum_b"),
     _formula("null_den", "${sum_a} / ${sum_n}", "sum_a", "sum_n"),
     _formula("small_ratio", "${sum_flag} / ${sum_big}", "sum_flag", "sum_big"),
     _formula("ratio_of_ratio", "${ratio_ab} / ${a_per_row}", "ratio_ab", "a_per_row")],
)
VIEWS["p2_sales_ext"] = ("T:sales_ext", _dims("sale_id", "channel"), [])
VIEWS["p2_customers_dup"] = ("T:customers_dup", _dims("id", "name"), [])
VIEWS["p2_thirds"] = ("T:thirds", _dims("id"),
                      [{"name": "avg_flag", "type": "avg", "sql": "${TABLE}.flag"},
                       _sum("sum_flag", "flag"), {"name": "n", "type": "count", "sql": "*"},
                       _formula("rate", "${sum_flag} / ${n}", "sum_flag", "n")])


LAT_LAYERS = 7      # 2^7 = 128 forward chains lat_fact → lat_top: more than the route cap (64)
for _i in range(1, LAT_LAYERS + 1):
    for _x in "ab":
        VIEWS[f"p2_lat_{_i}{_x}"] = ("T:lat", _dims("id", "name"), [])
CHAIN = 8           # p2_ch_1 … p2_ch_8 (identity keys)
for _i in range(1, CHAIN + 1):
    VIEWS[f"p2_ch_{_i}"] = ("T:chain", _dims("id"), [])
PD = 65             # 65 copies of the owner dimension: 65 propagation routes, more than the cap
for _i in range(1, PD + 1):
    VIEWS[f"p2_pd_{_i}"] = ("T:owners", _dims("id", "name"), [])


def rel(view, fc, tc, *, cross="single", card="many_to_one", alias=None, active=True):
    j = {"name": alias or view, "view": view, "type": "left", "from_column": fc, "to_column": tc,
         "sql_on": f"${{TABLE}}.{fc} = ${{{alias or view}}}.{tc}", "relationship": card, "cardinality": card,
         "is_active": active, "cross_filter": cross}
    if alias:
        j["alias"] = alias
    return j


def comp_rel(view, cols, *, cross="single"):
    on = " AND ".join(f"${{TABLE}}.{c} = ${{{view}}}.{c}" for c in cols)
    return {"name": view, "view": view, "type": "left", "from_column": cols[0], "to_column": cols[0],
            "from_columns": list(cols), "to_columns": list(cols), "sql_on": on, "relationship": "many_to_one",
            "cardinality": "many_to_one", "is_active": True, "cross_filter": cross}


def cal_rel(view, col, *, alias=None, cross="single"):
    return rel(view, col, "date", alias=alias, cross=cross)


# model key -> {base view -> joins}. Every view a test uses as a BASE has an
# explore (joins may be empty: the graph is model-wide).
def _star():
    return {"p2_sales": [rel("p2_customers", "customer_id", "id"), rel("p2_products", "product_id", "id")],
            "p2_customers": [], "p2_products": []}


def _star_both():
    return {"p2_sales": [rel("p2_customers", "customer_id", "id", cross="both"),
                         rel("p2_products", "product_id", "id")],
            "p2_customers": [], "p2_products": []}


def _snow():
    return {"p2_sales": [rel("p2_customers", "customer_id", "id"), rel("p2_products", "product_id", "id")],
            "p2_customers": [rel("p2_regions", "region_id", "id")], "p2_regions": [], "p2_products": []}


def _diamond(alias=False):
    return {"p2_sales": [rel("p2_customers", "customer_id", "id"), rel("p2_stores", "store_id", "id")],
            "p2_customers": [rel("p2_regions", "region_id", "id")],
            "p2_stores": [rel("p2_regions", "region_id", "id", alias="store_region" if alias else None)],
            "p2_regions": []}


def _galaxy(cross="both", owners=True, activity=False, owner_cross=None):
    m = {"p2_revenue": [cal_rel("p2_cal", "rdate")] + ([rel("p2_owners", "owner_id", "id")] if owners else []),
         "p2_deals": [cal_rel("p2_cal", "ddate", cross=cross)]
         + ([rel("p2_owners", "owner_id", "id", cross=owner_cross or cross)] if owners else []),
         "p2_cal": [], "p2_owners": []}
    if activity:
        m["p2_activity"] = [cal_rel("p2_cal", "adate"), rel("p2_owners", "owner_id", "id")]
    return m


def _roles(kind):
    sales = [rel("p2_customers", "customer_id", "id")]
    if kind == "main":       # main calendar on order_date + two role-played date dims
        sales += [cal_rel("p2_cal", "order_date"), cal_rel("p2_sales__ship_date__date_dim", "ship_date"),
                  cal_rel("p2_sales__close_date__date_dim", "close_date")]
    elif kind == "roles_only":   # only role-played dims: no main calendar decides
        sales += [cal_rel("p2_sales__ship_date__date_dim", "ship_date"),
                  cal_rel("p2_sales__close_date__date_dim", "close_date")]
    elif kind == "aliases":      # one calendar view, two aliased roles
        sales += [cal_rel("p2_cal", "ship_date", alias="ship_cal"), cal_rel("p2_cal", "close_date", alias="close_cal")]
    return {"p2_sales": sales, "p2_customers": [], "p2_cal": [], "p2_sales__ship_date__date_dim": [],
            "p2_sales__close_date__date_dim": [], "p2_revenue": [cal_rel("p2_cal", "rdate")]}


def _composite():
    return {"p2_c_sales": [comp_rel("p2_c_stores", ["region_code", "store_code"])],
            "p2_c_stores": [rel("p2_c_regions", "region_code", "region_code")], "p2_c_regions": []}


def _bridge(cross="both"):
    return {"p2_acct_rev": [rel("p2_accounts", "account_id", "id")],
            "p2_account_tags": [rel("p2_accounts", "account_id", "id", cross=cross),
                                rel("p2_tags", "tag_id", "id", cross=cross)],
            "p2_accounts": [], "p2_tags": []}


def _without(model: dict, base: str, view: str, active=False) -> dict:
    """``model`` with the relationship ``base → view`` marked Inactive."""
    out = {k: [dict(j) for j in v] for k, v in model.items()}
    for j in out[base]:
        if j["view"] == view:
            j["is_active"] = active
    return out


def _lattice(layers):
    m = {"p2_lat_fact": [rel("p2_lat_1a", "k", "id"), rel("p2_lat_1b", "k", "id")], "p2_lat_top": []}
    for i in range(1, layers + 1):
        nxt = ([f"p2_lat_{i + 1}a", f"p2_lat_{i + 1}b"] if i < layers else ["p2_lat_top"])
        for x in "ab":
            m[f"p2_lat_{i}{x}"] = [rel(v, "id", "id") for v in nxt]
    return m


def _chain(n, last):
    m = {f"p2_ch_{i}": [rel(f"p2_ch_{i + 1}", "id", "id")] for i in range(1, n)}
    m[f"p2_ch_{n}"] = [rel(last, "id", "id")] if last else []
    return m


def _shared_dims(k):
    return {"p2_revenue": [rel(f"p2_pd_{i}", "owner_id", "id") for i in range(1, k + 1)],
            "p2_deals": [rel(f"p2_pd_{i}", "owner_id", "id", cross="both") for i in range(1, k + 1)],
            **{f"p2_pd_{i}": [] for i in range(1, k + 1)}}


_DIRECT_REGION = {"p2_sales": [rel("p2_customers", "customer_id", "id"), rel("p2_regions", "store_id", "id")],
                  "p2_customers": [rel("p2_regions", "region_id", "id")], "p2_regions": []}
# sales → customers directly AND sales → stores → customers (store i is customer i's store): two
# meanings of "the sale's customer", of different lengths
_UNEQUAL_CUSTOMERS = {"p2_sales": [rel("p2_customers", "customer_id", "id"), rel("p2_stores", "store_id", "id")],
                      "p2_stores": [rel("p2_customers", "id", "id")], "p2_customers": []}

MODELS = {
    "G1_star": _star(),
    "G1_star_both": _star_both(),
    "G2_snowflake": _snow(),
    "G2_nested_cte": {"p2_sales": [rel("p2_customers", "customer_id", "id")],
                      "p2_customers": [rel("p2_regions_cte", "region_id", "id")], "p2_regions_cte": []},
    "G3_diamond": _diamond(),
    # the diamond with a hop PAST the shared node (review r1: the FROM re-check compared full routes)
    "G3_diamond_countries": {**_diamond(), "p2_regions": [rel("p2_countries", "country_id", "id")],
                             "p2_countries": []},
    # a snowflake PLUS a direct sales → regions link: "region" has two forward chains of different
    # lengths (the sale's own region vs the customer's region) — review r2
    "G2_direct_region": _DIRECT_REGION,
    # G12 — the same two meanings with ONE relationship Inactive: the other is determined
    "G12_direct_inactive": _without(_DIRECT_REGION, "p2_sales", "p2_regions"),
    "G12_customer_region_inactive": _without(_DIRECT_REGION, "p2_customers", "p2_regions"),
    "G12_unequal_customers": _UNEQUAL_CUSTOMERS,
    "G12_unequal_store_inactive": _without(_UNEQUAL_CUSTOMERS, "p2_stores", "p2_customers"),
    "G12_unequal_direct_inactive": _without(_UNEQUAL_CUSTOMERS, "p2_sales", "p2_customers"),
    # sales → products directly AND sales → products_dim → products on the SAME key: one meaning
    "G12_passthrough": {"p2_sales": [rel("p2_products", "product_id", "id"), rel("p2_products_dim", "product_id", "id")],
                        "p2_products_dim": [rel("p2_products", "id", "id")], "p2_products": []},
    # … the same shape through ANOTHER key (the sale's store id as a product id): two meanings
    # Pair #3 H3-13 — the direct relationship next to a pass-through that misses Ink
    "G12_orphan_direct_and_chain": {"p2_sales": [rel("p2_products", "product_id", "id"), rel("p2_pda", "product_id", "id")],
                                    "p2_pda": [rel("p2_products", "id", "id")], "p2_products": []},
    # … two equally short pass-throughs on the same key, each missing a different product: which one
    # is joined decides which product's revenue lands in the "no product" group
    "G12_orphan_two_chains": {"p2_sales": [rel("p2_pda", "product_id", "id"), rel("p2_pdb", "product_id", "id")],
                              "p2_pda": [rel("p2_products", "id", "id")], "p2_pdb": [rel("p2_products", "id", "id")],
                              "p2_products": []},
    # Pair #3 sweep: regions is related to sales ONLY under a role alias (the customer's region)
    "G16_alias_only": {"p2_sales": [rel("p2_customers", "customer_id", "id")],
                       "p2_customers": [rel("p2_regions", "region_id", "id", alias="cust_region")],
                       "p2_regions": []},
    "G12_passthrough_other_key": {"p2_sales": [rel("p2_products", "product_id", "id"),
                                               rel("p2_products_dim", "store_id", "id")],
                                  "p2_products_dim": [rel("p2_products", "id", "id")], "p2_products": []},
    # G14 — route-count bound: 128 forward chains (refused), 8 (complete: two+ meanings); 65 and 3
    # filter-propagation routes (past the cap: refused, never a partial AND); and valid propagation
    # routes LONGER than the direct ones — a relay through another fact, another role of a dim
    "G14_lattice": _lattice(LAT_LAYERS),
    "G14_lattice_small": _lattice(3),
    "G14_prop_overflow": _shared_dims(PD),
    "G14_prop_three": _shared_dims(3),
    "G14_prop_unequal": {"p2_revenue": [cal_rel("p2_cal", "rdate"), rel("p2_owners", "owner_id", "id")],
                         "p2_activity": [cal_rel("p2_cal", "adate", cross="both"),
                                         rel("p2_owners", "owner_id", "id", cross="both")],
                         "p2_deals": [cal_rel("p2_cal", "ddate", cross="both")], "p2_cal": [], "p2_owners": []},
    # deals share the owner with revenue directly (revenue → owner ← deals) AND a region reached
    # from revenue through its customer (revenue → customer → region ← deals): another role
    "G14_prop_role_longer": {"p2_revenue": [rel("p2_owners", "owner_id", "id"), rel("p2_customers", "owner_id", "id")],
                             "p2_customers": [rel("p2_regions", "region_id", "id")],
                             "p2_deals": [rel("p2_owners", "owner_id", "id", cross="both"),
                                          rel("p2_regions", "id", "id", cross="both")],
                             "p2_owners": [], "p2_regions": []},
    # G15 — depth bound: a second meaning of "region" (through the sale's CUSTOMER id, not its store
    # id) 9 hops long (past the bound) / 7 hops (within)
    "G15_deep_select": {"p2_sales": [rel("p2_regions", "store_id", "id"), rel("p2_ch_1", "customer_id", "id")],
                        **_chain(CHAIN, "p2_regions"), "p2_regions": []},
    "G15_within_select": {"p2_sales": [rel("p2_regions", "store_id", "id"), rel("p2_ch_1", "customer_id", "id")],
                          **_chain(6, "p2_regions"), "p2_regions": []},
    "G15_deep_prop": {"p2_revenue": [rel("p2_owners", "owner_id", "id"), rel("p2_ch_1", "owner_id", "id")],
                      "p2_deals": [rel("p2_owners", "owner_id", "id", cross="both"),
                                   rel(f"p2_ch_{CHAIN}", "owner_id", "id", cross="both")],
                      **_chain(CHAIN, None), "p2_owners": []},
    # review r1: the SHORTEST route (through the owner) does not carry a deals filter (single
    # direction); a longer one does (the deal's region ← the revenue's customer's region, both ways)
    "G14_prop_valid_longer": {"p2_revenue": [rel("p2_owners", "owner_id", "id"), rel("p2_customers", "owner_id", "id")],
                              "p2_customers": [rel("p2_regions", "region_id", "id")],
                              "p2_deals": [rel("p2_owners", "owner_id", "id"),
                                           rel("p2_regions", "id", "id", cross="both")],
                              "p2_owners": [], "p2_regions": []},
    # review r4: the chart's base (revenue) has its OWN route to products (owner_id as a product id);
    # the measure's view (sales) has one — the sale's product
    "G16m_measure_filter": {"p2_sales": [rel("p2_customers", "customer_id", "id"), rel("p2_products", "product_id", "id")],
                            "p2_revenue": [rel("p2_products", "owner_id", "id")], "p2_customers": [],
                            "p2_products": []},
    "G15_deep_prop_only": {"p2_revenue": [rel("p2_ch_1", "owner_id", "id")],
                           "p2_deals": [rel(f"p2_ch_{CHAIN}", "owner_id", "id", cross="both")],
                           **_chain(CHAIN, None)},
    # G7c — two calendar roles both reached through a dimension, at different depths (the
    # customer's signup date: 2 hops; the store's region's founding date: 3 hops)
    "G7c_indirect_calendars": {"p2_sales": [rel("p2_customers", "customer_id", "id"), rel("p2_stores", "store_id", "id")],
                               "p2_customers": [cal_rel("p2_cal", "signup", alias="signup_cal")],
                               "p2_stores": [rel("p2_regions", "region_id", "id")],
                               "p2_regions": [cal_rel("p2_cal", "founded", alias="founded_cal")],
                               "p2_revenue": [cal_rel("p2_cal", "rdate")], "p2_cal": []},
    "G7c_direct_and_indirect": {"p2_sales": [rel("p2_customers", "customer_id", "id"), rel("p2_stores", "store_id", "id"),
                                             cal_rel("p2_cal", "order_date")],
                                "p2_customers": [cal_rel("p2_cal", "signup", alias="signup_cal")],
                                "p2_stores": [rel("p2_regions", "region_id", "id")],
                                "p2_regions": [cal_rel("p2_cal", "founded", alias="founded_cal")],
                                "p2_revenue": [cal_rel("p2_cal", "rdate")], "p2_cal": []},
    # a forward many-to-many relationship, single direction (the recommended M:N setting) — review r3
    "G9_mn_single": {"p2_acct_rev": [rel("p2_account_tags", "account_id", "account_id", card="many_to_many")],
                     "p2_account_tags": [rel("p2_tags", "tag_id", "id")], "p2_tags": []},
    "G3_diamond_alias": _diamond(alias=True),
    "G4_chasm_both": _galaxy("both", owners=False),
    "G4_chasm_single": _galaxy("single", owners=False),
    "G5_galaxy_both": _galaxy("both"),
    "G5_galaxy_single": _galaxy("single"),
    "G5_galaxy_mixed": _galaxy("both", owner_cross="single"),
    "G6_three_facts": _galaxy("single", activity=True),
    "G7_roles_main": _roles("main"),
    "G7_roles_only": _roles("roles_only"),
    "G7_roles_alias": _roles("aliases"),
    # roles only, but a MAIN calendar is reachable through ANOTHER fact (revenue → customers) — review r5
    "G7_roles_only_via_other_fact": {**_roles("roles_only"),
                                     "p2_revenue": [cal_rel("p2_cal", "rdate"), rel("p2_customers", "owner_id", "id")]},
    "G8_composite": _composite(),
    "G9_bridge_both": _bridge("both"),
    "G9_bridge_single": _bridge("single"),
    "G11_ties": {"p2_ties": []},
    # a dataset whose calendar is Asia/Ho_Chi_Minh (the test world gives TZ_ models that dataset)
    "TZ_events": {"p2_events_tz": []},
}

AMBIGUOUS = "AMBIGUOUS_ROUTE"
UNRELATED = "UNRELATED_GRAIN"
FANOUT = "FANOUT_RISK"
UNSUPPORTED = "UNSUPPORTED_CONTEXT"
UNREACHABLE = "UNREACHABLE_VIEW"
REFUSED = "REFUSED"   # any explicit refusal (a ValueError the engine raises on purpose)
ROUTE_LIMIT = "ROUTE_LIMIT"   # the planner could not see every route within its bounds


def f(op, value, **kw):
    return {"operator": op, "value": value, **kw}


# (id, model, base, request, expected). expected: list of row dicts keyed by
# field ref, or an error category. `ordered` rows compare in order (Top-N).
CASES = [
    # G1 star
    ("G1.by_product", "G1_star", "p2_sales", {"dims": ["p2_products.name"], "measures": ["p2_sales.revenue"]},
     [{"p2_products.name": "Pen", "p2_sales.revenue": 141}, {"p2_products.name": "Ink", "p2_sales.revenue": 57}]),
    ("G1.customer_x_product", "G1_star", "p2_sales",
     {"dims": ["p2_customers.name", "p2_products.name"], "measures": ["p2_sales.revenue"]},
     [{"p2_customers.name": "C1", "p2_products.name": "Pen", "p2_sales.revenue": 100},
      {"p2_customers.name": "C2", "p2_products.name": "Ink", "p2_sales.revenue": 50},
      {"p2_customers.name": "C2", "p2_products.name": "Pen", "p2_sales.revenue": 11},
      {"p2_customers.name": "C3", "p2_products.name": "Pen", "p2_sales.revenue": 30},
      {"p2_customers.name": None, "p2_products.name": "Ink", "p2_sales.revenue": 7}]),
    ("G1.kpi_filtered", "G1_star", "p2_sales",
     {"dims": [], "measures": ["p2_sales.revenue"], "filters": {"p2_products.name": [f("eq", "Pen")]}},
     [{"p2_sales.revenue": 141}]),
    # G2 snowflake (NULL customer keeps its row: LEFT semantics)
    ("G2.by_region", "G2_snowflake", "p2_sales", {"dims": ["p2_regions.name"], "measures": ["p2_sales.revenue"]},
     [{"p2_regions.name": "North", "p2_sales.revenue": 130}, {"p2_regions.name": "South", "p2_sales.revenue": 61},
      {"p2_regions.name": None, "p2_sales.revenue": 7}]),
    ("G2.kpi_region_filter", "G2_snowflake", "p2_sales",
     {"dims": [], "measures": ["p2_sales.revenue"], "filters": {"p2_regions.name": [f("eq", "North")]}},
     [{"p2_sales.revenue": 130}]),
    ("G2.by_product_region_filter", "G2_snowflake", "p2_sales",
     {"dims": ["p2_products.name"], "measures": ["p2_sales.revenue"],
      "filters": {"p2_regions.name": [f("eq", "North")]}},
     [{"p2_products.name": "Pen", "p2_sales.revenue": 130}]),
    # a related view backed by a NESTED-CTE source: filtered and grouped like any other (H2-10)
    ("G2.nested_cte_filter", "G2_nested_cte", "p2_sales",
     {"dims": [], "measures": ["p2_sales.revenue"], "filters": {"p2_regions_cte.name": [f("eq", "North")]}},
     [{"p2_sales.revenue": 130}]),
    ("G2.nested_cte_group", "G2_nested_cte", "p2_sales",
     {"dims": ["p2_regions_cte.name"], "measures": ["p2_sales.revenue"]},
     [{"p2_regions_cte.name": "North", "p2_sales.revenue": 130}, {"p2_regions_cte.name": "South", "p2_sales.revenue": 61},
      {"p2_regions_cte.name": None, "p2_sales.revenue": 7}]),
    # G3 role diamond: region is reachable as the CUSTOMER's and as the STORE's
    ("G3.by_region", "G3_diamond", "p2_sales", {"dims": ["p2_regions.name"], "measures": ["p2_sales.revenue"]},
     AMBIGUOUS),
    ("G3.kpi_region_filter", "G3_diamond", "p2_sales",
     {"dims": [], "measures": ["p2_sales.revenue"], "filters": {"p2_regions.name": [f("eq", "North")]}},
     AMBIGUOUS),
    ("G3.by_customer_region", "G3_diamond", "p2_sales",
     {"dims": ["p2_customers.name", "p2_regions.name"], "measures": ["p2_sales.revenue"]},
     [{"p2_customers.name": "C1", "p2_regions.name": "North", "p2_sales.revenue": 100},
      {"p2_customers.name": "C2", "p2_regions.name": "South", "p2_sales.revenue": 61},
      {"p2_customers.name": "C3", "p2_regions.name": "North", "p2_sales.revenue": 30},
      {"p2_customers.name": None, "p2_regions.name": None, "p2_sales.revenue": 7}]),
    ("G3.by_store_region", "G3_diamond", "p2_sales",
     {"dims": ["p2_stores.name", "p2_regions.name"], "measures": ["p2_sales.revenue"]},
     [{"p2_stores.name": "S1", "p2_regions.name": "South", "p2_sales.revenue": 130},
      {"p2_stores.name": "S2", "p2_regions.name": "North", "p2_sales.revenue": 57},
      {"p2_stores.name": None, "p2_regions.name": None, "p2_sales.revenue": 11}]),
    # SELECT route and FILTER route agree: grouped by customer, region filters the customer's region
    ("G3.by_customer_filter_region", "G3_diamond", "p2_sales",
     {"dims": ["p2_customers.name"], "measures": ["p2_sales.revenue"],
      "filters": {"p2_regions.name": [f("eq", "North")]}},
     [{"p2_customers.name": "C1", "p2_sales.revenue": 100}, {"p2_customers.name": "C3", "p2_sales.revenue": 30}]),
    ("G3.by_store_filter_region", "G3_diamond", "p2_sales",
     {"dims": ["p2_stores.name"], "measures": ["p2_sales.revenue"],
      "filters": {"p2_regions.name": [f("eq", "North")]}},
     [{"p2_stores.name": "S2", "p2_sales.revenue": 57}]),
    ("G3.by_customer_and_store_region", "G3_diamond", "p2_sales",
     {"dims": ["p2_customers.name", "p2_stores.name", "p2_regions.name"], "measures": ["p2_sales.revenue"]},
     AMBIGUOUS),
    # an alias makes the store's region a different business field: no ambiguity
    ("G3a.by_region", "G3_diamond_alias", "p2_sales",
     {"dims": ["p2_regions.name"], "measures": ["p2_sales.revenue"]},
     [{"p2_regions.name": "North", "p2_sales.revenue": 130}, {"p2_regions.name": "South", "p2_sales.revenue": 61},
      {"p2_regions.name": None, "p2_sales.revenue": 7}]),
    ("G3a.by_store_region", "G3_diamond_alias", "p2_sales",
     {"dims": ["store_region.name"], "measures": ["p2_sales.revenue"]},
     [{"store_region.name": "South", "p2_sales.revenue": 130}, {"store_region.name": "North", "p2_sales.revenue": 57},
      {"store_region.name": None, "p2_sales.revenue": 11}]),
    ("G3a.kpi_store_region_filter", "G3_diamond_alias", "p2_sales",
     {"dims": [], "measures": ["p2_sales.revenue"], "filters": {"store_region.name": [f("eq", "North")]}},
     [{"p2_sales.revenue": 57}]),
    # G4 chasm: a filter on deals reaches revenue through the shared date (cross_filter both)
    ("G4.kpi_won_deals_both", "G4_chasm_both", "p2_revenue",
     {"dims": [], "measures": ["p2_revenue.amount"], "filters": {"p2_deals.stage": [f("eq", "Won")]}},
     [{"p2_revenue.amount": 170}]),
    # G5 galaxy: through date AND owner → the intersection (won dates ∩ won owners)
    ("G5.kpi_won_deals_both", "G5_galaxy_both", "p2_revenue",
     {"dims": [], "measures": ["p2_revenue.amount"], "filters": {"p2_deals.stage": [f("eq", "Won")]}},
     [{"p2_revenue.amount": 165}]),
    ("G5.by_owner_won_deals_both", "G5_galaxy_both", "p2_revenue",
     {"dims": ["p2_owners.name"], "measures": ["p2_revenue.amount"],
      "filters": {"p2_deals.stage": [f("eq", "Won")]}},
     [{"p2_owners.name": "Ann", "p2_revenue.amount": 140}, {"p2_owners.name": "Bob", "p2_revenue.amount": 25}]),
    # date propagates (both) but owner does not (single): only the date route filters revenue
    ("G5.kpi_won_deals_mixed", "G5_galaxy_mixed", "p2_revenue",
     {"dims": [], "measures": ["p2_revenue.amount"], "filters": {"p2_deals.stage": [f("eq", "Won")]}},
     [{"p2_revenue.amount": 170}]),
    ("G5.by_owner_won_deals_mixed", "G5_galaxy_mixed", "p2_revenue",
     {"dims": ["p2_owners.name"], "measures": ["p2_revenue.amount"],
      "filters": {"p2_deals.stage": [f("eq", "Won")]}},
     [{"p2_owners.name": "Ann", "p2_revenue.amount": 140}, {"p2_owners.name": "Bob", "p2_revenue.amount": 25},
      {"p2_owners.name": None, "p2_revenue.amount": 5}]),
    # single direction everywhere: a deals filter does not reach revenue at all (ignored, recorded)
    ("G5.kpi_won_deals_single", "G5_galaxy_single", "p2_revenue",
     {"dims": [], "measures": ["p2_revenue.amount"], "filters": {"p2_deals.stage": [f("eq", "Won")]}},
     {"rows": [{"p2_revenue.amount": 180}], "dropped": ["p2_deals.stage"]}),
    # G6 three facts stitched on the shared calendar / owner
    ("G6.by_year_three_facts", "G6_three_facts", "p2_revenue",
     {"dims": ["p2_cal.year"], "measures": ["p2_revenue.amount", "p2_deals.value", "p2_activity.calls"]},
     [{"p2_cal.year": 2024, "p2_revenue.amount": 170, "p2_deals.value": 1370, "p2_activity.calls": 3},
      {"p2_cal.year": 2025, "p2_revenue.amount": 10, "p2_deals.value": 50, "p2_activity.calls": 4}]),
    ("G6.by_owner_two_facts", "G6_three_facts", "p2_revenue",
     {"dims": ["p2_owners.name"], "measures": ["p2_revenue.amount", "p2_deals.value"]},
     [{"p2_owners.name": "Ann", "p2_revenue.amount": 140, "p2_deals.value": 1120},
      {"p2_owners.name": "Bob", "p2_revenue.amount": 35, "p2_deals.value": 300},
      {"p2_owners.name": None, "p2_revenue.amount": 5, "p2_deals.value": None}]),
    # a deals-only filter does NOT become a revenue row filter (cross_filter single)
    ("G6.by_year_deal_filter", "G6_three_facts", "p2_revenue",
     {"dims": ["p2_cal.year"], "measures": ["p2_revenue.amount", "p2_deals.value"],
      "filters": {"p2_deals.stage": [f("eq", "Won")]}},
     [{"p2_cal.year": 2024, "p2_revenue.amount": 170, "p2_deals.value": 1300},
      {"p2_cal.year": 2025, "p2_revenue.amount": 10, "p2_deals.value": None}]),
    # a filter on one fact's own column filters that fact only (H2-09)
    ("G6.kpi_revenue_own_filter", "G6_three_facts", "p2_revenue",
     {"dims": [], "measures": ["p2_revenue.amount", "p2_deals.value", "p2_activity.calls"],
      "filters": {"p2_revenue.owner_id": [f("eq", 1)]}},
     [{"p2_revenue.amount": 140, "p2_deals.value": 1420, "p2_activity.calls": 7}]),
    ("G6.kpi_deal_filter", "G6_three_facts", "p2_revenue",
     {"dims": [], "measures": ["p2_revenue.amount", "p2_deals.value", "p2_activity.calls"],
      "filters": {"p2_deals.stage": [f("eq", "Won")]}},
     [{"p2_revenue.amount": 180, "p2_deals.value": 1300, "p2_activity.calls": 7}]),
    ("G6.by_owner_revenue_own_filter", "G6_three_facts", "p2_revenue",
     {"dims": ["p2_owners.name"], "measures": ["p2_revenue.amount", "p2_deals.value"],
      "filters": {"p2_revenue.owner_id": [f("eq", 1)]}},
     [{"p2_owners.name": "Ann", "p2_revenue.amount": 140, "p2_deals.value": 1120},
      {"p2_owners.name": "Bob", "p2_revenue.amount": None, "p2_deals.value": 300}]),
    # a shared-dimension filter (owner) filters every fact
    ("G6.kpi_owner_filter", "G6_three_facts", "p2_revenue",
     {"dims": [], "measures": ["p2_revenue.amount", "p2_deals.value", "p2_activity.calls"],
      "filters": {"p2_owners.name": [f("eq", "Bob")]}},
     [{"p2_revenue.amount": 35, "p2_deals.value": 300, "p2_activity.calls": 3}]),
    ("G6.kpi_three_facts", "G6_three_facts", "p2_revenue",
     {"dims": [], "measures": ["p2_revenue.amount", "p2_deals.value", "p2_activity.calls"]},
     [{"p2_revenue.amount": 180, "p2_deals.value": 1420, "p2_activity.calls": 7}]),
    # percent of the visible total (H2-11): by customer region, and under a filter
    ("G2.pct_by_region", "G2_snowflake", "p2_sales",
     {"dims": ["p2_regions.name"], "measures": ["p2_sales.rev_pct"]},
     [{"p2_regions.name": "North", "p2_sales.rev_pct": 130 * 100 / 198},
      {"p2_regions.name": "South", "p2_sales.rev_pct": 61 * 100 / 198},
      {"p2_regions.name": None, "p2_sales.rev_pct": 7 * 100 / 198}]),
    ("G2.pct_by_product_north", "G2_snowflake", "p2_sales",
     {"dims": ["p2_products.name"], "measures": ["p2_sales.rev_pct"],
      "filters": {"p2_regions.name": [f("eq", "North")]}},
     [{"p2_products.name": "Pen", "p2_sales.rev_pct": 100}]),
    # context modifiers are not supported: refused, never half-applied (H2-11)
    ("G2.modifier_all_refused", "G2_snowflake", "p2_sales",
     {"dims": ["p2_regions.name"], "measures": ["p2_sales.rev_all"]}, UNSUPPORTED),
    # measure-level filter on a related view: correlated to the measure's own rows (H2-10)
    ("G2.measure_filter_related_kpi", "G2_snowflake", "p2_sales",
     {"dims": [], "measures": ["p2_sales.north_rev"]}, [{"p2_sales.north_rev": 130}]),
    ("G2.measure_filter_related_by_product", "G2_snowflake", "p2_sales",
     {"dims": ["p2_products.name"], "measures": ["p2_sales.north_rev"]},
     [{"p2_products.name": "Pen", "p2_sales.north_rev": 130}, {"p2_products.name": "Ink", "p2_sales.north_rev": None}]),
    ("G3.measure_filter_related_ambiguous", "G3_diamond", "p2_sales",
     {"dims": [], "measures": ["p2_sales.north_rev"]}, AMBIGUOUS),
    ("G1.measure_filter_related_unreachable", "G1_star", "p2_sales",
     {"dims": ["p2_products.name"], "measures": ["p2_sales.north_rev"]}, UNREACHABLE),
    # G7 role-playing dates
    ("G7.by_order_year", "G7_roles_main", "p2_sales", {"dims": ["p2_cal.year"], "measures": ["p2_sales.revenue"]},
     [{"p2_cal.year": 2024, "p2_sales.revenue": 191}, {"p2_cal.year": 2025, "p2_sales.revenue": 7}]),
    ("G7.by_ship_year", "G7_roles_main", "p2_sales",
     {"dims": ["p2_sales__ship_date__date_dim.year"], "measures": ["p2_sales.revenue"]},
     [{"p2_sales__ship_date__date_dim.year": 2024, "p2_sales.revenue": 150},
      {"p2_sales__ship_date__date_dim.year": 2025, "p2_sales.revenue": 37},
      {"p2_sales__ship_date__date_dim.year": None, "p2_sales.revenue": 11}]),
    ("G7.by_close_year", "G7_roles_main", "p2_sales",
     {"dims": ["p2_sales__close_date__date_dim.year"], "measures": ["p2_sales.revenue"]},
     [{"p2_sales__close_date__date_dim.year": 2024, "p2_sales.revenue": 11},
      {"p2_sales__close_date__date_dim.year": 2025, "p2_sales.revenue": 157},
      {"p2_sales__close_date__date_dim.year": None, "p2_sales.revenue": 30}]),
    ("G7.kpi_ship_year_filter", "G7_roles_main", "p2_sales",
     {"dims": [], "measures": ["p2_sales.revenue"],
      "filters": {"p2_sales__ship_date__date_dim.year": [f("eq", 2025)]}},
     [{"p2_sales.revenue": 37}]),
    # re-anchored KPI (chart based on another fact) whose Date filter was written onto THAT
    # fact's date column: it moves to the measure's MAIN calendar (order date)
    ("G7.reanchor_foreign_date_filter", "G7_roles_main", "p2_revenue",
     {"dims": [], "measures": ["p2_sales.revenue"],
      "filters": {"p2_revenue.rdate": [f("eq", 2025, calendarField="year", calendarSourceField="rdate")]}},
     [{"p2_sales.revenue": 7}]),
    # … with no main calendar the measure's date roles tie: no single meaning → refused
    ("G7.reanchor_foreign_date_filter_tied_roles", "G7_roles_only", "p2_revenue",
     {"dims": [], "measures": ["p2_sales.revenue"],
      "filters": {"p2_revenue.rdate": [f("eq", 2025, calendarField="year", calendarSourceField="rdate")]}},
     AMBIGUOUS),
    ("G7.reanchor_foreign_date_filter_aliases", "G7_roles_alias", "p2_revenue",
     {"dims": [], "measures": ["p2_sales.revenue"],
      "filters": {"p2_revenue.rdate": [f("eq", 2025, calendarField="year", calendarSourceField="rdate")]}},
     AMBIGUOUS),
    # a role-specific filter ALREADY on the measure's own date column keeps that role (ship year)
    ("G7.reanchor_own_role_filter", "G7_roles_main", "p2_customers",
     {"dims": [], "measures": ["p2_sales.revenue"],
      "filters": {"p2_sales.ship_date": [f("eq", 2025, calendarField="year", calendarSourceField="ship_date")]}},
     [{"p2_sales.revenue": 37}]),
    ("G7.reanchor_own_role_filter_roles_only", "G7_roles_only", "p2_customers",
     {"dims": [], "measures": ["p2_sales.revenue"],
      "filters": {"p2_sales.close_date": [f("eq", 2024, calendarField="year", calendarSourceField="close_date")]}},
     [{"p2_sales.revenue": 11}]),
    # stitched with another fact by the conformed calendar: sales' own date role must be determined
    ("G7.stitch_by_year_main", "G7_roles_main", "p2_revenue",
     {"dims": ["p2_cal.year"], "measures": ["p2_revenue.amount", "p2_sales.revenue"]},
     [{"p2_cal.year": 2024, "p2_revenue.amount": 170, "p2_sales.revenue": 191},
      {"p2_cal.year": 2025, "p2_revenue.amount": 10, "p2_sales.revenue": 7}]),
    ("G7.stitch_by_year_tied_roles", "G7_roles_only", "p2_revenue",
     {"dims": ["p2_cal.year"], "measures": ["p2_revenue.amount", "p2_sales.revenue"]}, AMBIGUOUS),
    # G8 composite snowflake (and a partially NULL composite key keeps its row)
    ("G8.by_store", "G8_composite", "p2_c_sales", {"dims": ["p2_c_stores.name"], "measures": ["p2_c_sales.amt"]},
     [{"p2_c_stores.name": "N-one", "p2_c_sales.amt": 10}, {"p2_c_stores.name": "N-two", "p2_c_sales.amt": 5},
      {"p2_c_stores.name": "S-one", "p2_c_sales.amt": 28}, {"p2_c_stores.name": None, "p2_c_sales.amt": 9}]),
    ("G8.by_region", "G8_composite", "p2_c_sales", {"dims": ["p2_c_regions.label"], "measures": ["p2_c_sales.amt"]},
     [{"p2_c_regions.label": "North", "p2_c_sales.amt": 15}, {"p2_c_regions.label": "South", "p2_c_sales.amt": 28},
      {"p2_c_regions.label": None, "p2_c_sales.amt": 9}]),
    # G9 M:N bridge: a tag FILTER restricts by membership (EXISTS); grouping by tag would fan out
    ("G9.kpi_vip", "G9_bridge_both", "p2_acct_rev",
     {"dims": [], "measures": ["p2_acct_rev.amount"], "filters": {"p2_tags.label": [f("eq", "VIP")]}},
     [{"p2_acct_rev.amount": 100}]),
    ("G9.kpi_beta", "G9_bridge_both", "p2_acct_rev",
     {"dims": [], "measures": ["p2_acct_rev.amount"], "filters": {"p2_tags.label": [f("eq", "Beta")]}},
     [{"p2_acct_rev.amount": 150}]),
    ("G9.by_tag", "G9_bridge_both", "p2_acct_rev", {"dims": ["p2_tags.label"], "measures": ["p2_acct_rev.amount"]},
     UNRELATED),
    # single-direction bridge: the tag filter does not propagate (ordinary filter → ignored, recorded)
    ("G9.kpi_vip_single", "G9_bridge_single", "p2_acct_rev",
     {"dims": [], "measures": ["p2_acct_rev.amount"], "filters": {"p2_tags.label": [f("eq", "VIP")]}},
     {"rows": [{"p2_acct_rev.amount": 170}], "dropped": ["p2_tags.label"]}),
    # ── more Pair #2 hypotheses ──────────────────────────────────────────
    # two filters (the metamorphic suite also reverses their order)
    ("G2.two_filters", "G2_snowflake", "p2_sales",
     {"dims": [], "measures": ["p2_sales.revenue"],
      "filters": {"p2_products.name": [f("eq", "Pen")], "p2_regions.name": [f("eq", "North")]}},
     [{"p2_sales.revenue": 130}]),
    # a fact filter restricting a dimension list: only through a both-ways relationship (H2-06)
    ("G1.dims_only_fact_filter_single", "G1_star", "p2_customers",
     {"dims": ["p2_customers.name"], "measures": [], "filters": {"p2_sales.id": [f("eq", 1)]}},
     {"rows": [{"p2_customers.name": n} for n in ("C1", "C2", "C3", "C4")], "dropped": ["p2_sales.id"]}),
    ("G1.dims_only_fact_filter_both", "G1_star_both", "p2_customers",
     {"dims": ["p2_customers.name"], "measures": [], "filters": {"p2_sales.id": [f("eq", 1)]}},
     [{"p2_customers.name": "C1"}]),
    # grain: a single-fact measure grouped by another fact's column is unrelated (H2-07)
    ("G5.by_stage_unrelated", "G5_galaxy_both", "p2_revenue",
     {"dims": ["p2_deals.stage"], "measures": ["p2_revenue.amount"]}, UNRELATED),
    # multi-fact grouped by a column only one fact has: no conformed grain → refused (H2-08)
    ("G6.by_stage_two_facts", "G6_three_facts", "p2_revenue",
     {"dims": ["p2_deals.stage"], "measures": ["p2_revenue.amount", "p2_deals.value"]}, FANOUT),
    # a measure filter on the stitched row (HAVING-like)
    ("G6.by_owner_having", "G6_three_facts", "p2_revenue",
     {"dims": ["p2_owners.name"], "measures": ["p2_revenue.amount", "p2_deals.value"],
      "filters": {"p2_revenue.amount": [f("gt", 30)]}},
     [{"p2_owners.name": "Ann", "p2_revenue.amount": 140, "p2_deals.value": 1120},
      {"p2_owners.name": "Bob", "p2_revenue.amount": 35, "p2_deals.value": 300}]),
    # a time grain on the conformed calendar across facts
    ("G6.by_month_grain", "G6_three_facts", "p2_revenue",
     {"dims": ["p2_cal.date"], "measures": ["p2_revenue.amount", "p2_deals.value", "p2_activity.calls"],
      "time_grains": {"p2_cal.date": "month"}},
     [{"p2_cal.date": "2024-01-01", "p2_revenue.amount": 105, "p2_deals.value": 1000, "p2_activity.calls": 3},
      {"p2_cal.date": "2024-02-01", "p2_revenue.amount": 65, "p2_deals.value": 370, "p2_activity.calls": None},
      {"p2_cal.date": "2025-03-01", "p2_revenue.amount": 10, "p2_deals.value": 50, "p2_activity.calls": 4}]),
    # an AUTHORITATIVE deals filter that cannot reach revenue: the whole request is refused (Pair #1)
    ("G6.kpi_authoritative_deal_filter", "G6_three_facts", "p2_revenue",
     {"dims": [], "measures": ["p2_revenue.amount", "p2_deals.value"],
      "filters": {"p2_deals.stage": [f("eq", "Won", _authoritative=True)]}}, REFUSED),
    # the same propagated filter, grouped by owner from base = owners: the same per-owner values
    ("G5.by_owner_won_deals_both_base_owners", "G5_galaxy_both", "p2_owners",
     {"dims": ["p2_owners.name"], "measures": ["p2_revenue.amount"],
      "filters": {"p2_deals.stage": [f("eq", "Won")]}},
     [{"p2_owners.name": "Ann", "p2_revenue.amount": 140}, {"p2_owners.name": "Bob", "p2_revenue.amount": 25}]),
    # a fanned "Date" filter (copies of ONE filter on every date role) binds to the main calendar
    ("G7.fanned_date_main", "G7_roles_main", "p2_sales",
     {"dims": [], "measures": ["p2_sales.revenue"],
      "filters": {c: [f("eq", 2025, calendarField="year", calendarSourceField=c.split(".")[1], _calendar_fan="F")]
                  for c in ("p2_sales.order_date", "p2_sales.ship_date", "p2_sales.close_date")}},
     [{"p2_sales.revenue": 7}]),
    ("G7.fanned_date_roles_only", "G7_roles_only", "p2_sales",
     {"dims": [], "measures": ["p2_sales.revenue"],
      "filters": {c: [f("eq", 2025, calendarField="year", calendarSourceField=c.split(".")[1], _calendar_fan="F")]
                  for c in ("p2_sales.ship_date", "p2_sales.close_date")}},
     AMBIGUOUS),
    # an authoritative date lock on ONE role keeps that role, re-anchored too
    ("G7.reanchor_authoritative_role_lock", "G7_roles_main", "p2_customers",
     {"dims": [], "measures": ["p2_sales.revenue"],
      "filters": {"p2_sales.ship_date": [f("eq", 2025, calendarField="year", calendarSourceField="ship_date",
                                           _authoritative=True)]}},
     [{"p2_sales.revenue": 37}]),
    # isolated two-fact KPI: each measure binds the Date filter to its own calendar
    ("G7.isolated_two_facts_date_filter", "G7_roles_main", "p2_revenue",
     {"dims": [], "measures": ["p2_revenue.amount", "p2_sales.revenue"],
      "filters": {"p2_revenue.rdate": [f("eq", 2025, calendarField="year", calendarSourceField="rdate")]}},
     [{"p2_revenue.amount": 10, "p2_sales.revenue": 7}]),
    ("G7.isolated_two_facts_date_filter_tied", "G7_roles_only", "p2_revenue",
     {"dims": [], "measures": ["p2_revenue.amount", "p2_sales.revenue"],
      "filters": {"p2_revenue.rdate": [f("eq", 2025, calendarField="year", calendarSourceField="rdate")]}},
     AMBIGUOUS),
    # ── independent-review round (each reproduced on demo-start or on the first Pair #2 draft) ──
    # r1: a hop past the shared node — the context (customer) decides, in every storage order
    ("G3c.by_customer_country", "G3_diamond_countries", "p2_sales",
     {"dims": ["p2_customers.name", "p2_countries.name"], "measures": ["p2_sales.revenue"]},
     [{"p2_customers.name": "C1", "p2_countries.name": "Northland", "p2_sales.revenue": 100},
      {"p2_customers.name": "C2", "p2_countries.name": "Southland", "p2_sales.revenue": 61},
      {"p2_customers.name": "C3", "p2_countries.name": "Northland", "p2_sales.revenue": 30},
      {"p2_customers.name": None, "p2_countries.name": None, "p2_sales.revenue": 7}]),
    ("G3c.by_customer_region_country", "G3_diamond_countries", "p2_sales",
     {"dims": ["p2_customers.name", "p2_regions.name", "p2_countries.name"], "measures": ["p2_sales.revenue"]},
     [{"p2_customers.name": "C1", "p2_regions.name": "North", "p2_countries.name": "Northland", "p2_sales.revenue": 100},
      {"p2_customers.name": "C2", "p2_regions.name": "South", "p2_countries.name": "Southland", "p2_sales.revenue": 61},
      {"p2_customers.name": "C3", "p2_regions.name": "North", "p2_countries.name": "Northland", "p2_sales.revenue": 30},
      {"p2_customers.name": None, "p2_regions.name": None, "p2_countries.name": None, "p2_sales.revenue": 7}]),
    ("G3c.by_country", "G3_diamond_countries", "p2_sales",
     {"dims": ["p2_countries.name"], "measures": ["p2_sales.revenue"]}, AMBIGUOUS),
    # A chart BASED ON customers still sums SALES: "region" is the customer's (customers → regions)
    # OR the summed sale's own (sales → regions) — C2's South revenue is 61 by the customer's region
    # (sales 2 + 5) and 50 by the sale's (sale 2 only). Two meanings → refused, as the same request
    # is from the sales base (G2d.by_customer_filter_region). The single-meaning versions (one
    # relationship Inactive) are G12.*.
    ("G2d.base_customers_filter_region", "G2_direct_region", "p2_customers",
     {"dims": ["p2_customers.name"], "measures": ["p2_sales.revenue"], "filters": {"p2_regions.name": [f("eq", "South")]}},
     AMBIGUOUS),
    # grouped: by the customer's region C2 is (South, 61); by the sale's own region C2 splits into
    # (South, 50) + (no region, 11) — two meanings → refused, as from the sales base
    ("G2d.base_customers_by_region", "G2_direct_region", "p2_customers",
     {"dims": ["p2_customers.name", "p2_regions.name"], "measures": ["p2_sales.revenue"]},
     AMBIGUOUS),
    ("G2d.by_customer_and_region", "G2_direct_region", "p2_sales",
     {"dims": ["p2_customers.name", "p2_regions.name"], "measures": ["p2_sales.revenue"]}, AMBIGUOUS),
    # … from the sales base, the sale's own region and the customer's region are two meanings
    ("G2d.by_region", "G2_direct_region", "p2_sales",
     {"dims": ["p2_regions.name"], "measures": ["p2_sales.revenue"]}, AMBIGUOUS),
    ("G2d.kpi_filter_region", "G2_direct_region", "p2_sales",
     {"dims": [], "measures": ["p2_sales.revenue"], "filters": {"p2_regions.name": [f("eq", "South")]}}, AMBIGUOUS),
    ("G2d.by_customer_filter_region", "G2_direct_region", "p2_sales",
     {"dims": ["p2_customers.name"], "measures": ["p2_sales.revenue"],
      "filters": {"p2_regions.name": [f("eq", "South")]}}, AMBIGUOUS),
    # r3: a single-direction many-to-many carries a filter from its far side
    ("G9mn.kpi_vip", "G9_mn_single", "p2_acct_rev",
     {"dims": [], "measures": ["p2_acct_rev.amount"], "filters": {"p2_tags.label": [f("eq", "VIP")]}},
     [{"p2_acct_rev.amount": 100}]),
    ("G9mn.kpi_tag_2", "G9_mn_single", "p2_acct_rev",
     {"dims": [], "measures": ["p2_acct_rev.amount"], "filters": {"p2_account_tags.tag_id": [f("eq", 2)]}},
     [{"p2_acct_rev.amount": 150}]),
    # r5: a main calendar reachable only through ANOTHER fact is not the measure's calendar
    ("G7.reanchor_foreign_date_filter_main_via_other_fact", "G7_roles_only_via_other_fact", "p2_revenue",
     {"dims": [], "measures": ["p2_sales.revenue"],
      "filters": {"p2_revenue.rdate": [f("eq", 2025, calendarField="year", calendarSourceField="rdate")]}},
     AMBIGUOUS),
    # r4: an INSTANT is filtered on the same LOCAL date it is grouped by (non-UTC calendar)
    ("TZ.kpi_local_year_filter", "TZ_events", "p2_events_tz",
     {"dims": [], "measures": ["p2_events_tz.total"],
      "filters": {"p2_events_tz.ts": [f("eq", 2024, calendarField="year", calendarSourceField="ts")]}},
     [{"p2_events_tz.total": 15}]),
    ("TZ.by_local_year", "TZ_events", "p2_events_tz",
     {"dims": ["p2_events_tz.ts"], "measures": ["p2_events_tz.total"], "time_grains": {"p2_events_tz.ts": "year"}},
     [{"p2_events_tz.ts": "2024-01-01", "p2_events_tz.total": 15}, {"p2_events_tz.ts": "2025-01-01", "p2_events_tz.total": 3}]),
    # ── G12: two meanings of DIFFERENT lengths, asked from the fact AND from dimension bases ──
    # sales → regions (the sale's own region, via store_id) and sales → customers → regions
    ("G12.regions_base_by_region", "G2_direct_region", "p2_regions",
     {"dims": ["p2_regions.name"], "measures": ["p2_sales.revenue"]}, AMBIGUOUS),
    ("G12.regions_base_kpi_filter_region", "G2_direct_region", "p2_regions",
     {"dims": [], "measures": ["p2_sales.revenue"], "filters": {"p2_regions.name": [f("eq", "South")]}}, AMBIGUOUS),
    # one relationship Inactive → the other meaning is determined, from every base
    ("G12.direct_inactive.fact_by_region", "G12_direct_inactive", "p2_sales",
     {"dims": ["p2_regions.name"], "measures": ["p2_sales.revenue"]},
     [{"p2_regions.name": "North", "p2_sales.revenue": 130}, {"p2_regions.name": "South", "p2_sales.revenue": 61},
      {"p2_regions.name": None, "p2_sales.revenue": 7}]),
    ("G12.direct_inactive.regions_base_by_region", "G12_direct_inactive", "p2_regions",
     {"dims": ["p2_regions.name"], "measures": ["p2_sales.revenue"]},
     [{"p2_regions.name": "North", "p2_sales.revenue": 130}, {"p2_regions.name": "South", "p2_sales.revenue": 61}]),
    ("G12.direct_inactive.customers_base_filter_region", "G12_direct_inactive", "p2_customers",
     {"dims": ["p2_customers.name"], "measures": ["p2_sales.revenue"], "filters": {"p2_regions.name": [f("eq", "South")]}},
     [{"p2_customers.name": "C2", "p2_sales.revenue": 61}, {"p2_customers.name": "C4", "p2_sales.revenue": None}]),
    ("G12.customer_region_inactive.fact_by_region", "G12_customer_region_inactive", "p2_sales",
     {"dims": ["p2_regions.name"], "measures": ["p2_sales.revenue"]},
     [{"p2_regions.name": "North", "p2_sales.revenue": 130}, {"p2_regions.name": "South", "p2_sales.revenue": 57},
      {"p2_regions.name": None, "p2_sales.revenue": 11}]),
    ("G12.customer_region_inactive.regions_base_by_region", "G12_customer_region_inactive", "p2_regions",
     {"dims": ["p2_regions.name"], "measures": ["p2_sales.revenue"]},
     [{"p2_regions.name": "North", "p2_sales.revenue": 130}, {"p2_regions.name": "South", "p2_sales.revenue": 57}]),
    # sales → customers (direct) and sales → stores → customers (the store's customer)
    ("G12.unequal.fact_by_customer", "G12_unequal_customers", "p2_sales",
     {"dims": ["p2_customers.name"], "measures": ["p2_sales.revenue"]}, AMBIGUOUS),
    ("G12.unequal.customers_base_by_customer", "G12_unequal_customers", "p2_customers",
     {"dims": ["p2_customers.name"], "measures": ["p2_sales.revenue"]}, AMBIGUOUS),
    ("G12.unequal.store_inactive.customers_base_by_customer", "G12_unequal_store_inactive", "p2_customers",
     {"dims": ["p2_customers.name"], "measures": ["p2_sales.revenue"]},
     [{"p2_customers.name": "C1", "p2_sales.revenue": 100}, {"p2_customers.name": "C2", "p2_sales.revenue": 61},
      {"p2_customers.name": "C3", "p2_sales.revenue": 30}, {"p2_customers.name": "C4", "p2_sales.revenue": None}]),
    ("G12.unequal.store_inactive.fact_by_customer", "G12_unequal_store_inactive", "p2_sales",
     {"dims": ["p2_customers.name"], "measures": ["p2_sales.revenue"]},
     [{"p2_customers.name": "C1", "p2_sales.revenue": 100}, {"p2_customers.name": "C2", "p2_sales.revenue": 61},
      {"p2_customers.name": "C3", "p2_sales.revenue": 30}, {"p2_customers.name": None, "p2_sales.revenue": 7}]),
    # the store's customer: S1 is C1's (sales 1 + 3), S2 is C2's (sales 2 + 4)
    ("G12.unequal.direct_inactive.customers_base_by_customer", "G12_unequal_direct_inactive", "p2_customers",
     {"dims": ["p2_customers.name"], "measures": ["p2_sales.revenue"]},
     [{"p2_customers.name": "C1", "p2_sales.revenue": 130}, {"p2_customers.name": "C2", "p2_sales.revenue": 57},
      {"p2_customers.name": "C3", "p2_sales.revenue": None}, {"p2_customers.name": "C4", "p2_sales.revenue": None}]),
    # chains that compose to the SAME key equalities are one meaning — answered from every base
    # (no over-refusal because another physical path exists); another key → two meanings
    ("G12.passthrough.fact_by_product", "G12_passthrough", "p2_sales",
     {"dims": ["p2_products.name"], "measures": ["p2_sales.revenue"]},
     [{"p2_products.name": "Pen", "p2_sales.revenue": 141}, {"p2_products.name": "Ink", "p2_sales.revenue": 57}]),
    ("G12.passthrough.products_base_by_product", "G12_passthrough", "p2_products",
     {"dims": ["p2_products.name"], "measures": ["p2_sales.revenue"]},
     [{"p2_products.name": "Pen", "p2_sales.revenue": 141}, {"p2_products.name": "Ink", "p2_sales.revenue": 57}]),
    ("G12.passthrough.kpi_filter_product", "G12_passthrough", "p2_sales",
     {"dims": [], "measures": ["p2_sales.revenue"], "filters": {"p2_products.name": [f("eq", "Ink")]}},
     [{"p2_sales.revenue": 57}]),
    # Pair #3 H3-13 — the equivalent-key route that is USED is the direct relationship (the strictly
    # shortest): Ink keeps its revenue (57) although the pass-through does not know Ink
    ("G12.orphan.direct_and_chain_by_product", "G12_orphan_direct_and_chain", "p2_sales",
     {"dims": ["p2_products.name"], "measures": ["p2_sales.revenue"]},
     [{"p2_products.name": "Pen", "p2_sales.revenue": 141}, {"p2_products.name": "Ink", "p2_sales.revenue": 57}]),
    ("G12.orphan.direct_and_chain_filter_ink", "G12_orphan_direct_and_chain", "p2_sales",
     {"dims": [], "measures": ["p2_sales.revenue"], "filters": {"p2_products.name": [f("eq", "Ink")]}},
     [{"p2_sales.revenue": 57}]),
    # two equal-length pass-throughs keeping different rows: Pen 141 + (none) 57 through one, (none)
    # 141 + Ink 57 through the other — refused, never the alphabetically first
    ("G12.orphan.two_chains_by_product", "G12_orphan_two_chains", "p2_sales",
     {"dims": ["p2_products.name"], "measures": ["p2_sales.revenue"]}, AMBIGUOUS),
    ("G12.orphan.two_chains_filter_ink", "G12_orphan_two_chains", "p2_sales",
     {"dims": [], "measures": ["p2_sales.revenue"], "filters": {"p2_products.name": [f("eq", "Ink")]}}, AMBIGUOUS),
    ("G12.passthrough_other_key.fact_by_product", "G12_passthrough_other_key", "p2_sales",
     {"dims": ["p2_products.name"], "measures": ["p2_sales.revenue"]}, AMBIGUOUS),
    ("G12.passthrough_other_key.products_base_by_product", "G12_passthrough_other_key", "p2_products",
     {"dims": ["p2_products.name"], "measures": ["p2_sales.revenue"]}, AMBIGUOUS),
    # ── G14: route-count bound ──
    ("G14.lattice_select", "G14_lattice", "p2_lat_fact",
     {"dims": ["p2_lat_top.name"], "measures": ["p2_lat_fact.amount"]}, ROUTE_LIMIT),
    ("G14.lattice_filter", "G14_lattice", "p2_lat_fact",
     {"dims": [], "measures": ["p2_lat_fact.amount"], "filters": {"p2_lat_top.name": [f("eq", "L")]}}, ROUTE_LIMIT),
    # within the bound every chain is seen: the 8 chains all compare lat_fact.k with the top's id
    # (identity keys straight through) — one KEY meaning, but through 8 different intermediate views
    # of equal length: which rows reach the top depends on which intermediate is joined (Pair #3
    # H3-13: an orphan in one of them would be a NULL there) — not provably one answer → refused
    ("G14.lattice_small_select", "G14_lattice_small", "p2_lat_fact",
     {"dims": ["p2_lat_top.name"], "measures": ["p2_lat_fact.amount"]}, AMBIGUOUS),
    ("G14.prop_overflow", "G14_prop_overflow", "p2_revenue",
     {"dims": [], "measures": ["p2_revenue.amount"], "filters": {"p2_deals.stage": [f("eq", "Won")]}}, ROUTE_LIMIT),
    # Ann and Bob both have a Won deal: every owner route keeps their revenue (100+40+25+10)
    ("G14.prop_three", "G14_prop_three", "p2_revenue",
     {"dims": [], "measures": ["p2_revenue.amount"], "filters": {"p2_deals.stage": [f("eq", "Won")]}},
     [{"p2_revenue.amount": 175}]),
    # A filter restricts through the most DIRECT routes (every shortest one, AND-ed): Won deals'
    # dates (Jan 15, Feb 15 2024) → revenue 1, 2, 3, 5 = 170. The 4-hop route (dates → activity on
    # them → that activity's owner ← deals) relays the filter through ANOTHER fact's rows ("owners
    # with an activity on a Won-deal date": revenue 3 → 25) — not a filter route.
    ("G14.prop_unequal", "G14_prop_unequal", "p2_revenue",
     {"dims": [], "measures": ["p2_revenue.amount"], "filters": {"p2_deals.stage": [f("eq", "Won")]}},
     [{"p2_revenue.amount": 170}]),
    # deals of Feb 15 2024 (deal 2: Bob, deal 4: Ann) → their owners' revenue 1-4 = 175 through the
    # shared owner. The longer route — the revenue's CUSTOMER's region vs the deal's region — is
    # another role of the region (it would give 35); not a filter route.
    ("G14.prop_role_longer", "G14_prop_role_longer", "p2_revenue",
     {"dims": [], "measures": ["p2_revenue.amount"], "filters": {"p2_deals.ddate": [f("eq", "2024-02-15")]}},
     [{"p2_revenue.amount": 175}]),
    # a shorter route a filter may NOT travel never hides one it may: deals of Feb 15 2024 → the
    # deal's region (deal 2 → South) → revenue whose customer is in the South (revenue 3, 4) = 35;
    # it used to be DROPPED (the owner route is single-direction) → 180 unfiltered
    ("G14.prop_valid_longer", "G14_prop_valid_longer", "p2_revenue",
     {"dims": [], "measures": ["p2_revenue.amount"], "filters": {"p2_deals.ddate": [f("eq", "2024-02-15")]}},
     [{"p2_revenue.amount": 35}]),
    # a measure-level filter is the MEASURE's (its sale's product), whatever the chart's base: from a
    # revenue-based chart (revenue has its own route to products) the Pen revenue is still sales
    # 1 + 3 + 5 = 141 — the base's route is not the measure's
    ("G16m.revenue_base_pen_rev", "G16m_measure_filter", "p2_revenue",
     {"dims": [], "measures": ["p2_sales.pen_rev"]}, [{"p2_sales.pen_rev": 141}]),
    ("G16m.customers_base_pen_rev", "G16m_measure_filter", "p2_customers",
     {"dims": ["p2_customers.name"], "measures": ["p2_sales.pen_rev"]},
     [{"p2_customers.name": "C1", "p2_sales.pen_rev": 100}, {"p2_customers.name": "C2", "p2_sales.pen_rev": 11},
      {"p2_customers.name": "C3", "p2_sales.pen_rev": 30}, {"p2_customers.name": "C4", "p2_sales.pen_rev": None}]),
    ("G16m.sales_base_pen_rev", "G16m_measure_filter", "p2_sales",
     {"dims": ["p2_customers.name"], "measures": ["p2_sales.pen_rev"]},
     [{"p2_customers.name": "C1", "p2_sales.pen_rev": 100}, {"p2_customers.name": "C2", "p2_sales.pen_rev": 11},
      {"p2_customers.name": "C3", "p2_sales.pen_rev": 30}, {"p2_customers.name": None, "p2_sales.pen_rev": None}]),
    # ── G15: depth bound — a second meaning longer than the planner sees is not "no route" ──
    ("G15.deep_select", "G15_deep_select", "p2_sales",
     {"dims": ["p2_regions.name"], "measures": ["p2_sales.revenue"]}, ROUTE_LIMIT),
    ("G15.deep_kpi_filter", "G15_deep_select", "p2_sales",
     {"dims": [], "measures": ["p2_sales.revenue"], "filters": {"p2_regions.name": [f("eq", "South")]}}, ROUTE_LIMIT),
    ("G15.within_select", "G15_within_select", "p2_sales",
     {"dims": ["p2_regions.name"], "measures": ["p2_sales.revenue"]}, AMBIGUOUS),
    # filter propagation has no depth cut: its routes are the shortest ones (a breadth-first walk) —
    # a 9-hop route next to the direct owner route is not one; ALONE it is, and it applies
    ("G15.deep_prop", "G15_deep_prop", "p2_revenue",
     {"dims": [], "measures": ["p2_revenue.amount"], "filters": {"p2_deals.stage": [f("eq", "Won")]}},
     [{"p2_revenue.amount": 175}]),
    ("G15.deep_prop_only", "G15_deep_prop_only", "p2_revenue",
     {"dims": [], "measures": ["p2_revenue.amount"], "filters": {"p2_deals.stage": [f("eq", "Won")]}},
     [{"p2_revenue.amount": 175}]),
    # ── G7c: two dimension dates (the customer's signup, the store region's founding) — a shorter
    #    chain is not "the" Date: refused; the measure's own date relationship is ──
    ("G7c.indirect_calendars_tie", "G7c_indirect_calendars", "p2_revenue",
     {"dims": [], "measures": ["p2_sales.revenue"],
       "filters": {"p2_revenue.rdate": [f("eq", 2025, calendarField="year", calendarSourceField="rdate")]}},
     AMBIGUOUS),
    ("G7c.own_date_wins", "G7c_direct_and_indirect", "p2_revenue",
     {"dims": [], "measures": ["p2_sales.revenue"],
       "filters": {"p2_revenue.rdate": [f("eq", 2025, calendarField="year", calendarSourceField="rdate")]}},
     [{"p2_sales.revenue": 7}]),
    # the NULL contract (spec): a sale with NO customer (sale 4) passes no predicate on the related
    # view — IS NULL included (SQL three-valued logic, every path); every customer has a name
    ("G1.kpi_customer_name_is_null", "G1_star", "p2_sales",
     {"dims": [], "measures": ["p2_sales.revenue"], "filters": {"p2_customers.name": [f("is_null", None)]}},
     [{"p2_sales.revenue": None}]),
    ("G2.kpi_region_is_null_two_hops", "G2_snowflake", "p2_sales",
     {"dims": [], "measures": ["p2_sales.revenue"], "filters": {"p2_regions.name": [f("is_null", None)]}},
     [{"p2_sales.revenue": None}]),
    ("G1.kpi_customer_name_is_not_null", "G1_star", "p2_sales",
     {"dims": [], "measures": ["p2_sales.revenue"], "filters": {"p2_customers.name": [f("is_not_null", None)]}},
     [{"p2_sales.revenue": 191}]),
    # composite key filter: a partially NULL key matches no store (G8)
    ("G8.kpi_region_filter", "G8_composite", "p2_c_sales",
     {"dims": [], "measures": ["p2_c_sales.amt"], "filters": {"p2_c_regions.label": [f("eq", "North")]}},
     [{"p2_c_sales.amt": 15}]),
]

# Base-invariance: the same KPI asked from every base that relates to the measure
BASE_INVARIANCE = [
    ("G2.kpi", "G2_snowflake", ["p2_sales", "p2_customers", "p2_regions", "p2_products"],
     {"dims": [], "measures": ["p2_sales.revenue"]}, [{"p2_sales.revenue": 198}]),
    ("G2.kpi_region_filter", "G2_snowflake", ["p2_sales", "p2_customers", "p2_regions", "p2_products"],
     {"dims": [], "measures": ["p2_sales.revenue"], "filters": {"p2_regions.name": [f("eq", "North")]}},
     [{"p2_sales.revenue": 130}]),
    ("G7.kpi_order_year_filter", "G7_roles_main", ["p2_sales", "p2_customers"],
     {"dims": [], "measures": ["p2_sales.revenue"], "filters": {"p2_cal.year": [f("eq", 2024)]}},
     [{"p2_sales.revenue": 191}]),
    # G13 — two meanings of "region": refused from EVERY base (no base resolves them) …
    ("G13.kpi_region_filter_ambiguous", "G2_direct_region", ["p2_sales", "p2_regions", "p2_customers"],
     {"dims": [], "measures": ["p2_sales.revenue"], "filters": {"p2_regions.name": [f("eq", "South")]}}, AMBIGUOUS),
    # … one meaning: the same number from every base (the customer's region: C2's 61; the sale's: 57)
    ("G13.kpi_region_filter_customer", "G12_direct_inactive", ["p2_sales", "p2_regions", "p2_customers"],
     {"dims": [], "measures": ["p2_sales.revenue"], "filters": {"p2_regions.name": [f("eq", "South")]}}, [{"p2_sales.revenue": 61}]),
    ("G13.kpi_region_filter_sale", "G12_customer_region_inactive", ["p2_sales", "p2_regions", "p2_customers"],
     {"dims": [], "measures": ["p2_sales.revenue"], "filters": {"p2_regions.name": [f("eq", "South")]}}, [{"p2_sales.revenue": 57}]),
    ("G13.kpi_customer_meaning_ambiguous", "G12_unequal_customers", ["p2_sales", "p2_customers"],
     {"dims": [], "measures": ["p2_sales.revenue"], "filters": {"p2_customers.name": [f("eq", "C2")]}},
     AMBIGUOUS),
]

# Top-N on the final result: A=100, B=80, C=50 style fixture from G1/G6
TOP_N = [
    # sort on the stitched result
    ("G6.sorted_limit_stitched", "G6_three_facts", "p2_revenue",
     {"dims": ["p2_owners.name"], "measures": ["p2_revenue.amount", "p2_deals.value"],
      "sorts": [{"field": "p2_deals.value", "direction": "desc"}], "limit": 1},
     [{"p2_owners.name": "Ann", "p2_revenue.amount": 140, "p2_deals.value": 1120}]),
    # ties broken by the group value, NULL never ranks as top (A 100, B 80 = C 80, D 50, E NULL)
    ("G11.top2_with_tie", "G11_ties", "p2_ties",
     {"dims": ["p2_ties.name"], "measures": ["p2_ties.total"], "top_n": {"field": "p2_ties.total", "n": 2}},
     [{"p2_ties.name": "A", "p2_ties.total": 100}, {"p2_ties.name": "B", "p2_ties.total": 80}]),
    ("G11.top3_with_tie", "G11_ties", "p2_ties",
     {"dims": ["p2_ties.name"], "measures": ["p2_ties.total"], "top_n": {"field": "p2_ties.total", "n": 3}},
     [{"p2_ties.name": "A", "p2_ties.total": 100}, {"p2_ties.name": "B", "p2_ties.total": 80},
      {"p2_ties.name": "C", "p2_ties.total": 80}]),
    ("G11.sorted_limit_with_tie", "G11_ties", "p2_ties",
     {"dims": ["p2_ties.name"], "measures": ["p2_ties.total"],
      "sorts": [{"field": "p2_ties.total", "direction": "desc"}], "limit": 2},
     [{"p2_ties.name": "A", "p2_ties.total": 100}, {"p2_ties.name": "B", "p2_ties.total": 80}]),
    ("G1.top2_customers", "G1_star", "p2_sales",
     {"dims": ["p2_customers.name"], "measures": ["p2_sales.revenue"],
      "top_n": {"field": "p2_sales.revenue", "n": 2}},
     [{"p2_customers.name": "C1", "p2_sales.revenue": 100}, {"p2_customers.name": "C2", "p2_sales.revenue": 61}]),
    ("G6.top1_owner_stitched", "G6_three_facts", "p2_revenue",
     {"dims": ["p2_owners.name"], "measures": ["p2_revenue.amount", "p2_deals.value"],
      "top_n": {"field": "p2_deals.value", "n": 1}},
     [{"p2_owners.name": "Ann", "p2_revenue.amount": 140, "p2_deals.value": 1120}]),
]


# H2-07 — every requested dimension classified BY HAND per topology; the engine
# must behave accordingly (and its grain graph must agree with its FROM route).
SAFE, CONFORMED, UNRELATED_DIM, FANNING, AMBIGUOUS_DIM = (
    "SAFE AT FACT GRAIN", "SAFE AS CONFORMED DIMENSION", "UNRELATED", "FANNING", "AMBIGUOUS")
GRAIN_MATRIX = [
    # (model, base, measures, dimension, class)
    ("G1_star", "p2_sales", ["p2_sales.revenue"], "p2_products.name", SAFE),
    ("G2_snowflake", "p2_sales", ["p2_sales.revenue"], "p2_regions.name", SAFE),
    ("G3_diamond", "p2_sales", ["p2_sales.revenue"], "p2_regions.name", AMBIGUOUS_DIM),
    ("G3_diamond_alias", "p2_sales", ["p2_sales.revenue"], "store_region.name", SAFE),
    ("G4_chasm_both", "p2_revenue", ["p2_revenue.amount", "p2_deals.value"], "p2_cal.year", CONFORMED),
    ("G4_chasm_both", "p2_revenue", ["p2_revenue.amount"], "p2_deals.stage", UNRELATED_DIM),
    ("G5_galaxy_both", "p2_revenue", ["p2_revenue.amount", "p2_deals.value"], "p2_owners.name", CONFORMED),
    ("G6_three_facts", "p2_revenue", ["p2_revenue.amount", "p2_deals.value", "p2_activity.calls"], "p2_cal.year",
     CONFORMED),
    ("G6_three_facts", "p2_revenue", ["p2_revenue.amount", "p2_deals.value"], "p2_deals.stage", UNRELATED_DIM),
    ("G7_roles_main", "p2_sales", ["p2_sales.revenue"], "p2_sales__ship_date__date_dim.year", SAFE),
    ("G8_composite", "p2_c_sales", ["p2_c_sales.amt"], "p2_c_regions.label", SAFE),
    ("G9_bridge_both", "p2_acct_rev", ["p2_acct_rev.amount"], "p2_tags.label", FANNING),
    ("G10_null", "p2_sales", ["p2_sales.revenue"], "p2_customers.name", SAFE),
]
MODELS["G10_null"] = MODELS["G1_star"]
# Semantic foundation — numeric meaning: two unrelated single-table explores
MODELS["F1_numeric"] = {"p2_nums": [], "p2_thirds": []}
# foundation F8: a one-to-one relationship; F10: an invalid one and a non-unique one side
MODELS["F8_one_to_one"] = {"p2_sales": [rel("p2_sales_ext", "id", "sale_id", card="one_to_one")]}
MODELS["F10_invalid"] = {"p2_sales": [rel("p2_customers", "customer_id", "id", card="sometimes")]}
MODELS["F10_dup_key"] = {"p2_sales": [rel("p2_customers_dup", "customer_id", "id")]}
# foundation F11: deals with NO relationship — a filter on owners filters revenue, not deals
MODELS["F11_unrelated_fact"] = {"p2_revenue": [rel("p2_owners", "owner_id", "id")], "p2_deals": [], "p2_owners": []}
