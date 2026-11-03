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

MAX_SLOTS = 40
_NUM_RX = re.compile(r"(?<![\w#.,-])[-+]?\d{1,3}(?:[.,\s]\d{3})+(?:[.,]\d+)?(?:\s?(?:tỷ|Tỷ|tr|Tr|triệu|N|K|M|B|%|₫|đ|VND|USD))?"
                     r"|(?<![\w#.,-])[-+]?\d+(?:[.,]\d+)?\s?(?:tỷ|Tỷ|tr|Tr|triệu|N|K|M|B|%|₫|đ|VND|USD)(?![\w])"
                     r"|(?<![\w#.,:/-])[-+]?\d{3,}(?:[.,]\d+)?(?![\w:/-])")
_CHART_HINT = re.compile(r"chart|graph|plot|canvas|viz|sparkline", re.I)
_PLACEHOLDER = re.compile(r"@[cf]\d+\b")
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
        if len(text) >= 2:
            return text[:80]
        if end - start > 2000:
            break
    return ""


# ── Analyze ───────────────────────────────────────────────────────────────────

def detect_slots(html: str) -> List[Dict[str, Any]]:
    sc = _scan(html)
    tags = sc.tags
    slots: List[Dict[str, Any]] = []
    taken: List[Tuple[int, int]] = []

    def inside(a: int, b: int) -> bool:
        return any(x <= a and b <= y for x, y in taken)

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
            if inside(t.start, end):
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
        for m in _NUM_RX.finditer(data):
            tok = m.group(0).strip()
            if re.fullmatch(r"(19|20)\d{2}", tok):
                continue  # a year in a heading is not a figure
            a = pos + m.start() + (len(m.group(0)) - len(m.group(0).lstrip()))
            label = _plain(data[:m.start()]) or _enclosing_label(html, tags, a, tok) or _heading_before(html, pos)
            slots.append({"kind": "value", "start": a, "end": a + len(tok), "tag": "text", "context": label[:80],
                          "sample": tok, "host": _sole_host(html, tags, a, tok)})
    slots.sort(key=lambda s: s["start"])
    slots = slots[:MAX_SLOTS]
    for n, s in enumerate(slots):
        s["id"] = f"s{n + 1}"
    return slots


def _kinds_for(slot: Dict[str, Any]) -> Tuple[str, ...]:
    return {"value": ("kpi",), "chart": ("time", "category"), "table": ("category",)}.get(slot["kind"], ())


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
        s += 0.3
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


