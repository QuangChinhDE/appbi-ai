"""The layout engine's invariants, checked without a browser or a model.

These are the properties an imported report must have no matter what the source
looked like. Each one stands for a bug that shipped: tiles landing on top of one
another, widgets arriving with no coordinates at all, and blocks disappearing
between the analyzer and the grid.
"""

import pytest

from app.services.dashboard_html_import_service import (
    IMPORT_TEMPLATE_FAMILIES,
    LAYOUT_RECIPES,
    RECIPE_GRID_COLS,
    apply_layout_recipe,
    compose_import_layout,
    _normalize_template_family,
)


def _chart(block_id, chart_type, order):
    return {"block_id": block_id, "order": order, "final_chart_type": chart_type}


def _widget(block_id, widget_type, order):
    return {
        "block_id": block_id,
        "order": order,
        "widget_type": widget_type,
        "widget_config": {},
        "title": block_id,
    }


def _mixed_document():
    """One block of every kind the engine has to place, interleaved.

    Interleaved on purpose: a source that groups its KPIs together is the easy
    case. The packer has to produce a coherent report from one that does not.
    """
    return [
        _widget("hero", "hero_strip", 1),
        _chart("kpi-1", "KPI", 2),
        _widget("sec-1", "section_header", 3),
        _chart("kpi-2", "KPI", 4),
        _chart("bar-1", "BAR", 5),
        _widget("note-1", "callout", 6),
        _chart("tbl-1", "TABLE", 7),
        _chart("kpi-3", "KPI", 8),
        _chart("line-1", "LINE", 9),
        _widget("frag-1", "html_fragment", 10),
        _widget("copy-1", "text", 11),
        _chart("pie-1", "PIE", 12),
    ]


def _overlaps(a, b):
    ax, ay, aw, ah = a["x"], a["y"], a["w"], a["h"]
    bx, by, bw, bh = b["x"], b["y"], b["w"], b["h"]
    return ax < bx + bw and bx < ax + aw and ay < by + bh and by < ay + ah


@pytest.mark.parametrize("family", IMPORT_TEMPLATE_FAMILIES)
def test_no_two_tiles_overlap(family):
    items = _mixed_document()
    apply_layout_recipe(items, family)
    placed = [(it["block_id"], it["layout"]) for it in items]
    for i, (id_a, a) in enumerate(placed):
        for id_b, b in placed[i + 1:]:
            assert not _overlaps(a, b), f"{family}: {id_a} overlaps {id_b} ({a} vs {b})"


@pytest.mark.parametrize("family", IMPORT_TEMPLATE_FAMILIES)
def test_every_block_is_placed(family):
    """No block reaches the grid without coordinates.

    Widgets used to be packed on a separate pass from charts, so every one of
    them arrived with no layout and the builder defaulted it to (0, 0) --
    stacking every section header on top of the first chart.
    """
    items = _mixed_document()
    apply_layout_recipe(items, family)
    for item in items:
        layout = item.get("layout")
        assert isinstance(layout, dict), f"{family}: {item['block_id']} has no layout"
        assert layout["w"] > 0 and layout["h"] > 0
        assert 0 <= layout["x"] < RECIPE_GRID_COLS
        assert layout["x"] + layout["w"] <= RECIPE_GRID_COLS


@pytest.mark.parametrize("family", IMPORT_TEMPLATE_FAMILIES)
def test_only_the_topmost_tile_sits_at_the_origin(family):
    items = _mixed_document()
    apply_layout_recipe(items, family)
    at_origin = [
        it["block_id"] for it in items
        if it["layout"]["x"] == 0 and it["layout"]["y"] == 0
    ]
    assert len(at_origin) <= 1, f"{family}: {at_origin} all landed at (0,0)"


@pytest.mark.parametrize("family", IMPORT_TEMPLATE_FAMILIES)
def test_a_section_header_sits_directly_above_what_it_introduces(family):
    """The document's structure has to survive the template.

    The first recipe model sorted blocks into a contiguous band per kind, so a
    report's three section headers ended up stacked at rows 0, 2 and 4 --
    introducing nothing, with the content they named scattered below.
    """
    items = _mixed_document()
    apply_layout_recipe(items, family)
    by_id = {it["block_id"]: it["layout"] for it in items}
    header = by_id["sec-1"]
    # Everything that FOLLOWS the header in the source starts below it.
    for block_id in ("bar-1", "tbl-1", "line-1", "pie-1"):
        assert by_id[block_id]["y"] >= header["y"] + header["h"], (
            f"{family}: {block_id} is not below the header that introduces it"
        )
    # And a header always owns its row.
    same_row = [i for i, layout in by_id.items() if layout["y"] == header["y"] and i != "sec-1"]
    assert not same_row, f"{family}: {same_row} share a row with a section header"


@pytest.mark.parametrize("family", IMPORT_TEMPLATE_FAMILIES)
def test_the_recipe_gives_each_kind_its_own_shape(family):
    """The template owns shape even though the document owns order."""
    items = _mixed_document()
    apply_layout_recipe(items, family)
    flow = LAYOUT_RECIPES[family]["flow"]
    for item in items:
        kind = item["_region"]
        if kind not in flow:
            continue
        shape = flow[kind]
        expected_w = RECIPE_GRID_COLS if shape.get("full") else RECIPE_GRID_COLS // shape["cols"]
        assert item["layout"]["w"] == expected_w, f"{family}: {item['block_id']} ({kind})"
        assert item["layout"]["h"] == shape["h"]


