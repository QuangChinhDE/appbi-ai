"""Report-as-Code contracts: what reaches the sandbox, what authored code may do,
and that an edit of one region leaves every other byte alone."""
import json
from pathlib import Path

import pytest

from app.services.report_code import bindings as B
from app.services.report_code import document as D


PAGE = (
    '<aside data-rac-region="sidebar" class="side"><nav><a href="#kpis">KPI</a></nav></aside>\n'
    '<header data-rac-region="header"><h1>Báo cáo</h1><div data-rac-filter="f1"></div></header>\n'
    '<section data-rac-region="kpis"><div class="card"><div data-rac-viz="kpi" data-rac-bind="b1"></div></div>'
    '<svg viewBox="0 0 10 10"><linearGradient id="g"><stop offset="0"/></linearGradient><path d="M0 0"/></svg></section>\n'
    '<section data-rac-region="trend"><div data-rac-viz="line" data-rac-bind="b2" style="height:300px"></div></section>'
)


def test_clean_markup_is_returned_byte_for_byte():
    out, warnings = D.sanitize_html(PAGE)
    assert out == PAGE
    assert warnings == []


def test_scripts_frames_handlers_and_outside_links_are_removed():
    dirty = ('<div data-rac-region="a" onclick="steal()"><script>fetch("//x")</script>'
             '<iframe src="https://evil.example"></iframe><a href="https://evil.example/?d=1">x</a>'
             '<img src="https://evil.example/p.png"><img src="data:image/png;base64,AAA"><base href="//x"><a href="#ok">ok</a></div>')
    out, warnings = D.sanitize_html(dirty)
    for gone in ("<script", "fetch(", "<iframe", "onclick", "evil.example", "<base"):
        assert gone not in out, gone
    assert 'src="data:image/png;base64,AAA"' in out, "inline images stay"
    assert 'href="#ok"' in out, "in-page anchors stay"
    assert len(warnings) >= 4


def test_a_region_edit_changes_only_that_region():
    new = D.replace_region(PAGE, "kpis", '<section data-rac-region="kpis"><p>new</p></section>')
    before, after = PAGE.split('<section data-rac-region="kpis">')[0], PAGE.split("</section>\n", 1)[1]
    assert new.startswith(before)
    assert new.endswith(after)
    assert "<p>new</p>" in new and 'data-rac-bind="b1"' not in new


def test_a_region_edit_keeps_the_region_id_even_when_the_model_drops_it():
    new = D.replace_region(PAGE, "trend", "<section class='x'><p>t</p></section>")
    assert [r["id"] for r in D.list_regions(new)] == ["sidebar", "header", "kpis", "trend"]


def test_region_span_follows_nesting_of_the_same_tag():
    html = '<div data-rac-region="outer"><div><div>a</div></div><div>b</div></div><div data-rac-region="next">c</div>'
    assert D.region_markup(html, "outer") == '<div data-rac-region="outer"><div><div>a</div></div><div>b</div></div>'
    assert D.region_markup(html, "next") == '<div data-rac-region="next">c</div>'


def test_the_document_policy_allows_no_network_and_only_nonced_scripts():
    csp = D.csp_header("abc", "'self'")
    directives = dict(d.strip().split(" ", 1) for d in csp.split(";"))
    assert directives["connect-src"] == "'none'"
    assert directives["default-src"] == "'none'"
    assert directives["script-src"] == "'nonce-abc'"
    assert "unsafe-eval" not in csp and "unsafe-inline" not in directives["script-src"]
    assert directives["form-action"] == "'none'" and directives["base-uri"] == "'none'"


def test_runtime_runs_first_and_authored_code_cannot_close_its_script():
    doc = D.build_document(html="<p>x</p>", css="p{}</style><script>alert(1)</script>",
                           js='var s = "</script><img src=x onerror=alert(1)>";', title="T", nonce="N")
    scripts = doc.split('<script nonce="N">')
    assert len(scripts) == 3, "exactly two scripts, both nonced: runtime then the report"
    assert "AppBI Report Runtime" in scripts[1]
    assert "</script><img" not in doc
    assert "</style><script>" not in doc


def test_an_uploaded_file_splits_into_sources_and_drops_outside_scripts():
    raw = ('<!doctype html><html><head><style>.a{color:red}</style>'
           '<script src="https://cdn.jsdelivr.net/npm/chart.js"></script></head>'
           '<body><div class="a">Doanh thu 1.234</div><script>console.log(1)</script></body></html>')
    html, css, js, warnings = D.split_document(raw)
    assert html == '<div class="a">Doanh thu 1.234</div>'
    assert css == ".a{color:red}"
    assert js == "console.log(1)"
    assert any("cdn.jsdelivr.net" in w for w in warnings)


def test_oversized_code_is_refused():
    with pytest.raises(ValueError):
        D.validate("x" * (D.MAX_HTML + 1), "", "")


DECL = [
    {"key": "f1", "label": "Bang", "kind": "category", "fieldKey": "v_o.state", "field": "state", "datasetId": 9},
    {"key": "f2", "label": "Ngày", "kind": "date", "fieldKey": "v_o.day", "field": "day", "datasetId": 9},
]


def test_a_viewer_can_only_set_declared_filters_with_well_formed_values():
    with pytest.raises(ValueError):
        B.clean_state(DECL, {"f9": ["x"]})
    with pytest.raises(ValueError):
        B.clean_state(DECL, {"f1": "not-a-list"})
    with pytest.raises(ValueError):
        B.clean_state(DECL, {"f1": [{"$ne": 1}]})
    with pytest.raises(ValueError):
        B.clean_state(DECL, {"f2": ["2017-01-01", "DROP TABLE"]})
    assert B.clean_state(DECL, {"f1": ["SP", 3], "f2": ["2017-01-01", None]}) == {"f1": ["SP", "3"], "f2": ["2017-01-01", None]}


def test_engine_conditions_are_built_from_the_declaration_not_the_request():
    conds = B.conditions(DECL, {"f1": ["SP"], "f2": ["2017-01-01", "2017-12-31"]})
    assert conds == [
        {"field": "state", "fieldKey": "v_o.state", "semanticField": "v_o.state", "datasetId": 9, "operator": "in", "value": ["SP"]},
        {"field": "day", "fieldKey": "v_o.day", "semanticField": "v_o.day", "datasetId": 9, "operator": "between",
         "value": ["2017-01-01", "2017-12-31"]},
    ]
    assert B.conditions(DECL, {"f1": ["SP"]}, skip="f1") == []


class _Debug(dict):
    pass


def test_the_dto_carries_values_and_meaning_never_ids_refs_or_sql(monkeypatch):
    from app.services import chart_service

    def fake_get_chart_data(db, chart_id, **kwargs):
        assert kwargs["extra_filters"][0]["fieldKey"] == "v_o.state"
        return {
            "chart": {"id": chart_id, "owner_email": "owner@corp.example", "dataset_id": 77, "datasource_id": 5,
                      "config": {"secret": "x"}},
            "data": [{"v_o.state": "SP", "v_oi.revenue": 10.5}, {"v_o.state": "RJ", "v_oi.revenue": 4}],
            "debug": {"sql_emitted": "SELECT secret FROM t", "dropped_filters": [{"semantic_field": "v_o.day"}],
                      "result_as_of": "2026-11-03T10:00:00"},
            "time_completeness": None,
        }

    monkeypatch.setattr(chart_service.ChartService, "get_chart_data", staticmethod(fake_get_chart_data))
    binding = {"id": "b3", "chart_id": 4242, "title": "Doanh thu theo bang", "kind": "category",
               "fields": {"v_o.state": {"label": "Bang", "role": "dimension", "kind": "string"},
                          "v_oi.revenue": {"label": "Doanh thu", "role": "measure", "kind": "number", "aggregation": "sum"}}}
    dto = B.mint_dto(None, binding, DECL, {"f1": ["SP"]}, source_label="Olist", public=True)
    blob = json.dumps(dto, ensure_ascii=False)
    for leak in ("4242", "owner@corp.example", "77", "SELECT", "sql", "v_o.", "v_oi.", "datasource", "Olist", "fieldKey"):
        assert leak not in blob, leak
    assert dto["rows"] == [{"d0": "SP", "m0": 10.5}, {"d0": "RJ", "m0": 4}]
    assert [f["key"] for f in dto["fields"]] == ["d0", "m0"]
    assert dto["fields"][0]["filterKey"] == "f1", "a dimension a viewer can filter by says so (drill)"
    assert dto["notApplied"] == ["Ngày"]
    assert dto["status"] == "ready" and dto["bindingId"] == "b3"


def test_what_a_viewer_learns_about_bindings_and_filters_is_minimal():
    pb = B.public_bindings([{"id": "b1", "chart_id": 9, "title": "T", "kind": "kpi", "fields": {"v.x": {}}}])
    assert pb == [{"id": "b1", "title": "T", "kind": "kpi"}]
    assert B.public_filters(DECL) == [{"key": "f1", "label": "Bang", "kind": "category"},
                                      {"key": "f2", "label": "Ngày", "kind": "date"}]


def test_an_invented_binding_id_is_pointed_at_a_real_binding_of_the_right_kind():
    from app.services.report_code import generation as G

    bindings = [{"id": "b1", "kind": "kpi", "title": "Doanh thu"}, {"id": "b2", "kind": "time", "title": "Theo tháng"},
                {"id": "b3", "kind": "category", "title": "Theo bang"}]
    html = ('<div data-rac-viz="kpi" data-rac-bind="b1"></div><div data-rac-viz="heatmap" data-rac-bind="b7"></div>'
            '<div data-rac-bind="b9" data-rac-viz="hbar"></div><h3 data-rac-title="b9"></h3>')
    out, js, notes = G.heal_references(html, "rac.bind('b7', f)", bindings)
    assert 'data-rac-viz="heatmap" data-rac-bind="b2"' in out
    assert 'data-rac-bind="b3" data-rac-viz="hbar"' in out and 'data-rac-title="b3"' in out
    assert js == "rac.bind('b2', f)"
    assert len(notes) == 2
    untouched, _, none = G.heal_references('<div data-rac-viz="kpi" data-rac-bind="b1"></div>', "", bindings)
    assert none == [] and untouched == '<div data-rac-viz="kpi" data-rac-bind="b1"></div>'


_STATES = {"b6": {"title": "Đơn theo bang", "fields": [{"key": "d0", "role": "dimension"}, {"key": "m0", "role": "measure"}],
                  "rows": [{"d0": "SP", "m0": 41375}, {"d0": "RJ", "m0": 12852}, {"d0": "MG", "m0": 11544}]}}


def test_a_total_printed_in_the_RJ_row_is_bound_to_RJ():
    from app.services.report_code import semantics as S

    html = ('<table><tr><th>Bang</th><th>Số đơn</th></tr>'
            '<tr><td>SP</td><td><span data-rac-value="b6"></span></td></tr>'
            '<tr><td>RJ</td><td><span data-rac-value="b6"></span></td></tr></table>')
    fixed, notes = S.check_rows(html, _STATES, fix=True)
    assert '<td>SP</td><td><span data-rac-value="b6" data-rac-row="SP"></span>' in fixed
    assert '<td>RJ</td><td><span data-rac-value="b6" data-rac-row="RJ"></span>' in fixed
    assert fixed.startswith('<table><tr><th>Bang</th><th>Số đơn</th></tr>'), "the header row is untouched"
    assert len(notes) == 2


