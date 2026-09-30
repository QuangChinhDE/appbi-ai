"""Golden VALUE matrix for the semantic engine — executed, not string-matched.

Every case builds a tiny model whose right answer is computed by hand, asks the
REAL `SemanticQueryEngine` for SQL, EXECUTES it on Postgres, and compares the
returned rows with that answer. A case with no correct number (ambiguity, a
chasm, an M:N grain) must REFUSE — succeed-and-wrong is the one outcome no case
may produce.

    star            one fact, dims via M:1 chains, NULL member, base invariance
    role-playing    one fact, three date roles; one role filtered alone; a fanned
                    "Date" filter collapses onto the main calendar or refuses
    diamond         two equal-length routes to one dim: refused; deactivating
                    one route makes the other deterministic
    galaxy          two facts at DIFFERENT grains (daily sales, monthly targets
                    with one mid-month row), stitched; time grain, Top-N, sort
                    and a measure filter all apply to the stitched rows
    chasm           a dim of another fact through a shared dim: refused; the
                    shared dim itself stitches correctly
    M:N bridge      a dim reachable only through a many-to-many hop: refused
    composite key   a two-column relationship where one column alone is ambiguous
    text filters    literal % / _ ; not_contains ; the NULL contract

Needs Postgres (DATABASE_URL). CI runs it in `integration-golden`, whose database
has the alembic schema. Everything — physical tables in a scratch schema and the
metadata rows — lives in ONE transaction that is rolled back, so the job's other
fixtures are untouched.
"""
from __future__ import annotations

import datetime as dt
import os
from decimal import Decimal

import pytest
import sqlalchemy as sa
from sqlalchemy.orm import Session

from app.models.dataset import Dataset
from app.models.semantic import SemanticExplore, SemanticModel, SemanticView
from app.services.semantic_join_resolver import AmbiguousJoinPathError
from app.services.semantic_query_engine import SemanticQueryEngine

SCHEMA = "golden_sem"
CAL_SQL = (
    "(SELECT g.d::date AS date, EXTRACT(YEAR FROM g.d)::int AS year, "
    "EXTRACT(MONTH FROM g.d)::int AS month "
    "FROM generate_series(DATE '2023-01-01', DATE '2025-12-31', INTERVAL '1 day') AS g(d))"
)

PHYSICAL = [
    "CREATE TABLE {s}.regions(id int, name text)",
    "INSERT INTO {s}.regions VALUES (1,'North'),(2,'South')",
    "CREATE TABLE {s}.customers(id int, region_id int)",
    "INSERT INTO {s}.customers VALUES (1,1),(2,2)",
    "CREATE TABLE {s}.stores(id int, region_id int)",
    "INSERT INTO {s}.stores VALUES (1,2),(2,1)",
    "CREATE TABLE {s}.products(id int, name text)",
    "INSERT INTO {s}.products VALUES (1,'A'),(2,'B')",
    "CREATE TABLE {s}.product_tags(product_id int, tag text)",
    "INSERT INTO {s}.product_tags VALUES (1,'red'),(1,'blue'),(2,'red')",
    # id 5 has NO customer (NULL member) and no ship/delivery date.
    "CREATE TABLE {s}.sales(id int, order_date date, ship_date date, delivery_date date,"
    " customer_id int, store_id int, product_id int, amount numeric, status text)",
    "INSERT INTO {s}.sales VALUES"
    " (1,'2023-01-10','2023-02-05','2023-02-07',1,1,1,100,'ok'),"
    " (2,'2024-03-15','2024-03-20','2025-01-01',1,2,1,200,'ok'),"
    " (3,'2024-06-01','2025-01-02','2025-01-05',2,1,2,300,'x50%_fail'),"
    " (4,'2024-12-31','2025-01-05','2025-01-06',2,2,2,400,'ok'),"
    " (5,'2024-07-01',NULL,NULL,NULL,1,2,50,NULL)",
    # Monthly grain, one row mid-month (2024-06-15) that must land in June.
    "CREATE TABLE {s}.targets(id int, product_id int, month_start date, target numeric)",
    "INSERT INTO {s}.targets VALUES (1,1,'2024-03-01',50),(2,1,'2024-06-01',60),(3,2,'2024-06-15',70)",
    "CREATE TABLE {s}.tickets(id int, customer_id int, priority text)",
    "INSERT INTO {s}.tickets VALUES (1,1,'high'),(2,1,'low'),(3,2,'high')",
    # Composite key: store_code alone repeats across regions.
    "CREATE TABLE {s}.shops(region_code text, store_code text, name text)",
    "INSERT INTO {s}.shops VALUES ('N','1','N-one'),('S','1','S-one')",
    "CREATE TABLE {s}.shop_sales(id int, region_code text, store_code text, amount numeric)",
    "INSERT INTO {s}.shop_sales VALUES (1,'N','1',10),(2,'S','1',20),(3,'S','1',5)",
    # Instants stored as UTC. 2024-06-30 20:00Z is 2024-07-01 03:00 in Asia/Ho_Chi_Minh.
    "CREATE TABLE {s}.events(id int, ts timestamp, amount numeric)",
    "INSERT INTO {s}.events VALUES (1,'2024-06-30 20:00:00',5),(2,'2024-06-15 10:00:00',7)",
]