@pytest.mark.parametrize("family", IMPORT_TEMPLATE_FAMILIES)
def test_kpis_are_grouped_not_scattered(family):
    """A KPI strip is a strip.

    The source interleaves its KPIs with charts; reading that order literally
    produces a report with single KPIs sprinkled between visuals, which is the
    look the recipes exist to replace.
    """
    items = _mixed_document()
    apply_layout_recipe(items, family)
    kpi_rows = {it["layout"]["y"] for it in items if it["block_id"].startswith("kpi-")}
    assert len(kpi_rows) == 1, f"{family}: 3 KPIs spread over rows {sorted(kpi_rows)}"


def test_a_declared_layout_is_never_overwritten():
    """A round-trip reproduces the author's report rather than redesigning it."""
    authored = {"x": 6, "y": 3, "w": 6, "h": 9}
    plans = [
        {
            "block_id": "authored",
            "order": 1,
            "final_chart_type": "BAR",
            "layout": dict(authored),
        },
        _chart("free", "LINE", 2),
    ]
    compose_import_layout(chart_plans=plans, widgets=[], family="console")
    assert plans[0]["layout"] == authored


def test_generated_tiles_pack_around_a_partial_authored_layout():
    """Partial metadata is common when an author pins only the hero visual."""
    authored = _chart("authored", "BAR", 1)
    authored["layout"] = {"x": 0, "y": 0, "w": 8, "h": 5}
    generated = [
        _chart("kpi-a", "KPI", 2),
        _chart("kpi-b", "KPI", 3),
        _chart("chart-a", "LINE", 4),
    ]

    compose_import_layout(
        chart_plans=[authored, *generated],
        widgets=[],
        family="console",
    )

    assert authored["layout"] == {"x": 0, "y": 0, "w": 8, "h": 5}
    placed = [authored, *generated]
    for index, item in enumerate(placed):
        for other in placed[index + 1:]:
            assert not _overlaps(item["layout"], other["layout"]), (
                f"{item['block_id']} overlaps {other['block_id']}"
            )


def test_interleaved_kpis_are_hoisted_into_one_strip():
    """A KPI strip is a strip, whatever order the source used.

    Hoisting is kind-based rather than taken from the model's region list: a
    KPI is a header by nature, and a source that sprinkles single KPIs between
    charts reads as noise however faithfully it is reproduced.
    """
    items = [_chart("kpi-a", "KPI", 1), _chart("bar", "BAR", 2), _chart("kpi-b", "KPI", 3)]
    compose_import_layout(chart_plans=items, widgets=[], family="console")
    by_id = {it["block_id"]: it["layout"] for it in items}
    assert by_id["kpi-a"]["y"] == by_id["kpi-b"]["y"]
    assert by_id["bar"]["y"] > by_id["kpi-a"]["y"]


def test_an_empty_document_places_nothing_and_does_not_raise():
    assert apply_layout_recipe([], "console") == []


def test_a_document_of_one_kind_still_fills_the_width():
    """Ten KPIs and nothing else must not leave nine of them stacked in column 0."""
    items = [_chart(f"kpi-{i}", "KPI", i) for i in range(1, 11)]
    apply_layout_recipe(items, "console")
    assert len({it["layout"]["x"] for it in items}) > 1
    # A region's `max` is a soft cap. Ten KPIs keep the KPI strip's shape; they
    # do not spill to the bottom of the report as full-width bars.
    assert len({it["layout"]["w"] for it in items}) == 1
    # A soft-capped strip keeps its shape; the extras do not spill to the
    # bottom of the report as full-width bars.
    assert max(it["layout"]["w"] for it in items) < RECIPE_GRID_COLS


@pytest.mark.parametrize(
    "alias,expected",
    [
        ("presentation", "stage"),
        ("deck", "stage"),
        ("executive_brief", "brief"),
        ("Operations", "ops"),
        ("report", "editorial"),
        ("SaaS", "console"),
        ("console", "console"),
        ("nonsense", None),
        ("", None),
        (None, None),
    ],
)
def test_template_ids_stay_in_sync_with_the_frontend_catalog(alias, expected):
    """The FE catalog and the importer must name the same five templates.

    They drifted once: the importer emitted `presentation`, the catalog had
    `stage`, and every report imported as that family fell back to the default
    look with no error anywhere.
    """
    assert _normalize_template_family(alias) == expected


# ── Which template a document gets ──────────────────────────────────────────


def _plans(kpi=0, chart=0, table=0):
    return (
        [{"final_chart_type": "KPI"} for _ in range(kpi)]
        + [{"final_chart_type": "BAR"} for _ in range(chart)]
        + [{"final_chart_type": "TABLE"} for _ in range(table)]
    )


def _doc(prose_chars=0, block_count=1):
    per = prose_chars // max(block_count, 1)
    return {"blocks": [{"role": "text", "text": "x" * per} for _ in range(max(block_count, 1))]}