def test_a_row_reference_that_contradicts_its_label_is_corrected():
    from app.services.report_code import semantics as S

    html = '<ul><li>RJ <b><span data-rac-value="b6" data-rac-row="SP"></span></b></li></ul>'
    fixed, notes = S.check_rows(html, _STATES, fix=True)
    assert 'data-rac-row="RJ"' in fixed and 'data-rac-row="SP"' not in fixed
    detected, _ = S.check_rows(html, _STATES, fix=False)
    assert detected == html, "detection-only never edits"


def test_correct_or_unlabelled_rows_are_left_alone():
    from app.services.report_code import semantics as S

    ok = ('<tr><td>MG</td><td><span data-rac-value="b6" data-rac-row="MG"></span></td></tr>'
          '<div class="kpi"><span data-rac-value="b6"></span></div>'
          '<tr><td>Tổng</td><td><span data-rac-value="b6"></span></td></tr>')
    fixed, notes = S.check_rows(ok, _STATES, fix=True)
    assert fixed == ok and notes == []


def test_document_ticket_grants_one_revision_and_expires():
    from app.services.report_code import lifecycle as L

    t = L.make_ticket(4, 17, now=1000.0)
    assert L.read_ticket(t, now=1001.0) == (4, 17)
    assert L.read_ticket(t, now=1000.0 + L.TICKET_TTL_S + 1) is None, "expired"
    body, sig = t.split(".")
    assert L.read_ticket(body + "." + sig[:-2] + ("A" if sig[-2] != "A" else "B") + sig[-1], now=1001.0) is None, "tampered signature"
    import base64, json
    forged = base64.urlsafe_b64encode(json.dumps({"a": 5, "r": 17, "e": 9e12}).encode()).decode().rstrip("=")
    assert L.read_ticket(forged + "." + sig, now=1001.0) is None, "a body signed for another report"


def test_report_origin_is_never_the_app_origin(monkeypatch):
    from app.core.config import settings
    from app.services.report_code import lifecycle as L

    monkeypatch.setattr(settings, "CORS_ORIGINS", "http://localhost:3000")
    monkeypatch.setattr(settings, "REPORT_ARTIFACT_ORIGIN", "")
    assert L.report_origin() == "http://127.0.0.1:3000", "localhost apps get a loopback report origin"
    monkeypatch.setattr(settings, "REPORT_ARTIFACT_ORIGIN", "http://localhost:3000")
    assert L.report_origin() is None, "configuring the app origin is refused (sandbox escape)"
    monkeypatch.setattr(settings, "CORS_ORIGINS", "https://bi.example.com")
    monkeypatch.setattr(settings, "REPORT_ARTIFACT_ORIGIN", "")
    assert L.report_origin() is None, "no configured origin in production → opaque, author JS off"
    monkeypatch.setattr(settings, "REPORT_ARTIFACT_ORIGIN", "https://reports.example.com/")
    assert L.document_url("/x") == ("https://reports.example.com/api/v1/x", True)


def test_author_script_is_handed_to_the_runtime_gate():
    doc = D.build_document(html="<p>x</p>", css="", js="window.x = 1;", title="T", nonce="N")
    assert 'rac.__author(function(){\nwindow.x = 1;\n});' in doc
    assert 'x-dns-prefetch-control' in doc


_MODEL = {"views": [
    {"name": "dataset_table_2", "dataset_table_id": 2, "table_display_name": "Items", "measures": [
        {"name": "revenue", "type": "sum", "label": "Doanh thu", "sql": "${TABLE}.price"},
        {"name": "orders", "type": "count_distinct", "label": "Số đơn"}],
     "dimensions": [{"name": "order_id", "type": "string"}, {"name": "category", "type": "string", "label": "Danh mục"}]},
    {"name": "dataset_table_1", "dataset_table_id": 1, "table_display_name": "Orders", "measures": [], "dimensions": [
        {"name": "purchase_date", "type": "date", "label": "Ngày mua"}, {"name": "state", "type": "string", "label": "Bang"}]},
]}

PASTED = ('<header class="hero"><h1>Báo cáo 2024</h1></header>'
          '<div class="stats"><div class="stat">Doanh thu<b>12.345.678</b></div><div class="stat">Số đơn<b>4.321</b></div></div>'
          '<h3>Doanh thu theo tháng</h3><canvas id="rev" height="220"></canvas>'
          '<label>Bang</label><select id="st"><option>SP</option><option>RJ</option></select>')


def test_pasted_html_yields_value_chart_and_filter_slots_but_not_years():
    from app.services.report_code import importer as I

    slots = I.detect_slots(PASTED)
    kinds = [(s["kind"], s.get("sample") or s.get("context")) for s in slots]
    assert ("value", "12.345.678") in kinds and ("value", "4.321") in kinds
    assert any(k == "chart" for k, _ in kinds) and any(k == "filter" for k, _ in kinds)
    assert not any(s.get("sample") == "2024" for s in slots), "a year in a heading is not a figure"
    chart = next(s for s in slots if s["kind"] == "chart")
    assert chart["context"] == "Doanh thu theo tháng" and chart["height"] == 220
    by_sample = {s["sample"]: s["context"] for s in slots if s["kind"] == "value"}
    assert by_sample == {"12.345.678": "Doanh thu", "4.321": "Số đơn"}, \
        "each figure carries ITS OWN tile label, not the previous figure's (off-by-one regression)"


def test_a_model_pick_that_contradicts_the_slot_label_loses_to_the_matching_metric(monkeypatch):
    from app.services import llm_client
    from app.services.report_code import bindings as B
    from app.services.report_code import importer as I

    cands = B.candidates(_MODEL)
    for c in cands:
        c["title"] = B._localize_title(c["title"])
    rev_month = next(c for c in cands if c["kind"] == "time" and c["measure"] == "Doanh thu")
    orders_month = next(c for c in cands if c["kind"] == "time" and c["measure"] == "Số đơn")
    slot = {"id": "s1", "kind": "chart", "context": "Doanh thu theo tháng", "sample": ""}
    monkeypatch.setattr(llm_client.LLMClient, "complete_json",
                        staticmethod(lambda **kw: {"map": [{"slot": "s1", "id": orders_month["id"]}]}))
    out = I.propose([slot], cands, [])
    assert out["s1"]["candidate"] == rev_month["id"], "the chart says Doanh thu: an orders series is the wrong metric"
    assert out["s1"]["source"] == "rules"


def test_applying_a_mapping_changes_only_the_data_spans(monkeypatch):
    from app.services.report_code import bindings as B
    from app.services.report_code import importer as I

    monkeypatch.setattr(B, "load_model", lambda db, ds: _MODEL)

    def fake_bind(db, picks, *, existing, **kw):
        out, m = [], {}
        for n, (c, _t) in enumerate(picks, start=len(existing) + 1):
            out.append({"id": f"b{n}", "chart_id": 900 + n, "title": c["title"], "kind": c["kind"], "fields": {}})
            m[c["id"]] = f"b{n}"
        return out, m, []

    monkeypatch.setattr(B, "bind_candidates", fake_bind)
    cands = B.candidates(_MODEL)
    kpi_rev = next(c for c in cands if c["kind"] == "kpi" and c["measure"] == "Doanh thu")
    time_rev = next(c for c in cands if c["kind"] == "time" and c["measure"] == "Doanh thu")
    dims = B.filter_dimensions(_MODEL, 9)
    state = next(d for d in dims if d["label"] == "Bang")
    slots = {(s["context"] if s["kind"] in ("filter", "chart") else s["sample"]): s["id"] for s in I.detect_slots(PASTED)}
    js = "new Chart(document.getElementById('rev'), {type: 'line', data: {}});"
    out = I.apply(None, dataset_id=9, html=PASTED, css=".hero{color:red}", js=js, filters=[],
                  mapping=[{"slot": slots["12.345.678"], "candidate": kpi_rev["id"]},
                           {"slot": slots["Doanh thu theo tháng"], "candidate": time_rev["id"]},
                           {"slot": slots["Bang"], "dimension": state["id"]}],
                  owner_id=None, report_name="R", existing=[], existing_filters=[], progress=lambda s: None)
    html = out["html"]
    assert '<div class="stat">Doanh thu<b data-rac-value="b1" data-rac-opts="{&quot;decimals&quot;: 0, &quot;compact&quot;: false}"></b></div>' in html, \
        "a figure that is its element's whole text is bound ON that element (author CSS keeps styling it), " \
        "with the design's number format (12.345.678: no decimals, not abbreviated)"
    # an unmapped figure keeps its text and design, and is MARKED as a sample: it must never
    # reach a published report looking like governed data (publish refuses while it remains)
    assert '<div class="stat">Số đơn<b><span data-rac-sample>4.321</span></b></div>' in html
    assert '4.321' in html
    assert '<div id="rev" data-rac-viz="line" data-rac-bind="b2" style="height:220px;width:100%"' in html
    assert '<div id="st" data-rac-filter="f1"' in html and "<select" not in html, "the replaced select keeps its id for the author's JS"
    assert '<h1>Báo cáo 2024</h1>' in html and 'class="hero"' in html
    assert out["css"] == ".hero{color:red}", "the author's CSS is untouched"
    assert out["js"].endswith(js) and "var Chart" in out["js"], "chart library stubbed, author JS kept"
    assert [f["label"] for f in out["filters"]] == ["Bang"]
    assert html.count("data-rac-region") >= 3


def test_context_pack_carries_meanings_not_data_or_internals(monkeypatch):
    from app.services.report_code import bindings as B
    from app.services.report_code import importer as I

    monkeypatch.setattr(B, "load_model", lambda db, ds: _MODEL)
    pack = I.context_pack(None, dataset_id=9, dataset_name="Bán hàng")
    assert "@c1" in pack and "@f1" in pack and "Doanh thu" in pack
    for leak in ("dataset_table_", "${TABLE}", "price", "SELECT", "order_id", "purchase_date", "datasetId"):
        assert leak not in pack, leak


def test_filter_dimensions_come_from_the_model_and_skip_identifiers_and_numbers():
    model = {"views": [{"name": "v", "dataset_table_id": 1, "dimensions": [
        {"name": "order_id", "type": "string"}, {"name": "price", "type": "number"},
        {"name": "customer_state", "type": "string", "label": "Bang"}, {"name": "order_date", "type": "date"}]}]}
    dims = B.filter_dimensions(model, 9)
    assert [(d["fieldKey"], d["kind"]) for d in dims] == [("v.customer_state", "category"), ("v.order_date", "date")]
    assert B.declare_filters(dims, ["f2", "f1", "f2", "nope"]) == [
        {"key": "f1", "label": dims[1]["label"], "kind": "date", "fieldKey": "v.order_date", "field": "order_date", "datasetId": 9},
        {"key": "f2", "label": "Bang", "kind": "category", "fieldKey": "v.customer_state", "field": "customer_state", "datasetId": 9},
    ]


