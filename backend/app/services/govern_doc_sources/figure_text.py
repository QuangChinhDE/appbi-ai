"""What a figure contributes to a searchable index — which is never its URL.

THE BUG THIS FIXES
------------------
A Google Doc exports every image as `![Google Docs image 3](https://lh7-rt.goog
leusercontent.com/docsz/AD_4nXcx…)` — a generated alt text carrying no
information and a 400-character signed URL. The markdown path kept that line as
the block's text, so it was chunked, embedded, and indexed: 11 of 82 chunks in
this corpus, 13% of the index, were vectors whose content was a base64 blob.

That is not merely wasteful. It is three separate defects:

  * ELEVEN embedding calls per re-index buying nothing
  * eleven slots in every ANN candidate pool, competing with real passages
  * a passage that can be RETURNED to the model as a numbered source, so an
    answer's citation points at a URL nobody can read

WHAT A FIGURE'S TEXT ACTUALLY IS
-------------------------------
In order of preference:

  1. its CAPTION — the line beneath it, which is what a human reads to know what
     the picture shows; the PDF layout pass already finds this geometrically
  2. its ALT text, but only when a human wrote it. "Google Docs image 3",
     "image001.png", "Screenshot 2026-02-11 at 14.03" are placeholders emitted
     by an exporter, and treating them as content is how the noise got in
  3. a VISION description, when the document's policy permits sending the image
     to a provider (see figure_vision)

A figure with none of those has no text. It stays in the AST — so it is still
citable, still counted, and still there for a later vision pass to fill — but it
does not become a vector. An index is a claim about what can be found; a vector
with no meaning is a false claim.

THE URL IS NOT LOST
-------------------
It moves to `meta.src`, where it belongs: an anchor for the citation and the
input a vision pass needs. Structure keeps it; the embedding does not carry it.
"""
from __future__ import annotations

import re

#: `![alt](src)` — the only image syntax any of our extractors emit.
_IMAGE_RE = re.compile(r"!\[([^\]]*)\]\(([^)\s]+)(?:\s+\"[^\"]*\")?\)")

#: Alt texts an EXPORTER wrote, not a person. Matched against the folded form, so
#: accents and case do not matter. Each entry here was observed in a real export:
#: Google Docs numbers its images, Word keeps the embedded filename, screenshot
#: tools stamp a timestamp, and Confluence/Notion emit the storage key.
_PLACEHOLDER_ALT = (
    re.compile(r"^(google docs |)image[\s_-]*\d*$"),
    re.compile(r"^(unnamed|untitled|picture|hinh|anh|figure|fig)[\s_-]*\d*$"),
    re.compile(r"^screenshot\b"),
    re.compile(r"^(image|img|pasted image|download)[\s_-]*\d*\.(png|jpe?g|gif|webp|svg)$"),
    re.compile(r"^[0-9a-f]{8,}$"),                    # a storage key
    re.compile(r"^[\w-]{0,40}\.(png|jpe?g|gif|webp|svg|emf|wmf)$"),  # a bare filename
)

#: A caption shorter than this is a label ("Hình 1", "a)"), not a description. It
#: is kept as structure but is too thin to be worth its own vector.
_MIN_CAPTION_CHARS = 12

#: How far after a figure to look for its caption, in blocks. One: the caption is
#: the line beneath the picture. Two would reach the next paragraph, which is
#: about the topic rather than about the image.
_CAPTION_RADIUS = 1

#: Caption openers. A paragraph starting this way is talking ABOUT the figure
#: rather than continuing the prose, which is what makes it a caption and not
#: merely the next sentence.
_CAPTION_HINT = re.compile(
    r"^\s*(hình|hinh|ảnh|anh|biểu\s*đồ|bieu\s*do|sơ\s*đồ|so\s*do|bảng|bang|"
    r"figure|fig\.?|chart|diagram|image|table)\s*[\d.:)–-]*\s*",
    re.IGNORECASE,
)


