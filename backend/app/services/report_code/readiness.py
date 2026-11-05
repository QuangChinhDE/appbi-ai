"""ONE readiness report for a report revision - what blocks publishing, what to look at.

Before this, three checks lived apart and the author met their findings one by one, after
the page rendered: `lifecycle.dangling_references` (publish), `lifecycle.sample_marks`
(publish) and the row / association / provenance audit in `runtime.js` (the browser,
Studio only). This module is the server's single answer, per PLACE on the page, computed
from the revision itself (no stored state, nothing to backfill):

  blocking  - publishing is refused while one remains:
              UNBOUND        an anchor / filter names nothing the revision has
              SAMPLE         a design sample number is still shown (overridable: allow_samples)
              UNSAFE_ORIGIN  report documents would load from each viewer's own machine
  warnings  - shown, never blocking (heuristics):
              STATIC_FIGURE  a number typed into the page outside every data place: it never
                             follows the data or a filter
              STALE_TEXT     typed text that calls itself static / sample / demo data
              CARD_LABEL     a card named after one metric shows another binding's value
              ROW_ADDRESS    (with data) a value in a hand-built row is not addressed to it

Ranks, months, days, years and dates are not figures (the rules of the Studio audit,
runtime.js `auditNumbers`, kept in step by tests/test_report_code_contract.py).
"""
from __future__ import annotations

import re
from typing import Any, Dict, List, Optional

from app.services.report_code import document as D

#: elements whose text is the runtime's / the data's, not the author's
_DATA_ATTRS = ("data-rac-value", "data-rac-viz", "data-rac-repeat", "data-rac-cell", "data-rac-filter",
               "data-rac-filter-text", "data-rac-filter-chips", "data-rac-title", "data-rac-asof", "data-rac-sample",
               "data-rac-static")
_SKIP_TAGS = {"script", "style", "template", "svg", "code", "pre"}
_TOKEN_RX = re.compile(r"[-+]?\d[\d.,]*\s?(?:Tr|Tỷ|tỷ|N|K|M|B|%|₫)?")
_DATE_RX = re.compile(r"\b\d{1,2}[/.\-]\d{1,2}[/.\-]\d{2,4}\b|\b\d{4}[/.\-]\d{1,2}[/.\-]\d{1,2}\b")
_STALE_RX = re.compile(r"\b(?:dữ liệu tĩnh|số liệu tĩnh|dữ liệu mẫu|số liệu mẫu|số mẫu|demo|sample|mock|giả lập|placeholder)\b",
                       re.IGNORECASE)
_CARD_CLASS_RX = re.compile(r"\b(?:card|kpi|stat|tile|metric)\b", re.IGNORECASE)
MAX_ITEMS = 60


def _item(code: str, message: str, *, region: Optional[Dict[str, str]] = None, snippet: str = "",
          fix: str = "") -> Dict[str, Any]:
    place = {"region": (region or {}).get("id"), "label": (region or {}).get("label") or (region or {}).get("id"),
             "snippet": re.sub(r"\s+", " ", snippet).strip()[:120]}
    out = {"code": code, "message": message, "place": place}
    if fix:
        out["fix"] = fix
    return out


def _is_figure(tok: str) -> bool:
    """The Studio audit's skip rules, in the same ORDER: a rank, a month, a day, a year are
    not figures; the sentence's punctuation is not part of a number."""
    t = re.sub(r"\s+", "", tok).strip(".,")
    try:
        n = float(t.rstrip("TrỷtỷNKMB%₫").replace(".", "").replace(",", "."))
    except ValueError:
        return False
    if re.fullmatch(r"\d{4}", t) and 1900 <= n <= 2100:
        return False
    if re.fullmatch(r"\d{1,2}", t) and n <= 31:
        return False
    return True