def test_the_blank_starter_page_passes_validation_and_has_regions_but_no_numbers():
    from app.services.report_code import generation as G

    html, css, js = G.starter_page("Báo cáo <x>")
    v = D.validate(html, css, js)
    assert v.html == html, "the starter must survive validation unchanged"
    for region in ("header", "kpis", "charts"):
        assert f'data-rac-region="{region}"' in html
    assert "<x>" not in html, "the name is escaped"


def test_ai_edit_without_permission_never_offers_or_binds_new_data(monkeypatch):
    from types import SimpleNamespace
    from app.services.report_code import generation as G

    cands = [{"id": "c1", "kind": "kpi", "title": "Doanh thu", "measure": "Doanh thu"}]
    monkeypatch.setattr(G.B, "load_model", lambda db, ds: {})
    monkeypatch.setattr(G.B, "field_meta", lambda m: {})
    monkeypatch.setattr(G.B, "candidates", lambda m: cands)
    monkeypatch.setattr(G.B, "filter_dimensions", lambda m, ds: [])
    monkeypatch.setattr(G, "_probe", lambda db, b, d: {})
    seen = {}

    def fake(prompt, images, max_tokens, timeout):
        seen["prompt"] = prompt
        return {"html": '<section data-rac-region="kpis"><div data-rac-viz="kpi" data-rac-bind="@c1"></div></section>',
                "css": "", "js": "", "summary": "x", "add_data": [{"id": "c1", "title": "Doanh thu"}]}

    monkeypatch.setattr(G, "_design_call", fake)
    monkeypatch.setattr(G, "_bind_candidates", lambda *a, **k: pytest.fail("data was bound without permission"), raising=False)
    art = SimpleNamespace(id=1, dataset_id=7, name="r")
    rev = SimpleNamespace(bindings=[], filters=[], html=PAGE, css="", js="")
    out = G.edit(None, artifact=art, revision=rev, instruction="thêm doanh thu", region=None, owner_id=1,
                 progress=lambda s: None, allow_data=False)
    assert "CANDIDATES" not in seen["prompt"]
    assert not out.get("bindings"), "no binding may be added when the author did not allow new data"


def test_only_an_editors_ticket_may_render_unsaved_code():
    from app.services.report_code import lifecycle as L

    viewer = L.make_ticket(4, 17, now=1000.0)
    editor = L.make_ticket(4, 17, now=1000.0, edit=True)
    assert L.read_ticket(viewer, now=1001.0) == (4, 17)
    assert L.read_ticket(viewer, now=1001.0, need_edit=True) is None, "a viewer cannot live-preview arbitrary code"
    assert L.read_ticket(editor, now=1001.0, need_edit=True) == (4, 17)


def test_saving_the_blank_starter_raises_no_unknown_binding_warnings():
    from types import SimpleNamespace
    from app.services.report_code import generation as G
    from app.services.report_code import lifecycle as L

    html, css, js = G.starter_page("r")

    class _Q:
        def filter(self, *a): return self
        def scalar(self): return 0

    db = SimpleNamespace(query=lambda *a: _Q(), add=lambda o: None, flush=lambda: None, commit=lambda: None, refresh=lambda o: None)
    art = SimpleNamespace(id=1, draft_revision_id=None)
    _, warnings = L.add_revision(db, art, user_id=1, html=html, css=css, js=js, bindings=[], filters=[], source="manual")
    assert not [w for w in warnings if "b1" in w or "b2" in w], warnings


# ── Public links: the dashboard model on reports ────────────────────────────────
_DECL = [
    {"key": "f1", "label": "Bang", "kind": "category", "fieldKey": "state", "field": "state", "datasetId": 1},
    {"key": "f2", "label": "Ngày", "kind": "date", "fieldKey": "day", "field": "day", "datasetId": 1},
    {"key": "f3", "label": "Kênh", "kind": "category", "fieldKey": "channel", "field": "channel", "datasetId": 1},
]


class _Link:
    def __init__(self, id=7, token="rpt_abc", av=0):
        self.id, self.token, self.auth_version = id, token, av


def test_a_password_session_never_crosses_between_dashboards_and_reports():
    from app.api.public import _create_public_session, _verify_public_session
    from app.services import public_link_session as S

    link = _Link()
    dash_session = _create_public_session(link)
    report_session = S.create_session(link, "report")
    assert _verify_public_session(dash_session, link), "a dashboard session keeps working exactly as before"
    assert S.verify_session(report_session, link, "report")
    assert not S.verify_session(dash_session, link, "report"), "a dashboard session must not open a report link"
    assert not _verify_public_session(report_session, link), "a report session must not open a dashboard link"


def test_a_report_session_dies_when_the_links_security_generation_moves():
    from app.services import public_link_session as S

    link = _Link(av=3)
    session = S.create_session(link, "report")
    assert S.verify_session(session, link, "report")
    link.auth_version = 4  # password changed / link re-enabled / expiry changed
    assert not S.verify_session(session, link, "report")
    assert not S.verify_session(session, _Link(id=8, av=3), "report"), "bound to one link"
    assert not S.verify_session(session, _Link(token="rpt_other", av=3), "report")


def test_a_locked_filter_is_applied_whatever_the_viewer_sends():
    from app.services.report_code import public_links as PL

    config = [{"field": "f1", "value": ["SP"]}, {"field": "f3", "hidden": True}]
    viewer, locked, banner = PL.scope(_DECL, config)
    assert [f["key"] for f in viewer] == ["f2"], "a locked or hidden filter is not offered to the viewer"
    assert locked == {"f1": ["SP"]}
    assert [b["key"] for b in banner] == ["f1"]
    assert PL.effective_state(_DECL, config, {}) == {"f1": ["SP"]}, "the lock applies with no viewer state"
    with pytest.raises(ValueError):
        PL.effective_state(_DECL, config, {"f1": ["RJ"]})  # override attempt
    with pytest.raises(ValueError):
        PL.effective_state(_DECL, config, {"f3": ["web"]})  # hidden filter
    out = PL.effective_state(_DECL, config, {"f2": ["2024-01-01", "2024-12-31"]})
    assert out == {"f1": ["SP"], "f2": ["2024-01-01", "2024-12-31"]}


def test_a_hidden_lock_restricts_without_being_disclosed():
    from app.services.report_code import public_links as PL

    viewer, locked, banner = PL.scope(_DECL, [{"field": "f1", "value": ["SP"], "hidden": True}])
    assert locked == {"f1": ["SP"]} and banner == [] and "f1" not in {f["key"] for f in viewer}


def test_a_link_naming_a_filter_the_report_no_longer_declares_refuses_to_serve():
    from app.services.report_code import public_links as PL

    with pytest.raises(PL.LinkRefused):
        PL.scope(_DECL, [{"field": "f9", "value": ["x"]}])
    with pytest.raises(ValueError):
        PL.normalize_config(_DECL, [{"field": "f9", "value": ["x"]}])
    assert PL.normalize_config(_DECL, [{"field": "f1", "value": []}]) == [], "an empty visible entry restricts nothing"


def test_a_link_preview_token_is_signed_short_lived_and_carries_no_password(monkeypatch):
    from types import SimpleNamespace
    from app.services.report_code import public_links as PL

    monkeypatch.setattr(PL, "_decl_for", lambda db, art: _DECL)
    art = SimpleNamespace(id=5, published_revision_id=9)
    token, _ = PL.make_preview(None, art, [{"field": "f1", "value": ["SP"]}], {"theme": "x"}, now=1000.0)
    data = PL.read_preview(token, now=1001.0)
    assert data["a"] == 5 and data["f"][0]["value"] == ["SP"]
    assert PL.read_preview(token, now=1000.0 + PL.PREVIEW_TTL_S + 1) is None, "expired"
    assert PL.read_preview(token[:-2] + ("AA" if token[-2:] != "AA" else "BB"), now=1001.0) is None, "tampered"
    with pytest.raises(ValueError):
        PL.make_preview(None, SimpleNamespace(id=5, published_revision_id=None), [], {})  # never a draft


# ── P0: the reusable password session never sits in the report frame's URL ─────────

def test_the_document_grant_opens_one_revision_of_one_link_at_one_security_generation():
    from types import SimpleNamespace
    from app.services.report_code import public_links as PL

    link = SimpleNamespace(id=7, auth_version=2)
    g = PL.make_doc_grant(link, 41, now=1000.0)
    assert PL.doc_grant_ok(g, link, 41, now=1001.0)
    assert not PL.doc_grant_ok(g, link, 42, now=1001.0), "another revision"
    assert not PL.doc_grant_ok(g, SimpleNamespace(id=8, auth_version=2), 41, now=1001.0), "another link"
    assert not PL.doc_grant_ok(g, SimpleNamespace(id=7, auth_version=3), 41, now=1001.0), "password changed since"
    assert not PL.doc_grant_ok(g, link, 41, now=1000.0 + PL.DOC_GRANT_TTL_S + 1), "expired"
    assert not PL.doc_grant_ok(g[:-2] + ("AA" if g[-2:] != "AA" else "BB"), link, 41, now=1001.0), "tampered"


def test_a_document_grant_is_not_a_password_session():
    from types import SimpleNamespace
    from app.services import public_link_session as S
    from app.services.report_code import public_links as PL

    link = SimpleNamespace(id=7, token="rpt_x", auth_version=0)
    assert not S.verify_session(PL.make_doc_grant(link, 1), link, "report")


# ── AI scoped edit: a region edit cannot restyle another region ─────────────────────

def test_region_css_is_scoped_by_the_server_whatever_the_model_writes():
    from app.services.report_code.generation import scope_css

    out = scope_css(":root{--a:1} .card,h3{color:red} body{margin:0} "
                    "@media (max-width:600px){.card{padding:0}} @keyframes k{from{opacity:0}to{opacity:1}}", "kpis")
    rules = [r for r in out.splitlines() if "{" in r and not r.startswith(("@media", "@keyframes"))]
    assert rules and all(r.startswith('[data-rac-region="kpis"]') for r in rules), out
    assert '[data-rac-region="kpis"] .card, [data-rac-region="kpis"] h3 {color:red}' in out
    assert "body" not in out and ":root" not in out, "page-level selectors become the region itself"
    assert '@media (max-width:600px) {\n[data-rac-region="kpis"] .card {padding:0}\n}' in out
    assert "@keyframes k {from{opacity:0}to{opacity:1}}" in out


# ── Public Modal settings take effect on the public side ────────────────────────────

def test_viewer_filters_switched_off_leaves_the_viewer_no_filter_but_keeps_every_lock():
    from app.services.report_code import public_links as PL

    off = {"allow_viewer_filters": False}
    viewer, locked, banner = PL.scope(_DECL, [{"field": "f1", "value": ["SP"]}], off)
    assert viewer == [] and locked == {"f1": ["SP"]} and banner
    with pytest.raises(ValueError):
        PL.effective_state(_DECL, [], {"f2": ["2024-01-01", "2024-12-31"]}, off)
    assert PL.effective_state(_DECL, [{"field": "f1", "value": ["SP"]}], {}, off) == {"f1": ["SP"]}


