"""Bring outside HTML/CSS/JS into a governed report — keeping its design.

1. `analyze` finds what in the code is DATA: printed numbers, chart canvases/containers,
   tables, filter-like selects. Each slot gets its context (label / nearest heading) and
   a proposed candidate from the dataset's semantic model — chosen BY ID (model) or by
   keyword overlap (fallback). Nothing is applied yet: the author reviews the mapping.
2. `apply` runs every chosen candidate before keeping it (bindings.bind_candidates),
   then edits ONLY the spans that held data: a number token becomes a data-rac-value, a
   chart element becomes a data-rac-viz, a select becomes a data-rac-filter. Everything
   else in the author's markup, CSS and JS stays byte-for-byte.

Code written for AppBI (from the Context Pack) carries @cN / @fN placeholders instead;
it needs no mapping and goes through the same governed door.
"""
from __future__ import annotations

import json
import logging
import re
import unicodedata
from typing import Any, Dict, List, Optional, Tuple

from sqlalchemy.orm import Session

from app.services.report_code import bindings as B
from app.services.report_code import document as D

logger = logging.getLogger(__name__)

MAX_SLOTS = int(B._settings.REPORT_IMPORT_MAX_SLOTS)
_NUM_RX = re.compile(r"(?<![\w#.,-])[-+]?\d{1,3}(?:[.,\s]\d{3})+(?:[.,]\d+)?(?:\s?(?:tỷ|Tỷ|tr|Tr|triệu|N|K|M|B|%|₫|đ|VND|USD))?"
                     r"|(?<![\w#.,-])[-+]?\d+(?:[.,]\d+)?\s?(?:tỷ|Tỷ|tr|Tr|triệu|N|K|M|B|%|₫|đ|VND|USD)(?![\w])"
                     r"|(?<![\w#.,:/-])[-+]?\d{3,}(?:[.,]\d+)?(?![\w:/-])"
                     # a short decimal whose unit sits in the next element ("79,65" + <small>tỷ</small>)
                     r"|(?<![\w#.,:/-])[-+]?\d{1,2}[.,]\d{1,3}(?![\w:/.,-])")
_CHART_HINT = re.compile(r"chart|graph|plot|canvas|viz|sparkline", re.I)
_PLACEHOLDER = re.compile(r"@[cf]\d+\b")


def has_placeholders(html: str, js: str) -> bool:
    """Context-pack placeholders (`@c3`, `@f1`) still in the code: they must be bound."""
    return bool(_PLACEHOLDER.search((html or "") + (js or "")))
_LIB_STUBS = {
    "Chart": "var Chart = window.Chart || function () { return { destroy: function () {}, update: function () {} }; };",
    "echarts": "var echarts = window.echarts || { init: function () { return { setOption: function () {}, resize: function () {}, on: function () {} }; } };",
    "Highcharts": "var Highcharts = window.Highcharts || { chart: function () { return {}; }, setOptions: function () {} };",
    "ApexCharts": "var ApexCharts = window.ApexCharts || function () { return { render: function () {}, updateSeries: function () {} }; };",
    "Plotly": "var Plotly = window.Plotly || { newPlot: function () {}, react: function () {} };",
}


def _norm(s: str) -> str:
    s = unicodedata.normalize("NFD", (s or "").lower())
    s = "".join(ch for ch in s if unicodedata.category(ch) != "Mn").replace("đ", "d")
    return re.sub(r"[^a-z0-9 ]+", " ", s)


def _words(s: str) -> set:
    stop = {"cua", "va", "theo", "by", "the", "of", "so", "tong", "total", "and", "cac", "trong", "tren"}
    return {w for w in _norm(s).split() if len(w) > 1 and w not in stop}


class _Text(D._Scanner):
    """Tags (inherited) plus text nodes with offsets, outside script/style."""

    def __init__(self, text: str):
        super().__init__(text)
        self.texts: List[Tuple[int, str]] = []
        self._skip = 0

    def handle_starttag(self, tag, attrs):
        super().handle_starttag(tag, attrs)
        if tag in ("script", "style"):
            self._skip += 1

    def handle_endtag(self, tag):
        super().handle_endtag(tag)
        if tag in ("script", "style") and self._skip:
            self._skip -= 1

    def handle_data(self, data):
        if not self._skip and data.strip():
            self.texts.append((self._pos(), data))


def _scan(text: str) -> _Text:
    s = _Text(text)
    try:
        s.feed(text)
        s.close()
    except Exception:  # noqa: BLE001
        pass
    return s


def _plain(markup: str) -> str:
    import html as _h

    return re.sub(r"\s+", " ", _h.unescape(re.sub(r"<[^>]+>", " ", markup or ""))).strip()


def _heading_before(html: str, pos: int) -> str:
    window = html[max(0, pos - 900):pos]
    m = list(re.finditer(r"<(h[1-6]|strong|b|label|th|caption|[^>]*class=[\"'][^\"']*(?:title|label|name)[^\"']*[\"'])[^>]*>(.*?)</", window, re.I | re.S))
    return _plain(m[-1].group(2))[:80] if m else ""


def _sole_host(html: str, tags: List[D._Tag], pos: int, token: str) -> Optional[int]:
    """Index of the element whose ENTIRE text is this figure (`<b>12.345</b>`), if any:
    the binding then goes on that element, so the author's CSS styles it as before."""
    best = None
    for i, t in enumerate(tags):
        if t.kind != "start" or t.start >= pos or t.name in D._VOID or t.name in ("script", "style"):
            continue
        j = D._matching_end(tags, i)
        if j < 0 or tags[j].end <= pos:
            continue
        if best is None or t.start > tags[best].start:
            best = i
    if best is None:
        return None
    j = D._matching_end(tags, best)
    inner = html[tags[best].end:tags[j].start]
    return best if "<" not in inner and inner.strip() == token else None


_UNIT_ONLY = re.compile(r"(tỷ|Tỷ|tr|Tr|triệu|nghìn|K|N|M|B|%|₫|đ|VND|USD|điểm|điểm %)", re.I)


def _enclosing_label(html: str, tags: List[D._Tag], pos: int, token: str) -> str:
    """The text a reader sees next to a figure: the innermost element around it that
    says something besides the figure itself (a KPI tile's "Doanh thu")."""
    spans = []
    for i, t in enumerate(tags):
        if t.kind != "start" or t.start >= pos or t.name in D._VOID:
            continue
        j = D._matching_end(tags, i)
        if j >= 0 and tags[j].end > pos:
            spans.append((t.start, tags[j].end))
    for start, end in sorted(spans, key=lambda s: s[1] - s[0]):
        text = _plain(html[start:end]).replace(token, " ")
        text = re.sub(r"\s+", " ", _NUM_RX.sub(" ", text)).strip(" ·:-")
        if len(text) >= 2 and not _UNIT_ONLY.fullmatch(text):  # "2,18 <small>tr</small>": the unit is no label
            return text[:80]
        if end - start > 2000:
            break
    return ""


# ── Analyze ───────────────────────────────────────────────────────────────────

_PERIOD_RX = re.compile(r"\b(?:Tháng|Th\.?|T)\s?(0?[1-9]|1[0-2])\s?/\s?((?:19|20)\d{2})\b", re.I)
_LIST_MIN_ROWS = 2
#: never rows of a result: document plumbing, and the inside of an SVG drawing (a chart)
_NOT_LIST_TAGS = {"script", "style", "option", "head", "svg", "g", "text", "tspan", "circle", "rect", "line",
                  "path", "polyline", "polygon", "ellipse", "defs", "clippath", "lineargradient", "stop"}


def _class_sig(attrs: Dict[str, Any]) -> str:
    return " ".join(sorted(str(attrs.get("class") or "").split()))


def _children(tags) -> Dict[int, List[int]]:
    """parent start-tag index -> its direct child start-tag indexes (-1 = top level)."""
    out: Dict[int, List[int]] = {}
    stack: List[int] = []
    for i, t in enumerate(tags):
        if t.kind in ("start", "startend"):
            out.setdefault(stack[-1] if stack else -1, []).append(i)
            if t.kind == "start" and t.name not in D._VOID:
                stack.append(i)
        elif t.kind == "end":
            while stack and tags[stack[-1]].name != t.name:
                stack.pop()
            if stack:
                stack.pop()
    return out