@pytest.mark.parametrize(
    "name,plan,document,expected",
    [
        ("saas console", _plans(4, 4, 1), _doc(200, 3), "console"),
        ("board pack", _plans(3, 1, 1), _doc(700, 4), "brief"),
        ("ops wall", _plans(6, 8, 4), _doc(150, 3), "ops"),
        ("data story", _plans(3, 2, 1), _doc(2600, 8), "editorial"),
        ("metric wall", _plans(3, 2, 0), _doc(120, 2), "stage"),
    ],
)
def test_five_document_shapes_get_five_different_templates(name, plan, document, expected):
    """The templates only earn their keep if the chooser can tell them apart.

    The board-pack rule used to fire on any 3-KPI document that had a table,
    so a 4-KPI/4-chart/1-table SaaS console came out as a brief -- and the
    brief recipe has ONE main chart slot, so the console's grid was packed into
    a single oversized tile with the rest below it.
    """
    from app.services.dashboard_html_import_service import choose_template_family

    assert choose_template_family(document, plan) == expected, name


# ── Classification decides what a block becomes ─────────────────────────────


def _split(plans, block_plan):
    from app.services.dashboard_html_import_service import split_plans_by_classification

    return split_plans_by_classification(plans, block_plan)


def test_an_unbindable_kpi_card_does_not_become_a_full_width_table():
    """The bug this rule exists for.

    The chart planner's fallback for "I cannot bind this block to a column" is
    TABLE, and a table is the widest, tallest tile in the grid. So four KPI
    cards holding figures with no column behind them were laid out as four
    full-width detail bands -- the least important content rendered as the most
    prominent thing on the page.
    """
    plans = [
        {"block_id": f"kpi-{i}", "final_chart_type": "TABLE", "confidence": 0.4}
        for i in range(1, 5)
    ]
    block_plan = [
        {"block_id": f"kpi-{i}", "classification": "native_widget", "widget_type": "callout"}
        for i in range(1, 5)
    ]
    charts, reclassified = _split(plans, block_plan)
    assert charts == []
    assert [r["block_id"] for r in reclassified] == ["kpi-1", "kpi-2", "kpi-3", "kpi-4"]


def test_a_confident_chart_outranks_the_classification():
    """The planner bound it to real columns; that is evidence, not a guess."""
    plans = [{"block_id": "b1", "final_chart_type": "BAR", "confidence": 0.95}]
    block_plan = [{"block_id": "b1", "classification": "native_widget", "widget_type": "callout"}]
    charts, reclassified = _split(plans, block_plan)
    assert len(charts) == 1 and not reclassified


def test_an_unsupported_interaction_is_dropped_even_when_confident():
    """A tab strip is not a chart, however sure the planner is."""
    plans = [{"block_id": "tabs", "final_chart_type": "TABLE", "confidence": 0.99}]
    block_plan = [{"block_id": "tabs", "classification": "unsupported_interaction"}]
    charts, reclassified = _split(plans, block_plan)
    assert charts == [] and len(reclassified) == 1


def test_no_classification_leaves_every_plan_alone():
    """AI assist off must not change what a chart-first import produces."""
    plans = [{"block_id": "b1", "final_chart_type": "BAR", "confidence": 0.2}]
    charts, reclassified = _split(plans, None)
    assert charts == plans and reclassified == []


def test_a_block_classified_as_a_slicer_keeps_its_chart():
    """The slicer is built from resolved columns, not from the block.

    Dropping the chart would trade a real visual for a control that may not
    resolve to any column at all.
    """
    plans = [{"block_id": "b1", "final_chart_type": "BAR", "confidence": 0.3}]
    block_plan = [{"block_id": "b1", "classification": "slicer"}]
    charts, reclassified = _split(plans, block_plan)
    assert len(charts) == 1 and not reclassified


# ── Calculated fields must reference real columns ───────────────────────────


def _calc(fields, columns=None, notes=None):
    from app.services.dashboard_html_import_service import _validate_calculated_fields

    return [
        f["name"]
        for f in _validate_calculated_fields(
            fields,
            columns if columns is not None else ["price", "freight_value", "delivery_days"],
            warnings_out=notes,
        )
    ]


def test_a_hallucinated_column_does_not_reach_the_query():
    """One invented column used to fail every chart in the import.

    The validator assembled a set of known columns and then never consulted it,
    so `avg_delivery_days_current - avg_delivery_days_previous` -- invented from
    a KPI card that displayed a delta -- passed, was injected into the SELECT of
    every chart, and made all ten fail with `column ... does not exist`. The
    Build button stayed disabled and nothing said why.
    """
    notes = []
    kept = _calc(
        [{"name": "d", "expression": "avg_delivery_days_current - avg_delivery_days_previous"}],
        notes=notes,
    )
    assert kept == []
    assert notes and "avg_delivery_days_current" in notes[0]


def test_sql_functions_are_not_mistaken_for_columns():
    assert _calc([{"name": "pct", "expression": "ROUND(COALESCE(freight_value, 0) / price * 100, 2)"}]) == ["pct"]


def test_a_field_may_build_on_an_earlier_field_but_not_a_later_one():
    assert _calc([
        {"name": "a", "expression": "price * 2"},
        {"name": "b", "expression": "a + freight_value"},
    ]) == ["a", "b"]
    assert _calc([
        {"name": "b", "expression": "a + price"},
        {"name": "a", "expression": "price * 2"},
    ]) == ["a"]


def test_column_matching_ignores_case():
    assert _calc([{"name": "c", "expression": "PRICE + Freight_Value"}]) == ["c"]