def test_hiding_the_locked_filter_banner_hides_the_banner_not_the_lock():
    from app.services.report_code import public_links as PL

    viewer, locked, banner = PL.scope(_DECL, [{"field": "f1", "value": ["SP"]}], {"show_filter_banner": False})
    assert banner == [] and locked == {"f1": ["SP"]}


# ── The viewer's AI Bot on a report link ────────────────────────────────────────────

def test_the_report_bot_reads_the_locks_and_never_names_a_hidden_one():
    from types import SimpleNamespace
    from app.services.report_code import public_bot as PB

    rev = SimpleNamespace(filters=_DECL, bindings=[])
    link = SimpleNamespace(filters_config=[{"field": "f1", "value": ["SP"]},
                                           {"field": "f3", "value": ["web"], "hidden": True}],
                           appearance_config={})
    ctx = PB.build_context(SimpleNamespace(), rev, link, {"f2": ["2024-01-01", "2024-12-31"]})
    by_field = {f["fieldKey"]: f for f in ctx.public_filters}
    assert by_field["state"]["value"] == ["SP"] and not by_field["state"].get("hidden")
    from app.services.filter_layered_merge import DISCLOSE_KEY

    assert by_field["channel"][DISCLOSE_KEY] is False, "a hidden lock is applied but never disclosed"
    assert by_field["day"]["operator"] == "between", "the viewer's own choice is applied too"
    allowed, bare = ctx.exposed_fields
    assert "state" not in allowed and "channel" not in allowed, "a model filter cannot loosen a lock"
    assert "day" in allowed
    disclosed, withheld = ctx.disclosed_filters()
    assert withheld >= 1 and all(f.get("fieldKey") != "channel" for f in disclosed)


def test_the_report_bot_refuses_a_viewer_override_of_a_lock():
    from types import SimpleNamespace
    from app.services.report_code import public_bot as PB

    rev = SimpleNamespace(filters=_DECL, bindings=[])
    link = SimpleNamespace(filters_config=[{"field": "f1", "value": ["SP"]}], appearance_config={})
    with pytest.raises(ValueError):
        PB.build_context(SimpleNamespace(), rev, link, {"f1": ["RJ"]})


def test_report_links_never_share_a_dashboard_links_ai_budget():
    from app.services.report_code import public_bot as PB

    assert PB.ledger_link_id(3) == -3 and PB.ledger_link_id(3) != 3


def test_a_data_script_block_is_never_imported_as_javascript():
    raw = ('<html><body><h1>R</h1>'
           '<script type="application/appbi-dashboard">{"version": "appbi-import/v1"}</script>'
           '<script type="application/json">{"a": 1}</script>'
           '<script>window.ok = 1;</script>'
           '<script type="module">window.m = 1;</script></body></html>')
    html, css, js, warnings = D.split_document(raw)
    assert "appbi-import" not in js and '"a": 1' not in js, "an inert data block is not code"
    assert "window.ok = 1;" in js and "window.m = 1;" in js
    assert any("application/appbi-dashboard" in w for w in warnings)


def test_a_money_figure_is_never_mapped_to_a_count(monkeypatch):
    """The pasted 'R$ 16.0M Payments received' was bound to Unique Customers and printed
    'R$ 96 N': a real number under the wrong meaning. Neither the rules nor the model may do that."""
    from app.services import llm_client
    from app.services.report_code import importer as I

    cands = [{"id": "c1", "kind": "kpi", "title": "Unique Customers", "measure": "Unique Customers",
              "measure_type": "count_distinct", "rank": 1},
             {"id": "c2", "kind": "kpi", "title": "Order Count", "measure": "Order Count", "measure_type": "count", "rank": 2}]
    slot = {"id": "s1", "kind": "value", "context": "Payments received", "sample": "R$ 16.0M"}
    monkeypatch.setattr(llm_client.LLMClient, "complete_json",
                        staticmethod(lambda **kw: {"map": [{"slot": "s1", "id": "c1"}]}))
    out = I.propose([slot], cands, [])
    assert (out.get("s1") or {}).get("candidate") is None, out


def test_rules_leave_a_slot_unmapped_when_nothing_shares_its_meaning(monkeypatch):
    from app.services import llm_client
    from app.services.report_code import importer as I

    monkeypatch.setattr(llm_client.LLMClient, "complete_json", staticmethod(lambda **kw: {"map": []}))
    cands = [{"id": "c1", "kind": "kpi", "title": "Delivery days", "measure": "Delivery days", "measure_type": "average"}]
    out = I.propose([{"id": "s1", "kind": "value", "context": "Refund rate", "sample": "4.2%"}], cands, [])
    assert "s1" not in out or out["s1"].get("candidate") is None, out


def test_the_ai_analysis_is_told_the_link_is_restricted_without_being_told_how():
    """A hidden lock (state = AC) served AC's revenue; asked for SP, the analysis said
    "Doanh thu của bang SP là 15.982,95" - another state's number under SP's name."""
    from types import SimpleNamespace
    from app.services.answer_core import guided_analysis as GA
    from app.services.report_code import public_bot as PB

    rev = SimpleNamespace(filters=_DECL, bindings=[])
    link = SimpleNamespace(filters_config=[{"field": "f1", "value": ["AC"], "hidden": True}], appearance_config={})
    note = GA._scope_note(SimpleNamespace(ctx=PB.build_context(SimpleNamespace(), rev, link, {})))
    assert note["restricted_by_author"] is True
    assert "state" not in note["viewer_filterable"], "the locked field is not a viewer filter"
    assert "AC" not in json.dumps(note), "the hidden value is never named"
    assert "KHÔNG BAO GIỜ gán con số" in GA.SYSTEM



# ── Dynamic binding: repeated structures, the period, sample numbers ─────────────────

_LIST_HTML = """<section><h3>Doanh thu theo đơn vị</h3><table class="t"><tbody>
<tr class="r"><td>Khối HO</td><td><div class="bar"><i style="width:80%;background:red"></i></div></td><td>24,54 tỷ</td><td>▼ 29,7%</td></tr>
<tr class="r"><td>Cát Bà</td><td><div class="bar"><i style="width:55%;background:red"></i></div></td><td>16,85 tỷ</td><td>▼ 14,2%</td></tr>
<tr class="r"><td>Đại Lải</td><td><div class="bar"><i style="width:60%;background:red"></i></div></td><td>20,45 tỷ</td><td>▲ 4,3%</td></tr>
</tbody></table><p class="head">Toàn tập đoàn · Tháng 08/2026</p><p>Tổng 1.234 tỷ</p></section>"""


def test_rows_of_one_result_are_one_list_slot_and_the_table_keeps_its_design():
    from app.services.report_code import importer as I

    slots = I.detect_slots(_LIST_HTML)
    lists = [s for s in slots if s["kind"] == "list"]
    assert len(lists) == 1, [(s["kind"], s["sample"]) for s in slots]
    ls = lists[0]
    assert ls["rows"] == 3 and ls["tag"] == "tr"
    assert [c["sample"] for c in ls["columns"]] == ["Khối HO", "24,54 tỷ", "▼ 29,7%"]
    assert not any(s["kind"] == "table" for s in slots), "a table that holds a list is never swapped for a widget"
    periods = [s for s in slots if s["kind"] == "period"]
    assert [p["sample"] for p in periods] == ["Tháng 08/2026"], "the headline period is its own slot"
    assert not any(s["kind"] == "value" and s["sample"] in ("08/2026", "2026") for s in slots)


def test_a_mapped_list_becomes_ONE_repeat_template_cells_and_bar_from_the_first_row():
    from app.services.report_code import document as Dm
    from app.services.report_code import importer as I

    ls = next(s for s in I.detect_slots(_LIST_HTML) if s["kind"] == "list")
    plan = {"fields": {"0": "d0", "1": "m0", "2": "m1"}}
    out = I._list_template(_LIST_HTML, Dm._scan(_LIST_HTML), ls, plan, "b7")
    assert out.count("<tr") == 1, "the other rows go: rows come from the BI Core"
    assert 'data-rac-repeat="b7"' in out and 'class="r"' in out, "the template keeps the authored row"
    assert out.count('data-rac-cell="d0"') == 1 and 'data-rac-cell="m0"' in out and 'data-rac-cell="m1"' in out
    assert "Khối HO" not in out and "24,54" not in out, "no sample text left in a bound cell"
    assert 'data-rac-bar="m0"' in out and "width:80%" not in out and "background:red" in out, \
        "an empty width-% bar becomes a data bar, its other styling kept"


def test_unmapped_numbers_are_marked_as_samples_and_publish_refuses_them():
    from app.services.report_code import lifecycle as L

    html = '<p>Doanh thu <span data-rac-sample>79,65 tỷ</span></p><tr data-rac-sample class="r">'
    assert L.sample_marks(html) == 2
    assert L.sample_marks('<p data-rac-value="b1"></p><p>data-rac-sample as text</p>') == 0


def test_a_month_period_filter_is_one_whole_month_and_offered_as_months():
    decl = [{"key": "f1", "label": "Kỳ", "kind": "date", "grain": "month", "default": "latest",
             "fieldKey": "v.thang", "field": "thang", "datasetId": 1}]
    assert B.clean_state(decl, {"f1": ["2026-02-10", None]}) == {"f1": ["2026-02-01", "2026-02-28"]}
    assert B.clean_state(decl, {"f1": ["2024-02-01", "2024-02-01"]}) == {"f1": ["2024-02-01", "2024-02-29"]}
    with pytest.raises(ValueError):
        B.clean_state(decl, {"f1": [None, "2026-02-01"]})
    conds = B.conditions(decl, {"f1": ["2026-08-01", "2026-08-31"]})
    assert conds[0]["operator"] == "between" and conds[0]["value"] == ["2026-08-01", "2026-08-31"]
    pub = B.public_filters(decl)[0]
    assert pub == {"key": "f1", "label": "Kỳ", "kind": "date", "grain": "month", "default": "latest"}, \
        "the runtime learns grain/default, never the field"


def test_the_default_period_is_resolved_once_from_the_bi_core_months(monkeypatch):
    decl = [{"key": "f1", "label": "Kỳ", "kind": "date", "grain": "month", "default": "latest",
             "fieldKey": "v.thang", "field": "thang", "datasetId": 1},
            {"key": "f2", "label": "Đơn vị", "kind": "category", "fieldKey": "v.dv", "field": "dv", "datasetId": 1}]
    seen = []

    def fake_distinct(db, ds, field, **kw):
        seen.append((field, kw.get("filters")))
        return {"values": ["2026-04-01", "2026-09-01T00:00:00", "2026-06-01", None]}

    import app.services.dataset_model_service as DMS
    monkeypatch.setattr(DMS, "get_distinct_field_values", fake_distinct)
    assert B.resolve_state(None, decl, {}) == {"f1": ["2026-09-01", "2026-09-30"]}, "the newest month the data holds"
    assert B.resolve_state(None, decl, {"f1": ["2026-04-01", "2026-04-30"]})["f1"] == ["2026-04-01", "2026-04-30"], \
        "a viewer's or a lock's period always wins over the default"
    assert B.resolve_state(None, decl, {"f2": ["HO"]}) == {"f2": ["HO"], "f1": ["2026-09-01", "2026-09-30"]}
    assert seen[-1][1] and seen[-1][1][0]["fieldKey"] == "v.dv", "the latest month is the latest IN the other filters"


