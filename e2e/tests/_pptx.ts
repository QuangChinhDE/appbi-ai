import { execFileSync } from 'node:child_process';

/**
 * Reads a REAL generated .pptx (python-pptx + Pillow, the backend's own
 * dependencies) and reports, per slide, what a person opening the deck gets:
 * every text box, every native table (all rows), and every picture — with the
 * title text box placed right above it and two measurements of the picture:
 *
 *   ink:   the share of pixels in the PLOT area that differ from the card's own
 *          background (the header strip and the card border are excluded, so a
 *          frame-only or badge-only capture reads ~0);
 *   amber: pixels of the author-only filter-diagnostic badge colour anywhere in
 *          the picture (it is editor chrome, never presentation content).
 */
const READER = String.raw`
import io, json, sys
from pptx import Presentation
from PIL import Image

def measure(blob):
    im = Image.open(io.BytesIO(blob)).convert("RGB")
    w, h = im.size
    px = im.load()
    mx = max(6, int(min(w, h) * 0.04))
    ref = px[mx, int(h * 0.5)] if w > 2 * mx else (255, 255, 255)
    # the plot area: below the header strip, inside the card border
    x0, x1 = mx, w - mx
    y0, y1 = max(mx, int(h * 0.2)), h - mx
    ink = 0
    area = max(1, (x1 - x0) * (y1 - y0))
    for y in range(y0, y1, 2):
        for x in range(x0, x1, 2):
            r, g, b = px[x, y]
            if max(abs(r - ref[0]), abs(g - ref[1]), abs(b - ref[2])) > 40:
                ink += 4
    # the badge lives in the header strip: amber-200 border (253,230,138) and
    # amber-700 text/icon (180,83,9); a chart's own orange series sits lower down
    amber = 0
    for y in range(0, max(1, int(h * 0.2)), 2):
        for x in range(0, w, 2):
            r, g, b = px[x, y]
            for (cr, cg, cb) in ((253, 230, 138), (180, 83, 9)):
                if abs(r - cr) < 22 and abs(g - cg) < 22 and abs(b - cb) < 22:
                    amber += 4
                    break
    return {"w": w, "h": h, "ink": round(ink / area, 4), "amber": amber}

prs = Presentation(sys.argv[1])
out = {"slide_w": prs.slide_width, "slide_h": prs.slide_height, "slides": []}
for s in prs.slides:
    texts, tables, pictures, boxes, off = [], [], [], [], 0
    for sh in s.shapes:
        if sh.top + sh.height > prs.slide_height or sh.left + sh.width > prs.slide_width:
            off += 1
        if sh.has_text_frame and sh.text_frame.text:
            texts.append(sh.text_frame.text)
            boxes.append((sh.left, sh.top, sh.width, sh.height, sh.text_frame.text))
    for sh in s.shapes:
        if sh.has_table:
            tables.append([[c.text for c in r.cells] for r in sh.table.rows])
        if sh.shape_type == 13:
            title = None
            for (l, t, w, hh, txt) in boxes:
                if abs(l - sh.left) < sh.width and 0 <= sh.top - (t + hh) < 120000:
                    title = txt
            m = measure(sh.image.blob)
            m.update({"title": title, "left": sh.left, "top": sh.top, "width": sh.width, "height": sh.height})
            pictures.append(m)
    top = min([sh.top for sh in s.shapes if not (sh.has_text_frame and sh.top < 950000)] or [0])
    out["slides"].append({"texts": texts, "tables": tables, "pictures": pictures, "off": off, "content_top": top})
print(json.dumps(out, ensure_ascii=False))
`;

export type DeckPicture = { title: string | null; w: number; h: number; ink: number; amber: number; left: number; top: number; width: number; height: number };
export type DeckSlide = { texts: string[]; tables: string[][][]; pictures: DeckPicture[]; off: number; content_top: number };
export type Deck = { slide_w: number; slide_h: number; slides: DeckSlide[] };

export function readDeck(path: string): Deck {
  return JSON.parse(execFileSync('python', ['-c', READER, path], {
    encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' }, maxBuffer: 64 * 1024 * 1024,
  }));
}

/** A chart picture is real content when its plot area carries ink (fixture charts
 *  have axes, gridlines, bars, lines or sectors — a frame-only capture reads 0). */
export const MIN_CHART_INK = 0.004;
