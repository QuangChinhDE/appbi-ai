"""Editable PowerPoint export of a report (user feedback: "export editable so the
customer can adjust the report for the boss").

Contract — what is editable, honestly:
  * one slide per report page, the report title + page name as editable text;
  * every tile is its own movable/resizable object at the report's geometry;
  * KPI cards: label and value are REAL TEXT (editable, restylable);
  * text / heading elements: real text;
  * tables: a native PowerPoint table (editable cells) of the rows the report
    shows, capped — a longer table says how many rows were left out;
  * charts: a high-resolution PICTURE of the chart exactly as rendered, with an
    editable title. Not a native PowerPoint chart.

The browser sends what the reader actually sees (values already formatted,
filters already applied), so the deck can never disagree with the screen and
this module never queries data. It only lays out the payload.
"""
from __future__ import annotations

import base64
import binascii
import io
import re
from typing import List, Literal, Optional

from pydantic import BaseModel, Field, field_validator
from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.enum.shapes import MSO_SHAPE
from pptx.enum.text import MSO_ANCHOR, PP_ALIGN
from pptx.util import Emu, Inches, Pt

MAX_PAGES = 30
MAX_TILES_PER_PAGE = 120
MAX_TABLE_ROWS = 25
MAX_TABLE_COLS = 30
MAX_IMAGE_BYTES = 6 * 1024 * 1024

SLIDE_W = Inches(13.333)
SLIDE_H = Inches(7.5)
MARGIN_X = Inches(0.4)
CONTENT_TOP = Inches(1.05)
CONTENT_BOTTOM = Inches(7.05)
GAP = Inches(0.08)

INK = RGBColor(0x0F, 0x17, 0x2A)
MUTED = RGBColor(0x64, 0x74, 0x8B)
LINE = RGBColor(0xE2, 0xE8, 0xF0)
CARD = RGBColor(0xFF, 0xFF, 0xFF)
HEAD_FILL = RGBColor(0xF1, 0xF5, 0xF9)

_DATA_URL = re.compile(r"^data:image/(png|jpeg|jpg);base64,(.+)$", re.S)


class PptxTile(BaseModel):
    kind: Literal["kpi", "chart", "table", "text"]
    x: float = Field(ge=0)
    y: float = Field(ge=0)
    w: float = Field(gt=0)
    h: float = Field(gt=0)
    title: Optional[str] = Field(default=None, max_length=300)
    value: Optional[str] = Field(default=None, max_length=120)
    caption: Optional[str] = Field(default=None, max_length=300)
    text: Optional[str] = Field(default=None, max_length=8000)
    columns: Optional[List[str]] = None
    rows: Optional[List[List[str]]] = None
    total_rows: Optional[int] = Field(default=None, ge=0)
    image: Optional[str] = None

    @field_validator("columns")
    @classmethod
    def _cap_cols(cls, v):
        return [str(c)[:120] for c in v[:MAX_TABLE_COLS]] if v else v

    @field_validator("rows")
    @classmethod
    def _cap_rows(cls, v):
        if not v:
            return v
        return [[str(c)[:300] for c in r[:MAX_TABLE_COLS]] for r in v[:MAX_TABLE_ROWS]]


class PptxPage(BaseModel):
    name: str = Field(default="", max_length=200)
    # Tile x/y/w/h are the RENDERED pixel rectangle on the page (relative to the
    # page's left/top); `width` is that page's rendered width. One uniform scale
    # (slide width / page width) keeps every tile's shape, so a chart picture
    # fills its block and edges line up as on screen.
    width: float = Field(gt=0)
    tiles: List[PptxTile] = Field(default_factory=list, max_length=MAX_TILES_PER_PAGE)


class ReportPptxRequest(BaseModel):
    title: str = Field(default="Báo cáo", max_length=200)
    subtitle: Optional[str] = Field(default=None, max_length=300)
    footer: Optional[str] = Field(default=None, max_length=300)
    pages: List[PptxPage] = Field(min_length=1, max_length=MAX_PAGES)


def _decode_image(data_url: Optional[str]) -> Optional[bytes]:
    if not data_url:
        return None
    m = _DATA_URL.match(data_url.strip())
    if not m:
        return None
    try:
        raw = base64.b64decode(m.group(2), validate=False)
    except (binascii.Error, ValueError):
        return None
    if len(raw) > MAX_IMAGE_BYTES:
        return None
    return raw