@pytest.mark.parametrize("sample,after,expected", [
    ("79,65", " tỷ", {"decimals": 2, "scale": 1e9}),             # unit in the next element: scale only
    ("24,54 tỷ", "", {"decimals": 2, "scale": 1e9, "suffix": " tỷ"}),  # unit inside the figure: kept
    ("72,7%", "", {"decimals": 1, "kind": "percent"}),
    ("1,58", " tr", {"decimals": 2, "scale": 1e6}),
    ("90,5", "", {"decimals": 1, "compact": False}),
])
def test_a_bound_number_keeps_the_designs_unit_and_decimals(sample, after, expected):
    from app.services.report_code.importer import num_opts

    assert num_opts(sample, after) == expected


def test_the_model_never_maps_a_figure_to_a_measure_its_label_does_not_name(monkeypatch):
    """Benchmark #33: 'Tỷ lệ nghỉ việc 3,2%' and 'Chất lượng dịch vụ 101,7%' were proposed as
    '% đạt KH Doanh thu' - the dataset has no such data, and a published guess looks governed."""
    from app.services import llm_client
    from app.services.report_code import importer as I

    cands = [{"id": "c1", "kind": "kpi", "title": "% đạt KH Doanh thu", "measure": "% đạt KH Doanh thu", "rank": 1},
             {"id": "c2", "kind": "kpi", "title": "Doanh thu", "measure": "Doanh thu", "rank": 1}]
    slots = [{"id": "s1", "kind": "value", "context": "Tỷ lệ nghỉ việc", "sample": "3,2%"},
             {"id": "s2", "kind": "value", "context": "Chất lượng dịch vụ (audit)", "sample": "101,7%"},
             {"id": "s3", "kind": "value", "context": "Doanh thu ▼", "sample": "72,7%"}]
    monkeypatch.setattr(llm_client.LLMClient, "complete_json", staticmethod(
        lambda **kw: {"map": [{"slot": "s1", "id": "c1"}, {"slot": "s2", "id": "c1"}, {"slot": "s3", "id": "c1"}]}))
    out = I.propose(slots, cands, [])
    assert (out.get("s1") or {}).get("candidate") is None, out
    assert (out.get("s2") or {}).get("candidate") is None, out
    assert out["s3"]["candidate"] == "c1", "a pick that shares the label's meaning still stands"


def test_a_binding_keeps_its_metric_order_although_jsonb_reorders_the_fields(monkeypatch):
    """Benchmark matrix: % of plan showed in the KPI-score column. `fields` is JSONB and
    Postgres orders object keys shorter-first, so `tb_diem_kpi` came before `dat_doanh_thu`."""
    from app.services.chart_service import ChartService

    monkeypatch.setattr(ChartService, "get_chart_data", staticmethod(lambda *a, **k: {"data": [
        {"v.don_vi": "Cát Bà", "v.dat_doanh_thu": 0.936, "v.tb_diem_kpi": 88.2}]}))
    jsonb_order = {"v.don_vi": {"label": "Đơn vị", "role": "dimension", "kind": "string"},
                   "v.tb_diem_kpi": {"label": "Điểm KPI", "role": "measure", "kind": "number"},
                   "v.dat_doanh_thu": {"label": "% đạt", "role": "measure", "kind": "number"}}
    b = {"id": "b1", "chart_id": 1, "title": "t", "kind": "category", "fields": jsonb_order,
         "order": ["v.don_vi", "v.dat_doanh_thu", "v.tb_diem_kpi"]}
    dto = B.mint_dto(None, b, [], {})
    by = {f["key"]: f["label"] for f in dto["fields"]}
    assert by == {"d0": "Đơn vị", "m0": "% đạt", "m1": "Điểm KPI"}, "m0/m1 follow the chart's metric order"
    assert dto["rows"][0] == {"d0": "Cát Bà", "m0": 0.936, "m1": 88.2}


def test_a_figure_with_its_unit_in_the_next_element_keeps_the_unit_scale(monkeypatch):
    """Benchmark: '<b>79,65</b><small>tỷ</small>' rendered 82.960.000.000 - the unit beside the
    figure was not read, so the governed value lost the design's scale."""
    from app.services.report_code import importer as I

    html = '<div class="kc"><div class="lb">Doanh thu</div><b class="v">79,65</b><small>tỷ</small></div>'
    s = next(x for x in I.detect_slots(html) if x["kind"] == "value")
    sc = I._scan(html)
    assert I.num_opts(s["sample"], I._text_after(html, sc.tags, s.get("host"), s["end"])) == {"decimals": 2, "scale": 1e9}


def test_a_number_past_the_review_budget_is_still_marked_as_a_sample(monkeypatch):
    """Benchmark: 'Điểm KPI bình quân 90,5' (past the 40th figure) was neither bound nor marked -
    the review budget cut it, and apply saw the same truncated list."""
    from app.services.report_code import bindings as B
    from app.services.report_code import importer as I

    monkeypatch.setattr(B, "load_model", lambda db, ds: _MODEL)
    monkeypatch.setattr(B, "bind_candidates", lambda db, picks, *, existing, **kw: ([], {}, []))
    n = I.MAX_SLOTS + 5
    html = "".join(f"<p>Chỉ số {i}: {i},5 tỷ</p>" for i in range(n))
    slots = I.detect_slots(html)
    values = [x for x in slots if x["kind"] == "value"]
    assert len(values) == n and len(I.shown_slots(slots)) <= I.MAX_SLOTS < len(slots), "the review shows a budget"
    out = I.apply(None, dataset_id=9, html=html, css="", js="", mapping=[], filters=[], owner_id=None,
                  report_name="R", existing=[], existing_filters=[], progress=lambda s: None)
    from app.services.report_code import lifecycle as L

    assert out["html"].count("<span data-rac-sample>") == n, "every figure nobody mapped is marked - past the budget too"
    assert L.sample_marks(out["html"]) >= n


def test_the_last_pass_marks_every_figure_no_one_governs():
    from app.services.report_code import importer as I

    html = ('<h1>Báo cáo 2024</h1><nav><b>Tập đoàn</b><i>88</i></nav><button>T07/26</button>'
            '<p data-rac-value="b1">79,65</p><span data-rac-sample>3,2%</span><td data-rac-cell="m0">12</td>')
    out = I.mark_loose_numbers(html)
    assert "<i><span data-rac-sample>88</span></i>" in out and "<span data-rac-sample>07/26</span>" in out
    assert "<h1>Báo cáo 2024</h1>" in out, "a year in a heading is not a figure"
    assert '<p data-rac-value="b1">79,65</p>' in out and '<td data-rac-cell="m0">12</td>' in out, "governed stays as is"
    assert out.count("data-rac-sample") == 3, "an existing mark is not wrapped twice"


# ── Calculation / data contract (BI Core decides WHAT) ────────────────────────────

def test_a_percent_is_the_semantic_models_format_never_guessed_from_a_label():
    model = {"views": [{"name": "v", "measures": [
        {"name": "dat", "type": "formula", "label": "% đạt KH", "format": {"kind": "percent"}},
        {"name": "occ_pct", "type": "avg", "label": "OCC %"},  # a label with % is not a format
    ], "dimensions": []}]}
    meta = B.field_meta(model)
    assert meta["v.dat"]["format"] == {"kind": "percent"}
    assert meta["v.occ_pct"]["format"] is None, "the runtime would multiply a whole percent by 100"


def test_the_dto_says_when_its_rows_are_a_top_n_of_the_chart(monkeypatch):
    from app.services import chart_service
    from types import SimpleNamespace

    monkeypatch.setattr(chart_service.ChartService, "get_chart_data", staticmethod(
        lambda db, cid, **k: {"data": [{"v.s": "SP", "v.r": 3}], "debug": {}}))

    class _Db:
        def get(self, model, pk):
            return SimpleNamespace(config={"styleConfig": {"dataLimit": 10, "dataLimitDirection": "top"}})

        def rollback(self):
            pass

    binding = {"id": "b1", "chart_id": 7, "title": "T", "kind": "category",
               "fields": {"v.s": {"label": "S", "role": "dimension", "kind": "string"},
                          "v.r": {"label": "R", "role": "measure", "kind": "number"}}}
    dto = B.mint_dto(_Db(), binding, [], {})
    assert dto["topN"] == {"n": 10, "direction": "top"}


# ── Shared result cache: a hit is the same JSON as a miss (every surface, Manual included) ──

def test_a_cached_result_keeps_the_response_encoding_of_dates_and_decimals(tmp_path):
    """The shared result cache stored rows with json default=str: a datetime came back as
    "2024-01-01 00:00:00" where the API sends "2024-01-01T00:00:00", so a Builder tile and the
    same tile on a public link differed with the cache's state (public-closure date drill)."""
    import datetime as dt
    from decimal import Decimal

    from fastapi.encoders import jsonable_encoder

    from app.services import query_cache as Q

    store = Q._SharedSqliteCache(str(tmp_path / "c.db"), 60, 100)
    row = {"order_month": dt.datetime(2024, 1, 1), "day": dt.date(2024, 1, 2), "revenue": Decimal("136065.50")}
    store.set(1, "k", {"data": [row]})
    got = store.get(1, "k")["data"][0]
    assert got == jsonable_encoder(row), got
    assert got["order_month"] == "2024-01-01T00:00:00"


# ── What the report bot reads, and where its sources point ──────────────────────────

_PAGE_HTML = ('<section data-rac-region="kpis" data-rac-label="Tổng quan">'
              '<div class="card"><b data-rac-value="b1"></b></div></section>'
              '<section data-rac-region="trend" data-rac-label="Xu hướng doanh thu">'
              '<div data-rac-viz="line" data-rac-bind="b2"></div>'
              '<div data-rac-viz="table" data-rac-bind="b1"></div></section>')
_PAGE_BINDINGS = [{"id": "b1", "chart_id": 11, "title": "Doanh thu"},
                  {"id": "b2", "chart_id": 12, "title": "Doanh thu theo tháng"},
                  {"id": "b3", "chart_id": 13, "title": "Bị khai báo nhưng không vẽ"},
                  {"id": "b4", "chart_id": 14, "title": "Vẽ bằng JS"}]


def test_the_report_bot_never_reads_a_binding_the_page_does_not_draw():
    from types import SimpleNamespace
    from app.services.report_code import public_bot as PB

    rev = SimpleNamespace(html=_PAGE_HTML, js="rac.bind('b4', function(d){});", bindings=_PAGE_BINDINGS)
    ids = [b["id"] for b in PB.page_bindings(rev)]
    assert ids == ["b1", "b2", "b4"], "b3 is declared but drawn nowhere: out of the bot's scope"
    # a declared-only page (the sink probe) gives the bot nothing to read
    assert PB.page_bindings(SimpleNamespace(html="<h1>x</h1>", js="", bindings=_PAGE_BINDINGS)) == []


