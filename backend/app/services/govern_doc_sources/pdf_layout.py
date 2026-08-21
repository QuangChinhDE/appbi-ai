"""PDF layout: words, columns, reading order, and where each block sits.

WHY THE EXTRACTOR STOPPED RETURNING A STRING
--------------------------------------------
It used to flatten a PDF into markdown and the AST was parsed back out of that.
Everything geometric died in the flattening: which column a paragraph belonged to,
what order a human reads the page in, where a figure is, and the coordinates a
citation could point at. None of it is recoverable from the text afterwards, so
extraction has to emit structure.

READING ORDER IS NOT y-THEN-x
-----------------------------
`page.extract_text()` walks words roughly top-to-bottom, which is correct for one
column and wrong for two: it interleaves the left and right columns line by line,
producing sentences that alternate between unrelated paragraphs. On a report with
a sidebar it reads the sidebar into the middle of every paragraph.

So columns are detected first — by clustering word x-centres and looking for a
vertical gutter that no word crosses — and blocks are ordered column by column.
A single-column page trivially yields one cluster and behaves as before, which is
why this is safe to apply to every PDF rather than only to the ones that look
multi-column.

FIGURES ARE REGIONS, NOT MARKUP
-------------------------------
An image in a PDF has no alt text. What it has is a rectangle, a caption
somewhere near it, and possibly a lot of vector paths (which is what a chart is).
Those are the facts recorded here; describing the picture is a separate, gated
step (see govern_doc_figures) because it means sending the IMAGE to a model.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field

logger = logging.getLogger(__name__)

#: Minimum horizontal gap, in points, that no word crosses before it counts as a
#: column gutter. 24pt is about four characters at 12pt — narrower than any real
#: gutter and wider than inter-word spacing, which is where a smaller value starts
#: splitting ordinary sentences into columns.
_GUTTER_PT = 24.0

#: A column narrower than this is a margin note or a stray artefact, not a column.
_MIN_COLUMN_PT = 60.0

#: Vertical gap that ends a paragraph, as a multiple of the line height. Below
#: this a break is line wrapping; above it, a new block.
_PARAGRAPH_GAP = 1.6

#: A vector-path count above which a figure region is treated as a CHART rather
#: than a photograph. Charts are drawn (axes, ticks, series); photographs are one
#: image object. Deliberately generous — a mislabel costs a wrong hint, not data.
_CHART_PATH_COUNT = 12


@dataclass
class LayoutBlock:
    """One structural unit found on a page, with where it was found."""

    kind: str                       # paragraph | list | table | figure
    text: str
    page: int
    bbox: tuple[float, float, float, float]
    column: int = 0
    table_header: str | None = None
    meta: dict = field(default_factory=dict)


def _cluster_columns(words: list[dict], page_width: float) -> list[tuple[float, float]]:
    """Column x-ranges, left to right.

    Found by projecting every word onto the x axis and looking for vertical bands
    that no word occupies. A page whose words cover the width continuously yields
    one column, which is the common case and costs almost nothing to confirm.
    """
    if not words:
        return [(0.0, page_width)]
    spans = sorted((float(w["x0"]), float(w["x1"])) for w in words)
    merged: list[list[float]] = [list(spans[0])]
    for x0, x1 in spans[1:]:
        if x0 - merged[-1][1] > _GUTTER_PT:
            merged.append([x0, x1])
        else:
            merged[-1][1] = max(merged[-1][1], x1)
    columns = [(a, b) for a, b in merged if (b - a) >= _MIN_COLUMN_PT]
    return columns or [(0.0, page_width)]


def _column_of(word: dict, columns: list[tuple[float, float]]) -> int:
    centre = (float(word["x0"]) + float(word["x1"])) / 2
    for index, (x0, x1) in enumerate(columns):
        if x0 <= centre <= x1:
            return index
    # A word straddling a gutter (a full-width heading) belongs to the first
    # column: it reads before everything under it either way.
    return 0


def _group_lines(words: list[dict]) -> list[dict]:
    """Words into lines, by vertical overlap rather than exact `top` equality —
    superscripts and mixed font sizes make exact comparison useless."""
    lines: list[dict] = []
    for word in sorted(words, key=lambda w: (float(w["top"]), float(w["x0"]))):
        top, bottom = float(word["top"]), float(word["bottom"])
        placed = False
        for line in lines:
            if top < line["bottom"] and bottom > line["top"]:
                line["words"].append(word)
                line["top"] = min(line["top"], top)
                line["bottom"] = max(line["bottom"], bottom)
                placed = True
                break
        if not placed:
            lines.append({"top": top, "bottom": bottom, "words": [word]})
    for line in lines:
        line["words"].sort(key=lambda w: float(w["x0"]))
        line["text"] = " ".join(str(w.get("text") or "") for w in line["words"]).strip()
        line["x0"] = min(float(w["x0"]) for w in line["words"])
        line["x1"] = max(float(w["x1"]) for w in line["words"])
        sizes = [round(float(w.get("size") or 0), 1) for w in line["words"] if w.get("size")]
        line["size"] = max(sizes) if sizes else 0.0
        line["bold"] = any("bold" in str(w.get("fontname") or "").lower()
                           for w in line["words"])
    return sorted(lines, key=lambda line: line["top"])


#: A line must be this much larger than the page's body type before it counts as a
#: heading. 1.15 is deliberately close: many reports set headings only one point
#: above body text, and a stricter ratio finds none of them. Bold-and-short is
#: accepted separately for documents that never change size at all.
_HEADING_SIZE_RATIO = 1.15

#: A heading is short. Anything longer is a sentence that happens to be emphasised,
#: and promoting it would put a paragraph into every citation.
_HEADING_MAX_CHARS = 120


def body_size(lines: list[dict]) -> float:
    """The page's dominant font size — the baseline a heading is larger than.

    The MODE weighted by character count, not the mean: a page with one enormous
    title would drag a mean upwards and then nothing would look like a heading.
    """
    weights: dict[float, int] = {}
    for line in lines:
        size = line.get("size") or 0.0
        if size:
            weights[size] = weights.get(size, 0) + len(line.get("text") or "")
    if not weights:
        return 0.0
    return max(weights.items(), key=lambda kv: kv[1])[0]


def _heading_level(size: float, base: float, bold: bool, text: str) -> int:
    """Heading depth, or 0 for body text.

    Level comes from how far above the body size the line sits, capped at 3 —
    finer gradations than that are typographic, not structural, and a deeper tree
    makes heading paths long without making them more precise.
    """
    if len(text) > _HEADING_MAX_CHARS or not text:
        return 0
    if base and size >= base * 1.6:
        return 1
    if base and size >= base * 1.3:
        return 2
    if base and size >= base * _HEADING_SIZE_RATIO:
        return 3
    # A document that never varies size still marks its headings — usually bold,
    # short, and not ending in a full stop.
    if bold and len(text) <= 80 and not text.rstrip().endswith((".", ",", ";", ":")):
        return 3
    return 0


def _looks_like_list(text: str) -> bool:
    stripped = text.lstrip()
    if not stripped:
        return False
    if stripped[0] in "-•·*◦▪":
        return True
    head = stripped.split(" ", 1)[0].rstrip(".)")
    return head.isdigit() and len(head) <= 2


def _blocks_from_lines(lines: list[dict], page: int, column: int,
                       base_size: float = 0.0) -> list[LayoutBlock]:
    """Consecutive lines into paragraphs, split on vertical gaps, bullets and
    headings. A heading always ends the block before it and becomes its own
    `section` block, so a paragraph never carries the title above it."""
    blocks: list[LayoutBlock] = []
    current: list[dict] = []

    def flush() -> None:
        nonlocal current
        if not current:
            return
        text = " ".join(line["text"] for line in current).strip()
        if text:
            blocks.append(LayoutBlock(
                kind="list" if _looks_like_list(current[0]["text"]) else "paragraph",
                text=text,
                page=page,
                bbox=(min(line["x0"] for line in current),
                      min(line["top"] for line in current),
                      max(line["x1"] for line in current),
                      max(line["bottom"] for line in current)),
                column=column,
            ))
        current = []

    for line in lines:
        if not line["text"]:
            continue
        level = _heading_level(line.get("size") or 0.0, base_size,
                               bool(line.get("bold")), line["text"])
        if level:
            flush()
            blocks.append(LayoutBlock(
                kind="section", text=line["text"], page=page,
                bbox=(line["x0"], line["top"], line["x1"], line["bottom"]),
                column=column, meta={"level": level, "size": line.get("size")},
            ))
            continue
        if current:
            previous = current[-1]
            height = max(1.0, previous["bottom"] - previous["top"])
            gap = line["top"] - previous["bottom"]
            starts_list = _looks_like_list(line["text"])
            was_list = _looks_like_list(current[0]["text"])
            if gap > height * _PARAGRAPH_GAP or starts_list != was_list:
                flush()
        current.append(line)
    flush()
    return blocks


def _figure_blocks(page, page_number: int) -> list[LayoutBlock]:
    """Image and chart regions on the page.

    A photograph is one image object. A chart is a cluster of vector paths — axes,
    ticks, a series — so a region dense with paths is flagged as one. The flag is a
    HINT recorded in meta, not a claim: describing what a figure shows needs a
    model, and that is a separate, permission-gated step.
    """
    blocks: list[LayoutBlock] = []
    try:
        images = list(getattr(page, "images", []) or [])
    except Exception:  # noqa: BLE001
        images = []
    for index, image in enumerate(images):
        try:
            bbox = (float(image["x0"]), float(image["top"]),
                    float(image["x1"]), float(image["bottom"]))
        except Exception:  # noqa: BLE001
            continue
        blocks.append(LayoutBlock(
            kind="figure", text="", page=page_number, bbox=bbox,
            meta={"figure_index": index, "source": "image"},
        ))

    # A chart drawn with vector paths leaves no image object at all, so a page of
    # charts would otherwise report no figures whatsoever.
    try:
        curves = list(getattr(page, "curves", []) or []) + list(getattr(page, "lines", []) or [])
    except Exception:  # noqa: BLE001
        curves = []
    if len(curves) >= _CHART_PATH_COUNT and not images:
        xs = [float(c["x0"]) for c in curves] + [float(c["x1"]) for c in curves]
        ys = [float(c["top"]) for c in curves] + [float(c["bottom"]) for c in curves]
        blocks.append(LayoutBlock(
            kind="figure", text="", page=page_number,
            bbox=(min(xs), min(ys), max(xs), max(ys)),
            meta={"source": "vector", "chart": True, "path_count": len(curves)},
        ))
    return blocks


def _attach_captions(blocks: list[LayoutBlock]) -> None:
    """Give each figure the nearest text below it, else above it, on the same page.

    Below first because that is where captions overwhelmingly sit. A caption is
    COPIED into the figure's text rather than moved, so the paragraph still reads
    normally in document order — a figure whose only description is elsewhere in
    the flow is a figure the retriever cannot find.
    """
    figures = [b for b in blocks if b.kind == "figure"]
    text_blocks = [b for b in blocks if b.kind in ("paragraph", "list")]
    for figure in figures:
        below = [b for b in text_blocks
                 if b.page == figure.page and b.bbox[1] >= figure.bbox[3]]
        above = [b for b in text_blocks
                 if b.page == figure.page and b.bbox[3] <= figure.bbox[1]]
        candidate = None
        if below:
            candidate = min(below, key=lambda b: b.bbox[1] - figure.bbox[3])
        elif above:
            candidate = min(above, key=lambda b: figure.bbox[1] - b.bbox[3])
        if candidate is not None and len(candidate.text) <= 300:
            figure.text = candidate.text
            figure.meta["caption_from"] = "below" if below else "above"


def page_blocks(page, page_number: int, table_bboxes: list[tuple] | None = None) -> list[LayoutBlock]:
    """Every block on one pdfplumber page, in reading order.

    `table_bboxes` are excluded from the prose pass so a table's cells are not
    also emitted as sentences — the table itself is added by the caller, which
    already has the extracted cells.
    """
    boxes = list(table_bboxes or [])

    def outside_tables(obj) -> bool:
        cx = (float(obj["x0"]) + float(obj["x1"])) / 2
        cy = (float(obj["top"]) + float(obj["bottom"])) / 2
        return not any(b[0] <= cx <= b[2] and b[1] <= cy <= b[3] for b in boxes)

    try:
        # `size` is requested because a PDF has no headings — it has TYPE. Without
        # font size there is no way to tell a section title from a sentence, and a
        # citation that cannot name a section can only say "page 4".
        words = page.extract_words(
            use_text_flow=False, keep_blank_chars=False,
            extra_attrs=["size", "fontname"],
        ) or []
    except Exception:  # noqa: BLE001
        logger.warning("pdf_layout: word extraction failed on page %s", page_number, exc_info=True)
        words = []
    if boxes:
        words = [w for w in words if outside_tables(w)]

    columns = _cluster_columns(words, float(getattr(page, "width", 612) or 612))
    # The body size is measured across the WHOLE page, not per column: a sidebar
    # set in smaller type would otherwise make its own body size the baseline and
    # promote its ordinary sentences to headings.
    base = body_size(_group_lines(words))
    blocks: list[LayoutBlock] = []
    for index in range(len(columns)):
        column_words = [w for w in words if _column_of(w, columns) == index]
        blocks.extend(_blocks_from_lines(
            _group_lines(column_words), page_number, index, base_size=base))

    blocks.extend(_figure_blocks(page, page_number))
    _attach_captions(blocks)

    # Reading order: column first, then down the page. For one column this is
    # plain top-to-bottom.
    blocks.sort(key=lambda b: (b.column, b.bbox[1], b.bbox[0]))
    return blocks