def _text_box(slide, left, top, width, height, text, *, size, bold=False, color=INK,
              align=PP_ALIGN.LEFT, anchor=MSO_ANCHOR.TOP, wrap=True):
    box = slide.shapes.add_textbox(left, top, width, height)
    tf = box.text_frame
    tf.word_wrap = wrap
    tf.vertical_anchor = anchor
    tf.margin_left = tf.margin_right = Inches(0.06)
    tf.margin_top = tf.margin_bottom = Inches(0.03)
    lines = str(text or "").split("\n") or [""]
    for i, line in enumerate(lines):
        para = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
        para.alignment = align
        run = para.add_run()
        run.text = line
        run.font.size = Pt(size)
        run.font.bold = bold
        run.font.color.rgb = color
    return box


def _card(slide, left, top, width, height):
    shape = slide.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, left, top, width, height)
    shape.adjustments[0] = 0.06
    shape.fill.solid()
    shape.fill.fore_color.rgb = CARD
    shape.line.color.rgb = LINE
    shape.line.width = Pt(0.75)
    shape.shadow.inherit = False
    return shape


def _place_kpi(slide, t: PptxTile, L, T, W, H):
    _card(slide, L, T, W, H)
    pad = Inches(0.1)
    label_h = min(Emu(int(H * 0.38)), Inches(0.55))
    _text_box(slide, L + pad, T + pad, W - 2 * pad, label_h, t.title or "", size=11, color=MUTED)
    value_top = T + pad + label_h
    value_h = max(Emu(int(H - (value_top - T) - pad)), Inches(0.3))
    _text_box(slide, L + pad, value_top, W - 2 * pad, value_h, t.value or "—",
              size=26, bold=True, anchor=MSO_ANCHOR.MIDDLE, wrap=False)
    if t.caption:
        _text_box(slide, L + pad, T + H - Inches(0.32), W - 2 * pad, Inches(0.28), t.caption, size=9, color=MUTED)


def _title_strip(slide, t: PptxTile, L, T, W) -> int:
    if not t.title:
        return 0
    h = Inches(0.34)
    _text_box(slide, L, T, W, h, t.title, size=12, bold=True)
    return h