class _Walk:
    """The page's tags with, for each text run, the region it is in and whether it is author
    text (outside every data place, script and style)."""

    def __init__(self, html: str):
        self.html = html or ""
        self.tags = D._scan(self.html)
        self.regions: List[Dict[str, Any]] = []
        for i, t in enumerate(self.tags):
            if t.kind in ("start", "startend") and dict(t.attrs).get("data-rac-region"):
                j = D._matching_end(self.tags, i) if t.kind == "start" else i
                end = self.tags[j].end if j >= 0 else len(self.html)
                a = dict(t.attrs)
                self.regions.append({"id": a["data-rac-region"], "label": a.get("data-rac-label") or a["data-rac-region"],
                                     "start": t.start, "end": end})
        self.blocked: List[tuple] = []  # spans whose text is not the author's
        for i, t in enumerate(self.tags):
            if t.kind not in ("start", "startend"):
                continue
            a = dict(t.attrs)
            if t.name in _SKIP_TAGS or any(k in a for k in _DATA_ATTRS):
                j = D._matching_end(self.tags, i) if t.kind == "start" else i
                self.blocked.append((t.start, self.tags[j].end if j >= 0 else len(self.html)))

    def region_at(self, pos: int) -> Optional[Dict[str, Any]]:
        inside = [r for r in self.regions if r["start"] <= pos < r["end"]]
        return min(inside, key=lambda r: r["end"] - r["start"]) if inside else None

    def texts(self):
        """(position, text) of every author text run."""
        cursor = 0
        for t in self.tags:
            if t.start > cursor:
                yield cursor, self.html[cursor:t.start]
            cursor = max(cursor, t.end)
        if cursor < len(self.html):
            yield cursor, self.html[cursor:]

    def blocked_at(self, pos: int) -> bool:
        return any(a <= pos < b for a, b in self.blocked)