def _dims(*names):
    return [
        {"name": n, "type": ("date" if n.endswith("date") or n == "month_start" else
                             "number" if n in {"id", "year", "month"} or n.endswith("_id") else "string"),
         "sql": f"${{TABLE}}.{n}"}
        for n in names
    ]


VIEWS = {
    "g_regions": ("regions", _dims("id", "name"), []),
    "g_customers": ("customers", _dims("id", "region_id"), []),
    "g_stores": ("stores", _dims("id", "region_id"), []),
    "g_products": ("products", _dims("id", "name"), []),
    "g_product_tags": ("product_tags", _dims("product_id", "tag"), []),
    "g_sales": ("sales", _dims("id", "order_date", "ship_date", "delivery_date", "customer_id",
                               "store_id", "product_id", "status"), [
        {"name": "revenue", "type": "sum", "sql": "${TABLE}.amount"},
        {"name": "revenue_not_pct", "type": "sum", "sql": "${TABLE}.amount",
         "filters": [{"field": "status", "operator": "not_contains", "value": "50%_"}]},
        {"name": "revenue_pct", "type": "sum", "sql": "${TABLE}.amount",
         "filters": [{"field": "status", "operator": "contains", "value": "0%_"}]},
        {"name": "revenue_wild", "type": "sum", "sql": "${TABLE}.amount",
         "filters": [{"field": "status", "operator": "contains", "value": "5_%"}]},
    ]),
    "g_targets": ("targets", _dims("id", "product_id", "month_start"), [
        {"name": "target", "type": "sum", "sql": "${TABLE}.target"},
    ]),
    "g_tickets": ("tickets", _dims("id", "customer_id", "priority"), [
        {"name": "ticket_count", "type": "count", "sql": "${TABLE}.id"},
    ]),
    "g_shops": ("shops", _dims("region_code", "store_code", "name"), []),
    "g_shop_sales": ("shop_sales", _dims("id", "region_code", "store_code"), [
        {"name": "shop_revenue", "type": "sum", "sql": "${TABLE}.amount"},
    ]),
    # role-played calendars (one per date role) + one main calendar
    "g_sales__order_date__date_dim": (None, _dims("date", "year", "month"), []),
    "g_sales__ship_date__date_dim": (None, _dims("date", "year", "month"), []),
    "g_sales__delivery_date__date_dim": (None, _dims("date", "year", "month"), []),
    "g_targets__month_start__date_dim": (None, _dims("date", "year", "month"), []),
    "g_calendar": (None, _dims("date", "year", "month"), []),
    "g_events": ("events", [*_dims("id"), {"name": "ts", "type": "timestamp", "source_type": "timestamp",
                                          "sql": "${TABLE}.ts"}], [
        {"name": "ev_amount", "type": "sum", "sql": "${TABLE}.amount"},
    ]),
    "g_events__ts__date_dim": (None, _dims("date", "year", "month"), []),
}


def J(view, fc, tc, card="many_to_one", *, active=True, sql_on=""):
    return {"name": view, "view": view, "type": "left", "sql_on": sql_on,
            "from_column": fc, "to_column": tc, "relationship": card, "cardinality": card,
            "is_active": active, "cross_filter": "single"}


CAL_ORDER = J("g_sales__order_date__date_dim", "order_date", "date")
CAL_SHIP = J("g_sales__ship_date__date_dim", "ship_date", "date")
CAL_DELIV = J("g_sales__delivery_date__date_dim", "delivery_date", "date")
CAL_TGT = J("g_targets__month_start__date_dim", "month_start", "date")
TO_PRODUCTS = J("g_products", "product_id", "id")
TO_CUSTOMERS = J("g_customers", "customer_id", "id")
TO_STORES = J("g_stores", "store_id", "id")
REGION = J("g_regions", "region_id", "id")