def parse_image(line: str) -> dict | None:
    """`{alt, src}` for the first image in a line, or None.

    Returns the RAW alt — deciding whether it is informative is a separate
    question with a separate answer, and conflating them is how a placeholder
    ends up treated as a caption.
    """
    match = _IMAGE_RE.search(line or "")
    if not match:
        return None
    return {"alt": (match.group(1) or "").strip(), "src": (match.group(2) or "").strip()}


def alt_is_informative(alt: str) -> bool:
    """Did a HUMAN write this alt text?

    The test is negative on purpose: anything matching a known exporter pattern is
    rejected, everything else is trusted. Guessing which unfamiliar strings are
    meaningful would throw away real alt text, and a real alt text is the best
    description a figure can have short of looking at it.
    """
    from app.core.text_fold import fold_text

    folded = fold_text(alt or "").strip()
    if len(folded) < 3:
        return False
    return not any(pattern.match(folded) for pattern in _PLACEHOLDER_ALT)


def strip_images(text: str) -> str:
    """The prose of a block with its image syntax removed.

    A paragraph that mentions an image mid-sentence keeps its sentence; only the
    `![…](…)` markup goes. Whitespace is collapsed so a line that was ONLY an
    image becomes empty rather than a stray space.
    """
    return re.sub(r"[ \t]{2,}", " ", _IMAGE_RE.sub("", text or "")).strip()


def resolve_figures(blocks: list[dict]) -> dict:
    """Rewrite figure blocks in place: URL out of the text, caption in.

    Operates on the block list the AST is built from, BEFORE persistence, so the
    stored AST is already clean and no consumer has to re-derive this. Returns
    counts for the indexing report: a corpus where every figure is `described:0`
    is a corpus that needs a vision pass, and that should be visible without
    running a query.

    Deliberately does not delete a text-less figure. Structure is what makes the
    figure citable ("trang 4, hình dưới mục 2.1") and what a later vision pass
    fills in. Only EMBEDDING is withheld, by the chunker, on the same test.
    """
    described = 0
    captioned = 0
    from_alt = 0
    blank = 0

    for index, block in enumerate(blocks):
        if block.get("kind") != "figure":
            continue
        meta = dict(block.get("meta") or {})
        raw = str(block.get("text") or "")
        image = parse_image(raw)

        if image:
            if image["src"]:
                meta.setdefault("src", image["src"])
            if image["alt"]:
                meta.setdefault("alt", image["alt"])

        # Whatever prose was on the same line as the image, minus the markup.
        own = strip_images(raw)

        caption = str(meta.get("caption") or "").strip()
        if not caption and own and len(own) >= _MIN_CAPTION_CHARS:
            caption = own
            meta.setdefault("caption_from", "inline")

        # The line beneath the figure, when it reads like a caption. The PDF path
        # already does this geometrically; the markdown path has no geometry, so
        # the signal is the opener ("Hình 3:", "Biểu đồ doanh thu…").
        if not caption:
            for offset in range(1, _CAPTION_RADIUS + 1):
                if index + offset >= len(blocks):
                    break
                nxt = blocks[index + offset]
                if nxt.get("kind") not in ("paragraph", "list"):
                    break
                candidate = str(nxt.get("text") or "").strip()
                if _CAPTION_HINT.match(candidate) and len(candidate) >= _MIN_CAPTION_CHARS:
                    caption = candidate
                    meta.setdefault("caption_from", "below")
                    break

        alt = str(meta.get("alt") or "")
        text_out = caption
        if text_out:
            captioned += 1
        elif alt_is_informative(alt):
            text_out = alt
            meta.setdefault("caption_from", "alt")
            from_alt += 1
        elif meta.get("vision_description"):
            text_out = str(meta["vision_description"])
        else:
            text_out = ""
            blank += 1

        if text_out:
            described += 1
        block["text"] = text_out
        block["meta"] = meta

    return {"figures": described + blank, "described": described,
            "captioned": captioned, "from_alt": from_alt, "no_text": blank}