def detect_lists(html: str, sc=None) -> List[Dict[str, Any]]:
    """Repeated sibling structures that hold numbers: table rows, list items, alert rows,
    matrix rows. One list slot = its rows (the FIRST is the template) and the text runs of
    that first row (its columns), so a mapping can say which run shows which field."""
    sc = sc or _scan(html)
    tags = sc.tags
    kids = _children(tags)
    found: List[Dict[str, Any]] = []
    for parent, members in kids.items():
        groups: Dict[Tuple[str, str], List[int]] = {}
        for i in members:
            t = tags[i]
            if t.kind != "start" or t.name in _NOT_LIST_TAGS:
                continue
            groups.setdefault((t.name, _class_sig(dict(t.attrs))), []).append(i)
        for (name, sig), idxs in groups.items():
            if len(idxs) < _LIST_MIN_ROWS:
                continue
            spans = []
            for i in idxs:
                j = D._matching_end(tags, i)
                if j < 0:
                    break
                spans.append((tags[i].start, tags[j].end, i))
            if len(spans) != len(idxs):
                continue
            texts = [[(p, d) for p, d in sc.texts if a <= p < b] for a, b, _ in spans]
            numeric = [any(_NUM_RX.search(d) for _, d in tx) for tx in texts]
            if sum(numeric) < _LIST_MIN_ROWS:
                continue
            # rows of ONE result share a shape: the same number of text runs, row after row
            lens = sorted(len(tx) for tx in texts)
            shape = lens[len(lens) // 2]
            if not shape or sum(abs(len(tx) - shape) <= 2 for tx in texts) < max(_LIST_MIN_ROWS, round(0.8 * len(texts))):
                continue
            first = texts[0]
            cols = [{"index": n, "sample": d.strip()[:60], "numeric": bool(_NUM_RX.search(d))}
                    for n, (_, d) in enumerate(first)]
            if not any(c["numeric"] for c in cols) or len(cols) > 24:
                continue
            found.append({"kind": "list", "start": spans[0][0], "end": spans[-1][1], "tag": name,
                          "rows": len(spans), "row_spans": [(a, b) for a, b, _ in spans], "template_tag": spans[0][2],
                          "row_tags": [i for _, _, i in spans],
                          "columns": cols, "context": (_heading_before(html, spans[0][0]) or sig or name)[:120],
                          "sample": " · ".join(c["sample"] for c in cols[:4])[:120]})
    # the OUTERMOST uniform structure wins: rows made of cells, not the cells of one row
    found.sort(key=lambda s: -(s["end"] - s["start"]))
    chosen: List[Dict[str, Any]] = []
    for s in found:
        if any(c["start"] <= s["start"] and s["end"] <= c["end"] for c in chosen):
            continue
        chosen.append(s)
    return sorted(chosen, key=lambda s: s["start"])


def detect_slots(html: str) -> List[Dict[str, Any]]:
    sc = _scan(html)
    tags = sc.tags
    slots: List[Dict[str, Any]] = []
    taken: List[Tuple[int, int]] = []

    def inside(a: int, b: int) -> bool:
        return any(x <= a and b <= y for x, y in taken)

    # repeated structures: rows of ONE result. They keep their table from being swapped for a
    # widget; the single values inside stay mappable too (a mapped list wins over them).
    lists = detect_lists(html, sc)
    slots.extend(lists)
    list_spans = [(ls["start"], ls["end"]) for ls in lists]

    for i, t in enumerate(tags):
        if t.kind not in ("start", "startend"):
            continue
        attrs = dict(t.attrs)
        if attrs.get("data-rac-viz") or attrs.get("data-rac-value"):
            continue
        is_canvas = t.name == "canvas"
        hint = _CHART_HINT.search(" ".join(str(attrs.get(k) or "") for k in ("id", "class")))
        if t.name == "table" or is_canvas or (hint and t.name in ("div", "section", "figure", "svg")):
            j = D._matching_end(tags, i) if t.kind == "start" else -1
            end = tags[j].end if j >= 0 else t.end
            if inside(t.start, end) or any(t.start <= x and y <= end for x, y in list_spans) \
                    or any(x <= t.start and end <= y for x, y in list_spans):
                continue
            inner = html[t.end:tags[j].start] if j >= 0 else ""
            if t.name in ("div", "section", "figure") and _plain(inner) and "<canvas" not in inner and "<svg" not in inner:
                continue  # a "chart-card" wrapper with text: its canvas/table is the slot
            kind = "table" if t.name == "table" else "chart"
            if kind == "table":
                ctx = " · ".join(re.findall(r"<th[^>]*>(.*?)</th>", inner, re.I | re.S)[:6])
                ctx = _plain(ctx) or _heading_before(html, t.start)
            else:
                ctx = _heading_before(html, t.start) or str(attrs.get("id") or attrs.get("aria-label") or "")
            height = attrs.get("height") or (re.search(r"height\s*:\s*(\d+)px", str(attrs.get("style") or "")) or [None, None])[1]
            slots.append({"kind": kind, "start": t.start, "end": end, "tag": t.name, "context": ctx[:120],
                          "sample": "", "height": int(height) if str(height or "").isdigit() else None,
                          "element_id": attrs.get("id")})
            taken.append((t.start, end))
        elif t.name == "select":
            j = D._matching_end(tags, i)
            end = tags[j].end if j >= 0 else t.end
            opts = [_plain(o) for o in re.findall(r"<option[^>]*>(.*?)</option>", html[t.end:end], re.I | re.S)][:12]
            label = _heading_before(html, t.start) or str(attrs.get("name") or attrs.get("id") or "")
            slots.append({"kind": "filter", "start": t.start, "end": end, "tag": "select", "context": label[:80],
                          "sample": ", ".join(opts[:5]), "options": opts, "element_id": attrs.get("id")})
            taken.append((t.start, end))

    for pos, data in sc.texts:
        if inside(pos, pos + len(data)):
            continue
        periods = list(_PERIOD_RX.finditer(data))
        for m in periods:
            slots.append({"kind": "period", "start": pos + m.start(), "end": pos + m.end(), "tag": "text",
                          "context": (_plain(data[:m.start()]) or _heading_before(html, pos))[:80], "sample": m.group(0)})
        spans_p = [(m.start(), m.end()) for m in periods]
        for m in _NUM_RX.finditer(data):
            if any(a <= m.start() < b for a, b in spans_p):
                continue
            tok = m.group(0).strip()
            if re.fullmatch(r"(19|20)\d{2}", tok):
                continue  # a year in a heading is not a figure
            a = pos + m.start() + (len(m.group(0)) - len(m.group(0).lstrip()))
            label = _plain(data[:m.start()])
            if not label or _UNIT_ONLY.fullmatch(label):
                label = _enclosing_label(html, tags, a, tok) or _heading_before(html, pos)
            slots.append({"kind": "value", "start": a, "end": a + len(tok), "tag": "text", "context": label[:80],
                          "sample": tok, "host": _sole_host(html, tags, a, tok)})
    slots.sort(key=lambda s: s["start"])
    # ids over EVERY slot: the review shows a budget of them (shown_slots), but apply still
    # sees all - a number past the budget is never left looking like governed data
    for n, s in enumerate(slots):
        s["id"] = f"s{n + 1}"
    return slots


def shown_slots(slots: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """The slots the author reviews: every list/period/filter, then single values up to the budget."""
    keep = [s for s in slots if s["kind"] in ("list", "period", "filter")]
    rest = [s for s in slots if s["kind"] not in ("list", "period", "filter")][:max(0, MAX_SLOTS - len(keep))]
    return sorted(keep + rest, key=lambda s: s["start"])


def _kinds_for(slot: Dict[str, Any]) -> Tuple[str, ...]:
    return {"value": ("kpi",), "chart": ("time", "category"), "table": ("category",)}.get(slot["kind"], ())


def _shares_meaning(slot: Dict[str, Any], cand: Dict[str, Any]) -> bool:
    """At least one word of what the slot SAYS is in the measure's name. Without it a pick
    is a guess, and a guessed number published looks exactly like a governed one."""
    sw = _words(slot.get("context", "")) | _words(slot.get("sample", "").rstrip("0123456789.,% "))
    cw = _words(cand.get("title", "")) | _words(cand.get("measure", "")) | _words(cand.get("dimension_label", "") or "")
    return bool(sw & cw)


def _score(slot: Dict[str, Any], cand: Dict[str, Any]) -> float:
    sw = _words(slot.get("context", "")) | _words(slot.get("sample", "").rstrip("0123456789.,% "))
    cw = _words(cand.get("title", "")) | _words(cand.get("measure", "")) | _words(cand.get("dimension_label", "") or "")
    if not sw or not cw:
        return 0.0
    s = len(sw & cw) / len(sw | cw)
    ctx = _norm(slot.get("context", ""))
    if slot["kind"] == "chart":
        timey = any(w in ctx for w in ("thang", "month", "xu huong", "trend", "theo ngay", "quy", "nam"))
        if timey and cand["kind"] == "time":
            s += 0.25
        if not timey and cand["kind"] == "category":
            s += 0.1
    if "%" in slot.get("sample", "") and ("%" in cand.get("title", "") or "ty le" in _norm(cand.get("title", ""))):
        s += 0.6  # a percent figure next to "Doanh thu" is the attainment, not the revenue
    return s


_MONEY_RX = re.compile(r"(R\$|US\$|\$|€|£|¥|₫|\bVND\b|\bUSD\b|\bBRL\b|\bđ\b)", re.I)
_COUNT_TYPES = {"count", "count_distinct", "countd", "distinct_count"}


def _is_money_slot(slot: Dict[str, Any]) -> bool:
    return bool(_MONEY_RX.search(str(slot.get("sample") or "")))


def compatible(slot: Dict[str, Any], cand: Dict[str, Any]) -> bool:
    """Does the candidate's UNIT fit what the slot prints? A money figure (R$ 16.0M,
    1.2 tỷ ₫) is never a count of things (orders, customers): binding it to one prints
    "R$ 96 N" — a real number under the wrong meaning. Judged from the semantic model's
    measure type, not from words."""
    mtype = str(cand.get("measure_type") or "").lower()
    if _is_money_slot(slot) and mtype in _COUNT_TYPES:
        return False
    return True


def _dims_score(slot: Dict[str, Any], dim: Dict[str, Any]) -> float:
    sw = _words(slot.get("context", "")) | _words(" ".join(slot.get("options") or []))
    dw = _words(dim.get("label", ""))
    return len(sw & dw) / len(dw) if dw else 0.0


def propose(slots: List[Dict[str, Any]], cands: List[Dict[str, Any]], dims: List[Dict[str, Any]], goal: str = "",
            stats: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """{slot id: {candidate, confidence, source}} and proposed filter dimensions."""
    out: Dict[str, Dict[str, Any]] = {}
    for s in slots:
        if s["kind"] == "filter":
            best = max(dims, key=lambda d: _dims_score(s, d), default=None)
            if best and _dims_score(s, best) > 0:
                out[s["id"]] = {"dimension": best["id"], "confidence": round(min(1.0, _dims_score(s, best)), 2), "source": "rules"}
            continue
        pool = [c for c in cands if c["kind"] in _kinds_for(s) and compatible(s, c)]
        best = max(pool, key=lambda c: (_score(s, c), -c.get("rank", 9)), default=None)
        # Rules propose only what shares meaning with the slot's own label; "nothing in
        # common" is left for the author (or the model) — never the first candidate.
        if best is not None and _score(s, best) > 0 and _shares_meaning(s, best):
            out[s["id"]] = {"candidate": best["id"], "confidence": round(min(1.0, _score(s, best)), 2), "source": "rules"}
    data_slots = [s for s in slots if s["kind"] in ("value", "chart", "table")]  # lists/periods map by rules
    # The model only for the places the rules are UNSURE about, and only with those places
    # and a short list of candidates each - never the whole page against the whole model
    # (every analyse used to send every slot and 160 candidates, certain or not).
    unsure = [s for s in slots if _unsettled(s, out)]
    if stats is not None:
        stats["ai_slots"] = len(unsure)
    if unsure and cands:
        try:
            from app.services.llm_client import LLMClient

            from app.services.report_code.generation import _dims_listing

            brief = [{"slot": s["id"], "kind": s["kind"], "context": s["context"], "sample": s["sample"]} for s in unsure]
            shortlist = {c["id"]: c for s in unsure if s["kind"] != "filter" for c in _shortlist(s, cands)}
            listing = "\n".join(f"{c['id']}: {c['type']} — {c['title']}" for c in shortlist.values())
            res = LLMClient.complete_json(
                prompt=(f"An HTML report is being connected to governed data. {('REPORT PURPOSE: ' + goal[:500]) if goal else ''}\n"
                        f"SLOTS found in the HTML (value = a printed number, chart = a chart element, table = a table, filter = a select). "
                        f"`context` is the label a reader sees next to the slot — map by THAT meaning, never by position:\n"
                        f"{json.dumps(brief, ensure_ascii=False)}\n\nCANDIDATE DATA (governed, by id):\n{listing}\n\n"
                        f"FILTER DIMENSIONS:\n{_dims_listing(dims)}\n\n"
                        "Map each slot to the candidate that MEANS the same thing (value → KPI, chart over time → TIME_SERIES, "
                        "chart/table by category → BAR). Map filter slots to a dimension id. Use null when nothing fits — never guess. "
                        'Return JSON {"map": [{"slot": "s1", "id": "c4"}], "filters": [{"slot": "s9", "id": "f2"}]}'),
                system="You map report elements to governed BI data. Reply with JSON only.", max_tokens=1500)
            known = {c["id"]: c for c in cands}
            known_dims = {d["id"] for d in dims}
            if isinstance(res, dict):
                for item in res.get("map") or []:
                    sid, cid = (item or {}).get("slot"), (item or {}).get("id")
                    slot = next((s for s in slots if s["id"] == sid), None)
                    if slot and cid in known and known[cid]["kind"] in _kinds_for(slot) and not compatible(slot, known[cid]):
                        # the model's pick has the wrong unit for what the slot prints
                        out.setdefault(sid, {"candidate": None, "confidence": 0.0, "source": "rules", "note": "unit_mismatch"})
                        continue
                    if slot and cid in known and known[cid]["kind"] in _kinds_for(slot):
                        # The model must agree with what the slot SAYS: a pick that shares no
                        # meaning with its own label loses to a rules pick that does.
                        rule = out.get(sid) or {}
                        model_s = _score(slot, known[cid])
                        rule_s = _score(slot, known[rule["candidate"]]) if rule.get("candidate") in known else 0.0
                        if rule_s >= 0.3 and model_s < rule_s * 0.5:
                            out[sid] = {**rule, "source": "rules", "note": "model_disagreed"}
                        elif not _shares_meaning(slot, known[cid]):
                            # "Tỷ lệ nghỉ việc 3,2%" is not "% đạt KH Doanh thu": leave it for the author
                            out[sid] = {"candidate": None, "confidence": 0.0, "source": "model", "note": "no_shared_meaning"}
                        else:
                            out[sid] = {"candidate": cid, "confidence": round(min(1.0, 0.55 + model_s), 2), "source": "model"}
                    elif slot and item and item.get("id") is None:
                        out[sid] = {"candidate": None, "confidence": 0.0, "source": "model"}
                for item in res.get("filters") or []:
                    sid, did = (item or {}).get("slot"), (item or {}).get("id")
                    if did in known_dims:
                        out[sid] = {"dimension": did, "confidence": 0.8, "source": "model"}
        except Exception:  # noqa: BLE001 - mapping falls back to the rules
            logger.warning("report-code: mapping by model failed", exc_info=True)
    return out


#: a rules pick this sure, sharing meaning with the slot's own label, needs no model
SETTLED_CONFIDENCE = 0.6
SHORTLIST = 8


def _unsettled(slot: Dict[str, Any], picks: Dict[str, Any]) -> bool:
    if slot["kind"] not in ("value", "chart", "table", "filter"):
        return False  # lists / periods map by rules only
    pick = picks.get(slot["id"]) or {}
    if slot["kind"] == "filter":
        return not pick.get("dimension")
    return not (pick.get("candidate") and float(pick.get("confidence") or 0) >= SETTLED_CONFIDENCE)


def _shortlist(slot: Dict[str, Any], cands: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """The candidates of the kind the slot can show, best by the rules' own score first."""
    pool = [c for c in cands if c["kind"] in _kinds_for(slot) and compatible(slot, c)] or \
           [c for c in cands if c["kind"] in _kinds_for(slot)]
    return sorted(pool, key=lambda c: (-_score(slot, c), c.get("rank", 9), c["id"]))[:SHORTLIST]


def _table_names(db: Session, ids: set) -> Dict[int, str]:
    from app.models.dataset import DatasetTable
    if not ids:
        return {}
    return {t.id: t.display_name for t in db.query(DatasetTable.id, DatasetTable.display_name).filter(DatasetTable.id.in_(ids))}


def _looks_like_months(options: List[str]) -> bool:
    return len(options) >= 2 and sum(bool(_PERIOD_RX.search(o or "")) for o in options) >= max(2, len(options) - 1)


def _first_text(slot: Dict[str, Any]) -> int:
    return next((n for n, c in enumerate(slot["columns"]) if not c["numeric"]), -1)


def _guess_list_dimension(slot: Dict[str, Any], dims: List[Dict[str, Any]]) -> Optional[str]:
    """The dimension whose name the list's heading or first label column speaks of."""
    words = _words(slot.get("context") or "")
    best, score = None, 0.0
    for d in dims:
        if d["kind"] == "date":
            continue
        dw = _words(d.get("label") or "")
        sc = len(words & dw) / (len(dw) or 1)
        if sc > score:
            best, score = d["id"], sc
    return best if score >= 0.99 else None  # every word of the dimension in the heading, or no guess


def analyze(db: Session, *, dataset_id: int, html: str, css: str, js: str, goal: str = "") -> Dict[str, Any]:
    html, css, js, warnings = normalize_sources(html, css, js)
    model = B.load_model(db, dataset_id)
    cands, dims = B.candidates(model), B.filter_dimensions(model, dataset_id)
    for c in cands:
        c["title"] = B._localize_title(c["title"])
    compatible = bool(_PLACEHOLDER.search(html + js)) or "data-rac-" in html
    slots = [] if compatible else shown_slots(detect_slots(html))
    stats: Dict[str, Any] = {"ai_slots": 0}
    proposals = propose(slots, cands, dims, goal, stats=stats) if slots else {}
    ai_slots = int(stats["ai_slots"])
    by_id = {c["id"]: c for c in cands}
    table_names = _table_names(db, {c.get("table") for c in cands if c.get("table")})
    view = []
    for s in slots:
        p = proposals.get(s["id"], {})
        row = {k: s[k] for k in ("id", "kind", "context", "sample") if k in s}
        if s["kind"] == "filter":
            row["dimension"] = p.get("dimension")
            row["period"] = _looks_like_months(s.get("options") or [])
            kinds = {d["id"]: d["kind"] for d in dims}
            if row["period"] and kinds.get(row["dimension"]) != "date":
                # a month picker IS the report period: the date dimension the period text uses,
                # never a text column that happens to hold "T08/2026"
                row["dimension"] = next((d["id"] for d in dims if d["kind"] == "date"), None)
        elif s["kind"] == "period":
            # the headline period: shown from the report's period filter, never typed in
            row["dimension"] = next((d["id"] for d in dims if d["kind"] == "date"), None)
        elif s["kind"] == "list":
            row["rows"] = s["rows"]
            row["columns"] = [{"index": c["index"], "sample": c["sample"], "numeric": c["numeric"]} for c in s["columns"]]
            row["dimension"] = _guess_list_dimension(s, dims)
            row["column_fields"] = {str(c["index"]): ("dim" if not c["numeric"] and n == _first_text(s) else None)
                                    for n, c in enumerate(s["columns"])}
        else:
            row["candidate"] = p.get("candidate")
            row["candidate_title"] = by_id[p["candidate"]]["title"] if p.get("candidate") in by_id else None
            row["viz"] = default_viz(s, by_id.get(p.get("candidate")), js)
        row["confidence"] = p.get("confidence", 0.0)
        row["source"] = p.get("source", "rules")
        view.append(row)
    return {
        "compatible": compatible, "slots": view, "warnings": warnings,
        # how many places the model was asked about (0 for a page written to the contract)
        "ai_slots": ai_slots,
        "placeholders": sorted(set(_PLACEHOLDER.findall(html + js))) if compatible else [],
        # `source` = the table a measure lives in: two tables can carry the same measure name
        # (group vs unit KPIs) and the picker must let the author tell them apart.
        "candidates": [{"id": c["id"], "kind": c["kind"], "type": c["type"], "title": c["title"],
                        "source": table_names.get(c.get("table"))}
                       for c in sorted(cands, key=lambda c: (c.get("rank", 9), c["id"]))[:300]],
        "dimensions": [{"id": d["id"], "label": d["label"], "kind": d["kind"]} for d in dims],
    }


def normalize_sources(html: str, css: str, js: str) -> Tuple[str, str, str, List[str]]:
    """A pasted full document is split; separately pasted parts are kept as they are."""
    warnings: List[str] = []
    if re.search(r"<html|<head|<body|<style|<script", html or "", re.I):
        h, c, j, warnings = D.split_document(html)
        css = "\n\n".join(x for x in (c, css or "") if x.strip())
        js = "\n\n".join(x for x in (j, js or "") if x.strip())
        html = h
    clean, w = D.sanitize_html(html or "")
    return clean, css or "", js or "", list(dict.fromkeys(warnings + w))


def default_viz(slot: Dict[str, Any], cand: Optional[Dict[str, Any]], js: str) -> Optional[str]:
    if slot["kind"] == "table":
        return "table"
    if slot["kind"] != "chart":
        return None
    near = js or ""
    if slot.get("element_id"):
        i = near.find(slot["element_id"])
        near = near[max(0, i - 200): i + 800] if i >= 0 else near
    m = re.search(r"type\s*:\s*['\"](line|bar|pie|doughnut|area|radar|horizontalBar)['\"]", near)
    if m:
        return {"pie": "donut", "doughnut": "donut", "horizontalBar": "hbar", "radar": "bar"}.get(m.group(1), m.group(1))
    return "line" if cand and cand["kind"] == "time" else "bar"


# ── Apply ─────────────────────────────────────────────────────────────────────

def apply(db: Session, *, dataset_id: int, html: str, css: str, js: str, mapping: List[Dict[str, Any]],
          filters: List[str], owner_id, report_name: str, existing: List[Dict[str, Any]],
          existing_filters: List[Dict[str, Any]], progress) -> Dict[str, Any]:
    html, css, js, warnings = normalize_sources(html, css, js)
    model = B.load_model(db, dataset_id)
    meta, cands, dims = B.field_meta(model), B.candidates(model), B.filter_dimensions(model, dataset_id)
    by_id = {c["id"]: c for c in cands}
    notes: List[str] = list(warnings)
    compatible = bool(_PLACEHOLDER.search(html + js)) or "data-rac-" in html
    decl = list(existing_filters)
    # The pasted code REPLACES the page: a binding it no longer references is an orphan,
    # never kept (it spent the binding room and pushed new data to "missing"). A binding
    # it references by id keeps that id; the others may be reused for the same data.
    previous, existing = list(existing), _referenced(existing, html, js)

    if compatible:
        progress("Mã đã tương thích AppBI — chạy dữ liệu qua BI Core")
        wanted = sorted(set(re.findall(r"@(c\d+)\b", html + js)), key=lambda x: int(x[1:]))
        picks = [(by_id[c], "") for c in wanted if c in by_id]
        notes += [f"@{c} không có trong semantic model hiện tại — đã bỏ." for c in wanted if c not in by_id]
        added, mapping_ids, n2 = B.bind_candidates(db, picks, existing=existing, owner_id=owner_id, dataset_id=dataset_id,
                                                   prefix=f"[Code] {report_name}", meta=meta, reuse=previous)
        notes += n2
        html = re.sub(r"@(c\d+)\b", lambda m: mapping_ids.get(m.group(1), "missing"), html)
        js = re.sub(r"@(c\d+)\b", lambda m: mapping_ids.get(m.group(1), "missing"), js)
        fids = sorted(set(re.findall(r"@(f\d+)\b", html + js)), key=lambda x: int(x[1:]))
        decl, fmap = _add_filters(decl, dims, fids)
        html = re.sub(r"@(f\d+)\b", lambda m: fmap.get(m.group(1), "missing"), html)
        js = re.sub(r"@(f\d+)\b", lambda m: fmap.get(m.group(1), "missing"), js)
        notes += _missing_notes(html, js)
        return _finish(db, {"html": _ensure_regions(html), "css": css, "js": js, "bindings": existing + added,
                            "filters": decl, "notes": notes, "ai_slots": 0})

    progress("Đọc các vị trí dữ liệu trong HTML")
    slots = {s["id"]: s for s in detect_slots(html)}
    chosen = [m for m in mapping if m.get("slot") in slots and slots[m["slot"]]["kind"] in ("value", "chart", "table")
              and m.get("candidate") in by_id]
    static = {m["slot"] for m in mapping if m.get("candidate") == "static"}  # the author: "this is not data"
    progress("Chạy thử truy vấn qua BI Core")
    picks, seen = [], set()
    for m in chosen:
        if m["candidate"] not in seen:
            seen.add(m["candidate"])
            picks.append((by_id[m["candidate"]], ""))
    lists = _list_plans(mapping, slots, by_id, dims, notes)
    for plan in lists.values():
        picks.append((plan["cand"], plan["cand"]["title"]))
        by_id[plan["cand"]["id"]] = plan["cand"]
    added, cmap, n2 = B.bind_candidates(db, picks, existing=existing, owner_id=owner_id, dataset_id=dataset_id,
                                        prefix=f"[Code] {report_name}", meta=meta, reuse=previous)
    notes += n2
    filter_slots = {m["slot"]: m.get("dimension") for m in mapping if m.get("slot") in slots and slots[m["slot"]]["kind"] == "filter" and m.get("dimension")}
    period_dims = {m.get("dimension") for m in mapping if m.get("slot") in slots and m.get("dimension") and (
        slots[m["slot"]]["kind"] == "period" or (slots[m["slot"]]["kind"] == "filter"
                                                and _looks_like_months(slots[m["slot"]].get("options") or [])))}
    period_slots = {m["slot"]: m["dimension"] for m in mapping if m.get("slot") in slots
                    and slots[m["slot"]]["kind"] == "period" and m.get("dimension")}
    decl, fmap = _add_filters(decl, dims, list(dict.fromkeys(list(filter_slots.values()) + list(period_slots.values())
                                                             + list(filters or []))))
    for f in decl:
        if any(fmap.get(d) == f["key"] for d in period_dims) and f.get("kind") == "date":
            f["grain"], f["default"] = "month", "latest"  # one period, shown by default = the newest month

    progress("Gắn dữ liệu vào đúng vị trí, giữ nguyên thiết kế")
    edits: List[Tuple[int, int, str]] = []
    tags = D._scan(html)
    for m in chosen:
        s, bid = slots[m["slot"]], cmap.get(m["candidate"])
        if not bid:
            notes.append(f"'{s['context'] or s['sample']}': dữ liệu không chạy được — giữ nguyên như bản gốc.")
            continue
        if s["kind"] == "value":
            host = s.get("host")
            o = num_opts(s["sample"], _text_after(html, tags, host, s["end"]))
            if host is not None:
                t = tags[host]
                extra = [("data-rac-opts", json.dumps(o, ensure_ascii=False))] if o else []
                edits.append((t.start, t.end, D._rebuild_start(t, list(t.attrs) + [("data-rac-value", bid)] + extra)))
                edits.append((s["start"], s["end"], ""))
            else:
                edits.append((s["start"], s["end"], f'<span data-rac-value="{bid}"{_opts_attr(o)}></span>'))
        else:
            viz = m.get("viz") or default_viz(s, by_id[m["candidate"]], js) or "bar"
            if viz not in _VIZ:
                viz = "bar"
            h = s.get("height") or (None if viz in ("table", "donut", "kpi", "progress", "heatmap") else 280)
            style = f' style="height:{h}px;width:100%"' if h else ""
            keep_id = f' id="{s["element_id"]}"' if s.get("element_id") else ""
            edits.append((s["start"], s["end"], f'<div{keep_id} data-rac-viz="{viz}" data-rac-bind="{bid}"{style}></div>'))
    for sid, plan in lists.items():
        bid = cmap.get(plan["cand"]["id"])
        if not bid:
            notes.append(f"Danh sách '{slots[sid]['context']}': dữ liệu không chạy được — giữ nguyên, đánh dấu số mẫu.")
            continue
        edits.append((slots[sid]["start"], slots[sid]["end"], _list_template(html, tags, slots[sid], plan, bid)))
        static.add(sid)
    for sid, did in period_slots.items():
        key = fmap.get(did)
        if key:
            s = slots[sid]
            edits.append((s["start"], s["end"], f'<span data-rac-filter-text="{key}"></span>'))
            static.add(sid)
    covered = [(slots[sid]["start"], slots[sid]["end"]) for sid in lists if cmap.get(lists[sid]["cand"]["id"])]
    edits = [e for e in edits if not any(a <= e[0] and e[1] <= b for a, b in covered)
             or any(e[0] == slots[sid]["start"] and e[1] == slots[sid]["end"] for sid in lists)]
    done = {m["slot"] for m in chosen} | static | set(filter_slots)
    for sid, s in slots.items():
        if sid in done or any(a <= s["start"] and s["end"] <= b for a, b in covered):
            continue
        if s["kind"] == "list" and any(m["slot"] in slots and s["start"] <= slots[m["slot"]]["start"] < s["end"]
                                       for m in chosen):
            continue  # its values were mapped one by one: the list itself is not a sample
        if s["kind"] == "value":
            edits.append((s["start"], s["end"], f'<span data-rac-sample>{html[s["start"]:s["end"]]}</span>'))
        elif s["kind"] == "list":
            for ti in s["row_tags"]:
                t = tags[ti]
                edits.append((t.start, t.end, D._rebuild_start(t, list(t.attrs) + [("data-rac-sample", None)])))
        elif s["kind"] in ("table", "chart"):
            t = next((x for x in tags if x.start == s["start"] and x.kind in ("start", "startend")), None)
            if t is not None:
                edits.append((t.start, t.end, D._rebuild_start(t, list(t.attrs) + [("data-rac-sample", None)])))
    for sid, did in filter_slots.items():
        key = fmap.get(did)
        if key:
            s = slots[sid]
            keep_id = f' id="{s["element_id"]}"' if s.get("element_id") else ""
            edits.append((s["start"], s["end"], f'<div{keep_id} data-rac-filter="{key}"></div>'))
    new_keys = [fmap[d] for d in (filters or []) if d in fmap and d not in filter_slots.values()]
    out, cursor = [], 0
    for start, end, repl in sorted(edits):
        if start < cursor:
            continue
        out.append(html[cursor:start])
        out.append(repl)
        cursor = end
    out.append(html[cursor:])
    html = "".join(out)
    if new_keys:
        bar = "".join(f'<div data-rac-filter="{k}"></div>' for k in new_keys)
        # floating, never IN the design's flow: a bar prepended to <body> became a flex item of
        # the author's layout and pushed their sidebar/grid sideways
        html = (f'<div class="rac-import-filters" data-rac-region="filters" data-rac-label="Bộ lọc" '
                f'style="position:fixed;top:8px;right:12px;z-index:2147483000;display:flex;flex-wrap:wrap;gap:8px;'
                f'align-items:center;max-width:calc(100vw - 24px);padding:6px 10px;background:rgba(255,255,255,.96);'
                f'border:1px solid #e5e7eb;border-radius:10px;box-shadow:0 4px 16px rgba(15,23,42,.10)">{bar}</div>') + html
    stubs = [code for lib, code in _LIB_STUBS.items() if re.search(r"\b" + lib + r"\b", js or "")]
    if stubs:
        js = "/* AppBI: chart libraries are not loaded — their charts were replaced by governed visuals. */\n" + "\n".join(stubs) + "\n" + js
        notes.append("Các thư viện biểu đồ ngoài (" + ", ".join(l for l in _LIB_STUBS if re.search(r"\b" + l + r"\b", js)) +
                     ") không được tải; biểu đồ của chúng đã được thay bằng biểu đồ gắn dữ liệu BI Core.")
    html = mark_loose_numbers(html)
    return _finish(db, {"html": _ensure_regions(html), "css": css, "js": js, "bindings": existing + added,
                        "filters": decl, "notes": notes})


_UNIT_SCALE = {"tỷ": 1e9, "ty": 1e9, "tr": 1e6, "triệu": 1e6, "nghìn": 1e3, "k": 1e3, "n": 1e3}


def num_opts(sample: str, after: str = "") -> Dict[str, Any]:
    """Format options that keep the design's look for a governed number: its unit (a scale
    and the unit text when written inside the figure), its decimals, its percent sign."""
    tok = (sample or "").strip()
    m = re.match(r"^[▲▼+−-]?\s*([-+]?[\d.,\s]+?)\s*(%|tỷ|Tỷ|tr|Tr|triệu|nghìn|K|N)?\s*$", tok)
    if not m:
        return {}
    digits, unit = m.group(1).strip(), (m.group(2) or "")
    dec = 0
    if "," in digits:  # vi-VN: comma = decimal separator
        dec = len(digits.rsplit(",", 1)[1])
    out: Dict[str, Any] = {"decimals": dec}
    if unit == "%":
        out["kind"] = "percent"
        return out
    following = re.match(r"^\s*(tỷ|Tỷ|tr|Tr|triệu|nghìn)\b", after or "")
    u = (unit or (following.group(1) if following else "")).lower()
    if u in _UNIT_SCALE:
        out["scale"] = _UNIT_SCALE[u]
        if unit:
            out["suffix"] = " " + unit  # the unit was part of the figure: keep it in the text
    else:
        out["compact"] = False
    return out


_GOVERNED_ATTRS = ("data-rac-value", "data-rac-cell", "data-rac-filter-text", "data-rac-sample", "data-rac-filter",
                   "data-rac-viz", "data-rac-filter-chips")
_LOOSE_RX = re.compile(r"[-+−]?\d+(?:[.,/:]\d+)*\s?%?")


def mark_loose_numbers(html: str) -> str:
    """The last pass of an import: every figure still on the page that neither the BI Core
    supplies nor a mark already covers ("88" on an org tree, "T07/26", "13 dòng") is marked as
    a sample. Detection heuristics may miss a figure; this pass may not."""
    sc = _scan(html)
    tags = sc.tags
    covered: List[Tuple[int, int]] = []
    for i, t in enumerate(tags):
        if t.kind != "start" or not any(k in _GOVERNED_ATTRS for k, _ in t.attrs):
            continue
        j = D._matching_end(tags, i)
        covered.append((t.start, tags[j].end if j >= 0 else t.end))
    edits: List[Tuple[int, int, str]] = []
    for pos, data in sc.texts:
        if any(a <= pos < b for a, b in covered):
            continue
        for m in _LOOSE_RX.finditer(data):
            tok = m.group(0).rstrip()
            if re.fullmatch(r"(19|20)\d{2}", tok):
                continue  # a year in a heading is not a figure (as in detect_slots)
            a = pos + m.start()
            edits.append((a, a + len(tok), f"<span data-rac-sample>{tok}</span>"))
    out, cur = [], 0
    for a, b, rep in edits:
        out.append(html[cur:a])
        out.append(rep)
        cur = b
    out.append(html[cur:])
    return "".join(out)


def _text_after(html: str, tags, host: Optional[int], end: int) -> str:
    """The words a reader sees right after a figure: after its own element when it is the
    element's whole text ("<b>79,65</b><small>tỷ</small>"), else after the figure itself."""
    if host is not None:
        j = D._matching_end(tags, host)
        end = tags[j].end if j >= 0 else tags[host].end
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", html[end:end + 200])).strip()[:40]


def _opts_attr(o: Dict[str, Any]) -> str:
    return f" data-rac-opts='{json.dumps(o, ensure_ascii=False)}'" if o else ""


def _list_plans(mapping, slots, by_id, dims, notes) -> Dict[str, Dict[str, Any]]:
    """One governed result per mapped list: the row dimension + the measure of each column."""
    by_dim = {d["id"]: d for d in dims}
    out: Dict[str, Dict[str, Any]] = {}
    for m in mapping:
        sid = m.get("slot")
        s = slots.get(sid)
        if not s or s["kind"] != "list":
            continue
        d = by_dim.get(m.get("dimension"))
        cols = {str(k): v for k, v in (m.get("columns") or {}).items() if v}
        measures = [v for v in cols.values() if v in by_id and by_id[v]["kind"] == "kpi"]
        if not d or not measures:
            if cols:
                notes.append(f"Danh sách '{s['context']}': cần một chiều dữ liệu cho dòng và ít nhất một chỉ số.")
            continue
        metrics, key_of = [], {}
        for cid in measures:
            met = by_id[cid]["role"]["metrics"][0]
            if met not in metrics:
                metrics.append(met)
            key_of[cid] = f"m{metrics.index(met)}"
        first = by_id[measures[0]]
        cand = {"id": f"L{sid}", "kind": "category", "type": "BAR", "table": first["table"],
                "role": {"metrics": metrics, "dimension": d["fieldKey"]},
                "title": (s.get("context") or "Danh sách")[:80]}
        fields = {}
        for k, v in cols.items():
            fields[k] = "d0" if v == "dim" else "#" if v == "#" else key_of.get(v) if v in key_of else None
        out[sid] = {"cand": cand, "fields": fields}
    return out


def _list_template(html: str, tags, slot: Dict[str, Any], plan: Dict[str, Any], bid: str) -> str:
    """The FIRST row, kept as the author wrote it, as the repeat template: each mapped text
    run becomes a cell, an empty bar (inline width %) becomes a data bar; the other rows go."""
    a, b = slot["row_spans"][0]
    sc = _scan(html[a:b])
    edits = []
    for n, (pos, data) in enumerate(sc.texts):
        f = plan["fields"].get(str(n))
        lead = len(data) - len(data.lstrip())
        if f:
            o = num_opts(data.strip()) if f.startswith("m") else {}
            edits.append((pos + lead, pos + len(data.rstrip()), f'<span data-rac-cell="{f}"{_opts_attr(o)}></span>'))
        elif re.search(r"\d", data):
            # a figure no column was mapped to would repeat on EVERY row: it stays a labelled sample
            edits.append((pos + lead, pos + len(data.rstrip()), f'<span data-rac-sample>{data.strip()}</span>'))
    first_measure = next((f for f in plan["fields"].values() if f and f.startswith("m")), None)
    for i, t in enumerate(sc.tags):
        style = str(dict(t.attrs).get("style") or "")
        if first_measure and t.kind == "start" and re.search(r"(^|;)\s*width\s*:\s*[\d.]+%", style):
            j = D._matching_end(sc.tags, i)
            if j >= 0 and not _plain(html[a + t.end:a + sc.tags[j].start]):
                attrs = [(k, v) for k, v in t.attrs if k != "style"]
                rest = re.sub(r"(^|;)\s*width\s*:\s*[\d.]+%\s*;?", r"\1", style).strip("; ")
                if rest:
                    attrs.append(("style", rest))
                edits.append((t.start, t.end, D._rebuild_start(t, attrs + [("data-rac-bar", first_measure)])))
    seg = html[a:b]
    out, cur = [], 0
    for s0, e0, rep in sorted(edits):
        if s0 < cur:
            continue
        out.append(seg[cur:s0])
        out.append(rep)
        cur = e0
    out.append(seg[cur:])
    seg = "".join(out)
    first_tag = _scan(seg).tags[0]
    seg = D._rebuild_start(first_tag, list(first_tag.attrs) + [("data-rac-repeat", bid)]) + seg[first_tag.end:]
    return seg


_VIZ = {"kpi", "bar", "column", "hbar", "line", "area", "donut", "pie", "table", "heatmap", "gauge", "waterfall", "progress", "sparkline"}


def _finish(db: Session, out: Dict[str, Any]) -> Dict[str, Any]:
    """The certain fixes, then ONE readiness report of the result (no model involved)."""
    from types import SimpleNamespace

    from app.services.report_code import readiness as R
    from app.services.report_code import semantics as S

    dtos = None
    if db is not None and out["bindings"]:
        try:
            from app.services.report_code.generation import _probe

            dtos = _probe(db, out["bindings"], out["filters"])
        except Exception:  # noqa: BLE001 - a fix the data cannot inform is skipped, never invented
            logger.warning("report-code: probing the imported bindings failed", exc_info=True)
    if dtos:
        out["html"], fixed = S.check_rows(out["html"], dtos, fix=True)
        out["notes"] = list(out["notes"]) + [f"Đã tự sửa: {n}" for n in fixed]
    rep = R.report(SimpleNamespace(**out), dtos=dtos, with_origin=False)
    out["readiness"] = {"ready": rep["ready"], "counts": rep["counts"]}
    if rep["blocking"]:
        out["notes"] = [R.blocking_message(rep).replace("Chưa xuất bản được", "Cần xử lý trước khi xuất bản")] + list(out["notes"])
    return out


def _referenced(bindings: List[Dict[str, Any]], html: str, js: str) -> List[Dict[str, Any]]:
    from app.services.report_code import lifecycle as L

    refs = set(L._refs((html or "") + "\n" + (js or "")))
    return [b for b in bindings if isinstance(b, dict) and b.get("id") in refs]


_MISSING_RX = re.compile(r"data-rac-[a-z-]+=[\"']missing[\"']|rac\.\w+\(\s*[\"']missing[\"']")


def _missing_notes(html: str, js: str) -> List[str]:
    n = len(_MISSING_RX.findall((html or "") + (js or "")))
    return [f"{n} vị trí chưa gắn được dữ liệu, cần gắn tay (tab Dữ liệu) — báo cáo chưa xuất bản được cho đến khi gắn lại."] if n else []


def _add_filters(decl: List[Dict[str, Any]], dims: List[Dict[str, Any]], dim_ids: List[str]) -> Tuple[List[Dict[str, Any]], Dict[str, str]]:
    decl = list(decl)
    by_dim = {d["id"]: d for d in dims}
    fmap: Dict[str, str] = {}
    for did in dim_ids:
        d = by_dim.get(did)
        if not d:
            continue
        hit = next((f for f in decl if f["fieldKey"] == d["fieldKey"]), None)
        if hit:
            fmap[did] = hit["key"]
            continue
        if len(decl) >= B.MAX_FILTERS:
            break
        key = f"f{max([int(f['key'][1:]) for f in decl if f['key'][1:].isdigit()] + [0]) + 1}"
        decl.append({"key": key, "label": d["label"], "kind": d["kind"], "fieldKey": d["fieldKey"], "field": d["field"], "datasetId": d["datasetId"]})
        fmap[did] = key
    return decl, fmap


def _ensure_regions(html: str) -> str:
    """Give each top-level element a region id (attribute only) so it can be edited alone."""
    tags = D._scan(html)
    depth, edits, n = 0, [], 0
    for i, t in enumerate(tags):
        if t.kind == "end":
            depth = max(0, depth - 1)
            continue
        if depth == 0 and t.name not in ("script", "style", "br", "hr") and "data-rac-region" not in dict(t.attrs):
            n += 1
            head = next((m for m in re.finditer(r"<h[1-4][^>]*>(.*?)</h[1-4]>", html[t.end:t.end + 4000], re.I | re.S)), None)
            label = _plain(head.group(1))[:60] if head else f"Phần {n}"
            edits.append((t.start, t.end, D._rebuild_start(t, list(t.attrs) + [("data-rac-region", f"section-{n}"), ("data-rac-label", label)])))
        if t.kind == "start" and t.name not in D._VOID:
            depth += 1
    out, cursor = [], 0
    for start, end, repl in edits:
        out.append(html[cursor:start])
        out.append(repl)
        cursor = end
    out.append(html[cursor:])
    return "".join(out)


# ── AI Design Context Pack ────────────────────────────────────────────────────

def _pack_rows(cands: List[Dict[str, Any]], meta: Dict[str, Dict[str, Any]]) -> List[Dict[str, Any]]:
    """One row per candidate as an outside AI must see it: a meaning that is UNIQUE in the
    pack (two date axes and a text "month" column used to give three identical titles),
    the shape of the rows it returns and the field keys a page addresses."""
    out = []
    for c in sorted(cands, key=lambda c: (c.get("rank", 9), c["id"]))[:200]:
        mref = c["role"]["metrics"][0]["field"]
        m = meta.get(mref, {})
        fmt = (m.get("format") or {}).get("kind", "number")
        measure = m.get("label") or c.get("measure") or B._localize_title(c["title"])
        axis_ref = c["role"].get("timeField") or c["role"].get("dimension")
        axis = (meta.get(axis_ref) or {}).get("label", "") if axis_ref else ""
        if c["kind"] == "kpi":
            meaning, rows, fields = f"{measure} — one total for the whole filtered scope", "1 row", "`m0`"
        elif c["kind"] == "time":
            meaning = f"{measure} per month of «{axis}»"
            rows, fields = "1 row per month, oldest → newest", "`d0` month (date) · `m0`"
        else:
            meaning = f"{measure} by «{axis}» — Top 10"
            rows, fields = "≤ 10 rows, largest `m0` first", "`d0` text · `m0`"
        out.append({"id": c["id"], "kind": c["kind"], "meaning": meaning, "rows": rows, "fields": fields,
                    "aggregation": m.get("aggregation") or "", "format": fmt})
    return out


def context_pack(db: Session, *, dataset_id: int, dataset_name: str) -> str:
    """Everything an outside AI needs to write an AppBI-compatible report — and nothing
    else: no data values, no SQL, no table/view/column names, no ids of the platform.

    Every rule written here is what the platform actually does (runtime.js, readiness.py,
    bindings.MAX_*): a pack that promises a feature the runtime lacks (`data-rac-cell` by
    column LABEL, a 25-row list from a Top-10 candidate) produced pages that looked right
    in the AI's head and showed "—" in AppBI.
    """
    model = B.load_model(db, dataset_id)
    cands, dims = B.candidates(model), B.filter_dimensions(model, dataset_id)
    meta = B.field_meta(model)
    prow = _pack_rows(cands, meta)
    rows = [f"| `@{r['id']}` | {r['kind']} | {r['meaning']} | {r['rows']} | {r['fields']} | {r['aggregation']} | {r['format']} |"
            for r in prow]
    drows = [f"| `@{d['id']}` | {d['kind']} | {d['label']} | "
             + ("date range picker (from – to)" if d["kind"] == "date" else "multi-select list of the column's values") + " |"
             for d in dims]
    k1 = next((c["id"] for c in cands if c["kind"] == "kpi"), "c1")
    kt = next((c["id"] for c in cands if c["kind"] == "time"), k1)
    kc = next((c["id"] for c in cands if c["kind"] == "category"), kt)
    f1 = dims[0]["id"] if dims else "f1"
    fd = next((d["id"] for d in dims if d["kind"] == "date"), f1)
    L = B.MAX_BINDINGS
    return "\n".join([
        f"# AppBI AI Design Context Pack — {dataset_name}",
        "",
        "You are writing ONE report page (HTML + CSS + JS) that AppBI connects to its governed data.",
        "Paste the result into AppBI › AI Vibe Report › *Dán mã*. AppBI runs every placeholder through its",
        "BI Core — the semantic model, the viewer's permissions, the link's locked filters — so the numbers",
        "on screen are the Dataset's real, current figures. The page itself never holds or fetches data.",
        "",
        "Read the brief in this order: what is yours (§1), the data contract (§2), the data you may use (§3–4),",
        "how to put data on the page (§5), the sandbox (§6), the JS SDK (§7), formatting (§8), what AppBI",
        "checks (§9), hard limits (§10), then run the checklist (§11). Write the page's words in the language",
        "of the labels below.",
        "",
        "## 1. What is yours — design freely",
        "- Layout, typography, colours, spacing, icons drawn in CSS/SVG, animation, dark mode, responsive behaviour.",
        "- Any HTML structure, any CSS (grid, flex, custom properties, keyframes, media queries, container queries).",
        "- Any JavaScript for the page's behaviour: tabs, accordions, menus, scroll effects, sorting a table the user",
        "  clicks, your own charts drawn on SVG/canvas FROM the dto rows `rac.bind` hands you (§7).",
        "- Words: titles, section intros, explanations of what a section shows — never a sentence that states a figure.",
        "- AppBI's own visuals and controls follow your theme through CSS variables (§8): set them, do not fight them.",
        "",
        "## 2. The data contract — the only rules that are not negotiable",
        "Every business figure (a number, a total, a percentage, a ranking, a trend, a date range of the data)",
        "comes from AppBI at run time, through a placeholder from §3/§4. Concretely:",
        f"- A headline number: `<b data-rac-value=\"@{k1}\"></b>` — leave the element EMPTY; AppBI fills it, formatted.",
        f"- A visual: `<div data-rac-viz=\"bar\" data-rac-bind=\"@{kc}\" style=\"height:280px\"></div>` (kinds in §5.2).",
        f"- A list / your own table: one template row `<tr data-rac-repeat=\"@{kc}\">` with `<td data-rac-cell=\"d0\"></td>`",
        "  `<td data-rac-cell=\"m0\"></td>` — AppBI clones it once per row (§5.3). Cells take FIELD KEYS, not labels.",
        f"- A viewer filter: `<div data-rac-filter=\"@{f1}\"></div>` (AppBI draws the control) and",
        "  `<div data-rac-filter-chips></div>` for the active filters.",
        f"- In JS: `rac.bind('@{kt}', function (dto) {{ … dto.rows, dto.fields … }})` — draw from `dto`, nothing else.",
        "",
        "**Never** (AppBI flags each of these; the ones marked ⛔ block publishing until fixed):",
        "- type a figure into the markup or the script (`<b>12.345</b>`, `const data = [120, 98, …]`, `labels: ['T1', …]`);",
        "- ship sample / mock / demo data, or a sentence that states a figure or the data's date",
        "  (\"Doanh thu tăng 12%\", \"Dữ liệu tĩnh, tính tới 24/08\") — the data is live and filterable;",
        "- add up, average or compare rows in JS to make a new total or a period change — ask for the candidate",
        "  that already IS that figure (§3); if none exists, leave the place out;",
        "- invent a placeholder ⛔: use only `@c…` / `@f…` from §3/§4, exactly as written — never `b1`, `f1`, `c1`",
        "  without `@`, a column name, or `missing`;",
        "- load anything: no `<script src>`, `<link>`, `<iframe>`, web fonts, images from the web, CDN chart",
        "  libraries, fetch/XHR (§6).",
        "",
        "## 3. Data you may use (governed candidates — meanings, not values)",
        "Each placeholder is one query AppBI runs. The *Rows* and *Fields* columns are exactly what `dto.rows`",
        "holds: `d0` is the breakdown value, `m0` the measure. Pick by *Meaning*; two meanings are never the same.",
        "",
        "| Placeholder | Kind | Meaning | Rows | Fields | Aggregation | Format |",
        "|---|---|---|---|---|---|---|",
        *rows,
        "",
        "- **kpi** — the one number for the whole page scope. Use it for every total / headline.",
        "- **time** — a monthly series. Its headline (`data-rac-value`) is the LATEST month, not a total.",
        "- **category** — the 10 largest values of a breakdown. It is never the full list: do not promise",
        "  \"all\" items, do not ask for more rows (`limit` only shortens), do not compute shares of a total from it.",
        "- Format `percent` means the value is a ratio that AppBI shows ×100 — never multiply it yourself.",
        "",
        "## 4. Filters a viewer may use",
        "| Placeholder | Kind | Label | Control AppBI draws |",
        "|---|---|---|---|",
        *drows,
        "",
        f"A filter applies to every placeholder on the page. At most {B.MAX_FILTERS} filters per page; a list control",
        f"offers at most {B.MAX_FILTER_VALUES} values (searchable). A link can lock a filter for its viewers: the page must",
        "work whatever is selected, including an empty result.",
        "",
        "## 5. Putting data on the page — recipes",
        "### 5.1 Numbers",
        "```html",
        f"<b data-rac-value=\"@{k1}\"></b>                                   <!-- the kpi total -->",
        f"<b data-rac-value=\"@{kt}\"></b>                                   <!-- a time series: its latest month -->",
        f"<b data-rac-value=\"@{kc}\" data-rac-rank=\"0\"></b>                <!-- row 1 (0-based) of a breakdown: its m0 -->",
        f"<span data-rac-value=\"@{kc}\" data-rac-rank=\"0\" data-rac-field=\"d0\"></span>  <!-- row 1's label -->",
        f"<span data-rac-title=\"@{k1}\"></span>  <span data-rac-asof=\"@{k1}\"></span>  <!-- title / data timestamp -->",
        f"<span data-rac-filter-text=\"@{fd}\" data-rac-opts='{{\"prefix\":\"Kỳ: \",\"empty\":\"Tất cả\"}}'></span>  <!-- current selection as text -->",
        "```",
        "- A bare `data-rac-value` on a **category** placeholder shows `—` (many rows, no single value): add",
        "  `data-rac-rank` or use the kpi candidate. `data-rac-row=\"<value>\"` also exists, but you do not know the",
        "  data's values — prefer `data-rac-rank` or a repeat (§5.3).",
        "- Values arrive formatted WITH their unit (%, compact Tr/N/Tỷ, currency): never write a unit next to them.",
        "",
        "### 5.2 AppBI visuals (`data-rac-viz` + `data-rac-bind`, options in `data-rac-opts` as JSON)",
        "| Kind | Use with | Options |",
        "|---|---|---|",
        "| `kpi` | kpi, time | `label`, `goal:'up'/'down'` (colours the change), `compare:'none'`, `sparkline:false` |",
        "| `line` / `area` | time | `color`; needs a CSS height |",
        "| `bar` (= `column`) / `hbar` | category, time | `top` (≤ rows returned), `color`; bar needs a CSS height |",
        "| `donut` (= `pie`) | category | `top` |",
        "| `table` | any | `limit` (default 50), `bars:false`; headers sort on click |",
        "| `heatmap` | time (year × month) | — |",
        "| `gauge` | kpi | `max`, `target` — a target you type is YOUR number: AppBI labels it as such |",
        "| `progress` | category | `top` |",
        "| `sparkline` | time | `color`, `height` |",
        "| `waterfall` | time (period-over-period change), category | `top` |",
        "",
        "A `kpi` on a **time** placeholder shows ▲/▼ % between the two latest months, labelled \"tính trong báo cáo\"",
        "(a report calculation, not an official metric) and skipped for an incomplete month. Never type a %, delta",
        "or target yourself. Clicking a bar, slice or table row cross-filters the page when its breakdown is also",
        "a filter in §4.",
        "",
        "### 5.3 Your own list or table (repeat)",
        "```html",
        "<table class=\"my-table\"><thead><tr><th>#</th><th>Tên</th><th>Giá trị</th></tr></thead><tbody>",
        f"  <tr data-rac-repeat=\"@{kc}\" data-rac-opts='{{\"limit\":5}}'>",
        "    <td data-rac-cell=\"#\"></td>        <!-- 1, 2, 3 … -->",
        "    <td data-rac-cell=\"d0\"></td>       <!-- the breakdown value -->",
        "    <td data-rac-cell=\"m0\"></td>       <!-- the measure, formatted -->",
        "    <td><i data-rac-bar=\"m0\"></i></td> <!-- AppBI sets width: 0–100 % of the largest row -->",
        "  </tr></tbody></table>",
        "```",
        "- `data-rac-cell` takes ONLY `#`, `d0`/`d`, `m0`/`m` — a column label or any other key renders `—`.",
        "- Repeat options: `limit`, `sort` (`\"m0\"` ascending, `\"-m0\"` descending), `empty` (text when no row),",
        "  `cutNote:false` (hide AppBI's \"Top 10\" note — keep it unless your heading already says Top 10),",
        "  `bands` with `data-rac-tone=\"m0\"`: `[[100,'low'],[500,'mid'],[null,'high']]` sets `data-rac-tone-v` for CSS.",
        "- The template element is hidden and cloned; style it as one normal row. Works on any element, not only `<tr>`.",
        "",
        "### 5.4 Filters",
        "```html",
        f"<div data-rac-filter=\"@{f1}\"></div>   <div data-rac-filter=\"@{fd}\"></div>   <div data-rac-filter-chips></div>",
        "```",
        "AppBI draws, styles and wires the control. A custom control is allowed: call `rac.setFilter` (§7).",
        "",
        "### 5.5 States you do not draw",
        "AppBI shows loading, empty (\"Không có dữ liệu cho bộ lọc đang chọn\"), error, refused (a locked filter",
        "cannot apply) and \"Chưa gắn dữ liệu\" (a placeholder that is not bound) inside the element. Leave room for a",
        "one-line message in every data element; do not hide data elements until data arrives.",
        "",
        "## 6. Sandbox facts",
        "- The page runs in an isolated frame with a strict CSP: no network (`fetch`, XHR, WebSocket, EventSource,",
        "  `sendBeacon`, workers are removed), no storage (localStorage, sessionStorage, IndexedDB, cookies), no",
        "  popups (`window.open`), forms, or navigation away from the page.",
        "- `<iframe>`, `<object>`, `<embed>`, `<link>`, `<meta>`, `<base>` are removed. `<script src>` never loads.",
        "- Images and fonts only as `data:` / `blob:` URIs (inline SVG is best). No web fonts: use a system font stack.",
        "- `#anchor` links and `scrollIntoView` work; inline `on*=` handlers do not (use addEventListener);",
        "  eval / new Function are blocked. Your script runs after the runtime: `window.rac` is always defined.",
        "- If the viewer's browser cannot lock navigation, AppBI does not run your script at all (the declarative",
        "  places of §5 still render): every figure must work WITHOUT your JS. Use JS for behaviour and extra visuals.",
        "- Give each top-level section `data-rac-region=\"kebab-id\" data-rac-label=\"Human label\"` so authors can",
        "  edit a section with AI later (the only structural requirement).",
        "- The page is shown at any width (phone to wide screen): AppBI reports horizontal overflow as an error.",
        "",
        "## 7. JavaScript SDK (`window.rac`)",
        "```js",
        f"rac.bind('@{kt}', function (dto) {{ /* called on data and after EVERY filter change */ }});",
        "// dto = { status: 'loading'|'ready'|'empty'|'error'|'refused'|'unbound', title, rows: [{d0, m0}],",
        "//         fields: [{key:'d0'|'m0', label, role:'dimension'|'measure', kind:'date'|'string'|'number',",
        "//                   grain, aggregation, format, filterKey}],",
        "//         topN: {n, direction} | undefined, truncated, partial: [months not yet complete],",
        "//         notApplied: [filters this data could not apply], provenance: {asOf}, error }",
        f"rac.data('@{kt}')                 // the last dto (or null)",
        f"rac.viz.bar(el, '@{kc}', {{top: 5}})  // any §5.2 kind, re-renders by itself on new data",
        "rac.fmt(value, field, {compact: true, decimals: 1})   rac.fmtDate(value, 'month')   rac.label(value, field)",
        f"rac.primary('@{kt}')              // {{value, prev, field, note}} — the same headline data-rac-value shows",
        f"rac.filters()  rac.filterState()  rac.onFilters(fn)  rac.values('@{f1}', 'search') → Promise<values>",
        f"rac.setFilter('@{f1}', ['A', 'B'])  rac.setFilter('@{fd}', ['2025-01-01', '2025-12-31'])  rac.clearFilter('@{f1}')",
        f"rac.clearFilters()  rac.drill('@{f1}', value)  rac.ready(fn)  rac.icon('chart', 18) → svg string",
        "```",
        "- Always branch on `dto.status`; draw only when `'ready'`. Read values by `field.key`, label them by `field.label`.",
        "- Format every number with `rac.fmt(value, field)` so the unit and the percent convention stay right.",
        "- `<span data-rac-icon=\"NAME\"></span>` draws an icon. NAME: home chart trend users cart money truck star box",
        "  layers filter calendar map target table pie menu up down alert.",
        "",
        "## 8. Theme and formatting",
        "AppBI visuals read these CSS variables — set them on `:root` (or a section) to match your design:",
        "`--rac-accent` `--rac-c1`…`--rac-c8` (series palette) `--rac-text` `--rac-muted` `--rac-bg` `--rac-surface`",
        "`--rac-border` `--rac-grid` `--rac-pos` `--rac-neg` `--rac-warn` `--rac-font`.",
        "Number options on a `data-rac-value` / cell (`data-rac-opts`): `compact` (true/false), `decimals`,",
        "`scale` + `suffix` (e.g. `{\"scale\":1e9,\"suffix\":\" tỷ\"}` shows the same number in billions).",
        "Large numbers are compact by default (9,2 Tr); a `table` shows full numbers.",
        "",
        "## 9. What AppBI checks after import (and what you see in Studio)",
        "Blocking ⛔ — publishing is refused until fixed:",
        "- `UNBOUND` a placeholder / filter that is not in §3/§4, or could not be bound;",
        "- `SAMPLE` a design sample number still on the page.",
        "Warnings — shown next to the place:",
        "- `STATIC_FIGURE` a number typed outside every data place (it never follows the data or a filter);",
        "- `STALE_TEXT` text that calls itself static / sample / demo data;",
        "- `CARD_LABEL` a card titled after one metric that shows another placeholder's value;",
        "- `ROW_ADDRESS` a value in a hand-built row that is not addressed to its row (use §5.3 or `data-rac-rank`).",
        "In the live Studio preview: values in the wrong card, numbers matching no bound data, horizontal",
        "overflow, script errors and blocked APIs are listed too. Ranks (\"Top 10\"), months, years and dates in",
        "your text are not treated as figures. Mark a number that is deliberately not data (a phone number, a",
        "version) with `data-rac-static`.",
        "",
        "## 10. Hard limits",
        f"- At most {L} distinct `@c…` placeholders per page — one placeholder may be used in many places, it counts once.",
        f"  Beyond {L} the extra ones are left unbound (⛔). Plan the page around ≤ {L} queries.",
        f"- At most {B.MAX_FILTERS} filters; at most {B.MAX_ROWS} rows reach a dto; category placeholders return ≤ 10 rows.",
        f"- Sizes: HTML ≤ {D.MAX_HTML // 1000} KB, CSS ≤ {D.MAX_CSS // 1000} KB, JS ≤ {D.MAX_JS // 1000} KB.",
        "- Only the data in §3 exists. A figure not listed (a target, a forecast, a ratio of two candidates, last",
        "  year's value) cannot be shown — leave it out rather than computing or typing it.",
        "",
        "## 11. Before you hand the file back — check",
        "1. Search your output for digits: every one is in a CSS value, a placeholder id, `data-rac-opts`, a",
        "   label like \"Top\" / a year in a heading, or your JS logic — none is a business figure.",
        "2. Every `data-rac-value` / `data-rac-bind` / `data-rac-repeat` / `data-rac-filter` / `rac.bind` / `rac.setFilter`",
        "   uses a placeholder from §12's JSON list below, written with its `@`.",
        f"3. ≤ {L} distinct `@c…`, ≤ {B.MAX_FILTERS} distinct `@f…`. Every total is a **kpi** placeholder.",
        "4. Every `data-rac-cell` is `#`, `d0` or `m0`. No bare `data-rac-value` on a category placeholder.",
        "5. No array or object literal in the script holds business values; every chart is drawn from `dto`.",
        "6. No sentence states a figure, a data date, or that the data is static / sample / demo.",
        "7. One self-contained HTML file: `<style>`, `<script>` (no `src`), body markup; it reads well at 375 px.",
        "",
        "## 12. Self-check list (machine-readable) — the ONLY placeholders the page may use",
        "```json",
        json.dumps({"data": [f"@{r['id']}" for r in prow],
                    "data_kinds": {f"@{r['id']}": r["kind"] for r in prow},
                    "filters": [f"@{d['id']}" for d in dims],
                    "limits": {"placeholders": L, "filters": B.MAX_FILTERS, "category_rows": 10},
                    "cell_keys": ["#", "d0", "m0"],
                    "attributes": ["data-rac-value", "data-rac-bind", "data-rac-viz", "data-rac-opts", "data-rac-repeat",
                                   "data-rac-cell", "data-rac-bar", "data-rac-tone", "data-rac-row", "data-rac-rank",
                                   "data-rac-field", "data-rac-filter", "data-rac-filter-chips", "data-rac-filter-text",
                                   "data-rac-title", "data-rac-asof", "data-rac-icon", "data-rac-static",
                                   "data-rac-region", "data-rac-label"]},
                   ensure_ascii=False),
        "```",
    ])