def test_the_report_sections_are_the_cores_pages_with_the_charts_drawn_in_them():
    from types import SimpleNamespace
    from app.services.report_code import public_bot as PB

    rev = SimpleNamespace(html=_PAGE_HTML, js="", bindings=_PAGE_BINDINGS)
    sections = PB.page_sections(rev, {b["id"]: b["chart_id"] for b in _PAGE_BINDINGS})
    assert sections == [{"id": "kpis", "name": "Tổng quan", "chart_ids": [11]},
                        {"id": "trend", "name": "Xu hướng doanh thu", "chart_ids": [12, 11]}]


def test_a_report_source_carries_the_binding_ids_that_draw_it(monkeypatch):
    from types import SimpleNamespace
    from app.services.answer_core.published_report import PublishedReportScope

    scope = PublishedReportScope.__new__(PublishedReportScope)
    scope.ctx = SimpleNamespace(chart_meta={11: {"name": "Doanh thu", "anchors": ["b1", "b9"]}, 12: {"name": "x"}})
    scope.turn_id = "t" * 16
    p = SimpleNamespace(explore=SimpleNamespace(dataset_name="Doanh thu", explore_id=11))
    ev = scope.evidence(p, SimpleNamespace(meta={"chart_id": 11, "chart": "Doanh thu"}))
    assert ev["anchors"] == ["b1", "b9"] and ev["chart_id"] == 11
    ev2 = scope.evidence(p, SimpleNamespace(meta={"chart_id": 12, "chart": "x"}))
    assert "anchors" not in ev2, "a dashboard chart has no anchors: its tile is found by chart"


# ── Proposals: reviewed and previewed BEFORE they become a revision ──────────────

def _proposal_art():
    from types import SimpleNamespace

    return SimpleNamespace(id=7, job=None, draft_revision_id=11)


def _flagless(monkeypatch):
    from app.services.report_code import lifecycle as L

    monkeypatch.setattr(L, "flag_modified", lambda *_a, **_k: None)
    return L


def test_a_staged_proposal_is_validated_and_never_a_revision(monkeypatch):
    L = _flagless(monkeypatch)
    added = []
    monkeypatch.setattr(L, "add_revision", lambda *a, **k: added.append(k))
    art = _proposal_art()
    job = L.stage_proposal(None, art, user_id=None, base_revision_id=11, html='<p onclick="x()">hi</p>', css="", js="",
                           bindings=[{"id": "b1"}], filters=[], source="manual", note="n")
    assert added == [], "staging writes no revision"
    assert job["propose"] and job["state"] == "done" and "onclick" not in job["proposal"]["html"]
    view = L.job_view(art)
    assert "proposal" not in view and view["has_proposal"], "lists/summaries never carry the proposed code"


def test_a_proposal_is_applied_only_on_the_draft_it_was_made_on(monkeypatch):
    from types import SimpleNamespace

    L = _flagless(monkeypatch)
    art = _proposal_art()
    job = L.stage_proposal(None, art, user_id=None, base_revision_id=11, html="<p>v2</p>", css="", js="",
                           bindings=[], filters=[], source="manual", note=None)
    draft = SimpleNamespace(id=11, number=3)
    monkeypatch.setattr(L, "get_revision", lambda db, a, rid: draft)
    with pytest.raises(L.ProposalStale):
        L.apply_proposal(None, art, proposal_id=job["id"], base_number=2, user_id=None)
    with pytest.raises(ValueError):
        L.apply_proposal(None, art, proposal_id="someone-elses", base_number=3, user_id=None)
    saved = {}
    monkeypatch.setattr(L, "add_revision", lambda db, a, **k: (saved.update(k) or SimpleNamespace(number=4), []))
    rev, _ = L.apply_proposal(None, art, proposal_id=job["id"], base_number=3, user_id=None)
    assert rev.number == 4 and saved["html"] == "<p>v2</p>"
    assert L.proposal_of(art, job["id"]) is None, "a proposal is applied once"


def test_a_moved_draft_refuses_the_proposal_even_with_the_right_number(monkeypatch):
    from types import SimpleNamespace

    L = _flagless(monkeypatch)
    art = _proposal_art()
    job = L.stage_proposal(None, art, user_id=None, base_revision_id=11, html="x", css="", js="", bindings=[], filters=[],
                           source="manual", note=None)
    monkeypatch.setattr(L, "get_revision", lambda db, a, rid: SimpleNamespace(id=99, number=3))  # restored/rewritten draft
    with pytest.raises(L.ProposalStale):
        L.apply_proposal(None, art, proposal_id=job["id"], base_number=3, user_id=None)


def test_discard_and_a_running_job_both_protect_the_slot(monkeypatch):
    L = _flagless(monkeypatch)
    art = _proposal_art()
    job = L.stage_proposal(None, art, user_id=None, base_revision_id=11, html="x", css="", js="", bindings=[], filters=[],
                           source="manual", note=None)
    assert L.discard_proposal(art, job["id"]) and L.proposal_of(art, job["id"]) is None
    art.job = {"id": "j", "state": "running", "started_at": L._now().isoformat()}
    with pytest.raises(ValueError):
        L.stage_proposal(None, art, user_id=None, base_revision_id=11, html="x", css="", js="", bindings=[], filters=[],
                         source="manual", note=None)


# ── Re-import / re-bind keeps every anchor and every binding id ─────────────────────

def _reimport_world(monkeypatch, n_cands: int):
    """n KPI candidates; charts live in a fake db so an old binding can be matched back to
    the candidate it serves (same table, chart type, role config)."""
    from types import SimpleNamespace
    from app.services.report_code import bindings as B

    cands = [{"id": f"c{i}", "kind": "kpi", "type": "KPI", "table": 7, "title": f"M{i}", "measure": f"M{i}",
              "role": {"metrics": [{"field": f"v.m{i}", "agg": "sum"}]}} for i in range(1, n_cands + 1)]
    charts = {}

    def create(db, cand, title, **kw):
        cid = 500 + len(charts)
        charts[cid] = SimpleNamespace(id=cid, name=title, chart_type="KPI", dataset_table_id=cand["table"],
                                      config={"chartType": "KPI", "roleConfig": cand["role"]})
        return charts[cid]

    monkeypatch.setattr(B, "load_model", lambda db, ds: {"views": []})
    monkeypatch.setattr(B, "candidates", lambda model: cands)
    monkeypatch.setattr(B, "field_meta", lambda model: {})
    monkeypatch.setattr(B, "filter_dimensions", lambda model, ds: [])
    monkeypatch.setattr(B, "run_candidate", lambda db, cand: True)
    monkeypatch.setattr(B, "create_candidate_chart", create)
    db = SimpleNamespace(get=lambda model, cid: charts.get(cid))
    return db, cands, charts


def test_a_reimport_reuses_the_bindings_it_had_and_leaves_no_missing_anchor(monkeypatch):
    """Live (artifact 1, rev 2): the second import of the same report kept the 13 old
    bindings as 'existing', gave the KPIs NEW ids (b14..b16) and, the 16-binding room
    spent, wrote data-rac-bind="missing" in 19 of 22 places. A re-import binds the SAME
    data to the SAME ids, keeps no orphan, and writes every anchor."""
    from app.services.report_code import importer as I

    db, cands, _ = _reimport_world(monkeypatch, 13)
    html = "".join(f'<div class="card"><b data-rac-value="@c{i}"></b></div>' for i in range(1, 14))
    first = I.apply(db, dataset_id=1, html=html, css="", js="", mapping=[], filters=[], owner_id=None,
                    report_name="R", existing=[], existing_filters=[], progress=lambda s: None)
    assert [b["id"] for b in first["bindings"]] == [f"b{i}" for i in range(1, 14)]
    assert "missing" not in first["html"]

    # the same design pasted again (and a 14th..16th KPI added) onto the same report
    html2 = html + "".join(f'<div class="card"><b data-rac-value="@c{i}"></b></div>' for i in (1, 2, 3))
    second = I.apply(db, dataset_id=1, html=html2, css="", js="", mapping=[], filters=[], owner_id=None,
                     report_name="R", existing=first["bindings"], existing_filters=[], progress=lambda s: None)
    assert "missing" not in second["html"], "every anchor is written back"
    assert [b["id"] for b in second["bindings"]] == [f"b{i}" for i in range(1, 14)], \
        "the same data keeps its id: no renumbering, no duplicate, no orphan"
    assert second["html"].count('data-rac-value="b1"') == 2


def test_a_reimport_drops_bindings_the_new_page_no_longer_uses(monkeypatch):
    from app.services.report_code import importer as I

    db, cands, _ = _reimport_world(monkeypatch, 16)
    html = "".join(f'<b data-rac-value="@c{i}"></b>' for i in range(1, 17))
    first = I.apply(db, dataset_id=1, html=html, css="", js="", mapping=[], filters=[], owner_id=None,
                    report_name="R", existing=[], existing_filters=[], progress=lambda s: None)
    assert len(first["bindings"]) == 16
    # a new design that shows 3 OTHER metrics + 1 kept by its id: the room is not spent on orphans
    db2, _c, _ = db, cands, None
    html2 = '<b data-rac-value="b16"></b>' + "".join(f'<b data-rac-value="@c{i}"></b>' for i in (14, 15))
    second = I.apply(db2, dataset_id=1, html=html2, css="", js="", mapping=[], filters=[], owner_id=None,
                     report_name="R", existing=first["bindings"], existing_filters=[], progress=lambda s: None)
    assert sorted(b["id"] for b in second["bindings"]) == ["b14", "b15", "b16"]
    assert "missing" not in second["html"]


def test_publish_refuses_a_page_with_anchors_to_data_the_report_does_not_have():
    from types import SimpleNamespace
    from app.services.report_code import lifecycle as L

    rev = SimpleNamespace(id=2, html='<b data-rac-value="missing"></b><div data-rac-filter="f9"></div><b data-rac-value="b1"></b>',
                          js="", bindings=[{"id": "b1"}], filters=[{"key": "f1"}])
    art = SimpleNamespace(id=1, draft_revision_id=2, published_revision_id=None, last_published_at=None)
    L_get = L.get_revision
    try:
        L.get_revision = lambda db, a, rid: rev
        with pytest.raises(L.DanglingReferences) as ex:
            L.publish(None, art)
        assert "2" in str(ex.value) and art.published_revision_id is None
        rev.html = '<b data-rac-value="b1"></b><div data-rac-filter="f1"></div>'
        assert L.publish(None, art) is rev and art.published_revision_id == 2
    finally:
        L.get_revision = L_get