def propose(slots: List[Dict[str, Any]], cands: List[Dict[str, Any]], dims: List[Dict[str, Any]], goal: str = "") -> Dict[str, Any]:
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
        if best is not None and _score(s, best) > 0:
            out[s["id"]] = {"candidate": best["id"], "confidence": round(min(1.0, _score(s, best)), 2), "source": "rules"}
    data_slots = [s for s in slots if s["kind"] != "filter"]
    if data_slots and cands:
        try:
            from app.services.llm_client import LLMClient

            from app.services.report_code.generation import _candidate_listing, _dims_listing

            brief = [{"slot": s["id"], "kind": s["kind"], "context": s["context"], "sample": s["sample"]} for s in slots]
            res = LLMClient.complete_json(
                prompt=(f"An HTML report is being connected to governed data. {('REPORT PURPOSE: ' + goal[:500]) if goal else ''}\n"
                        f"SLOTS found in the HTML (value = a printed number, chart = a chart element, table = a table, filter = a select). "
                        f"`context` is the label a reader sees next to the slot — map by THAT meaning, never by position:\n"
                        f"{json.dumps(brief, ensure_ascii=False)}\n\nCANDIDATE DATA (governed, by id):\n{_candidate_listing(cands, 160)}\n\n"
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


def analyze(db: Session, *, dataset_id: int, html: str, css: str, js: str, goal: str = "") -> Dict[str, Any]:
    html, css, js, warnings = normalize_sources(html, css, js)
    model = B.load_model(db, dataset_id)
    cands, dims = B.candidates(model), B.filter_dimensions(model, dataset_id)
    for c in cands:
        c["title"] = B._localize_title(c["title"])
    compatible = bool(_PLACEHOLDER.search(html + js)) or "data-rac-" in html
    slots = [] if compatible else detect_slots(html)
    proposals = propose(slots, cands, dims, goal) if slots else {}
    by_id = {c["id"]: c for c in cands}
    view = []
    for s in slots:
        p = proposals.get(s["id"], {})
        row = {k: s[k] for k in ("id", "kind", "context", "sample") if k in s}
        if s["kind"] == "filter":
            row["dimension"] = p.get("dimension")
        else:
            row["candidate"] = p.get("candidate")
            row["candidate_title"] = by_id[p["candidate"]]["title"] if p.get("candidate") in by_id else None
            row["viz"] = default_viz(s, by_id.get(p.get("candidate")), js)
        row["confidence"] = p.get("confidence", 0.0)
        row["source"] = p.get("source", "rules")
        view.append(row)
    return {
        "compatible": compatible, "slots": view, "warnings": warnings,
        "placeholders": sorted(set(_PLACEHOLDER.findall(html + js))) if compatible else [],
        "candidates": [{"id": c["id"], "kind": c["kind"], "type": c["type"], "title": c["title"]}
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

    if compatible:
        progress("Mã đã tương thích AppBI — chạy dữ liệu qua BI Core")
        wanted = sorted(set(re.findall(r"@(c\d+)\b", html + js)), key=lambda x: int(x[1:]))
        picks = [(by_id[c], "") for c in wanted if c in by_id]
        notes += [f"@{c} không có trong semantic model hiện tại — đã bỏ." for c in wanted if c not in by_id]
        added, mapping_ids, n2 = B.bind_candidates(db, picks, existing=existing, owner_id=owner_id, dataset_id=dataset_id,
                                                   prefix=f"[Code] {report_name}", meta=meta)
        notes += n2
        html = re.sub(r"@(c\d+)\b", lambda m: mapping_ids.get(m.group(1), "missing"), html)
        js = re.sub(r"@(c\d+)\b", lambda m: mapping_ids.get(m.group(1), "missing"), js)
        fids = sorted(set(re.findall(r"@(f\d+)\b", html + js)), key=lambda x: int(x[1:]))
        decl, fmap = _add_filters(decl, dims, fids)
        html = re.sub(r"@(f\d+)\b", lambda m: fmap.get(m.group(1), "missing"), html)
        js = re.sub(r"@(f\d+)\b", lambda m: fmap.get(m.group(1), "missing"), js)
        return {"html": _ensure_regions(html), "css": css, "js": js, "bindings": existing + added, "filters": decl, "notes": notes}

    progress("Đọc các vị trí dữ liệu trong HTML")
    slots = {s["id"]: s for s in detect_slots(html)}
    chosen = [m for m in mapping if m.get("slot") in slots and slots[m["slot"]]["kind"] != "filter" and m.get("candidate") in by_id]
    progress("Chạy thử truy vấn qua BI Core")
    picks, seen = [], set()
    for m in chosen:
        if m["candidate"] not in seen:
            seen.add(m["candidate"])
            picks.append((by_id[m["candidate"]], ""))
    added, cmap, n2 = B.bind_candidates(db, picks, existing=existing, owner_id=owner_id, dataset_id=dataset_id,
                                        prefix=f"[Code] {report_name}", meta=meta)
    notes += n2
    filter_slots = {m["slot"]: m.get("dimension") for m in mapping if m.get("slot") in slots and slots[m["slot"]]["kind"] == "filter" and m.get("dimension")}
    decl, fmap = _add_filters(decl, dims, list(dict.fromkeys(list(filter_slots.values()) + list(filters or []))))

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
            if host is not None:
                t = tags[host]
                edits.append((t.start, t.end, D._rebuild_start(t, list(t.attrs) + [("data-rac-value", bid)])))
                edits.append((s["start"], s["end"], ""))
            else:
                edits.append((s["start"], s["end"], f'<span data-rac-value="{bid}"></span>'))
        else:
            viz = m.get("viz") or default_viz(s, by_id[m["candidate"]], js) or "bar"
            if viz not in _VIZ:
                viz = "bar"
            h = s.get("height") or (None if viz in ("table", "donut", "kpi", "progress", "heatmap") else 280)
            style = f' style="height:{h}px;width:100%"' if h else ""
            keep_id = f' id="{s["element_id"]}"' if s.get("element_id") else ""
            edits.append((s["start"], s["end"], f'<div{keep_id} data-rac-viz="{viz}" data-rac-bind="{bid}"{style}></div>'))
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
        html = (f'<div class="rac-import-filters" data-rac-region="filters" data-rac-label="Bộ lọc" '
                f'style="display:flex;flex-wrap:wrap;gap:8px;padding:10px 16px">{bar}<div data-rac-filter-chips></div></div>') + html
    stubs = [code for lib, code in _LIB_STUBS.items() if re.search(r"\b" + lib + r"\b", js or "")]
    if stubs:
        js = "/* AppBI: chart libraries are not loaded — their charts were replaced by governed visuals. */\n" + "\n".join(stubs) + "\n" + js
        notes.append("Các thư viện biểu đồ ngoài (" + ", ".join(l for l in _LIB_STUBS if re.search(r"\b" + l + r"\b", js)) +
                     ") không được tải; biểu đồ của chúng đã được thay bằng biểu đồ gắn dữ liệu BI Core.")
    return {"html": _ensure_regions(html), "css": css, "js": js, "bindings": existing + added, "filters": decl, "notes": notes}


_VIZ = {"kpi", "bar", "column", "hbar", "line", "area", "donut", "pie", "table", "heatmap", "gauge", "waterfall", "progress", "sparkline"}


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

def context_pack(db: Session, *, dataset_id: int, dataset_name: str) -> str:
    """Everything an outside AI needs to write an AppBI-compatible report — and nothing
    else: no data values, no SQL, no table/view/column names, no ids of the platform."""
    from app.services.report_code.generation import DESIGN_RULES, SDK_REFERENCE

    model = B.load_model(db, dataset_id)
    cands, dims = B.candidates(model), B.filter_dimensions(model, dataset_id)
    meta = B.field_meta(model)
    rows = []
    for c in sorted(cands, key=lambda c: (c.get("rank", 9), c["id"]))[:200]:
        mref = c["role"]["metrics"][0]["field"]
        m = meta.get(mref, {})
        fmt = (m.get("format") or {}).get("kind", "number")
        axis_ref = c["role"].get("timeField") or c["role"].get("dimension")
        axis = (meta.get(axis_ref) or {}).get("label", "") if axis_ref else ""
        rows.append(f"| `@{c['id']}` | {c['kind']} | {B._localize_title(c['title'])} | {axis or '—'} | {m.get('aggregation') or ''} | {fmt} |")
    drows = [f"| `@{d['id']}` | {d['kind']} | {d['label']} |" for d in dims]
    return "\n".join([
        f"# AppBI AI Design Context Pack — {dataset_name}",
        "",
        "Use this pack to design a report page in any AI tool (Claude Code, ChatGPT…). Paste the result back into",
        "AppBI › AI Vibe Report › *Dán mã*. AppBI runs every reference below through its BI Core (semantic model,",
        "permissions, filters) — the page itself never contains or fetches data.",
        "",
        "## What to produce",
        "ONE self-contained HTML file: `<style>` for CSS, `<script>` for JS (no `src`), body markup. No external fonts,",
        "images, CDNs or network calls. Bind data ONLY with the placeholders below:",
        "- `data-rac-bind=\"@c12\"` on an element with `data-rac-viz=\"…\"` — a chart/visual of candidate c12",
        "- `data-rac-value=\"@c3\"` — the formatted headline number of candidate c3 (add `data-rac-row=\"SP\"` for one row)",
        "- `data-rac-filter=\"@f2\"` — a viewer filter on dimension f2",
        "- in JS: `rac.bind('@c12', dto => …)` (dto.rows / dto.fields, see SDK) — never type a business number.",
        "",
        "## Data you may use (governed candidates — meanings, not values)",
        "| Placeholder | Kind | Meaning | Axis / breakdown | Aggregation | Format |",
        "|---|---|---|---|---|---|",
        *rows,
        "",
        "## Dimensions a viewer may filter by",
        "| Placeholder | Kind | Label |",
        "|---|---|---|",
        *drows,
        "",
        "## Runtime SDK (`window.rac`, already loaded in the AppBI sandbox)",
        SDK_REFERENCE.strip(),
        "",
        "## Design rules",
        DESIGN_RULES.replace('OUTPUT: one JSON object {"title": "...", "html": "...", "css": "...", "js": "...", "summary": "one sentence"}.\n', "").strip(),
        "",
        "## Sandbox facts",
        "- The page runs in an isolated frame: no network, storage, cookies, popups, forms or navigation away from the page.",
        "- `#anchor` links work; inline `on*=` handlers do not (use addEventListener); eval/new Function are blocked.",
        "- Every number on screen should come from a placeholder; AppBI flags numbers it cannot trace to the data.",
    ])