MODELS = {
    "star": {
        "g_sales": [TO_CUSTOMERS, TO_PRODUCTS, CAL_ORDER],
        "g_customers": [REGION], "g_products": [], "g_regions": [],
    },
    "roles": {"g_sales": [CAL_ORDER, CAL_SHIP, CAL_DELIV]},
    "roles_main": {"g_sales": [CAL_ORDER, CAL_SHIP, CAL_DELIV, J("g_calendar", "order_date", "date")]},
    "diamond": {
        "g_sales": [TO_CUSTOMERS, TO_STORES], "g_customers": [REGION], "g_stores": [REGION],
    },
    "diamond_resolved": {
        "g_sales": [TO_CUSTOMERS, TO_STORES], "g_customers": [REGION],
        "g_stores": [{**REGION, "is_active": False}],
    },
    "galaxy": {
        "g_sales": [TO_PRODUCTS, CAL_ORDER], "g_targets": [TO_PRODUCTS, CAL_TGT], "g_products": [],
    },
    "chasm": {"g_sales": [TO_CUSTOMERS], "g_tickets": [TO_CUSTOMERS], "g_customers": []},
    "bridge": {
        "g_sales": [TO_PRODUCTS],
        "g_products": [J("g_product_tags", "id", "product_id", "one_to_many")],
    },
    "tz": {"g_events": [J(
        "g_events__ts__date_dim", "ts", "date",
        sql_on="${APPBI_LOCAL_DATE(${TABLE}.ts|Asia/Ho_Chi_Minh)} = ${g_events__ts__date_dim}.date",
    )]},
    "composite": {"g_shop_sales": [J(
        "g_shops", "region_code", "region_code",
        sql_on="${TABLE}.region_code = ${g_shops}.region_code AND ${TABLE}.store_code = ${g_shops}.store_code",
    )]},
}


@pytest.fixture(scope="module")
def world():
    url = os.environ.get("DATABASE_URL", "")
    if not url.startswith("postgresql"):
        pytest.fail(
            "test_semantic_golden_matrix executes SQL and needs Postgres "
            f"(DATABASE_URL={url.split('@')[-1] or '<unset>'}). It is not a unit test."
        )
    engine = sa.create_engine(url)
    conn = engine.connect()
    outer = conn.begin()
    db = Session(bind=conn, join_transaction_mode="create_savepoint")
    try:
        conn.execute(sa.text(f"CREATE SCHEMA {SCHEMA}"))
        for stmt in PHYSICAL:
            conn.execute(sa.text(stmt.format(s=SCHEMA)))
        views = {}
        for name, (table, dims, measures) in VIEWS.items():
            v = SemanticView(
                name=name, sql_table_name=(f"{SCHEMA}.{table}" if table else CAL_SQL),
                dataset_table_id=None, dimensions=dims, measures=measures,
            )
            db.add(v)
            views[name] = v
        db.flush()
        # Only the timezone case needs a dataset: its calendar settings carry the zone.
        tz_dataset = Dataset(name="golden_tz", settings={"calendar_dimension": {"timezone": "Asia/Ho_Chi_Minh"}})
        db.add(tz_dataset)
        db.flush()
        models = {}
        for key, explores in MODELS.items():
            m = SemanticModel(name=f"golden_{key}", dataset_id=(tz_dataset.id if key == "tz" else None))
            db.add(m)
            db.flush()
            for base, joins in explores.items():
                db.add(SemanticExplore(
                    name=base, model_id=m.id, base_view_id=views[base].id,
                    base_view_name=base, joins=joins,
                ))
            models[key] = m.id
        db.flush()
        yield db, models
    finally:
        db.close()
        outer.rollback()
        conn.close()
        engine.dispose()


def run(world, model, base, dims, measures, filters=None, **kw):
    db, models = world
    sql, cols, _ = SemanticQueryEngine(db, database_type="postgresql").generate_sql(
        explore_name=base, dimensions=dims, measures=measures, filters=filters or {},
        model_id=models[model], **kw,
    )
    return [tuple(_norm(v) for v in r) for r in db.execute(sa.text(sql))]


def _norm(v):
    if isinstance(v, Decimal):
        return int(v) if v == int(v) else float(v)
    if isinstance(v, dt.datetime):
        return v.date().isoformat()
    if isinstance(v, dt.date):
        return v.isoformat()
    return v


def as_map(rows):
    return {r[0]: (r[1] if len(r) == 2 else r[1:]) for r in rows}


# ── star ─────────────────────────────────────────────────────────────────────