def test_a_server_never_gets_the_loopback_report_origin_and_a_misconfiguration_is_said(monkeypatch):
    """Live (/dashboards/code/1 on the server): a dev "localhost" among the CORS origins of
    the real domain made report_origin() guess 127.0.0.1 - every viewer's browser loaded the
    report from ITS OWN machine: a blank Studio. The loopback twin is a local install's only."""
    from app.core.config import settings
    from app.services.report_code import lifecycle as L

    monkeypatch.setattr(settings, "REPORT_ARTIFACT_ORIGIN", "")
    monkeypatch.setattr(settings, "CORS_ORIGINS", "http://localhost:3000,https://bi.example.com")
    assert L.report_origin() is None, "a real domain is served: never the viewer's loopback"
    assert "REPORT_ARTIFACT_ORIGIN is not set" in (L.origin_warning() or "")
    monkeypatch.setattr(settings, "REPORT_ARTIFACT_ORIGIN", "http://127.0.0.1:3000")
    assert "loopback" in (L.origin_warning() or ""), "a configured loopback origin on a server is said"
    monkeypatch.setattr(settings, "REPORT_ARTIFACT_ORIGIN", "https://report-docs.example.com")
    assert L.origin_warning() is None and L.report_origin() == "https://report-docs.example.com"
    monkeypatch.setattr(settings, "REPORT_ARTIFACT_ORIGIN", "")
    monkeypatch.setattr(settings, "CORS_ORIGINS", "http://localhost:3000,http://localhost:3001")
    assert L.report_origin() == "http://127.0.0.1:3000" and L.origin_warning() is None, "a local install keeps its twin"


def test_the_context_pack_frees_the_design_and_binds_every_figure_to_the_bi_core(monkeypatch):
    """PO 2026-11-05: an outside AI may design freely (layout, CSS, any JS) - ONLY the data
    connection is a contract, so the page always runs against the Dataset through the BI
    Core instead of fake numbers typed into the HTML."""
    from app.services.report_code import bindings as B
    from app.services.report_code import importer as I

    monkeypatch.setattr(B, "load_model", lambda db, ds: _MODEL)
    pack = I.context_pack(None, dataset_id=9, dataset_name="Bán hàng")
    assert "What is yours" in pack and "Any JavaScript" in pack, "the design is the author's"
    assert "data contract" in pack and "**Never**" in pack
    for rule in ("const data = [", "sample / mock / demo data", "add up, average or compare rows", "invent a placeholder"):
        assert rule in pack, rule
    assert 'data-rac-value=\\"@c' not in pack and 'data-rac-value="@c' in pack, "a copyable, valid example"
    assert "sidebar" not in pack.lower().split("## 6.")[0], "no imposed layout"
    import json as _json

    check = _json.loads(pack.split("```json\n")[1].split("\n```")[0])
    assert "@c1" in check["data"] and "@f1" in check["filters"] and "data-rac-value" in check["attributes"]


def test_the_summary_counts_unbound_places_of_the_published_version_too():
    """Backfill by reading: a version published before the publish guard (artifact 1
    rev 1: three tables bound to "missing") is flagged on every summary - no stored mark."""
    from types import SimpleNamespace
    from app.services.report_code import lifecycle as L

    pub = SimpleNamespace(number=1, html='<div data-rac-viz="table" data-rac-bind="missing"></div>' * 3
                          + '<b data-rac-value="b1"></b>', js="", bindings=[{"id": "b1"}], filters=[], content_hash="a")
    draft = SimpleNamespace(number=2, html='<b data-rac-value="b1"></b>', js="", bindings=[{"id": "b1"}], filters=[],
                            content_hash="b")
    art = SimpleNamespace(id=1, name="r", description=None, dataset_id=1, owner_id=None, job=None,
                          updated_at=None, last_published_at=None)
    s = L._summary(art, draft, pub, 0)
    assert s["unbound"] == {"draft": 0, "published": 3}


# ── Readiness: one report, per place; AI only where the rules are unsure ─────────────

_READY_HTML = (
    '<section data-rac-region="kpis" data-rac-label="Chỉ số">'
    '<div class="card"><h3>Doanh thu</h3><b data-rac-value="b1"></b></div>'
    '<div class="card"><h3>Số đơn</h3><b data-rac-value="b1"></b></div>'
    '<div class="card"><h3>Tồn kho</h3><b data-rac-value="missing"></b></div>'
    '<p>Top 10 theo tháng 8, năm 2026. Cập nhật 24/08/2026.</p>'
    '<p>Tăng 12,5% so với cùng kỳ, đạt 1.234 đơn.</p>'
    '<p class="note">Dữ liệu tĩnh — số liệu mẫu cho bản thiết kế.</p>'
    '<span data-rac-sample>9.999</span>'
    '<div data-rac-filter="f9"></div>'
    '</section>')
_READY_BINDINGS = [{"id": "b1", "title": "Doanh thu"}, {"id": "b2", "title": "Số đơn"}]


def test_the_readiness_report_names_each_problem_at_its_place():
    from types import SimpleNamespace
    from app.services.report_code import readiness as R

    rev = SimpleNamespace(html=_READY_HTML, js="rac.bind('b7', function(){});", bindings=_READY_BINDINGS,
                          filters=[{"key": "f1"}])
    rep = R.report(rev, with_origin=False)
    assert rep["ready"] is False
    codes = [x["code"] for x in rep["blocking"]]
    assert codes.count("UNBOUND") == 3, rep["blocking"]  # "missing", filter f9, rac.bind('b7')
    assert codes.count("SAMPLE") == 1
    unbound = next(x for x in rep["blocking"] if "missing" in x["message"])
    assert unbound["place"] == {"region": "kpis", "label": "Chỉ số", "snippet": '<b data-rac-value="missing">'}
    assert unbound["fix"]
    w = {x["code"]: x for x in rep["warnings"]}
    # a rank, a month, a year, a date are not figures; a typed growth and a count are
    static = [x for x in rep["warnings"] if x["code"] == "STATIC_FIGURE"]
    assert len(static) == 1 and "12,5%" in static[0]["message"] and "1.234" in static[0]["message"]
    assert "STALE_TEXT" in w
    assert "Số đơn" in w["CARD_LABEL"]["message"] and "b1" in w["CARD_LABEL"]["message"]
    assert rep["counts"]["UNBOUND"] == 3


def test_a_clean_page_written_to_the_contract_is_ready():
    from types import SimpleNamespace
    from app.services.report_code import readiness as R

    html = ('<section data-rac-region="kpis" data-rac-label="Chỉ số"><div class="card"><h3>Doanh thu</h3>'
            '<b data-rac-value="b1"></b></div><div data-rac-filter="f1"></div><p>Báo cáo năm 2026.</p></section>')
    rep = R.report(SimpleNamespace(html=html, js="", bindings=_READY_BINDINGS, filters=[{"key": "f1"}]), with_origin=False)
    assert rep == {"ready": True, "blocking": [], "warnings": [], "counts": {}}


def test_publish_refuses_a_loopback_report_origin_on_a_server(monkeypatch):
    from types import SimpleNamespace
    from app.core.config import settings
    from app.services.report_code import lifecycle as L

    monkeypatch.setattr(settings, "CORS_ORIGINS", "https://bi.example.com")
    monkeypatch.setattr(settings, "REPORT_ARTIFACT_ORIGIN", "http://127.0.0.1:3000")
    rev = SimpleNamespace(id=2, html='<b data-rac-value="b1"></b>', js="", bindings=[{"id": "b1"}], filters=[])
    art = SimpleNamespace(id=1, draft_revision_id=2, published_revision_id=None, last_published_at=None)
    monkeypatch.setattr(L, "get_revision", lambda db, a, rid: rev)
    with pytest.raises(L.DanglingReferences) as ex:
        L.publish(None, art)
    assert "REPORT_ARTIFACT_ORIGIN" in str(ex.value) and art.published_revision_id is None
    monkeypatch.setattr(settings, "REPORT_ARTIFACT_ORIGIN", "https://report-docs.example.com")
    assert L.publish(None, art) is rev


def test_the_model_is_asked_only_about_the_places_the_rules_are_unsure_of(monkeypatch):
    """Every analyse used to send EVERY slot and 160 candidates to the model, certain or not.
    A slot the rules settle never reaches it; an unsure one goes with a short candidate list."""
    from app.services import llm_client
    from app.services.report_code import bindings as B
    from app.services.report_code import importer as I

    cands = B.candidates(_MODEL)
    for c in cands:
        c["title"] = B._localize_title(c["title"])
    sent = []
    monkeypatch.setattr(llm_client.LLMClient, "complete_json", staticmethod(lambda **kw: sent.append(kw["prompt"]) or {"map": []}))
    sure = {"id": "s1", "kind": "chart", "context": "Doanh thu theo tháng", "sample": ""}
    unsure = {"id": "s2", "kind": "value", "context": "Chỉ số X", "sample": "42"}
    stats = {}
    out = I.propose([sure, unsure], cands, [], stats=stats)
    assert out["s1"]["source"] == "rules" and stats["ai_slots"] == 1
    brief = sent[0].split("never by position:\n")[1].split("\n\nCANDIDATE DATA")[0] if sent else ""
    assert len(sent) == 1 and '"s2"' in brief and '"s1"' not in brief, "only the unsure place is sent"
    listed = [l for l in sent[0].split("CANDIDATE DATA (governed, by id):\n")[1].split("\n\n")[0].splitlines() if l.strip()]
    assert 0 < len(listed) <= I.SHORTLIST
    sent.clear()
    stats = {}
    I.propose([sure], cands, [], stats=stats)
    assert sent == [] and stats["ai_slots"] == 0, "nothing unsure: no model call at all"


def test_a_page_written_to_the_contract_imports_without_any_model_call(monkeypatch):
    from app.services import llm_client
    from app.services.report_code import bindings as B
    from app.services.report_code import importer as I

    monkeypatch.setattr(B, "load_model", lambda db, ds: _MODEL)
    called = []
    monkeypatch.setattr(llm_client.LLMClient, "complete_json", staticmethod(lambda **kw: called.append(1) or {}))
    from types import SimpleNamespace

    class _Q:
        def filter(self, *a): return self
        def __iter__(self): return iter([])

    db = SimpleNamespace(query=lambda *a: _Q())
    out = I.analyze(db, dataset_id=9, html='<b data-rac-value="@c1"></b><div data-rac-filter="@f1"></div>', css="", js="")
    assert out["compatible"] is True and out["ai_slots"] == 0 and called == []



# ── rc1 bundle (report-demo /dashboards/code/1): what an outside AI was told vs what runs ──

def test_the_context_pack_teaches_only_what_the_runtime_does(monkeypatch):
    """rc1: the pack taught `data-rac-cell="<column label>"` (the runtime only reads field
    keys -> every cell "—"), gave three placeholders the same meaning, mixed `b1` examples
    with `@c1`, and never said a category is a Top 10 or that a page holds 16 queries."""
    from app.services.report_code import importer as I

    monkeypatch.setattr(B, "load_model", lambda db, ds: _MODEL)
    pack = I.context_pack(None, dataset_id=9, dataset_name="Bán hàng")
    assert "<column label>" not in pack
    for bad in ('="b1"', "'b1'", '="f1"', "'f1'", '="c1"'):
        assert bad not in pack, f"an example without @ teaches a placeholder that does not exist: {bad}"
    table = [l for l in pack.split("## 3.")[1].split("## 4.")[0].splitlines() if l.startswith("| `@c")]
    meanings = [l.split("|")[3].strip() for l in table]
    assert len(meanings) == len(set(meanings)) > 0, "two placeholders with one meaning: the AI picks blind"
    assert all("`m0`" in l for l in table) and any("`d0`" in l and "Top 10" in l for l in table)
    assert f"{B.MAX_BINDINGS} distinct" in pack and f"{B.MAX_FILTERS} filters" in pack
    check = json.loads(pack.split("```json\n")[1].split("\n```")[0])
    assert check["cell_keys"] == ["#", "d0", "m0"] and check["limits"]["placeholders"] == B.MAX_BINDINGS
    assert set(check["data_kinds"]) == set(check["data"])


