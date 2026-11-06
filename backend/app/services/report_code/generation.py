"""AI Vibe Design: prompt → governed data bindings → a full-page report, and edits.

Two different freedoms, deliberately kept apart:

* DATA — the model chooses among candidates enumerated from the semantic model, BY
  ID. It never writes SQL, never names a field, and every pick is run before it is
  kept (bindings.bind_candidates). New data in an edit goes through the same door.
* PRESENTATION — the model writes HTML/CSS/JS freely, against the `rac` runtime. It
  runs in the sandbox; it receives numbers, it never produces them.

When no model answers, a deterministic template builds the same kind of page, so the
feature works offline and a failed call never leaves the author with nothing.
"""
from __future__ import annotations

import html as _html
import json
import logging
import re
from typing import Any, Callable, Dict, List, Optional, Tuple

from sqlalchemy.orm import Session

from app.services.report_code import bindings as B
from app.services.report_code import document as D
from app.services.report_code import semantics as S

logger = logging.getLogger(__name__)

GENERATE_TIMEOUT_S = 170.0
EDIT_TIMEOUT_S = 120.0
LIMITS = {"kpi": 4, "time": 3, "category": 5}
MIN_COMPOSITION = {"kpi": 3, "time": 1, "category": 2}
MAX_CATEGORY_FILTERS = int(B._settings.REPORT_MAX_CATEGORY_FILTERS)  # settings: REPORT_MAX_CATEGORY_FILTERS
_VIZ_KIND = {"kpi": "kpi", "gauge": "kpi", "line": "time", "area": "time", "heatmap": "time", "waterfall": "time",
             "sparkline": "time", "bar": "category", "column": "category", "hbar": "category", "donut": "category",
             "pie": "category", "table": "category", "progress": "category"}
_REF_ATTR_RX = re.compile(r'(data-rac-(?:bind|value|title|asof)=["\'])([^"\']+)(["\'])')
_VIZ_TAG_RX = re.compile(r'<[^>]*data-rac-viz=["\']([a-z]+)["\'][^>]*data-rac-bind=["\']([^"\']+)["\']'
                         r'|<[^>]*data-rac-bind=["\']([^"\']+)["\'][^>]*data-rac-viz=["\']([a-z]+)["\']')


def heal_references(html: str, js: str, bindings: List[Dict[str, Any]]) -> Tuple[str, str, List[str]]:
    """Point a reference to a binding the page does not have at an unused binding of
    the kind its visual needs; what cannot be matched is reported, never invented."""
    known = {b["id"] for b in bindings}
    wanted: Dict[str, str] = {}
    for m in _VIZ_TAG_RX.finditer(html):
        viz, ref = (m.group(1), m.group(2)) if m.group(1) else (m.group(4), m.group(3))
        if ref not in known:
            wanted.setdefault(ref, _VIZ_KIND.get(viz, "category"))
    for m in _REF_ATTR_RX.finditer(html):
        if m.group(2) not in known:
            wanted.setdefault(m.group(2), "kpi")
    if not wanted:
        return html, js, []
    used = {m.group(2) for m in _REF_ATTR_RX.finditer(html) if m.group(2) in known}
    mapping, notes = {}, []
    for ref, kind in wanted.items():
        pool = [b for b in bindings if b.get("kind") == kind and b["id"] not in used] or \
               [b for b in bindings if b.get("kind") == kind]
        if pool:
            mapping[ref] = pool[0]["id"]
            used.add(pool[0]["id"])
            notes.append(f"Tham chiếu '{ref}' không có — đã gắn vào '{pool[0]['title']}'.")
        else:
            notes.append(f"Tham chiếu '{ref}' không có dữ liệu tương ứng.")
    html = _REF_ATTR_RX.sub(lambda m: m.group(1) + mapping.get(m.group(2), m.group(2)) + m.group(3), html)
    js = re.sub(r"(rac\.(?:bind|data|primary)\(\s*['\"])([^'\"]+)(['\"])",
                lambda m: m.group(1) + mapping.get(m.group(2), m.group(2)) + m.group(3), js)
    return html, js, notes

