"""Seed gold suite — Olist Public dashboard (ds67), the frozen eval fixture.

Ground-truth values were verified against the live semantic-layer query results
this build cycle (chart 684 trend, category revenue, state distribution, order
status). Keep this suite versioned; refresh when the dashboard/semantic layer
changes. Every fixed bug should add a locking case here (Regression-Catalog
discipline, extended into measurable eval).
"""
from app.services.dashboard_ai_bot.eval.schema import GoldCase, GoldSuite

OLIST_TOKEN = "EpgdXheFXfu3pe61hSIqF3MULlo2xwOU"

OLIST_SUITE = GoldSuite(
    name="olist_public_v1",
    dashboard_token=OLIST_TOKEN,
    fixture_note="Dashboard 67 'Olist Public', 70 charts, 5 pages. Data 2016-09..2018-09.",
    cases=[
        # ── lookup ──────────────────────────────────────────────────────────
        GoldCase(
            id="lookup_gmv_peak_month",
            question="Tháng nào có GMV cao nhất và bằng bao nhiêu?",
            tier="lookup",
            expect_numbers=[1179143.77],
            must_mention=["2017-11|11/2017|11 nam 2017|thang 11 2017|tháng 11"],
            notes="chart 684 monthly GMV peak. Mention accepts any date phrasing.",
        ),
        GoldCase(
            id="lookup_total_orders",
            question="Tổng số đơn hàng của Olist là bao nhiêu?",
            tier="lookup",
            expect_any_numbers=[99441, 99400, 99.4e3],
            notes="KPI 'Số đơn hàng' ~99.4K.",
        ),
        # ── aggregate ───────────────────────────────────────────────────────
        GoldCase(
            id="agg_top_category_revenue",
            question="Danh mục sản phẩm nào có doanh thu cao nhất, bao nhiêu và chiếm mấy % tổng?",
            tier="aggregate",
            expect_numbers=[1258681.34],
            expect_any_numbers=[9.26],
            must_mention=["health_beauty|health beauty|health & beauty|health and beauty|beleza_saude"],
            must_not_mention=["agro_industry"],  # the old Decimal→alphabetical bug's wrong answer
            notes="Regression lock for the Decimal-measure detection bug.",
        ),
        GoldCase(
            id="agg_canceled_share",
            question="Tỷ lệ đơn hàng bị hủy (canceled) chiếm bao nhiêu phần trăm?",
            tier="aggregate",
            expect_any_numbers=[0.63],
            notes="canceled 625 / ~99.4K = 0.63%.",
        ),
        # ── trend ───────────────────────────────────────────────────────────
        GoldCase(
            id="trend_gmv_growth",
            question="GMV theo tháng đang có xu hướng thế nào?",
            tier="trend",
            expect_any_numbers=[260.57, 260.5669],
            must_mention=["tăng"],
            notes="linreg+trim avg(first3) vs avg(last3) = +260.57%.",
        ),
        # ── compare ─────────────────────────────────────────────────────────
        GoldCase(
            id="compare_top_state",
            question="Bang khách hàng nào có nhiều đơn hàng nhất và chiếm bao nhiêu %?",
            tier="compare",
            expect_any_numbers=[41.98],
            must_mention=["SP"],
            notes="São Paulo ~41.98% of orders.",
        ),
        # ── definition (semantic / taught concept) ──────────────────────────
        GoldCase(
            id="def_high_value_order",
            question="Theo quy ước nội bộ của công ty, 'đơn giá trị cao' là đơn như thế nào?",
            tier="definition",
            expect_any_numbers=[500],
            must_mention=["500"],
            notes="Institutional-memory concept: GMV >= 500 BRL. Tests Knowledge-Layer recall.",
        ),
        # ── refusal (out-of-scope / no data) ────────────────────────────────
        GoldCase(
            id="refusal_out_of_range",
            question="Doanh thu tháng 12 năm 2025 của Olist là bao nhiêu?",
            tier="refusal",
            must_refuse=True,
            notes="Data ends 2018-09; must decline, not fabricate.",
        ),
        GoldCase(
            id="refusal_off_topic",
            question="Tỷ giá USD sang VND hôm nay là bao nhiêu?",
            tier="refusal",
            must_refuse=True,
            notes="Not in this report; must decline.",
        ),
    ],
)
