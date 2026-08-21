"""The document's structure, as the thing that gets indexed.

WHY THERE IS NO SEPARATE AST TABLE
----------------------------------
The obvious design is a `govern_doc_block` table holding the parsed document and
a `govern_doc_chunk` table holding what was embedded. That stores the same prose
twice — and every table holding text derived from a document has to carry the
document's status, space and trust labels and sit behind the same row-level
policy, or the isolation that was just closed reopens through the new table.

So the chunk IS the block. One row per structural unit, carrying where it came
from: its heading path, its kind, its page. That is enough to cite a passage, and
it costs no second copy of the text and no second permission surface.

SMALL TO BIG, IN ONE TABLE
--------------------------
Two levels of row:

    level 0   a SECTION. Never embedded, so retrieval — which already requires
              `embedding IS NOT NULL` — cannot return one by accident. It exists
              to be handed to the model as the context around a hit.
    level 1   a CHILD. Embedded and searched. Small enough to be precise about
              which passage answered, with `parent_id` pointing at the section it
              belongs to.

The existing retrieval filter therefore needed no change to keep sections out of
search results, which is the sort of thing worth designing for on purpose.

WHAT IS EMBEDDED IS NOT WHAT IS STORED
--------------------------------------
A child is embedded together with a CONTEXT PREFIX — the document title and the
heading path above it — because "Mục tiêu: ≥ 92%" is unsearchable on its own and
unambiguous under "Vận hành & Giao vận > Cam kết giao đúng hẹn (SLA)". The stored
`content` is the body alone, because that is what a reader should see quoted.

The prefix is limited to the title and the immediate heading path rather than the
full ancestor chain plus business metadata. `content_hash` covers the embedded
string, so anything in the prefix invalidates every descendant when it changes:
a wider prefix means renaming one heading re-embeds a whole document.

TABLES ARE NOT PROSE
--------------------
A markdown table split at a character boundary loses its header, and a row
without its header is a sequence of numbers with no meaning — the single worst
failure mode for a BI knowledge base. Tables are therefore kept whole, and when
one is genuinely too large it is split BY ROWS with the header repeated in every
piece.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

_HEADING_RE = re.compile(r"^(#{1,6})\s+(.*?)\s*#*$")
_PAGE_HEADING_RE = re.compile(r"^#{1,6}\s*page\s+(\d+)\s*$", re.I)
_TABLE_ROW_RE = re.compile(r"^\s*\|.*\|\s*$")
_TABLE_DIVIDER_RE = re.compile(r"^\s*\|[\s:|-]+\|\s*$")
_LIST_RE = re.compile(r"^\s*([-*+]|\d+[.)])\s+")
_IMAGE_RE = re.compile(r"!\[[^\]]*\]\([^)]+\)")
_TOKEN_RE = re.compile(r"\{\{[^}]+\}\}")

#: Rough characters-per-token for the mixed Vietnamese/English prose this corpus
#: holds, measured against `cl100k_base` on the demo documents.
#:
#: An ESTIMATE, deliberately. Exactness would mean `tiktoken`, which downloads its
#: BPE table from a Microsoft blob endpoint on first use — a runtime egress path
#: that the per-document `external_processing` veto would then have to cover, and
#: an offline install would break. Token counts here decide chunk SIZE, where a
#: 15% error changes nothing: the embedding model's real limit is 8191 tokens and
#: a chunk targets a few hundred. `estimate_tokens` is the seam if that trade ever
#: stops being worth it.
_CHARS_PER_TOKEN = 3.1


def estimate_tokens(text: str) -> int:
    """Approximate token count. See `_CHARS_PER_TOKEN` for why it approximates."""
    stripped = (text or "").strip()
    if not stripped:
        return 0
    return max(1, round(len(stripped) / _CHARS_PER_TOKEN))


@dataclass
class Block:
    """One structural unit of a document."""

    kind: str                    # prose | table | list | figure | heading
    text: str
    heading_path: tuple[str, ...] = ()
    page: int | None = None

    @property
    def tokens(self) -> int:
        return estimate_tokens(self.text)


@dataclass
class Section:
    """A heading and the blocks under it. Becomes one level-0 row."""

    heading_path: tuple[str, ...]
    page: int | None
    blocks: list[Block] = field(default_factory=list)

    @property
    def text(self) -> str:
        return "\n\n".join(b.text for b in self.blocks).strip()


def _clean(body: str | None) -> str:
    """Strip embed tokens, keep wikilink text.

    `{{metric:gmv}}` is a structural reference, not prose — but note what that
    means: metric references are INVISIBLE to search, which is why a question
    about a metric is answered by looking the metric up in the governance graph
    rather than by hoping the words happen to appear.
    """
    text = re.sub(r"\[\[([^\]|\n]+?)\|([^\]\n]+?)\]\]", r"\2", body or "")
    text = re.sub(r"\[\[([^\]\n]+?)\]\]", r"\1", text)
    return _TOKEN_RE.sub("", text)


def parse_blocks(body: str | None) -> list[Block]:
    """Markdown to a flat block list, each knowing its heading path and page.

    Page numbers come from the `## Page N` headings the PDF extractor already
    emits, so a PDF-sourced document gets citable page numbers with no second
    extraction pass — and those headings are consumed rather than becoming part
    of the heading path, where they would be noise.
    """
    lines = _clean(body).split("\n")
    blocks: list[Block] = []
    stack: list[tuple[int, str]] = []          # (heading level, title)
    page: int | None = None
    buffer: list[str] = []
    buffer_kind = "prose"

    def path() -> tuple[str, ...]:
        return tuple(title for _level, title in stack)

    def flush() -> None:
        nonlocal buffer, buffer_kind
        text = "\n".join(buffer).strip()
        if text:
            blocks.append(Block(kind=buffer_kind, text=text, heading_path=path(), page=page))
        buffer = []
        buffer_kind = "prose"

    index = 0
    while index < len(lines):
        line = lines[index]

        page_match = _PAGE_HEADING_RE.match(line.strip())
        if page_match:
            flush()
            page = int(page_match.group(1))
            index += 1
            continue

        heading = _HEADING_RE.match(line.strip()) if line.lstrip().startswith("#") else None
        if heading:
            flush()
            level = len(heading.group(1))
            title = heading.group(2).strip()
            while stack and stack[-1][0] >= level:
                stack.pop()
            if title:
                stack.append((level, title))
            index += 1
            continue

        # A table is consumed as ONE block: consecutive pipe rows.
        if _TABLE_ROW_RE.match(line):
            flush()
            rows = []
            while index < len(lines) and _TABLE_ROW_RE.match(lines[index]):
                rows.append(lines[index].rstrip())
                index += 1
            blocks.append(Block(kind="table", text="\n".join(rows),
                                heading_path=path(), page=page))
            continue

        if not line.strip():
            flush()
            index += 1
            continue

        kind = ("figure" if _IMAGE_RE.search(line)
                else "list" if _LIST_RE.match(line)
                else "prose")
        if buffer and kind != buffer_kind:
            flush()
        buffer_kind = kind
        buffer.append(line)
        index += 1

    flush()
    return blocks


def _split_table(block: Block, max_tokens: int) -> list[Block]:
    """Split a table by ROWS, repeating the header in every piece.

    A header-less fragment of a financial table is a row of numbers whose columns
    nobody can name. Repeating the header costs a few tokens per piece and is the
    difference between a citable fact and a guess.
    """
    lines = block.text.split("\n")
    header: list[str] = []
    body_rows = lines
    if len(lines) >= 2 and _TABLE_DIVIDER_RE.match(lines[1]):
        header, body_rows = lines[:2], lines[2:]
    if not body_rows:
        return [block]

    header_tokens = estimate_tokens("\n".join(header))
    out: list[Block] = []
    current: list[str] = []
    for row in body_rows:
        candidate = current + [row]
        if current and header_tokens + estimate_tokens("\n".join(candidate)) > max_tokens:
            out.append(Block(kind="table", text="\n".join(header + current),
                             heading_path=block.heading_path, page=block.page))
            current = [row]
        else:
            current = candidate
    if current:
        out.append(Block(kind="table", text="\n".join(header + current),
                         heading_path=block.heading_path, page=block.page))
    return out


def _split_prose(block: Block, max_tokens: int) -> list[Block]:
    """Split prose on sentence boundaries, falling back to a hard cut.

    Sentence boundaries rather than characters because a chunk that ends
    mid-clause reads as a different claim than the one the author made.
    """
    if block.tokens <= max_tokens:
        return [block]
    sentences = re.split(r"(?<=[.!?…])\s+", block.text)
    out: list[Block] = []
    current: list[str] = []
    for sentence in sentences:
        candidate = current + [sentence]
        if current and estimate_tokens(" ".join(candidate)) > max_tokens:
            out.append(Block(kind=block.kind, text=" ".join(current),
                             heading_path=block.heading_path, page=block.page))
            current = [sentence]
        else:
            current = candidate
    if current:
        out.append(Block(kind=block.kind, text=" ".join(current),
                         heading_path=block.heading_path, page=block.page))

    # A single sentence longer than the budget still has to fit somewhere.
    final: list[Block] = []
    hard = max(1, int(max_tokens * _CHARS_PER_TOKEN))
    for piece in out:
        if piece.tokens <= max_tokens * 1.5:
            final.append(piece)
            continue
        for start in range(0, len(piece.text), hard):
            final.append(Block(kind=piece.kind, text=piece.text[start:start + hard],
                               heading_path=piece.heading_path, page=piece.page))
    return final


def build_sections(body: str | None, *, child_tokens: int) -> list[Section]:
    """Group blocks under their heading, then size children within each section.

    Children never straddle a heading: a passage that spans two sections belongs
    to neither, and its citation would name the wrong one.
    """
    sections: list[Section] = []
    for block in parse_blocks(body):
        key = (block.heading_path, block.page)
        if not sections or (sections[-1].heading_path, sections[-1].page) != key:
            sections.append(Section(heading_path=block.heading_path, page=block.page))
        pieces = (_split_table(block, child_tokens) if block.kind == "table"
                  else _split_prose(block, child_tokens))
        sections[-1].blocks.extend(pieces)
    return sections


def merge_children(section: Section, *, child_tokens: int) -> list[Block]:
    """Pack a section's blocks into children of about `child_tokens`.

    A table is never merged with anything: mixing a table into a prose chunk
    makes both harder to read and destroys the "this passage is a table" signal
    the reader needs to interpret the numbers.
    """
    out: list[Block] = []
    current: list[Block] = []

    def flush() -> None:
        nonlocal current
        if current:
            out.append(Block(
                kind=current[0].kind if len(current) == 1 else "prose",
                text="\n\n".join(b.text for b in current),
                heading_path=section.heading_path,
                page=section.page,
            ))
            current = []

    for block in section.blocks:
        if block.kind == "table":
            flush()
            out.append(block)
            continue
        if current and estimate_tokens("\n\n".join(b.text for b in current + [block])) > child_tokens:
            flush()
        current.append(block)
    flush()
    return out


def heading_path_text(path: tuple[str, ...] | list[str] | None) -> str:
    return " > ".join(p for p in (path or []) if p)


def context_prefix(doc_title: str | None, path: tuple[str, ...] | list[str] | None,
                   page: int | None = None) -> str:
    """What is prepended to a child before embedding.

    Title plus heading path plus page, and nothing else. See the module docstring:
    the prefix is part of the hashed embedded string, so every field added here is
    a field whose edit re-embeds the entire document.
    """
    parts = [p for p in [(doc_title or "").strip(), heading_path_text(path)] if p]
    if page:
        parts.append("trang %d" % page)
    return " > ".join(parts)