SDK_REFERENCE = """
THE RUNTIME (window.rac) IS ALREADY LOADED. Never add <script src>, CDN links, fonts or images from the web.
DECLARATIVE (preferred — needs no JS):
  <div data-rac-viz="KIND" data-rac-bind="b1" data-rac-opts='{"top":8}' style="height:280px"></div>
     KIND: kpi | bar | hbar | line | area | donut | table | heatmap | gauge | waterfall | progress | sparkline
     Charts (bar, line, area, waterfall) need a height on the element; kpi, table, donut, progress, heatmap size themselves.
     heatmap of a monthly series = year × month matrix. waterfall of a time series = period-over-period change.
  <span data-rac-value="b1"></span>      the formatted HEADLINE number of b1 (a KPI binding's value, or a TIME binding's latest period) — ONE number per binding.
     A TOTAL is never added up by the report: bind a KPI candidate (the BI Core computes it). A many-row binding needs data-rac-row/-rank.
  <span data-rac-value="b6" data-rac-row="SP"></span>              one row's measure (row chosen by its dimension value)
  <span data-rac-value="b6" data-rac-rank="0" data-rac-field="d0"></span>  the 1st row's dimension label (rank is 0-based; field d0/m0)
     → a hand-built per-row table MUST use data-rac-row / data-rac-rank; never repeat a bare data-rac-value in rows.
     → values are already formatted WITH their unit (%, Tr, N, ₫): never write a unit or symbol next to them.
  Period-over-period change: data-rac-viz="kpi" on a TIME binding shows ▲/▼ % between the two latest periods the BI Core returned —
     it is labelled "tính trong báo cáo" (a report calculation, not an official metric) and is skipped for an incomplete period. NEVER type a %, delta or target.
  <span data-rac-title="b1"></span>      the binding's title        <span data-rac-asof="b1"></span> data timestamp
  <div data-rac-filter="f1"></div>       the control for declared filter f1 (multi-select dropdown, or date range)
  <div data-rac-filter-chips></div>      active-filter chips with clear buttons
  <span data-rac-icon="NAME"></span>     NAME: home chart trend users cart money truck star box layers filter calendar map target table pie menu up down alert
IMPERATIVE (JS tab, for custom visuals and interactions):
  rac.bind('b1', function (dto) { ... })   // called when data arrives and after EVERY filter change
  dto = {status:'loading'|'ready'|'empty'|'error'|'refused', title, rows:[{d0:..., m0:...}], topN:{n,direction}|absent, truncated,
         fields:[{key:'d0', label, role:'dimension'|'measure', kind:'date'|'string'|'number', grain, aggregation, format, filterKey}],
         partial:[buckets not yet complete], notApplied:[filters this data could not apply], provenance:{asOf}}
  rac.viz.KIND(element, 'b1', opts)      // same kinds as above; re-renders by itself on new data
  rac.fmt(value, field, {compact:true|false, decimals:n})   rac.fmtDate(value, grain)   rac.primary('b1') → {value, prev, field, note}
  rac.filters()  rac.filterState()  rac.onFilters(fn)  rac.setFilter('f1', ['A','B'])  rac.setFilter('f2', ['2017-01-01','2017-12-31'])
  rac.clearFilters()  rac.drill('f1', value)  rac.values('f1', search) → Promise<array>   rac.ready(fn)
  OPTS: kpi {label, goal:'up'|'down', compare:'none', sparkline:false}; bar/hbar {top, color}; line/area {color}; donut {top};
        table {limit, bars:false}; gauge {target, max}; waterfall {top}; progress {top}
  Clicking a bar, slice or row whose dimension has a filterKey cross-filters the whole report (drill-down).
  The frame has NO network, NO storage, NO cookies, NO access to the page around it. eval/new Function are blocked.
"""

DESIGN_RULES = """
OUTPUT: one JSON object {"title": "...", "html": "...", "css": "...", "js": "...", "summary": "one sentence"}.
HTML is the BODY CONTENT only (no <html>/<head>/<body>/<script>/<link>/<meta>). JS goes in "js", CSS in "css".
1. Every top-level section carries data-rac-region="kebab-id" and data-rac-label="Human label" (sidebar, header, kpis, …). Ids are unique and stable.
2. NEVER type a business number, total, percentage, date range or trend claim. Every figure comes from a binding via data-rac-value / data-rac-viz / rac.bind. Words may say what a section shows, not what the numbers are.
3. Use ONLY the binding ids and filter keys listed. Put a control for every declared filter in the header, plus data-rac-filter-chips.
4. Design a complete web app page, not a grid of tiles: a navigation sidebar (anchor links to section ids, icons), a sticky header with title + filters, a KPI card row, then sections with chart cards, a detail table. Cards: titles, short subtitles, comfortable spacing, soft shadows, 12–16px radius.
5. Make it responsive: ≤ 960px the sidebar becomes a top bar; ≤ 640px every grid is one column. Use CSS grid / flex, no fixed pixel page widths.
   Layout: the page shell is a 2-column grid (sidebar | main) with min-height:100vh; the sidebar is position:sticky; top:0; height:100vh.
   KPI cards size to their content (no fixed or stretched heights; use align-items:start on their grid). Chart cards give the chart element an explicit height (240–320px).
   Nothing may overflow horizontally at 390px: the header and filter rows use flex-wrap:wrap; grids use repeat(auto-fit,minmax(min(100%,220px),1fr)) or minmax(0,1fr) columns;
   no element has a min-width or fixed width above 300px; at ≤ 640px KPI and chart grids are a single column and long titles wrap.
6. Theme through CSS variables on :root (--rac-accent, --rac-bg, --rac-surface, --rac-text, --rac-muted, --rac-border, --rac-c1 … --rac-c8). System fonts only.
7. JS is optional: navigation active state, tabs, toggles, custom visuals built with rac.bind. Use addEventListener (inline on* handlers do not run). No network, storage or timers that poll.
8. Write UI text in the language of the request (Vietnamese by default). Never leave placeholder or lorem text.
"""

SKELETON = """
CSS: .app{display:grid;grid-template-columns:248px minmax(0,1fr);min-height:100vh}
     .side{position:sticky;top:0;height:100vh}  .kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:16px;align-items:start}
     @media (max-width:960px){.app{grid-template-columns:1fr}.side{position:static;height:auto}}
<div class="app">
<aside class="side" data-rac-region="sidebar" data-rac-label="Điều hướng"> <div class="brand">…</div>
  <nav><a href="#overview" class="active"><span data-rac-icon="home"></span>Tổng quan</a> …</nav></aside>
<main class="main">
  <header class="top" data-rac-region="header" data-rac-label="Tiêu đề & bộ lọc"> <h1>…</h1>
    <div class="filters"><div data-rac-filter="f1"></div></div><div data-rac-filter-chips></div></header>
  <section id="overview" class="kpis" data-rac-region="kpis" data-rac-label="Chỉ số chính">
    <div class="card"><div data-rac-viz="kpi" data-rac-bind="b1"></div></div> …</section>
  <section id="trend" data-rac-region="trend" data-rac-label="Xu hướng"> <div class="card"><h3><span data-rac-title="b5"></span></h3>
    <div data-rac-viz="area" data-rac-bind="b5" style="height:300px"></div></div></section> …
</main>
</div>
"""


# ── Prompt material ───────────────────────────────────────────────────────────