def test_star_values_by_dim_and_by_two_hop_dim_with_a_null_member(world):
    assert as_map(run(world, "star", "g_sales", ["g_products.name"], ["g_sales.revenue"])) == {"A": 300, "B": 750}
    # Two hops (sales → customers → regions); the sale with no customer is its own (NULL) group.
    assert as_map(run(world, "star", "g_sales", ["g_regions.name"], ["g_sales.revenue"])) == {
        "North": 300, "South": 700, None: 50,
    }


def test_star_base_invariance(world):
    for base in ("g_sales", "g_products"):
        assert run(world, "star", base, [], ["g_sales.revenue"],
                   {"g_products.name": {"operator": "eq", "value": "A"}}) == [(300,)], base


def test_star_null_contract_negations_exclude_missing_members(world):
    """Documented contract (docs/filter-semantics.md §7a): a negated filter on a
    related dim keeps rows whose member passes it; a row with NO member (NULL
    key) passes no predicate, negations included — SQL three-valued logic, the
    same on the engine, EXISTS, live and distinct paths."""
    for op, value in (("neq", "North"), ("not_in", ["North"]), ("not_contains", "Nor")):
        assert run(world, "star", "g_sales", [], ["g_sales.revenue"],
                   {"g_regions.name": {"operator": op, "value": value}}) == [(700,)], op
    assert run(world, "star", "g_sales", [], ["g_sales.revenue"],
               {"g_regions.name": {"operator": "is_null"}}) == [(None,)], "is_null on a related dim matches no row"


def test_star_time_grains_month_and_iso_week(world):
    assert as_map(run(world, "star", "g_sales", ["g_sales__order_date__date_dim.date"], ["g_sales.revenue"],
                      time_grains={"g_sales__order_date__date_dim.date": "month"})) == {
        "2023-01-01": 100, "2024-03-01": 200, "2024-06-01": 300, "2024-07-01": 50, "2024-12-01": 400,
    }
    weeks = as_map(run(world, "star", "g_sales", ["g_sales__order_date__date_dim.date"], ["g_sales.revenue"],
                       time_grains={"g_sales__order_date__date_dim.date": "week"}))
    assert weeks["2024-12-30"] == 400  # Tue 2024-12-31 → ISO week starting Mon 2024-12-30
    assert weeks["2024-05-27"] == 300  # Sat 2024-06-01 → week of Mon 2024-05-27


# ── text filters: literal pattern, not_contains ──────────────────────────────


def test_measure_text_filters_match_literally_and_not_contains_applies(world):
    rows = run(world, "star", "g_sales", [],
               ["g_sales.revenue_not_pct", "g_sales.revenue_pct", "g_sales.revenue_wild"])
    # not_contains '50%_': ok rows 100+200+400 (NULL status passes no predicate);
    # contains '0%_' literally: only 'x50%_fail'; '5_%' literally: nothing — as a
    # wildcard it would have matched 'x50%_fail'.
    assert rows == [(700, 300, None)]


# ── role-playing date (3 roles) ──────────────────────────────────────────────


def test_each_date_role_groups_by_its_own_date(world):
    by = lambda role: as_map(run(world, "roles", "g_sales", [f"g_sales__{role}__date_dim.year"],  # noqa: E731
                                 ["g_sales.revenue"]))
    assert by("order_date") == {2023: 100, 2024: 950}
    assert by("ship_date") == {2023: 100, 2024: 200, 2025: 700, None: 50}
    assert by("delivery_date") == {2023: 100, 2025: 900, None: 50}


def test_a_filter_on_one_role_is_not_anded_with_the_others(world):
    assert run(world, "roles", "g_sales", [], ["g_sales.revenue"],
               {"g_sales__ship_date__date_dim.year": {"operator": "eq", "value": 2025}}) == [(700,)]


FANNED_2024 = {
    f"g_sales.{c}": {"operator": "eq", "value": 2024, "calendarField": "year", "calendarSourceField": c}
    for c in ("order_date", "ship_date", "delivery_date")
}


def test_a_fanned_date_filter_collapses_onto_the_main_calendar(world):
    # One "Date" slicer fanned across three role columns means the MAIN date:
    # orders in 2024 = 200+300+400+50. AND-ing the roles gave 0.
    assert run(world, "roles_main", "g_sales", [], ["g_sales.revenue"], dict(FANNED_2024)) == [(950,)]


def test_a_fanned_date_filter_without_a_main_calendar_refuses(world):
    with pytest.raises(ValueError):
        run(world, "roles", "g_sales", [], ["g_sales.revenue"], dict(FANNED_2024))


# ── diamond ──────────────────────────────────────────────────────────────────


