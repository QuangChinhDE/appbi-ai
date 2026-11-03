"""Semantic correctness of a report's markup: right binding, right ROW, right metric.

A value can be numerically real and still wrong — the headline total of "orders by
state" printed in the row labelled "RJ". Comparing numbers cannot see that; this module
reads the markup the way a viewer reads it: a value inside a table row or list item
belongs to the dimension value that row is labelled with.

Edits are made on spans of the original text (document.py), so nothing else moves.
"""
from __future__ import annotations

import html as _html
import re
from typing import Any, Dict, List, Optional, Tuple

from app.services.report_code import document as D

_ROW_TAGS = {"tr", "li"}
_TAG_RX = re.compile(r"<[^>]+>")


def _text(markup: str) -> str:
    return _html.unescape(_TAG_RX.sub(" ", markup or ""))


def _dimension_values(dto: Dict[str, Any]) -> List[str]:
    dims = [f for f in dto.get("fields") or [] if f.get("role") != "measure"]
    if not dims:
        return []
    key = dims[0]["key"]
    return [str(r.get(key)) for r in dto.get("rows") or [] if r.get(key) not in (None, "")]


def _labels_in(text: str, values: List[str]) -> List[str]:
    found = []
    for v in values:
        if len(v) < 2:
            continue
        if re.search(r"(?<![\w])" + re.escape(v) + r"(?![\w])", text, flags=re.UNICODE):
            found.append(v)
    return found


def _ancestors(tags: List[D._Tag]) -> List[List[int]]:
    """For each tag index, the indexes of the start tags enclosing it."""
    stack: List[int] = []
    out: List[List[int]] = []
    for i, t in enumerate(tags):
        if t.kind == "end":
            for j in range(len(stack) - 1, -1, -1):
                if tags[stack[j]].name == t.name:
                    del stack[j:]
                    break
            out.append(list(stack))
            continue
        out.append(list(stack))
        if t.kind == "start" and t.name not in D._VOID:
            stack.append(i)
    return out


def check_rows(html: str, dtos: Dict[str, Dict[str, Any]], *, fix: bool) -> Tuple[str, List[str]]:
    """Find (and with `fix`, repair) values printed in a row they do not belong to."""
    tags = D._scan(html or "")
    anc = _ancestors(tags)
    edits: List[Tuple[int, int, str]] = []
    notes: List[str] = []
    for i, t in enumerate(tags):
        if t.kind not in ("start", "startend"):
            continue
        attrs = dict(t.attrs)
        bid = attrs.get("data-rac-value")
        if not bid or attrs.get("data-rac-rank") is not None or bid not in dtos:
            continue
        row_idx = next((a for a in reversed(anc[i]) if tags[a].name in _ROW_TAGS), None)
        if row_idx is None:
            continue
        end_idx = D._matching_end(tags, row_idx)
        if end_idx < 0:
            continue
        own_end = D._matching_end(tags, i) if t.kind == "start" else -1
        own_stop = tags[own_end].end if own_end >= 0 else t.end
        row_text = _text(html[tags[row_idx].start:t.start] + " " + html[own_stop:tags[end_idx].end])
        labels = _labels_in(row_text, _dimension_values(dtos[bid]))
        current = attrs.get("data-rac-row")
        title = dtos[bid].get("title") or bid
        if len(labels) != 1:
            continue
        want = labels[0]
        if current == want:
            continue
        if current is None:
            notes.append(f"'{title}': giá trị tổng đặt trong dòng '{want}' — đã gắn đúng dòng '{want}'.")
        else:
            notes.append(f"'{title}': dòng '{want}' đang hiển thị giá trị của '{current}' — đã sửa về '{want}'.")
        if fix:
            new_attrs = [(k, v) for k, v in t.attrs if k != "data-rac-row"] + [("data-rac-row", want)]
            edits.append((t.start, t.end, D._rebuild_start(t, new_attrs)))
    if not fix or not edits:
        return html, notes
    out, cursor = [], 0
    for start, end, repl in sorted(edits):
        out.append(html[cursor:start])
        out.append(repl)
        cursor = end
    out.append(html[cursor:])
    return "".join(out), notes