def test_a_demoted_kpi_card_keeps_the_shape_of_a_kpi():
    """It is still a KPI card; only its data binding was lost.

    Shaped as a plain callout it came out six columns wide and five rows tall.
    Four of those filled the top of the report as fat boxes where the source
    had a tidy strip of four.
    """
    widgets = [
        {
            "block_id": f"kpi-{i}",
            "order": i,
            "widget_type": "callout",
            "_source_role": "kpi",
            "widget_config": {"text": "R$ 13.59M"},
        }
        for i in range(1, 5)
    ]
    compose_import_layout(chart_plans=[], widgets=widgets, family="console")
    rows = {w["layout"]["y"] for w in widgets}
    assert len(rows) == 1, "four KPI cards should sit on one row"
    assert all(w["layout"]["w"] == RECIPE_GRID_COLS // 4 for w in widgets)


def test_a_real_callout_is_not_mistaken_for_a_kpi():
    widgets = [{
        "block_id": "note",
        "order": 1,
        "widget_type": "callout",
        "_source_role": "text",
        "widget_config": {"text": "Late orders average 4.1 days beyond estimate."},
    }]
    compose_import_layout(chart_plans=[], widgets=widgets, family="console")
    assert widgets[0]["_region"] == "callout"


def test_a_preserved_kpi_card_still_sits_in_the_kpi_strip():
    """Preserving the source's own card must not cost it its place.

    A KPI the planner could not bind is kept as the source's own markup rather
    than demoted to a line of grey text -- but it is still a KPI, so it belongs
    in the strip at the strip's width, not in the body at a fragment's width.
    """
    widgets = [
        {
            "block_id": f"kpi-{i}",
            "order": i,
            "widget_type": "html_fragment",
            "_source_role": "kpi",
            "widget_config": {"html": "<div>R$ 13.59M</div>"},
        }
        for i in range(1, 5)
    ]
    compose_import_layout(chart_plans=[], widgets=widgets, family="console")
    assert len({w["layout"]["y"] for w in widgets}) == 1
    assert all(w["_region"] == "kpi_strip" for w in widgets)


def test_a_preserved_illustration_is_not_treated_as_a_kpi():
    widgets = [{
        "block_id": "art",
        "order": 1,
        "widget_type": "html_fragment",
        "_source_role": "chart",
        "widget_config": {"html": "<svg></svg>"},
    }]
    compose_import_layout(chart_plans=[], widgets=widgets, family="console")
    assert widgets[0]["_region"] == "html_fragment"


def test_an_unbindable_kpi_is_reclassified_without_asking_the_model():
    """The safety net that makes the outcome stable run to run.

    Classification varies between model calls, so the same document imported as
    four tidy cards one time and four full-size tables the next. A KPI block
    that the planner rendered as a TABLE is the planner saying it could not bind
    the block, and that is evidence on its own.
    """
    plans = [
        {"block_id": "kpi-1", "final_chart_type": "TABLE", "confidence": 0.99},
        {"block_id": "chart-1", "final_chart_type": "BAR", "confidence": 0.5},
    ]
    roles = {"kpi-1": "kpi", "chart-1": "chart"}
    charts, reclassified = _split_with_roles(plans, None, roles)
    assert [c["block_id"] for c in charts] == ["chart-1"]
    assert [r["block_id"] for r in reclassified] == ["kpi-1"]


def test_a_kpi_block_the_planner_DID_bind_stays_a_chart():
    """Only the TABLE fallback counts as giving up."""
    plans = [{"block_id": "kpi-1", "final_chart_type": "KPI", "confidence": 0.9}]
    charts, reclassified = _split_with_roles(plans, None, {"kpi-1": "kpi"})
    assert len(charts) == 1 and not reclassified


def test_a_real_table_block_is_left_alone():
    plans = [{"block_id": "t1", "final_chart_type": "TABLE", "confidence": 0.9}]
    charts, reclassified = _split_with_roles(plans, None, {"t1": "table"})
    assert len(charts) == 1 and not reclassified


def _split_with_roles(plans, block_plan, roles):
    from app.services.dashboard_html_import_service import split_plans_by_classification

    return split_plans_by_classification(plans, block_plan, block_roles=roles)


# ── Preserved fragments actually get produced ───────────────────────────────


_KPI_FRAGMENT = (
    '<div style="padding:16px 18px;background-color:rgb(255,255,255)">'
    '<div style="font-size:11px">GROSS REVENUE</div>'
    '<div style="font-size:27px">R$ 13.59M</div>'
    '<div style="font-size:12px">+8.4% vs prior</div>'
    "</div>"
)
_KPI_TEXT = "GROSS REVENUE R$ 13.59M +8.4% vs prior"


def _one_widget(block_plan):
    from app.services.dashboard_html_import_service import widgets_from_blocks

    summary = {"blocks": [{
        "id": "b1", "order": 1, "tag": "div", "role": "kpi",
        "heading": "", "text": _KPI_TEXT, "classes": ["kpi"], "html": _KPI_FRAGMENT,
    }]}
    out = widgets_from_blocks([{"block_id": "b1"}], summary, block_plan=block_plan)
    return out[0] if out else None


@pytest.mark.parametrize("block_plan", [
    None,
    [{"block_id": "b1", "classification": "native_widget", "widget_type": "text"}],
    [{"block_id": "b1", "classification": "native_widget", "widget_type": "callout"}],
])
def test_an_unbindable_kpi_card_keeps_the_source_presentation(block_plan):
    """The branch that made the preserved-card path real.

    The widget kind was being switched to `html_fragment` and then handed to an
    if/elif chain that had no branch for it, so the trailing `else` rewrote it
    back to `text`. Every path through this function looked wired up and not one
    of them ever produced a fragment: four finished KPI cards -- small caps
    label, 27px figure, coloured delta -- rendered as four lines of 11px grey
    text.
    """
    widget = _one_widget(block_plan)
    assert widget is not None
    assert widget["widget_type"] == "html_fragment"
    assert "R$ 13.59M" in widget["widget_config"]["html"]
    assert widget["widget_config"]["degraded"], "a frozen block must say it is frozen"


def test_a_heading_is_still_a_heading_not_a_fragment():
    """Preservation is the last resort, not the first."""
    from app.services.dashboard_html_import_service import widgets_from_blocks

    summary = {"blocks": [{
        "id": "h1", "order": 1, "tag": "h2", "role": "title",
        "heading": "Revenue & fulfilment", "text": "Revenue & fulfilment",
        "classes": [], "html": "<h2 style='font-size:15px'>Revenue &amp; fulfilment</h2>",
    }]}
    out = widgets_from_blocks([{"block_id": "h1"}], summary)
    assert out[0]["widget_type"] == "section_header"
    assert out[0]["widget_config"]["title"] == "Revenue & fulfilment"
    # And it must not repeat itself underneath.
    assert not out[0]["widget_config"]["subtitle"]


def test_a_candidate_the_planner_skipped_is_not_lost():
    """The quietest of the three ways a block could disappear.

    A block the analyzer thought was chartable is not in `ignored`; if the
    model then returns no plan for it, it is not in the plans either, and
    nothing downstream ever sees it again. Two of a brief's three headline
    figures went missing exactly this way -- with no warning, because no code
    path knew they had existed.
    """
    from app.services.dashboard_html_import_service import widgets_from_blocks

    summary = {"blocks": [
        {"id": "kept", "order": 1, "tag": "div", "role": "kpi", "heading": "",
         "text": "GROSS REVENUE R$ 13.59M", "classes": [], "html": _KPI_FRAGMENT},
        {"id": "skipped", "order": 2, "tag": "div", "role": "kpi", "heading": "",
         "text": "LATE RATE 6.8%", "classes": [], "html": _KPI_FRAGMENT},
    ]}
    # `skipped` was a candidate the planner returned nothing for; it reaches the
    # widget builder the same way an ignored block does.
    out = widgets_from_blocks([{"block_id": "skipped"}], summary)
    assert [w["block_id"] for w in out] == ["skipped"]
    assert out[0]["widget_type"] == "html_fragment"


@pytest.mark.parametrize("markup,text,expected", [
    # A KPI card: label, figure, delta.
    ('<div><div>GROSS REVENUE</div><div>R$ 13.59M</div><div>+8.4%</div></div>',
     "GROSS REVENUE R$ 13.59M +8.4%", True),
    # A two-part card is still a card.
    ('<div><div>LATE RATE</div><div>6.8%</div></div>', "LATE RATE 6.8%", True),
    # A bare heading is a heading; a section_header carries it better.
    ('<h2>Revenue trajectory</h2>', "Revenue trajectory", False),
    # A paragraph is copy.
    ('<p>Late orders average 4.1 days beyond estimate.</p>',
     "Late orders average 4.1 days beyond estimate.", False),
    # Anything drawn is worth keeping whatever its size.
    ('<div><svg></svg></div>', "", True),
    # A wall of prose is prose, however many divs wrap it.
    ('<div><div>a</div><div>b</div></div>', "x" * 500, False),
    ("", "anything", False),
])
def test_what_earns_a_preserved_fragment(markup, text, expected):
    """Preservation is for what no native widget can carry -- and no more.

    A fragment is frozen: it does not follow the theme, translate, or respond
    to filters. So the threshold matters in both directions, and at four
    elements it was excluding the exact thing it exists for.
    """
    from app.services.dashboard_html_import_service import _fragment_is_worth_preserving

    assert _fragment_is_worth_preserving(markup, text) is expected


# ── What a block IS decides what shape it gets ──────────────────────────────


@pytest.mark.parametrize("block,expected", [
    # The bug: one word of prose decided the role.
    ({"tag": "blockquote", "classes": [], "text":
      "Late orders average 4.1 days beyond estimate. Bringing that to 2 days "
      "would recover roughly R$ 340k of freight remediation per quarter."},
     "text"),
    # A KPI card whose wrapper has no class at all -- most generated HTML.
    ({"tag": "div", "classes": [], "text": "GROSS REVENUE R$ 13.59M"}, "kpi"),
    ({"tag": "div", "classes": [], "text": "LATE RATE 6.8%"}, "kpi"),
    # A named one still works.
    ({"tag": "div", "classes": ["kpi"], "text": "Revenue"}, "kpi"),
    # Headings and tables are unambiguous.
    ({"tag": "h2", "classes": [], "text": "Revenue trajectory"}, "title"),
    ({"tag": "table", "classes": [], "text": "a b c"}, "table"),
    # A chart card is named like one.
    ({"tag": "div", "classes": ["chart"], "heading": "Revenue over time",
      "text": "Revenue over time price summed by order_purchase_date"}, "chart"),
    # Prose stays prose.
    ({"tag": "p", "classes": [], "text":
      "Across the observed window, price summed by purchase date rose steadily."},
     "text"),
])
def test_a_block_is_classified_by_what_it_is_not_by_a_word_in_it(block, expected):
    """Role decides SHAPE, so a wrong role is a visibly wrong layout.

    A pull quote classified as a KPI was laid out in the metric strip while the
    three real KPI cards beside it, whose wrappers carried no class, were
    classified as copy and laid out full width.
    """
    from app.services.dashboard_html_import_service import _classify_block_role

    assert _classify_block_role(block) == expected


def test_the_template_does_not_change_because_a_kpi_could_not_be_bound():
    """What the SOURCE is does not depend on what AppBI managed to do with it.

    A brief is defined by carrying a KPI row above one main chart. KPI cards
    that cannot be bound to a column leave `chart_plans` and become widgets, so
    counting KPIs from the plans alone made the same document import as a brief
    when the binding worked and as a console when it did not.
    """
    from app.services.dashboard_html_import_service import choose_template_family

    document = {"blocks": [
        {"id": "k1", "role": "kpi", "text": "GROSS REVENUE R$ 13.59M"},
        {"id": "k2", "role": "kpi", "text": "FREIGHT COST R$ 2.25M"},
        {"id": "k3", "role": "kpi", "text": "LATE RATE 6.8%"},
        {"id": "t1", "role": "table", "text": "seller_id price"},
        {"id": "c1", "role": "chart", "text": "Revenue trajectory"},
    ]}
    bound = [
        {"block_id": "k1", "final_chart_type": "KPI"},
        {"block_id": "k2", "final_chart_type": "KPI"},
        {"block_id": "k3", "final_chart_type": "KPI"},
        {"block_id": "c1", "final_chart_type": "LINE"},
        {"block_id": "t1", "final_chart_type": "TABLE"},
    ]
    unbound = [
        {"block_id": "c1", "final_chart_type": "LINE"},
        {"block_id": "t1", "final_chart_type": "TABLE"},
    ]
    assert choose_template_family(document, bound) == "brief"
    assert choose_template_family(document, unbound) == "brief"


# ── A declared plan is obeyed, not re-derived ───────────────────────────────


def test_declared_widgets_replace_inference_rather_than_joining_it():
    """Both together is worse than either alone.

    When a plan declares its headings and the importer ALSO derives headings
    from the markup, the document's structure appears twice -- and the derived
    copies carry no declared layout, so a full-width section header was placed
    on top of the first KPI at (0, 0).
    """
    from app.services.dashboard_html_import_service import widgets_from_plan

    declared = widgets_from_plan([
        {"block_id": "sec-1", "widget_type": "section_header",
         "widget_config": {"title": "Throughput"}, "layout": {"x": 0, "y": 2, "w": 12, "h": 1}},
        {"block_id": "note", "widget_type": "callout",
         "widget_config": {"text": "Late deliveries cluster.", "tone": "warning"},
         "layout": {"x": 0, "y": 7, "w": 12, "h": 2}},
    ])
    assert [w["widget_type"] for w in declared] == ["section_header", "callout"]
    assert declared[0]["layout"] == {"x": 0, "y": 2, "w": 12, "h": 1}
    assert declared[0]["title"] == "Throughput"
    assert declared[1]["widget_config"]["tone"] == "warning"


def test_a_declared_widget_of_an_unknown_kind_is_dropped_not_rendered_as_a_chart():
    """The build path rewrites an unknown kind to "chart" with no chart behind
    it, which renders as "Failed to load chart"."""
    from app.services.dashboard_html_import_service import widgets_from_plan

    assert widgets_from_plan([{"block_id": "x", "widget_type": "carousel"}]) == []
    assert widgets_from_plan([{"block_id": "x", "widget_type": "chart"}]) == []


def test_a_declared_widget_without_a_layout_is_placed_by_the_recipe():
    from app.services.dashboard_html_import_service import widgets_from_plan

    widgets = widgets_from_plan([
        {"block_id": "w1", "widget_type": "section_header", "widget_config": {"title": "A"}},
    ])
    assert "layout" not in widgets[0]
    compose_import_layout(chart_plans=[], widgets=widgets, family="console")
    assert widgets[0]["layout"]["w"] == RECIPE_GRID_COLS


def test_a_canvas_widget_keeps_pixel_geometry_without_fake_grid_coordinates():
    from app.services.dashboard_html_import_service import widgets_from_plan

    widgets = widgets_from_plan([{
        "block_id": "canvas-note",
        "widget_type": "callout",
        "widget_config": {"text": "Watch this"},
        "layout": {"xPx": 124.5, "yPx": 80, "wPx": 360, "hPx": 140, "z": 7},
    }])

    assert widgets[0]["layout"] == {
        "xPx": 124.5,
        "yPx": 80,
        "wPx": 360,
        "hPx": 140,
        "z": 7,
    }


def test_a_declared_WIDGET_layout_is_never_overwritten_either():
    """Declared-ness belongs to a tile, not to charts.

    The rule was implemented for `chart_plans` only, so a plan that placed its
    section header at y=2 had it repacked to y=0 -- on top of the first KPI.
    """
    widgets = [{
        "block_id": "sec", "order": 1, "widget_type": "section_header",
        "widget_config": {"title": "Throughput"},
        "layout": {"x": 0, "y": 2, "w": 12, "h": 1},
    }]
    charts = [{
        "block_id": "kpi", "order": 2, "final_chart_type": "KPI",
        "layout": {"x": 0, "y": 0, "w": 3, "h": 2},
    }]
    compose_import_layout(chart_plans=charts, widgets=widgets, family="console")
    assert widgets[0]["layout"] == {"x": 0, "y": 2, "w": 12, "h": 1}
    assert charts[0]["layout"] == {"x": 0, "y": 0, "w": 3, "h": 2}


def test_a_fully_declared_plan_has_no_overlap():
    """The invariant that matters once the plan is obeyed verbatim."""
    tiles = [
        {"block_id": "kpi-1", "order": 1, "final_chart_type": "KPI", "layout": {"x": 0, "y": 0, "w": 3, "h": 2}},
        {"block_id": "kpi-2", "order": 2, "final_chart_type": "KPI", "layout": {"x": 3, "y": 0, "w": 3, "h": 2}},
        {"block_id": "sec", "order": 3, "widget_type": "section_header",
         "widget_config": {"title": "A"}, "layout": {"x": 0, "y": 2, "w": 12, "h": 1}},
        {"block_id": "chart", "order": 4, "final_chart_type": "BAR", "layout": {"x": 0, "y": 3, "w": 6, "h": 4}},
    ]
    charts = [t for t in tiles if "final_chart_type" in t]
    widgets = [t for t in tiles if "widget_type" in t]
    compose_import_layout(chart_plans=charts, widgets=widgets, family="console")
    placed = [(t["block_id"], t["layout"]) for t in tiles]
    for i, (id_a, a) in enumerate(placed):
        for id_b, b in placed[i + 1:]:
            assert not _overlaps(a, b), f"{id_a} overlaps {id_b}"


# ── The source contract is a lock, not a hint ───────────────────────────────


def _contract_check(contract, tables):
    from app.services.dashboard_import_skill import compare_source_contract_to_dataset

    return compare_source_contract_to_dataset(source_contract=contract, tables=tables)


_OLIST_LIKE = [
    {"display_name": "Orders", "columns": [
        {"name": "order_id", "type": "string"},
        {"name": "order_purchase_date", "type": "date"},
        {"name": "delivery_days", "type": "float"},
    ]},
    {"display_name": "Order Items", "columns": [
        {"name": "price", "type": "float"},
        {"name": "seller_id", "type": "string"},
    ]},
]


def test_the_fingerprint_ignores_order_but_not_content():
    from app.services.dashboard_import_skill import schema_fingerprint

    assert schema_fingerprint(_OLIST_LIKE) == schema_fingerprint(list(reversed(_OLIST_LIKE)))
    dropped = [dict(_OLIST_LIKE[0], columns=_OLIST_LIKE[0]["columns"][:-1]), _OLIST_LIKE[1]]
    assert schema_fingerprint(dropped) != schema_fingerprint(_OLIST_LIKE)


def test_a_matching_contract_passes_without_comment():
    from app.services.dashboard_import_skill import build_source_contract

    contract = build_source_contract(dataset_id=111, dataset_name="Olist", tables=_OLIST_LIKE)
    ok, findings = _contract_check(contract, _OLIST_LIKE)
    assert ok and findings == []


def test_matching_table_names_with_a_missing_column_is_refused():
    """The case the older check let through.

    It compared table NAMES only and merely warned, so a file written for a
    different dataset whose tables happened to share names imported cleanly --
    and every column reference in it was then re-guessed by resemblance, which
    is the whole thing the declared path exists to remove.
    """
    ok, findings = _contract_check({
        "dataset_id": 999,
        "schema_fingerprint": "sha256:someothershape",
        "expected_source_keys": ["Orders"],
        "expected_columns": {"Orders": ["order_id", "revenue_current"]},
    }, _OLIST_LIKE)
    assert not ok
    assert any("revenue_current" in f for f in findings)


def test_a_missing_table_is_refused_and_named():
    ok, findings = _contract_check({
        "schema_fingerprint": "sha256:x",
        "expected_source_keys": ["Orders", "Shipments"],
        "expected_columns": {},
    }, _OLIST_LIKE)
    assert not ok
    assert any("Shipments" in f for f in findings)


def test_a_file_with_no_contract_still_imports():
    """Files written before the contract existed must keep working."""
    ok, findings = _contract_check({}, _OLIST_LIKE)
    assert ok and findings == []


def test_a_drifted_but_still_resolvable_dataset_warns_and_proceeds():
    """A new column added to the dataset changes the fingerprint but breaks
    nothing the file uses."""
    grown = [
        dict(_OLIST_LIKE[0], columns=_OLIST_LIKE[0]["columns"] + [{"name": "is_late", "type": "boolean"}]),
        _OLIST_LIKE[1],
    ]
    ok, findings = _contract_check({
        "dataset_id": 111,
        "schema_fingerprint": "sha256:theoldshape",
        "expected_source_keys": ["Orders"],
        "expected_columns": {"Orders": ["order_id", "delivery_days"]},
    }, grown)
    assert ok
    assert findings, "a drift the author should know about must be reported"


def test_a_declared_widget_is_named_by_what_it_says():
    """"Callout" as a tile title above the sentence it carries says nothing."""
    from app.services.dashboard_html_import_service import widgets_from_plan

    [widget] = widgets_from_plan([{
        "block_id": "n1", "widget_type": "callout",
        "widget_config": {"text": "Late deliveries cluster in a few sellers.", "tone": "warning"},
    }])
    assert widget["title"] == "Late deliveries cluster in a few sellers."

    [header] = widgets_from_plan([{
        "block_id": "h1", "widget_type": "section_header",
        "widget_config": {"title": "Throughput", "subtitle": "orders moving"},
    }])
    assert header["title"] == "Throughput"

    # An explicit title still wins over the body.
    [named] = widgets_from_plan([{
        "block_id": "n2", "widget_type": "callout", "title": "Watch this",
        "widget_config": {"text": "Body copy."},
    }])
    assert named["title"] == "Watch this"


# ── Declared filters actually become filters ────────────────────────────────


_MULTI_TABLE = {
    "Orders": {"columns": [
        {"name": "order_id", "type": "string"},
        {"name": "is_late", "type": "boolean"},
    ]},
    "Order Payments": {"columns": [
        {"name": "payment_type", "type": "string"},
        {"name": "payment_value", "type": "float"},
    ]},
    "Order Reviews": {"columns": [{"name": "review_score", "type": "integer"}]},
}
_PRIMARY = {"columns": _MULTI_TABLE["Orders"]["columns"]}


def _slicers(fields, *, declared=True, document=None):
    from app.services.dashboard_html_import_service import slicers_from_source

    return [
        s["field"]
        for s in slicers_from_source(
            ai_slicer_fields=fields,
            document_summary=document or {"blocks": [], "filter_controls": []},
            source_profile=_PRIMARY,
            all_source_profiles=_MULTI_TABLE,
            declared=declared,
        )
    ]


def test_a_declared_filter_resolves_from_any_table():
    """It silently dropped every filter that was not on the primary table.

    A plan asking to filter by `payment_type` (Order Payments) or
    `review_score` (Order Reviews) built a dashboard whose filter bar read
    "No slicers added" -- with no warning, because the resolver only ever
    looked at the table the first chart happened to read from.
    """
    assert _slicers(["payment_type"]) == ["payment_type"]
    assert _slicers(["review_score"]) == ["review_score"]
    assert _slicers(["is_late"]) == ["is_late"]


def test_a_declared_plan_does_not_get_extra_filters_invented():
    """A report declaring one filter came out filtering by a different column.

    Candidate names are also harvested from filter-ish blocks, which is a fair
    guess when a document declared nothing. Applied on top of a plan that DID
    declare its filters, it adds controls the author never asked for.
    """
    document = {
        "blocks": [{"id": "b1", "role": "filter", "heading": "Order status", "text": "Order status"}],
        "filter_controls": ["Order status"],
    }
    assert _slicers(["is_late"], declared=True, document=document) == ["is_late"]
    # With nothing declared, guessing is still how a plain HTML import gets any
    # filters at all.
    assert "is_late" not in _slicers([], declared=False, document=document)


def test_an_unresolvable_declared_filter_is_dropped_not_guessed():
    assert _slicers(["revenue_bucket"]) == []


# ── A template means the same thing wherever it is applied ──────────────────


@pytest.mark.parametrize("family", IMPORT_TEMPLATE_FAMILIES)
def test_relayout_produces_the_same_shape_as_an_import(family):
    """The endpoint that re-flows an existing dashboard shares the importer's
    recipe, so switching template on a built report and importing a report with
    that template give the same arrangement.

    Before this existed, a template's composition was applied at import and
    never again: picking a different one afterwards repainted the report and
    left every tile where the previous template had put it. Five presets read
    as one layout in five palettes, which is exactly what they were reported as.
    """
    tiles = [
        {"block_id": "1", "order": 1, "widget_type": "chart", "final_chart_type": "KPI", "_source_role": "kpi"},
        {"block_id": "2", "order": 2, "widget_type": "chart", "final_chart_type": "KPI", "_source_role": "kpi"},
        {"block_id": "3", "order": 3, "widget_type": "section_header", "widget_config": {}},
        {"block_id": "4", "order": 4, "widget_type": "chart", "final_chart_type": "LINE"},
        {"block_id": "5", "order": 5, "widget_type": "chart", "final_chart_type": "TABLE"},
    ]
    from copy import deepcopy

    as_import = deepcopy(tiles)
    as_relayout = deepcopy(tiles)
    apply_layout_recipe(as_import, family)
    apply_layout_recipe(as_relayout, family)
    assert [t["layout"] for t in as_import] == [t["layout"] for t in as_relayout]


def test_the_five_templates_do_not_share_a_shape():
    """The complaint this whole thing answers: "the presets are the same layout
    in different colours". If two families place the same tiles identically,
    they are one template with two names."""
    from copy import deepcopy

    tiles = [
        {"block_id": str(i), "order": i, "widget_type": "chart",
         "final_chart_type": "KPI" if i <= 3 else ("TABLE" if i == 8 else "BAR"),
         "_source_role": "kpi" if i <= 3 else ""}
        for i in range(1, 9)
    ]
    shapes = {}
    for family in IMPORT_TEMPLATE_FAMILIES:
        items = deepcopy(tiles)
        apply_layout_recipe(items, family)
        shapes[family] = tuple(
            (t["layout"]["x"], t["layout"]["y"], t["layout"]["w"], t["layout"]["h"]) for t in items
        )
    duplicates = [
        (a, b) for a in shapes for b in shapes if a < b and shapes[a] == shapes[b]
    ]
    assert not duplicates, f"these templates lay out identically: {duplicates}"