def _binding_brief(b: Dict[str, Any], dto: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    out = {"id": b["id"], "title": b.get("title"), "kind": b.get("kind")}
    if dto:
        out["fields"] = [{k: f[k] for k in ("key", "label", "role", "kind", "grain", "aggregation", "filterKey") if k in f}
                         for f in dto.get("fields") or []]
        out["rows"] = len(dto.get("rows") or [])
        out["sample"] = (dto.get("rows") or [])[:3]
    return out


def _probe(db: Session, bindings: List[Dict[str, Any]], decl: List[Dict[str, Any]]) -> Dict[str, Dict[str, Any]]:
    out = {}
    for b in bindings:
        try:
            out[b["id"]] = B.mint_dto(db, b, decl, {})
        except Exception:  # noqa: BLE001
            db.rollback()
    return out


def _candidate_listing(cands: List[Dict[str, Any]], limit: int = 120) -> str:
    ranked = sorted(cands, key=lambda c: (c.get("rank", 9), c["id"]))[:limit]
    return "\n".join(f"{c['id']}: {c['type']} — {c['title']}" for c in ranked)


def _dims_listing(dims: List[Dict[str, Any]]) -> str:
    return "\n".join(f"{d['id']}: {d['kind']} — {d['label']}" for d in dims)


# ── Step 1: choose the data (governed) ─────────────────────────────────────────

def choose_data(db: Session, *, goal: str, model: Dict[str, Any], cands: List[Dict[str, Any]],
                dims: List[Dict[str, Any]]) -> Tuple[List[Tuple[Dict[str, Any], str]], List[str], str, str]:
    """(picks, filter dimension ids, report name, source) — the model chooses by id only."""
    from app.services.report_starter_service import _deterministic_order

    by_id = {c["id"]: c for c in cands}
    name, picks, fids, source = "", [], [], "rules"
    if goal.strip():
        try:
            from app.services.llm_client import LLMClient

            prompt = (
                f"REPORT REQUEST: {goal.strip()[:1500]}\n\n"
                "CANDIDATE DATA (each is a governed query on the semantic model; it is run before it is kept).\n"
                f"KPI = one headline number, TIME_SERIES = a measure by month, BAR = a measure by a category:\n{_candidate_listing(cands)}\n\n"
                f"DIMENSIONS A VIEWER MAY FILTER BY:\n{_dims_listing(dims)}\n\n"
                "Choose what this report needs, in reading order: 3 to 4 KPI ids, 1 to 3 TIME_SERIES ids, 2 to 5 BAR ids "
                "(pick the breakdowns the request names, e.g. by category or by state). "
                "Choose 1 to 3 filter dimensions (a date dimension is welcome when there are time series). "
                "Give each chosen item a short, clear title in the request's language, with no digits. Use ONLY ids from the lists. "
                'Return JSON: {"name": "short report name", "kpis": [{"id": "c1", "title": "..."}], '
                '"trends": [{"id": "c30", "title": "..."}], "breakdowns": [{"id": "c80", "title": "..."}], "filters": ["f1"]}'
            )
            res = LLMClient.complete_json(prompt=prompt, system="You design governed BI reports. Reply with JSON only.",
                                          max_tokens=1500)
            if isinstance(res, dict):
                for group in ("kpis", "trends", "breakdowns", "data"):
                    for item in res.get(group) or []:
                        if isinstance(item, dict) and item.get("id") in by_id and all(p[0]["id"] != item["id"] for p in picks):
                            title = str(item.get("title") or "").strip()
                            picks.append((by_id[item["id"]], "" if re.search(r"\d", title) else title[:80]))
                fids = [f for f in (res.get("filters") or []) if isinstance(f, str)]
                n = res.get("name")
                if isinstance(n, str) and not re.search(r"\d", n):
                    name = n.strip()[:120]
                if picks:
                    source = "model"
        except Exception:  # noqa: BLE001 - a model failure falls back to the rules
            logger.warning("report-code: data choice by model failed", exc_info=True)
    if not picks:
        picks = [(by_id[i], "") for i in _deterministic_order(cands)]
    # A report page needs a headline, a trend and a breakdown; a model that chose only
    # one kind is topped up from the deterministic ranking (still the semantic model).
    for kind, minimum in MIN_COMPOSITION.items():
        have = [p for p, _ in picks if p["kind"] == kind]
        for cid in _deterministic_order(cands, spares=True):
            if len(have) >= minimum:
                break
            c = by_id[cid]
            if c["kind"] != kind or any(p["id"] == cid for p, _ in picks):
                continue
            if kind != "category" and any(p["kind"] == kind and p["measure"] == c["measure"] for p, _ in picks):
                continue
            picks.append((c, ""))
            have.append(c)
    if not fids:
        cat = next((d for d in dims if d["kind"] == "category"), None)
        date = next((d for d in dims if d["kind"] == "date"), None)
        fids = [d["id"] for d in (cat, date) if d]
    # The date filter a viewer expects is the one the trend is drawn on.
    trend_axis = next((p["role"].get("timeField") for p, _ in picks if p["kind"] == "time"), None)
    axis_dim = next((d for d in dims if d["fieldKey"] == trend_axis), None)
    by_dim = {d["id"]: d for d in dims}
    if axis_dim:
        fids = [f for f in fids if by_dim.get(f, {}).get("kind") != "date"] + [axis_dim["id"]]
    # Every breakdown the page shows is filterable — that is what makes a click on its
    # bars a drill-down across the whole report. Bounded so the header stays readable.
    for p, _ in picks:
        if p["kind"] != "category":
            continue
        if sum(1 for f in fids if by_dim.get(f, {}).get("kind") == "category") >= MAX_CATEGORY_FILTERS:
            break
        d = next((x for x in dims if x["fieldKey"] == p["role"].get("dimension")), None)
        if d and d["id"] not in fids:
            fids.insert(0, d["id"])
    return picks, fids, name, source


# ── Step 2: design the page ───────────────────────────────────────────────────

def _design_call(prompt: str, images: Optional[List[str]], max_tokens: int, timeout: float) -> Optional[Dict[str, Any]]:
    from app.services.llm_client import LLMClient

    return LLMClient.complete_json_multimodal(
        prompt=prompt,
        system=("You are a senior product designer and front-end engineer. You build beautiful, app-like analytics "
                "report pages in HTML/CSS/JS that run inside the AppBI report sandbox. Reply with JSON only."),
        images=images or None, max_tokens=max_tokens, timeout=timeout)


def _pick_code(res: Any) -> Optional[Tuple[str, str, str, str, str]]:
    if not isinstance(res, dict):
        return None
    html, css, js = res.get("html"), res.get("css"), res.get("js")
    if not isinstance(html, str) or "data-rac-region" not in html:
        return None
    return html, css if isinstance(css, str) else "", js if isinstance(js, str) else "", \
        str(res.get("title") or "")[:160], str(res.get("summary") or "")[:400]


PRESERVE_RULES = """
THIS IS AN IMPORT OF THE AUTHOR'S OWN DESIGN. Keep it:
- Keep the reference's HTML structure, element order, class names and wording, and its CSS (copy the CSS into "css", fixing only what cannot work here).
- Replace every hard-coded business number with a binding (data-rac-value / data-rac-viz) of matching meaning; replace every chart-library
  canvas/script (Chart.js, ECharts, …) with a data-rac-viz element of the same kind and size, bound to matching data.
- Add data-rac-region + data-rac-label to each top-level section. Add controls for the declared filters where the design has a toolbar or header.
- Do NOT restyle, do NOT add a sidebar or new sections the reference does not have.
OUTPUT: one JSON object {"title": "...", "html": "...", "css": "...", "js": "...", "summary": "one sentence"}.
"""


def design_page(*, goal: str, name: str, bindings: List[Dict[str, Any]], decl: List[Dict[str, Any]],
                dtos: Dict[str, Dict[str, Any]], image: Optional[str] = None,
                reference: Optional[Tuple[str, str, str]] = None, preserve: bool = False) -> Optional[Tuple[str, str, str, str, str]]:
    brief = [_binding_brief(b, dtos.get(b["id"])) for b in bindings]
    parts = [
        f"REPORT REQUEST: {goal.strip()[:2000] or 'A clear executive report of this data.'}",
        f"REPORT NAME: {name}",
        "BINDINGS (governed data; every number on the page must come from these):\n" + json.dumps(brief, ensure_ascii=False, default=str),
        "ALLOWED BINDING IDS: " + ", ".join(b["id"] for b in bindings) +
        " — no other id exists. Use every binding at least once; a visual must match its binding's kind "
        "(kpi → kpi/gauge/value, time → line/area/heatmap/waterfall, category → bar/hbar/donut/table/progress).",
        "DECLARED FILTERS:\n" + json.dumps(B.public_filters(decl), ensure_ascii=False),
        SDK_REFERENCE,
    ]
    if preserve and reference:
        parts.append(PRESERVE_RULES)
    else:
        parts += [DESIGN_RULES, "STRUCTURE EXAMPLE (adapt freely, this is not a template to copy):" + SKELETON,
                  "DESIGN KIT — a polished starting stylesheet. Copy it into your css and ADAPT it to the request "
                  "(colours, density, typography, components); add rules for every new component you create (badges, gauges, "
                  "alert tables, chips, floating buttons, tabs…). Every class used in your HTML must be styled; the result should "
                  "look finished and professional, like a commercial SaaS analytics product:\n" + _template_css()]
    if reference:
        rh, rc, rj = reference
        parts.append("REFERENCE DESIGN (recreate its layout, components and visual style; replace every hard-coded number, "
                     "chart library call and fake data with the bindings above):\nHTML:\n" + rh[:24000] +
                     "\nCSS:\n" + rc[:12000] + ("\nJS (for behaviour only):\n" + rj[:6000] if rj else ""))
    if image:
        parts.append("A REFERENCE SCREENSHOT is attached: match its layout, density, colours and component style.")
    return _pick_code(_design_call("\n\n".join(parts), [image] if image else None, 12000, GENERATE_TIMEOUT_S))


def _template_css() -> str:
    _h, css, _j = template_page(name="R", goal="", bindings=[], decl=[])
    return css


# ── Deterministic template (no model / failed model) ──────────────────────────

def template_page(*, name: str, goal: str, bindings: List[Dict[str, Any]], decl: List[Dict[str, Any]]) -> Tuple[str, str, str]:
    esc = _html.escape
    kpis = [b for b in bindings if b.get("kind") == "kpi"]
    times = [b for b in bindings if b.get("kind") == "time"]
    cats = [b for b in bindings if b.get("kind") in ("category", "table")]
    nav = [("overview", "home", "Tổng quan")]
    if times:
        nav.append(("trend", "trend", "Xu hướng"))
    if cats:
        nav.append(("breakdown", "chart", "Phân tích"))
        nav.append(("detail", "table", "Chi tiết"))
    initials = "".join(w[0] for w in name.split()[:2]).upper() or "R"
    first = (kpis or times or cats or bindings or [{"id": ""}])[0]["id"]
    h = [f'<div class="app">',
         f'<aside class="side" data-rac-region="sidebar" data-rac-label="Điều hướng">',
         f'<div class="brand"><div class="logo">{esc(initials)}</div><div><b>{esc(name)}</b><small>AppBI Report</small></div></div>',
         '<button type="button" class="menu" aria-label="Menu"><span data-rac-icon="menu"></span></button><nav>']
    for i, (sid, icon, label) in enumerate(nav):
        active = ' class="active"' if i == 0 else ""
        h.append(f'<a href="#{sid}"{active}><span data-rac-icon="{icon}"></span>{esc(label)}</a>')
    h.append('</nav><div class="side-foot">Dữ liệu từ AppBI BI Core</div></aside><main class="main">')
    h.append('<header class="top" data-rac-region="header" data-rac-label="Tiêu đề & bộ lọc"><div class="title">'
             f'<h1>{esc(name)}</h1><p>{esc(goal.strip()[:220] or "Báo cáo được dựng từ semantic model của dataset.")}</p></div>'
             '<div class="filters">' + "".join(f'<div data-rac-filter="{esc(f["key"])}"></div>' for f in decl) + '</div>'
             f'<div class="chips" data-rac-filter-chips></div><div class="asof">Cập nhật: <span data-rac-asof="{esc(first)}"></span></div></header>')
    h.append('<section id="overview" class="grid kpis" data-rac-region="kpis" data-rac-label="Chỉ số chính">')
    for b in (kpis or times[:2])[:4]:
        h.append(f'<div class="card kpi"><div data-rac-viz="kpi" data-rac-bind="{esc(b["id"])}"></div></div>')
    h.append('</section>')
    if times:
        t0 = times[0]
        h.append('<section id="trend" class="grid two" data-rac-region="trend" data-rac-label="Xu hướng">'
                 f'<div class="card wide"><div class="card-h"><h3 data-rac-title="{esc(t0["id"])}"></h3><span class="hint">Theo thời gian</span></div>'
                 f'<div data-rac-viz="area" data-rac-bind="{esc(t0["id"])}" style="height:300px"></div></div>'
                 f'<div class="card"><div class="card-h"><h3>Bản đồ nhiệt theo tháng</h3><span class="hint">Năm × tháng</span></div>'
                 f'<div data-rac-viz="heatmap" data-rac-bind="{esc(t0["id"])}"></div></div>'
                 f'<div class="card"><div class="card-h"><h3>Biến động kỳ</h3><span class="hint">So với kỳ trước</span></div>'
                 f'<div data-rac-viz="waterfall" data-rac-bind="{esc((times[1] if len(times) > 1 else t0)["id"])}" data-rac-opts=\'{{"top":12}}\' style="height:260px"></div></div>'
                 '</section>')
    if cats:
        h.append('<section id="breakdown" class="grid three" data-rac-region="breakdown" data-rac-label="Phân tích">')
        kinds = ["hbar", "donut", "progress", "bar", "hbar"]
        for i, b in enumerate(cats[:5]):
            style = ' style="height:300px"' if kinds[i] == "bar" else ""
            h.append(f'<div class="card"><div class="card-h"><h3 data-rac-title="{esc(b["id"])}"></h3><span class="hint">Nhấp để lọc</span></div>'
                     f'<div data-rac-viz="{kinds[i]}" data-rac-bind="{esc(b["id"])}" data-rac-opts=\'{{"top":8}}\'{style}></div></div>')
        h.append('</section>')
        h.append(f'<section id="detail" data-rac-region="detail" data-rac-label="Chi tiết"><div class="card"><div class="card-h">'
                 f'<h3>Chi tiết — <span data-rac-title="{esc(cats[0]["id"])}"></span></h3></div>'
                 f'<div data-rac-viz="table" data-rac-bind="{esc(cats[0]["id"])}" data-rac-opts=\'{{"limit":15}}\'></div></div></section>')
    h.append('</main></div>')
    css = """
:root{--rac-accent:#4f46e5;--rac-bg:#f4f6fb}
.app{display:grid;grid-template-columns:248px minmax(0,1fr);min-height:100vh}
.side{position:sticky;top:0;height:100vh;background:linear-gradient(180deg,#111836,#1d1b4b);color:#c7d2fe;padding:22px 16px;display:flex;flex-direction:column;gap:22px}
.brand{display:flex;gap:12px;align-items:center;color:#fff}.brand small{display:block;color:#a5b4fc;font-size:11px}
.logo{width:38px;height:38px;border-radius:12px;background:linear-gradient(135deg,#818cf8,#22d3ee);display:grid;place-items:center;font-weight:800;color:#0b1020}
.side nav{display:flex;flex-direction:column;gap:4px}
.side nav a{display:flex;gap:10px;align-items:center;color:#c7d2fe;text-decoration:none;padding:10px 12px;border-radius:10px;font-size:14px}
.side nav a:hover{background:rgba(255,255,255,.06)}.side nav a.active{background:rgba(129,140,248,.22);color:#fff}
.side-foot{margin-top:auto;font-size:11px;color:#818cf8}.menu{display:none;background:none;border:0;color:#fff}
.main{padding:26px 30px 48px;display:flex;flex-direction:column;gap:22px;min-width:0}
.top{position:sticky;top:0;z-index:20;background:color-mix(in srgb,var(--rac-bg) 88%,transparent);backdrop-filter:blur(8px);padding:6px 0 10px;display:flex;flex-wrap:wrap;gap:12px 18px;align-items:center}
.top .title{flex:1 1 320px}.top h1{margin:0;font-size:24px;letter-spacing:-.02em}.top p{margin:4px 0 0;color:var(--rac-muted);font-size:13px}
.filters{display:flex;gap:8px;flex-wrap:wrap}.chips{flex-basis:100%}.asof{font-size:12px;color:var(--rac-muted)}
.grid{display:grid;gap:16px}.kpis{grid-template-columns:repeat(auto-fit,minmax(200px,1fr))}
.two{grid-template-columns:2fr 1fr}.two .wide{grid-column:1/-1}.three{grid-template-columns:repeat(auto-fit,minmax(300px,1fr))}
.card{background:var(--rac-surface);border:1px solid var(--rac-border);border-radius:16px;padding:18px;box-shadow:0 1px 2px rgba(15,23,42,.04),0 8px 24px rgba(15,23,42,.04);min-width:0}
.card.kpi{border-top:3px solid var(--rac-accent)}
.card-h{display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin-bottom:12px}.card-h h3{margin:0;font-size:15px}
.hint{font-size:12px;color:var(--rac-muted)}
@media (max-width:960px){.app{grid-template-columns:1fr}.side{position:sticky;height:auto;flex-direction:row;align-items:center;padding:12px 16px;z-index:30}
.side nav{flex-direction:row;overflow:auto}.side-foot{display:none}.side nav a{padding:8px 10px;white-space:nowrap}.two{grid-template-columns:1fr}.top{position:static}}
@media (max-width:640px){.main{padding:16px}.side nav{display:none}.side.open nav{display:flex;position:absolute;top:100%;left:0;right:0;flex-direction:column;background:#1d1b4b;padding:10px}
.menu{display:block;margin-left:auto}.kpis,.three{grid-template-columns:1fr}}
"""
    js = """
(function(){
  var links=[].slice.call(document.querySelectorAll('.side nav a'));
  var side=document.querySelector('.side'),menu=document.querySelector('.menu');
  if(menu)menu.addEventListener('click',function(){side.classList.toggle('open');});
  links.forEach(function(a){a.addEventListener('click',function(){side.classList.remove('open');});});
  var secs=links.map(function(a){return document.querySelector(a.getAttribute('href'));}).filter(Boolean);
  window.addEventListener('scroll',function(){
    var y=window.scrollY+120,cur=secs[0];
    secs.forEach(function(s){if(s.offsetTop<=y)cur=s;});
    links.forEach(function(a){a.classList.toggle('active',cur&&a.getAttribute('href')==='#'+cur.id);});
  },{passive:true});
})();
"""
    return "\n".join(h), css.strip(), js.strip()


# ── Generate / import ─────────────────────────────────────────────────────────

Progress = Callable[[str], None]


def generate(db: Session, *, dataset_id: int, goal: str, name: Optional[str], owner_id, progress: Progress,
             image: Optional[str] = None, reference_html: Optional[str] = None, preserve: bool = False) -> Dict[str, Any]:
    progress("Đọc semantic model")
    model = B.load_model(db, dataset_id)
    meta = B.field_meta(model)
    cands = B.candidates(model)
    dims = B.filter_dimensions(model, dataset_id)
    if not cands:
        raise ValueError("Semantic model của dataset chưa có measure nào để dựng báo cáo.")
    progress("Chọn dữ liệu theo yêu cầu")
    picks, fids, model_name, source = choose_data(db, goal=goal, model=model, cands=cands, dims=dims)
    report_name = (name or model_name or "Báo cáo AI").strip()[:200]
    progress("Chạy thử truy vấn qua BI Core")
    from app.services.report_starter_service import _deterministic_order

    pool = [c for c in (next((x for x in cands if x["id"] == i), None) for i in _deterministic_order(cands, spares=True)) if c]
    new_bindings, _mapping, notes = B.bind_candidates(db, picks, existing=[], owner_id=owner_id, dataset_id=dataset_id,
                                                      prefix=f"[Code] {report_name}", meta=meta, pool=pool, limits=LIMITS)
    if not new_bindings:
        raise ValueError("Không có truy vấn nào trả về số liệu — chưa thể dựng báo cáo.")
    decl = B.declare_filters(dims, fids)
    db.flush()
    dtos = _probe(db, new_bindings, decl)

    reference = None
    warnings: List[str] = []
    if reference_html:
        rh, rc, rj, w = D.split_document(reference_html)
        reference = (rh, rc, rj)
        warnings += w
    progress("AI đang thiết kế trang")
    designed = design_page(goal=goal, name=report_name, bindings=new_bindings, decl=decl, dtos=dtos,
                           image=image, reference=reference, preserve=preserve)
    if designed:
        html, css, js, title, summary = designed
        html, js, healed = heal_references(html, js, new_bindings)
        html, row_notes = S.check_rows(html, dtos, fix=True)
        warnings += healed + row_notes
        design_source = "ai"
    else:
        progress("AI không phản hồi — dùng mẫu thiết kế chuẩn")
        html, css, js = template_page(name=report_name, goal=goal, bindings=new_bindings, decl=decl)
        summary, design_source = "Mẫu thiết kế chuẩn (AI không phản hồi).", "template"
    return {"name": report_name, "html": html, "css": css, "js": js, "bindings": new_bindings, "filters": decl,
            "notes": notes + warnings, "summary": summary, "data_source": source, "design_source": design_source}


# ── Edit ──────────────────────────────────────────────────────────────────────

_PLACEHOLDER_RX = re.compile(r"@(c\d+)\b")
_FILTER_PLACEHOLDER_RX = re.compile(r"@(f\d+)\b")


def starter_page(name: str) -> Tuple[str, str, str]:
    """A commented starting point for authors who write the report themselves."""
    esc = _html.escape
    html = f"""<!-- Báo cáo do bạn tự viết. Dữ liệu: tab "Dữ liệu" → thêm nguồn → chèn snippet vào đây.
     Mọi con số lấy từ binding (data-rac-value / data-rac-viz) — không gõ số liệu bằng tay. -->
<div class="page">
  <header class="top" data-rac-region="header" data-rac-label="Tiêu đề">
    <h1>{esc(name)}</h1>
    <p>Mô tả ngắn về báo cáo.</p>
    <div class="filters"><!-- <div data-rac-filter="f1"></div> --></div>
  </header>
  <section class="kpis" data-rac-region="kpis" data-rac-label="Chỉ số chính">
    <!-- <div class="card"><div data-rac-viz="kpi" data-rac-bind="b1"></div></div> -->
    <div class="card empty">Thêm một nguồn dữ liệu KPI ở tab Dữ liệu rồi chèn vào đây.</div>
  </section>
  <section class="charts" data-rac-region="charts" data-rac-label="Biểu đồ">
    <!-- <div class="card"><h3 data-rac-title="b2"></h3><div data-rac-viz="line" data-rac-bind="b2" style="height:280px"></div></div> -->
  </section>
</div>"""
    css = """:root { --rac-accent: #0b57d0; }
.page { max-width: 1200px; margin: 0 auto; padding: 28px 24px 48px; }
.top h1 { margin: 0; font-size: 26px; letter-spacing: -.01em; }
.top p { margin: 4px 0 16px; color: var(--rac-muted); }
.filters { display: flex; flex-wrap: wrap; gap: 8px; }
.kpis, .charts { display: grid; gap: 16px; margin-top: 16px; grid-template-columns: repeat(auto-fit, minmax(min(100%, 240px), 1fr)); align-items: start; }
.card { background: var(--rac-surface); border: 1px solid var(--rac-border); border-radius: 14px; padding: 18px; }
.card.empty { color: var(--rac-muted); border-style: dashed; }
.card h3 { margin: 0 0 10px; font-size: 15px; }"""
    js = """// JavaScript tùy biến (không bắt buộc). Ví dụ:
// rac.bind('b1', function (dto) { console.log(dto.rows); });"""
    return html, css, js


def scope_css(css: str, region: str) -> str:
    """Prefix every selector of `css` with the region, so its rules apply inside it only.

    `:root`, `html` and `body` become the region itself; a selector already scoped to
    this region is kept; @media/@supports/@container/@layer blocks are scoped inside;
    @keyframes/@font-face are kept as they are (they style nothing by themselves)."""
    scope = f'[data-rac-region="{region}"]'
    out: List[str] = []
    i, n = 0, len(css)
    while i < n:
        j = css.find("{", i)
        if j < 0:
            break  # trailing text without a block is not a rule
        head = css[i:j].strip()
        depth, k = 1, j + 1
        while k < n and depth:
            depth += 1 if css[k] == "{" else -1 if css[k] == "}" else 0
            k += 1
        body = css[j + 1:k - 1]
        low = head.lower()
        if low.startswith(("@media", "@supports", "@container", "@layer")):
            out.append(f"{head} {{\n{scope_css(body, region)}\n}}")
        elif low.startswith("@"):
            out.append(f"{head} {{{body}}}")
        elif head:
            sels = []
            for sel in head.split(","):
                sel = sel.strip()
                if not sel:
                    continue
                if scope in sel:
                    sels.append(sel)
                elif re.match(r"^(:root|html|body)\b", sel):
                    sels.append(re.sub(r"^(:root|html|body)", scope, sel))
                else:
                    sels.append(f"{scope} {sel}")
            if sels:
                out.append(f"{', '.join(sels)} {{{body}}}")
        i = k
    return "\n".join(x for x in out if x.strip())


def edit(db: Session, *, artifact, revision, instruction: str, region: Optional[str], owner_id,
         progress: Progress, image: Optional[str] = None, allow_data: bool = False) -> Dict[str, Any]:
    bindings = list(revision.bindings or [])
    decl = list(revision.filters or [])
    html, css, js = revision.html, revision.css, revision.js
    cands: List[Dict[str, Any]] = []
    dims: List[Dict[str, Any]] = []
    meta: Dict[str, Dict[str, Any]] = {}
    if artifact.dataset_id:
        try:
            model = B.load_model(db, artifact.dataset_id)
            meta, cands, dims = B.field_meta(model), B.candidates(model), B.filter_dimensions(model, artifact.dataset_id)
        except ValueError:
            pass
    progress("Đọc báo cáo hiện tại")
    dtos = _probe(db, bindings, decl)
    brief = [_binding_brief(b, dtos.get(b["id"])) for b in bindings]
    data_door = ""
    if cands and allow_data:
        data_door = (
            "\nIF THE REQUEST NEEDS DATA THE BINDINGS DO NOT HAVE: pick candidates by id and reference them as @cN in the markup "
            "(e.g. data-rac-bind=\"@c12\"); list them in \"add_data\": [{\"id\":\"c12\",\"title\":\"...\"}]. They are run before they are kept.\n"
            f"CANDIDATES:\n{_candidate_listing(cands, 80)}\n"
            "New filters: reference as @fN and list in \"add_filters\": [\"f3\"]. FILTER DIMENSIONS:\n" + _dims_listing(dims))
    common = ("BINDINGS:\n" + json.dumps(brief, ensure_ascii=False, default=str) +
              "\nDECLARED FILTERS:\n" + json.dumps(B.public_filters(decl), ensure_ascii=False) + "\n" + SDK_REFERENCE + data_door)
    if region:
        current = D.region_markup(html, region)
        if current is None:
            raise ValueError(f"Không tìm thấy vùng '{region}'.")
        prompt = (
            f"EDIT ONE REGION of an AppBI report. REQUEST: {instruction.strip()[:2000]}\n\nREGION id=\"{region}\" (current markup):\n{current[:30000]}\n\n"
            f"REPORT CSS (context, do not repeat it):\n{css[:14000]}\n\nREPORT JS (context):\n{js[:8000]}\n\n{common}\n"
            "RULES: change ONLY this region. Keep data-rac-region=\"" + region + "\" on its root element. Never type business numbers. "
            "Write every UI text in the language the report already uses (Vietnamese by default); never leave placeholder or lorem text — "
            "a description says what the figure means in one short phrase. Keep headline numbers visually prominent. "
            "CSS for this change goes in css_add and must be scoped with [data-rac-region=\"" + region + "\"]. JS for this change goes in js_add (optional).\n"
            'Return JSON: {"html": "<the full new markup of this region>", "css_add": "", "js_add": "", "summary": "one sentence", "add_data": [], "add_filters": []}'
        )
    else:
        prompt = (
            f"EDIT AN AppBI REPORT PAGE. REQUEST: {instruction.strip()[:2000]}\n\nCURRENT HTML:\n{html[:40000]}\n\nCURRENT CSS:\n{css[:20000]}\n\n"
            f"CURRENT JS:\n{js[:12000]}\n\n{common}\n{DESIGN_RULES}\n"
            "SCOPE: change ONLY what the request asks for. Everything the request does not mention (layout, sections, other CSS rules, JS, bindings) must come back exactly as it is - do not add sections, cards, navigation or new metrics that were not asked for. Keep the data-rac-region ids. Return the complete page.\n"
            'Return JSON: {"html": "...", "css": "...", "js": "...", "summary": "one sentence", "add_data": [], "add_filters": []}'
        )
    progress("AI đang chỉnh sửa")
    res = _design_call(prompt, [image] if image else None, 12000 if not region else 8000, EDIT_TIMEOUT_S)
    if not isinstance(res, dict) or not isinstance(res.get("html"), str) or not res["html"].strip():
        raise ValueError("AI không trả về nội dung chỉnh sửa hợp lệ — thử diễn đạt lại yêu cầu.")

    notes: List[str] = []
    new_html = res["html"]
    css_out = css
    js_out = js
    if region:
        css_add = res.get("css_add") if isinstance(res.get("css_add"), str) else ""
        js_add = res.get("js_add") if isinstance(res.get("js_add"), str) else ""
        html_out = D.replace_region(html, region, new_html)
        if css_add.strip():
            # Scoped by the server, not by trust in the model: a region edit cannot
            # restyle another region or the page.
            css_out = (css.rstrip() + f"\n\n/* region:{region} */\n" + scope_css(css_add.strip(), region)).strip()
        if js_add.strip():
            # Script cannot be confined to one region (it reaches the whole DOM), so a
            # region edit never adds any; behaviour changes go through a page edit or the code.
            notes.append("AI đề xuất thêm JavaScript cho vùng này — không áp dụng vì JS không giới hạn được trong "
                         "một vùng. Sửa JS ở tab Mã nguồn hoặc yêu cầu AI sửa toàn trang.")
    else:
        html_out = new_html
        css_out = res.get("css") if isinstance(res.get("css"), str) else css
        js_out = res.get("js") if isinstance(res.get("js"), str) else js

    # New data through the governed door, then placeholders → binding ids.
    wanted = []
    for item in res.get("add_data") or []:
        if isinstance(item, dict) and isinstance(item.get("id"), str):
            wanted.append(item)
    referenced = set(_PLACEHOLDER_RX.findall(html_out + js_out))
    for cid in referenced:
        if not any(w["id"] == cid for w in wanted):
            wanted.append({"id": cid, "title": ""})
    mapping: Dict[str, str] = {}
    if wanted and cands and allow_data:
        progress("Chạy thử dữ liệu mới qua BI Core")
        by_id = {c["id"]: c for c in cands}
        picks = [(by_id[w["id"]], "" if re.search(r"\d", str(w.get("title") or "")) else str(w.get("title") or "")[:80])
                 for w in wanted if w["id"] in by_id]
        added, mapping, n2 = B.bind_candidates(db, picks, existing=bindings, owner_id=owner_id, dataset_id=artifact.dataset_id,
                                               prefix=f"[Code] {artifact.name}", meta=meta)
        bindings += added
        notes += n2
    for cid in referenced:
        if cid not in mapping:
            notes.append(f"Dữ liệu @{cid} không dùng được — đã bỏ khỏi báo cáo." if allow_data else f"AI muốn thêm dữ liệu @{cid} nhưng bạn chưa cho phép — không thêm.")
    html_out = _PLACEHOLDER_RX.sub(lambda m: mapping.get(m.group(1), "missing"), html_out)
    js_out = _PLACEHOLDER_RX.sub(lambda m: mapping.get(m.group(1), "missing"), js_out)
    html_out, js_out, healed = heal_references(html_out, js_out, bindings)
    notes += healed
    missing = [b for b in bindings if b["id"] not in dtos]
    if missing:
        dtos.update(_probe(db, missing, decl))
    html_out, row_notes = S.check_rows(html_out, dtos, fix=True)
    notes += row_notes

    fadd = [f for f in (res.get("add_filters") or []) if isinstance(f, str)]
    fref = set(_FILTER_PLACEHOLDER_RX.findall(html_out + js_out))
    fmap: Dict[str, str] = {}
    if (fadd or fref) and dims and allow_data:
        # Existing filter keys stay as they are; new dimensions are appended.
        by_dim = {d["id"]: d for d in dims}
        for fid in list(dict.fromkeys(list(fref) + fadd)):
            d = by_dim.get(fid)
            if not d:
                continue
            existing = next((f for f in decl if f["fieldKey"] == d["fieldKey"]), None)
            if existing:
                fmap[fid] = existing["key"]
                continue
            if len(decl) >= B.MAX_FILTERS:
                notes.append("Đã đạt giới hạn số bộ lọc.")
                break
            key = f"f{max([int(f['key'][1:]) for f in decl if f['key'][1:].isdigit()] + [0]) + 1}"
            decl.append({"key": key, "label": d["label"], "kind": d["kind"], "fieldKey": d["fieldKey"],
                         "field": d["field"], "datasetId": d["datasetId"]})
            fmap[fid] = key
    html_out = _FILTER_PLACEHOLDER_RX.sub(lambda m: fmap.get(m.group(1), "missing"), html_out)
    js_out = _FILTER_PLACEHOLDER_RX.sub(lambda m: fmap.get(m.group(1), "missing"), js_out)

    return {"html": html_out, "css": css_out, "js": js_out, "bindings": bindings, "filters": decl,
            "notes": notes, "summary": str(res.get("summary") or "")[:400]}


def import_html(db: Session, *, dataset_id: int, raw: str, goal: str, name: Optional[str], owner_id,
                progress: Progress) -> Dict[str, Any]:
    """An uploaded HTML report: keep its design, bind its numbers to governed data."""
    progress("Tách HTML / CSS / JS")
    rh, rc, rj, warnings = D.split_document(raw)
    out = generate(db, dataset_id=dataset_id, goal=goal or "Giữ nguyên thiết kế của file tải lên.", name=name,
                   owner_id=owner_id, progress=progress, reference_html=raw, preserve=True)
    out["notes"] = list(dict.fromkeys(warnings + out.get("notes", [])))
    if out.get("design_source") == "template":
        # No model: keep the author's own design as it was, unbound, and say so.
        out.update({"html": rh, "css": rc, "js": rj, "summary": "File được nhập nguyên trạng; AI chưa gắn số liệu."})
        out["notes"].append("AI không phản hồi: báo cáo giữ nguyên số liệu tĩnh của file — hãy dùng AI để gắn dữ liệu.")
    return out