def test_diamond_refuses_to_pick_a_route_for_select_and_for_filter(world):
    with pytest.raises(AmbiguousJoinPathError):
        run(world, "diamond", "g_sales", ["g_regions.name"], ["g_sales.revenue"])
    with pytest.raises(AmbiguousJoinPathError):
        run(world, "diamond", "g_sales", [], ["g_sales.revenue"],
            {"g_regions.name": {"operator": "eq", "value": "North"}})


def test_diamond_with_one_route_inactive_is_deterministic(world):
    assert as_map(run(world, "diamond_resolved", "g_sales", ["g_regions.name"], ["g_sales.revenue"])) == {
        "North": 300, "South": 700, None: 50,
    }
    assert run(world, "diamond_resolved", "g_sales", [], ["g_sales.revenue"],
               {"g_regions.name": {"operator": "eq", "value": "North"}}) == [(300,)]


# ── galaxy: two facts, different grains ──────────────────────────────────────


def test_galaxy_by_shared_dim(world):
    for base in ("g_sales", "g_targets"):
        assert as_map(run(world, "galaxy", base, ["g_products.name"], ["g_sales.revenue", "g_targets.target"])) == {
            "A": (300, 110), "B": (750, 70),
        }, base


def test_galaxy_time_grain_survives_the_calendar_rebind(world):
    assert as_map(run(world, "galaxy", "g_sales", ["g_sales__order_date__date_dim.date"],
                      ["g_sales.revenue", "g_targets.target"],
                      time_grains={"g_sales__order_date__date_dim.date": "month"})) == {
        "2023-01-01": (100, None), "2024-03-01": (200, 50), "2024-06-01": (300, 130),
        "2024-07-01": (50, None), "2024-12-01": (400, None),
    }


def test_galaxy_top_n_and_sort_apply_after_the_stitch(world):
    assert run(world, "galaxy", "g_sales", ["g_products.name"], ["g_sales.revenue", "g_targets.target"],
               top_n={"field": "g_sales.revenue", "n": 1}) == [("B", 750, 70)]
    assert run(world, "galaxy", "g_sales", ["g_products.name"], ["g_sales.revenue", "g_targets.target"],
               sorts=[{"field": "g_targets.target", "direction": "desc"}]) == [("A", 300, 110), ("B", 750, 70)]


def test_galaxy_measure_filter_removes_the_whole_stitched_row(world):
    """`revenue > 400` keeps B only — A's target must not survive on its own
    row, and the filter must not become a row filter on targets."""
    assert run(world, "galaxy", "g_sales", ["g_products.name"], ["g_sales.revenue", "g_targets.target"],
               {"g_sales.revenue": {"operator": "gt", "value": 400}}) == [("B", 750, 70)]


# ── chasm ────────────────────────────────────────────────────────────────────


def test_chasm_refuses_a_dim_of_the_other_fact(world):
    with pytest.raises(ValueError):
        run(world, "chasm", "g_sales", ["g_tickets.priority"], ["g_sales.revenue"])


def test_chasm_facts_stitch_on_the_shared_dim(world):
    assert as_map(run(world, "chasm", "g_sales", ["g_customers.id"],
                      ["g_sales.revenue", "g_tickets.ticket_count"])) == {1: (300, 2), 2: (700, 1), None: (50, None)}


# ── M:N bridge ───────────────────────────────────────────────────────────────


def test_grouping_through_a_one_to_many_bridge_refuses(world):
    with pytest.raises(ValueError):
        run(world, "bridge", "g_sales", ["g_product_tags.tag"], ["g_sales.revenue"])


# ── composite key ────────────────────────────────────────────────────────────


def test_composite_key_uses_both_columns(world):
    assert as_map(run(world, "composite", "g_shop_sales", ["g_shops.name"], ["g_shop_sales.shop_revenue"])) == {
        "N-one": 10, "S-one": 25,
    }


# ── timezone: time grain and calendar agree on the LOCAL day ─────────────────


def test_time_grain_and_calendar_bucket_an_instant_on_the_same_local_day(world):
    """Calendar timezone Asia/Ho_Chi_Minh: the 2024-06-30 20:00Z event is a July
    event locally. Grouping by the month GRAIN and by the calendar's month must
    agree (the grain used to bucket the raw UTC instant into June)."""
    assert as_map(run(world, "tz", "g_events", ["g_events.ts"], ["g_events.ev_amount"],
                      time_grains={"g_events.ts": "month"})) == {"2024-06-01": 7, "2024-07-01": 5}
    assert as_map(run(world, "tz", "g_events", ["g_events__ts__date_dim.month"], ["g_events.ev_amount"])) == {
        6: 7, 7: 5,
    }