def test_the_runtime_reads_a_repeat_cell_by_field_key_only():
    """The pack's cell keys are exactly the runtime's (`cellField`): # / d0 / d / m0 / m."""
    js = D.RUNTIME_JS if hasattr(D, "RUNTIME_JS") else open(
        __import__("pathlib").Path(B.__file__).with_name("runtime.js"), encoding="utf8").read()
    body = js.split("function cellField(d, ref) {")[1].split("\n  }")[0]
    assert "ref === 'dim' || ref === 'd'" in body and "ref === 'm'" in body and "return field(d, ref)" in body
    assert "[data-rac-static]" in js.split("var TRUSTED")[1].split(";")[0], "the pack's opt-out is honoured by the audit"


def test_an_import_says_a_query_failed_not_that_it_had_no_data(monkeypatch):
    """rc1: 3 places were dropped with "truy vấn không trả về số liệu" while BigQuery had
    refused the query - the author looked for empty data that was never the problem."""
    from app.services import report_starter_service as RS
    from app.services.chart_service import ChartService

    class _Db:
        def rollback(self): pass

    cand = {"id": "c1", "type": "BAR", "table": 1, "role": {"metrics": [{"field": "v.m"}], "dimension": "v.d"}}
    monkeypatch.setattr(ChartService, "preview_chart_data", staticmethod(lambda *a, **k: (_ for _ in ()).throw(RuntimeError("400 bad"))))
    assert B.run_candidate(_Db(), cand) is False
    assert "lỗi" in B.drop_note("A", B._last_why.value) and "không phải do dữ liệu rỗng" in B.drop_note("A", B._last_why.value)
    monkeypatch.setattr(ChartService, "preview_chart_data", staticmethod(lambda *a, **k: {"data": []}))
    assert B.run_candidate(_Db(), cand) is False
    assert B._last_why.value == {"reason": "empty"} and "không trả về số liệu" in B.drop_note("A", B._last_why.value)
    assert RS._runs(_Db(), cand) is None, "the starter's own callers are unchanged"


def test_a_warehouse_error_never_reaches_the_report_page():
    """rc1: the Studio frame printed BigQuery's 400 with its Job ID and SQL fragment."""
    raw = ("Lỗi chạy chart query trên bigquery (dialect bigquery): 400 SELECT * expands to zero columns after "
           "applying EXCEPT at [4:14]; reason: invalidQuery Location: us-central1 Job ID: decf06ec")
    msg = B._author_error(None, raw, "b1")
    for leak in ("Job ID", "SELECT", "bigquery", "EXCEPT", "us-central1"):
        assert leak not in msg
    assert "Dataset" in msg
    assert B._author_error(None, "Trường 'Doanh thu' không còn trong model") == "Trường 'Doanh thu' không còn trong model"


def test_a_hand_quoted_measure_column_is_stored_portable():
    """rc1: `SUM("Quá hạn SLA")` is a column on Postgres/DuckDB and a STRING on BigQuery."""
    from app.schemas.semantic import MeasureDefinition as M

    assert M(name="x", type="sum", sql='"Quá hạn SLA"').sql == "Quá hạn SLA"
    assert M(name="x", type="sum", sql="`Sản lượng`").sql == "Sản lượng"
    assert M(name="x", type="sum", sql='"Đối tượng"').sql == '"Đối tượng"', "a name the engine cannot re-quote stays"
    assert M(name="x", type="sum", sql="${TABLE}.price").sql == "${TABLE}.price"
    assert M(name="x", type="sum", sql='CASE WHEN "a" > 0 THEN 1 END').sql == 'CASE WHEN "a" > 0 THEN 1 END'


def test_a_table_whose_column_names_are_all_nonstandard_is_refused():
    """rc1: every header of Phieu_nhap_xuat was Vietnamese; once the BigQuery snapshot was
    built no chart of the Dataset could run. Refuse that table at creation; warn on some."""
    from app.services import dataset_column_names as C

    allbad = C.check([{"name": "Mã phiếu"}, {"name": "Sản lượng"}])
    assert allbad["blocked"] is True and allbad["bad"] == ["Mã phiếu", "Sản lượng"]
    detail = C.detail(allbad)
    assert detail["code"] == "COLUMN_NAMES_NONSTANDARD" and "Mã phiếu" in detail["message"] and "ma_phieu" in detail["message"]
    some = C.check([{"name": "ma_phieu"}, {"name": "Sản lượng"}])
    assert some["blocked"] is False and some["bad"] == ["Sản lượng"] and "vẫn dùng được" in some["message"]
    assert C.detail(C.check([{"name": "ma_phieu"}, {"name": "san_luong"}])) is None
    assert C.check([])["blocked"] is False


# ── Page-size limits: configurable, stated, never a silent cut ─────────────────────

def test_the_page_limits_come_from_settings_and_fit_an_operational_report():
    """Report 10 (9 KPIs + 7 charts) hit the hard-coded 16; a multi-table dataset needs
    more than 6 date filters. The limits are settings (REPORT_MAX_*), raised by default."""
    from app.core.config import settings
    from app.services.report_code import generation as G
    from app.services.report_code import importer as I

    assert B.MAX_BINDINGS == settings.REPORT_MAX_BINDINGS >= 40
    assert B.MAX_FILTERS == settings.REPORT_MAX_FILTERS >= 12
    assert B.PROBE_BUDGET_S == settings.REPORT_PROBE_BUDGET_S
    assert G.MAX_CATEGORY_FILTERS == settings.REPORT_MAX_CATEGORY_FILTERS
    assert I.MAX_SLOTS == settings.REPORT_IMPORT_MAX_SLOTS


def test_an_import_over_the_limit_names_every_place_it_left_out(monkeypatch):
    """Over the ceiling the import used to stop with one generic line. It names each
    dropped data source; their places stay unbound, so publishing is refused."""
    from types import SimpleNamespace
    from app.services.report_code import importer as I
    from app.services.report_code import readiness as R

    db, cands, _ = _reimport_world(monkeypatch, 6)
    monkeypatch.setattr(B, "MAX_BINDINGS", 4)
    html = "".join(f'<div class="card"><b data-rac-value="@c{i}"></b></div>' for i in range(1, 7))
    out = I.apply(db, dataset_id=1, html=html, css="", js="", mapping=[], filters=[], owner_id=None,
                  report_name="R", existing=[], existing_filters=[], progress=lambda s: None)
    assert len(out["bindings"]) == 4
    note = next(n for n in out["notes"] if "REPORT_MAX_BINDINGS" in n)
    assert "Không gắn 2 dữ liệu" in note and all(f"'{c['title']}'" in note for c in cands[4:]), note
    rep = R.report(SimpleNamespace(html=out["html"], js=out["js"], bindings=out["bindings"], filters=out["filters"]),
                   with_origin=False)
    assert rep["ready"] is False and rep["counts"]["UNBOUND"] == 2


def test_saving_code_with_context_pack_placeholders_binds_them_like_an_import(monkeypatch):
    """"Sửa mã nguồn" saved `@c3` raw: the page showed "Chưa gắn dữ liệu" with no word
    at save. Saving runs the import's placeholder binding and returns its notes."""
    from types import SimpleNamespace
    from app.api import report_artifacts as RA
    from app.services.report_code import importer as I

    draft = SimpleNamespace(number=3, bindings=[{"id": "b1"}], filters=[])
    art = SimpleNamespace(id=7, dataset_id=1, name="R")
    monkeypatch.setattr(RA, "_load", lambda db, aid, user, level="view": art)
    monkeypatch.setattr(RA, "_draft", lambda db, a: draft)
    seen = {}

    def apply(db, **kw):
        seen.update(kw)
        return {"html": kw["html"].replace("@c3", "b2"), "css": kw["css"], "js": kw["js"],
                "bindings": kw["existing"] + [{"id": "b2"}], "filters": [], "notes": ["gắn @c3 → b2"]}

    saved = {}
    monkeypatch.setattr(I, "apply", apply)
    monkeypatch.setattr(RA.L, "add_revision", lambda db, a, **kw: (saved.update(kw) or SimpleNamespace(), []))
    monkeypatch.setattr(RA.L, "revision_view", lambda rev, with_source=False: {})
    db = SimpleNamespace(commit=lambda: None)
    user = SimpleNamespace(id="u")
    out = RA.save_source(7, RA.SourceBody(html='<b data-rac-value="b1"></b><b data-rac-value="@c3"></b>', base_number=3), db, user)
    assert seen["existing"] == [{"id": "b1"}], "existing bindings are reused, never renumbered"
    assert "@c3" not in saved["html"] and [b["id"] for b in saved["bindings"]] == ["b1", "b2"]
    assert out["warnings"][0] == "gắn @c3 → b2"
    seen.clear(); saved.clear()
    RA.save_source(7, RA.SourceBody(html='<b data-rac-value="b1"></b>', base_number=3), db, user)
    assert seen == {} and saved["bindings"] == [{"id": "b1"}], "code without placeholders saves as it is"


def test_js_off_is_told_as_js_off_not_as_not_set_or_an_error(monkeypatch):
    """Operator feedback: REPORT_ARTIFACT_ORIGIN set to the app's own domain still logged
    "is not set"; authors saw a red "Bảo mật" issue as if the report were broken; the pack
    and the AI generator taught JS the environment would never run."""
    from app.core.config import settings
    from app.services.report_code import generation as G
    from app.services.report_code import importer as I
    from app.services.report_code import lifecycle as L

    monkeypatch.setattr(B, "load_model", lambda db, ds: _MODEL)
    monkeypatch.setattr(settings, "CORS_ORIGINS", "https://bi.example.com")
    monkeypatch.setattr(settings, "REPORT_ARTIFACT_ORIGIN", "https://bi.example.com")
    w = L.origin_warning() or ""
    assert "is not set" not in w and "app's own domain" in w and "still work" in w and "OFF" in w
    pack = I.context_pack(None, dataset_id=9, dataset_name="Bán hàng")
    check = json.loads(pack.split("```json\n")[1].split("\n```")[0])
    assert check["custom_js"] is False and "custom JavaScript is OFF" in pack.split("## 1.")[0]
    assert "leave \"js\" empty" in G.design_rules()

    monkeypatch.setattr(settings, "REPORT_ARTIFACT_ORIGIN", "https://report-docs.example.com")
    assert L.origin_warning() is None
    pack = I.context_pack(None, dataset_id=9, dataset_name="Bán hàng")
    assert json.loads(pack.split("```json\n")[1].split("\n```")[0])["custom_js"] is True
    assert "custom JavaScript RUNS" in pack and G.design_rules() == G.DESIGN_RULES

    rt = (Path(L.__file__).parent / "runtime.js").read_text(encoding="utf-8")
    refused = rt.split("authorState = 'refused';")[1][:400]
    assert "report('js_off'" in refused and "report('security'" not in refused and "KHÔNG lỗi" in refused