def _place_chart(slide, t: PptxTile, L, T, W, H):
    used = _title_strip(slide, t, L, T, W)
    raw = _decode_image(t.image)
    top = T + used
    avail_h = H - used
    if raw is None or avail_h <= 0:
        _text_box(slide, L, top, W, max(avail_h, Inches(0.3)), "(biểu đồ không chụp được)", size=10, color=MUTED)
        return
    from PIL import Image  # pillow is a pinned dependency
    with Image.open(io.BytesIO(raw)) as im:
        iw, ih = im.size
    # Fit inside the box, keep the chart's shape, anchor top-left with the tile.
    scale = min(W / iw, avail_h / ih)
    pw, ph = int(iw * scale), int(ih * scale)
    slide.shapes.add_picture(io.BytesIO(raw), L + (W - pw) // 2, top, pw, ph)


def _place_table(slide, t: PptxTile, L, T, W, H):
    used = _title_strip(slide, t, L, T, W)
    cols = t.columns or []
    rows = t.rows or []
    if not cols:
        _text_box(slide, L, T + used, W, Inches(0.3), "(bảng trống)", size=10, color=MUTED)
        return
    # Only the rows that FIT the block (a native table cannot be shrunk below
    # readable row height — it used to run off the slide); the rest are counted.
    row_h = Inches(0.22)
    total = max(t.total_rows or 0, len(rows))
    fit_all = max(1, int((H - used) / row_h) - 1)
    if total <= min(MAX_TABLE_ROWS, fit_all):
        shown, more, note_h = rows, 0, 0
    else:
        # Room for the "rows left out" line only when something IS left out.
        note_h = Inches(0.26)
        fit = max(1, int((H - used - note_h) / row_h) - 1)
        shown = rows[:min(MAX_TABLE_ROWS, fit)]
        more = total - len(shown)
    graphic = slide.shapes.add_table(len(shown) + 1, len(cols), L, T + used, W, row_h * (len(shown) + 1))
    table = graphic.table
    size = 9 if len(cols) <= 8 else 7
    for c, name in enumerate(cols):
        cell = table.cell(0, c)
        cell.text = name
        cell.fill.solid()
        cell.fill.fore_color.rgb = HEAD_FILL
        for p in cell.text_frame.paragraphs:
            for r in p.runs:
                r.font.size = Pt(size)
                r.font.bold = True
                r.font.color.rgb = INK
    for r_i, row in enumerate(shown, start=1):
        for c in range(len(cols)):
            cell = table.cell(r_i, c)
            cell.text = row[c] if c < len(row) else ""
            for p in cell.text_frame.paragraphs:
                for r in p.runs:
                    r.font.size = Pt(size)
                    r.font.color.rgb = INK
    if more:
        _text_box(slide, L, T + H - note_h, W, note_h,
                  f"… còn {more} dòng không hiển thị — xuất Excel/CSV để có toàn bộ dữ liệu.",
                  size=8, color=MUTED)


def _place_text(slide, t: PptxTile, L, T, W, H):
    used = _title_strip(slide, t, L, T, W)
    if t.text:
        _text_box(slide, L, T + used, W, max(H - used, Inches(0.3)), t.text, size=11)


_PLACERS = {"kpi": _place_kpi, "chart": _place_chart, "table": _place_table, "text": _place_text}


def _new_page_slide(prs, layout, req, page, content_w):
    """A continuation slide of the same report page."""
    slide = prs.slides.add_slide(layout)
    _text_box(slide, MARGIN_X, Inches(0.25), content_w, Inches(0.45), req.title, size=22, bold=True)
    _text_box(slide, MARGIN_X, Inches(0.66), content_w, Inches(0.3),
              " · ".join(s for s in (page.name, "(tiếp)") if s), size=12, color=MUTED)
    return slide


def build_report_pptx(req: ReportPptxRequest) -> bytes:
    prs = Presentation()
    prs.slide_width = SLIDE_W
    prs.slide_height = SLIDE_H
    blank = prs.slide_layouts[6]
    content_w = SLIDE_W - 2 * MARGIN_X
    content_h = CONTENT_BOTTOM - CONTENT_TOP

    for page_no, page in enumerate(req.pages, start=1):
        slide = prs.slides.add_slide(blank)
        _text_box(slide, MARGIN_X, Inches(0.25), content_w, Inches(0.45), req.title, size=22, bold=True)
        sub = " · ".join(s for s in (page.name, req.subtitle) if s)
        if sub:
            _text_box(slide, MARGIN_X, Inches(0.66), content_w, Inches(0.3), sub, size=12, color=MUTED)
        if req.footer:
            _text_box(slide, MARGIN_X, Inches(7.12), content_w, Inches(0.28),
                      f"{req.footer}   ·   {page_no}/{len(req.pages)}", size=8, color=MUTED)
        if not page.tiles:
            continue
        scale = content_w / page.width  # EMU per rendered pixel — one for x AND y
        ordered = sorted(page.tiles, key=lambda t: (t.y, t.x))
        start = ordered[0].y
        slide_tiles: list = []
        chunks: list = []
        for t in ordered:
            # Continue on a new slide at a tile boundary, never through a tile.
            if slide_tiles and (t.y + t.h - start) * scale > content_h and t.y > start:
                chunks.append((start, slide_tiles))
                start, slide_tiles = t.y, []
            slide_tiles.append(t)
        chunks.append((start, slide_tiles))
        for ci, (top0, tiles) in enumerate(chunks):
            target = slide if ci == 0 else _new_page_slide(prs, blank, req, page, content_w)
            for t in tiles:
                L = int(MARGIN_X + t.x * scale + GAP / 2)
                T = int(CONTENT_TOP + (t.y - top0) * scale + GAP / 2)
                W = int(max(t.w * scale - GAP, Inches(0.3)))
                H = int(min(max(t.h * scale - GAP, Inches(0.3)), CONTENT_BOTTOM - T))
                _PLACERS[t.kind](target, t, Emu(L), Emu(T), Emu(W), Emu(H))

    out = io.BytesIO()
    prs.save(out)
    return out.getvalue()