def report(rev: Any, *, dtos: Optional[Dict[str, Dict[str, Any]]] = None, with_origin: bool = True) -> Dict[str, Any]:
    """{blocking, warnings, counts} for a revision-like object (html, js, bindings, filters)."""
    from app.services.report_code import lifecycle as L

    html = re.sub(r"<!--.*?-->", "", getattr(rev, "html", "") or "", flags=re.S)
    walk = _Walk(html)
    blocking: List[Dict[str, Any]] = []
    warnings: List[Dict[str, Any]] = []

    # UNBOUND - the place, not only the count
    known = {b.get("id") for b in getattr(rev, "bindings", None) or [] if isinstance(b, dict)}
    keys = {f.get("key") for f in getattr(rev, "filters", None) or [] if isinstance(f, dict)}
    for t in walk.tags:
        if t.kind not in ("start", "startend"):
            continue
        a = dict(t.attrs)
        for attr in ("data-rac-value", "data-rac-bind", "data-rac-repeat", "data-rac-title", "data-rac-asof"):
            ref = a.get(attr)
            if ref and ref not in known:
                blocking.append(_item("UNBOUND", f"Vị trí trỏ tới dữ liệu '{ref}' không có trong báo cáo — chưa gắn dữ liệu.",
                                      region=walk.region_at(t.start), snippet=html[t.start:t.end],
                                      fix="Gắn một nguồn dữ liệu cho vị trí này (tab Dữ liệu) hoặc xoá vị trí."))
        for attr in ("data-rac-filter", "data-rac-filter-text"):
            ref = a.get(attr)
            if ref and ref not in keys:
                blocking.append(_item("UNBOUND", f"Bộ lọc '{ref}' không có trong báo cáo — chưa gắn dữ liệu.",
                                      region=walk.region_at(t.start), snippet=html[t.start:t.end],
                                      fix="Khai báo bộ lọc (tab Dữ liệu) hoặc xoá vị trí."))
    in_html = {dict(t.attrs).get(k) for t in walk.tags if t.kind in ("start", "startend")
               for k in ("data-rac-value", "data-rac-bind", "data-rac-repeat", "data-rac-title", "data-rac-asof",
                         "data-rac-filter", "data-rac-filter-text")}
    for ref in dict.fromkeys(r for r in L.dangling_references(rev) if r not in in_html):
        blocking.append(_item("UNBOUND", f"Mã JS đọc dữ liệu '{ref}' không có trong báo cáo.", snippet=f"rac.bind('{ref}')",
                              fix="Dùng một binding id có trong báo cáo."))

    # SAMPLE - every marked sample, by place
    for t in walk.tags:
        if t.kind in ("start", "startend") and "data-rac-sample" in dict(t.attrs):
            j = D._matching_end(walk.tags, walk.tags.index(t)) if t.kind == "start" else -1
            text = re.sub(r"<[^>]+>", " ", html[t.start:walk.tags[j].end]) if j >= 0 else html[t.start:t.end]
            blocking.append(_item("SAMPLE", "Số mẫu từ thiết kế chưa nối dữ liệu BI Core.", region=walk.region_at(t.start),
                                  snippet=text, fix="Nối với dữ liệu, đánh dấu là chữ tĩnh, hoặc xuất bản kèm nhãn số mẫu."))

    # UNSAFE_ORIGIN - only the configuration that loads reports from each viewer's machine
    if with_origin:
        w = L.origin_warning()
        if w and "loopback" in w:
            blocking.append(_item("UNSAFE_ORIGIN", w))

    # STATIC_FIGURE / STALE_TEXT - author text
    for pos, text in walk.texts():
        if walk.blocked_at(pos) or not text.strip():
            continue
        plain = re.sub(r"&[a-z#0-9]+;", " ", text)
        if _STALE_RX.search(plain) and len(warnings) < MAX_ITEMS:
            warnings.append(_item("STALE_TEXT", "Chữ cố định tự nhận là dữ liệu tĩnh / mẫu / demo — báo cáo giờ dùng dữ liệu thật.",
                                  region=walk.region_at(pos), snippet=plain,
                                  fix="Xoá câu này, hoặc thay bằng ngày cập nhật lấy từ dữ liệu (data-rac-asof)."))
        figures = [tok for tok in _TOKEN_RX.findall(_DATE_RX.sub(" ", plain)) if _is_figure(tok)]
        if figures and len(warnings) < MAX_ITEMS:
            warnings.append(_item("STATIC_FIGURE", "Số gõ cố định trong trang: " + ", ".join(dict.fromkeys(f.strip() for f in figures[:4]))
                                  + " — không đổi theo dữ liệu hay bộ lọc.", region=walk.region_at(pos), snippet=plain,
                                  fix="Hiển thị bằng data-rac-value, hoặc đánh dấu data-rac-static nếu đó là chữ cố ý."))

    # CARD_LABEL - a card titled after one binding that shows another binding's value
    titles = {b["id"]: str(b.get("title") or "") for b in getattr(rev, "bindings", None) or [] if isinstance(b, dict) and b.get("id")}
    for i, t in enumerate(walk.tags):
        a = dict(t.attrs)
        if t.kind != "start" or not _CARD_CLASS_RX.search(a.get("class") or ""):
            continue
        j = D._matching_end(walk.tags, i)
        if j < 0:
            continue
        inner = html[t.start:walk.tags[j].end]
        shown = set(re.findall(r'data-rac-(?:value|bind)=["\']([^"\']+)["\']', inner))
        if len(shown) != 1:
            continue
        bid = next(iter(shown))
        text = re.sub(r"<[^>]+>", " ", inner)
        own = titles.get(bid, "")
        named = [o for o, tt in titles.items() if o != bid and len(tt) > 3 and tt in text and tt not in own]
        if own and own not in text and named:
            warnings.append(_item("CARD_LABEL", f"Thẻ ghi “{titles[named[0]]}” nhưng hiển thị “{own}” ({bid}).",
                                  region=walk.region_at(t.start), snippet=text,
                                  fix=f"Gắn thẻ vào {named[0]}, hoặc đổi tiêu đề thẻ."))

    # ROW_ADDRESS - needs the data's row labels
    if dtos:
        from app.services.report_code import semantics as S

        _html, notes = S.check_rows(html, dtos, fix=False)
        for n in notes:
            warnings.append(_item("ROW_ADDRESS", n, fix="Thêm data-rac-row=\"<nhãn dòng>\" (Import tự sửa được)."))

    blocking, warnings = blocking[:MAX_ITEMS], warnings[:MAX_ITEMS]
    counts: Dict[str, int] = {}
    for x in blocking + warnings:
        counts[x["code"]] = counts.get(x["code"], 0) + 1
    return {"ready": not blocking, "blocking": blocking, "warnings": warnings, "counts": counts}


def blocking_message(rep: Dict[str, Any]) -> str:
    c = rep.get("counts") or {}
    parts = []
    if c.get("UNBOUND"):
        parts.append(f"{c['UNBOUND']} vị trí chưa gắn dữ liệu")
    if c.get("SAMPLE"):
        parts.append(f"{c['SAMPLE']} vị trí còn số mẫu")
    if c.get("UNSAFE_ORIGIN"):
        parts.append("cấu hình nơi phục vụ báo cáo không an toàn (REPORT_ARTIFACT_ORIGIN)")
    return "Chưa xuất bản được: " + "; ".join(parts) + ". Xem danh sách Vấn đề trong Studio."
