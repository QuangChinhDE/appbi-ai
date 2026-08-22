"""The document AST: built once per version, projected into chunks many times.

TWO GATES, NOT ONE
------------------
Indexing used to be gated on a single hash covering the body, the model and the
chunk profile. Any change to any of them re-ran the whole pipeline — including
extraction, which for a scanned PDF means running OCR again. The chunker version
moved three times in one session and re-extracted every document each time.

So there are two now, and they invalidate for different reasons:

    ast_hash        the SOURCE changed (a new published version, a re-sync)
                    -> re-extract, rebuild the AST
    embedded_hash   the CHUNKER or the MODEL changed
                    -> re-chunk from the existing AST, re-embed. No extraction.

CITATIONS SURVIVE A RE-CHUNK
----------------------------
A chunk's id is regenerated whenever it is re-indexed, so a citation recorded
against one pointed at nothing afterwards. A block's `ordinal` is stable for the
life of a document version, so `(doc_id, source_version, ordinal)` is an anchor
that a re-chunk does not move. Chunks carry `block_from`/`block_to`, which is what
turns a retrieved passage back into a citation.

WHERE THE BLOCKS COME FROM
--------------------------
Two front-ends, one AST:

  * A FILE source has structured extraction — bounding boxes, columns, figure
    regions — stored on the upload. That is preferred, but only while it still
    matches what was published: if an author edited the extracted text, the
    structured form describes something else and the published markdown wins.
  * Everything else (typed, web, Google Docs) is markdown, parsed for structure.

Both paths produce the same block rows, so nothing downstream knows the difference.
"""
from __future__ import annotations

import hashlib
import json
import logging

from sqlalchemy import text
from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)

#: Bumped when the EXTRACTION or the AST shape changes — not when the chunker
#: does. That separation is the whole point of having two gates.
AST_VERSION = "a3"


def _hash(*parts: str) -> str:
    digest = hashlib.sha256("\n".join(parts).encode("utf-8")).hexdigest()
    return f"{AST_VERSION}:{digest}"


def _blocks_from_markdown(body: str) -> list[dict]:
    """Markdown to blocks. The structure is in the headings and the blank lines."""
    from app.services.dashboard_ai_bot.govern_doc_blocks import parse_blocks

    out: list[dict] = []
    for block in parse_blocks(body):
        out.append({
            "kind": block.kind,
            "text": block.text,
            "page": block.page,
            "bbox": None,
            "table_header": _table_header(block.text) if block.kind == "table" else None,
            # A STRING, matching what `ast_blocks` reads back from the database.
            # Two shapes for the same field is how the projection came to call
            # `.split()` on a list: the markdown front-end returned one form and
            # the AST the other, and only one of the two paths was exercised.
            "heading_path": " > ".join(block.heading_path) or None,
            "level": block.level,
            "meta": {},
        })
    return out


def _table_header(markdown: str) -> str | None:
    """The header row(s) of a markdown table, so any fragment can be re-headed."""
    lines = (markdown or "").split("\n")
    if len(lines) >= 2 and set(lines[1].strip()) <= set("|-: "):
        return "\n".join(lines[:2])
    return None


def _blocks_from_structured(raw: list[dict]) -> list[dict]:
    """Layout blocks from the PDF extractor, with heading nesting resolved.

    The extractor emits `section` blocks with a LEVEL but no path — it sees one
    page at a time and a heading path spans pages. Resolving it here keeps the
    extractor stateless and puts the tree-building in one place.
    """
    out: list[dict] = []
    stack: list[tuple[int, str]] = []
    for item in raw:
        kind = item.get("kind") or "paragraph"
        meta = dict(item.get("meta") or {})
        level = int(meta.pop("level", 0) or 0)
        text_value = (item.get("text") or "").strip()
        if kind == "section" and text_value:
            while stack and stack[-1][0] >= level:
                stack.pop()
            stack.append((level, text_value))
        out.append({
            "kind": kind,
            "text": text_value,
            "page": item.get("page"),
            "bbox": item.get("bbox"),
            "table_header": item.get("table_header"),
            "heading_path": " > ".join(title for _lvl, title in stack) or None,
            "level": level,
            "meta": meta,
        })
    return out


def source_blocks(db: Session, doc) -> tuple[list[dict], int, str]:
    """`(blocks, source_version, ast_hash)` for the version being served.

    `source_version` is 0 for a document that never published explicitly, which is
    what `published_body()` falls back to — recording it means the AST can never
    silently describe a version nobody published.
    """
    from app.services.governance_service import GovernanceService

    body = (GovernanceService.published_body(db, doc) or "").strip()
    version = int(getattr(doc, "published_version", 0) or 0)

    structured: list[dict] | None = None
    if (getattr(doc, "source_type", None) or "") == "file":
        try:
            row = db.execute(
                text(
                    "SELECT extracted_blocks, extracted_body_hash "
                    "FROM govern_doc_source_files WHERE doc_id = :d"
                ),
                {"d": doc.id},
            ).first()
        except Exception:  # noqa: BLE001
            row = None
        if row and row[0]:
            body_digest = hashlib.sha256(body.encode("utf-8")).hexdigest()
            if row[1] == body_digest:
                structured = row[0] if isinstance(row[0], list) else json.loads(row[0])
            else:
                # The author edited the extracted text. The structured form now
                # describes something they did not publish, so it is not used —
                # and saying so beats silently indexing the older geometry.
                logger.info(
                    "govern_doc_ast: doc %s has edited extracted text; using the "
                    "published markdown instead of the stored layout", doc.id,
                )

    blocks = _blocks_from_structured(structured) if structured else _blocks_from_markdown(body)
    # A figure's text is its caption, never its URL. Done HERE, before the AST is
    # persisted, so the stored tree is already clean and no consumer re-derives
    # it: the Google Docs exporter's `![Google Docs image 3](https://lh7-rt…)`
    # was being chunked and embedded verbatim, 13% of this corpus's vectors.
    from app.services.govern_doc_sources.figure_text import resolve_figures

    figure_info = resolve_figures(blocks)
    # A figure with no caption gets a described one, but only if this document's
    # owner allowed sending pictures out. The policy is part of the fingerprint
    # below for exactly this reason: a tree built without descriptions and a tree
    # built with them are different trees, so flipping the policy has to rebuild.
    if figure_info["no_text"]:
        from app.services.govern_doc_sources.figure_vision import describe_figures

        vision_info = describe_figures(db, doc, blocks)
        figure_info["vision"] = vision_info
        figure_info["described"] += vision_info["described"]
        figure_info["no_text"] -= vision_info["described"]
        logger.info("govern_doc_ast: doc %s vision %s", doc.id, vision_info)
    if figure_info["figures"]:
        logger.info(
            "govern_doc_ast: doc %s figures=%d described=%d (caption %d, alt %d) no_text=%d",
            doc.id, figure_info["figures"], figure_info["described"],
            figure_info["captioned"], figure_info["from_alt"], figure_info["no_text"],
        )
    from app.services.dashboard_ai_bot.govern_doc_embeddings import processing_policy

    fingerprint = _hash(
        str(version),
        "structured" if structured else "markdown",
        # The processing policy decides whether figures carry a described caption
        # and whether cloud OCR was allowed to read the pages. Both change the
        # CONTENT of the tree, so a policy change that left the old tree in place
        # would be a permission change that never took effect.
        "policy=%s" % processing_policy(doc),
        body if not structured else json.dumps(structured, sort_keys=True, default=str),
    )
    return blocks, version, fingerprint


def persist_ast(db: Session, doc, blocks: list[dict], version: int) -> int:
    """Replace this document's AST. Returns how many blocks were written.

    Sections are inserted before their children so `parent_id` resolves in one
    pass, and the whole AST for the document is replaced rather than merged: a
    partially-updated tree is worse than a rebuilt one, and rebuilding is cheap
    once extraction is not part of it.
    """
    from app.services.dashboard_ai_bot.govern_doc_blocks import estimate_tokens

    db.execute(text("DELETE FROM govern_doc_block WHERE doc_id = :d"), {"d": doc.id})
    # ordinal -> row id, so a block can point at the section that contains it.
    section_ids: dict[int, int] = {}
    stack: list[tuple[int, int]] = []            # (level, ordinal)
    written = 0

    for ordinal, block in enumerate(blocks):
        kind = block.get("kind") or "paragraph"
        level = int(block.get("level") or 0)
        parent_id = None
        if kind == "section":
            while stack and stack[-1][0] >= level:
                stack.pop()
            parent_id = section_ids.get(stack[-1][1]) if stack else None
        elif stack:
            parent_id = section_ids.get(stack[-1][1])

        row_id = db.execute(
            text(
                """
                INSERT INTO govern_doc_block
                    (doc_id, source_version, ordinal, parent_id, kind, level, text,
                     heading_path, page, bbox, table_header, meta, token_count)
                VALUES (:d, :v, :o, :p, :k, :lvl, :t, :hp, :pg,
                        CAST(:bbox AS jsonb), :th, CAST(:meta AS jsonb), :tc)
                RETURNING id
                """
            ),
            {
                "d": doc.id, "v": version, "o": ordinal, "p": parent_id,
                "k": kind, "lvl": level, "t": block.get("text") or "",
                "hp": block.get("heading_path") or None,
                "pg": block.get("page"),
                "bbox": json.dumps(_bbox_dict(block.get("bbox"))) if block.get("bbox") else None,
                "th": block.get("table_header"),
                "meta": json.dumps(block.get("meta") or {}, default=str),
                "tc": estimate_tokens(block.get("text") or ""),
            },
        ).scalar()
        if kind == "section":
            section_ids[ordinal] = int(row_id)
            stack.append((level, ordinal))
        written += 1

    doc.ast_hash = None      # set by the caller once the whole build succeeded
    doc.ast_version = version
    return written


def _bbox_dict(bbox) -> dict | None:
    if not bbox:
        return None
    try:
        x0, y0, x1, y1 = (float(v) for v in bbox)
    except Exception:  # noqa: BLE001
        return None
    return {"x0": x0, "y0": y0, "x1": x1, "y1": y1}


def ensure_ast(db: Session, doc, *, force: bool = False) -> dict:
    """Build the AST if the source changed. Returns what happened.

    This is the gate that stops a chunker change from re-running extraction.
    """
    blocks, version, fingerprint = source_blocks(db, doc)
    if not blocks:
        db.execute(text("DELETE FROM govern_doc_block WHERE doc_id = :d"), {"d": doc.id})
        doc.ast_hash = None
        doc.ast_version = version
        return {"status": "empty", "blocks": 0, "version": version}

    if not force and doc.ast_hash == fingerprint:
        existing = db.execute(
            text("SELECT count(*) FROM govern_doc_block WHERE doc_id = :d AND source_version = :v"),
            {"d": doc.id, "v": version},
        ).scalar() or 0
        if existing:
            return {"status": "unchanged", "blocks": int(existing), "version": version}

    written = persist_ast(db, doc, blocks, version)
    doc.ast_hash = fingerprint
    doc.ast_version = version
    return {"status": "built", "blocks": written, "version": version}


def ast_blocks(db: Session, doc) -> list[dict]:
    """The live AST, in document order. What the chunker reads."""
    rows = db.execute(
        text(
            """
            SELECT ordinal, kind, level, text, heading_path, page, bbox,
                   table_header, meta, token_count
            FROM govern_doc_block
            WHERE doc_id = :d AND source_version = :v
            ORDER BY ordinal
            """
        ),
        {"d": doc.id, "v": int(getattr(doc, "ast_version", 0) or 0)},
    ).fetchall()
    return [
        {
            "ordinal": int(r[0]), "kind": r[1], "level": int(r[2] or 0),
            "text": r[3] or "", "heading_path": r[4], "page": r[5],
            "bbox": r[6], "table_header": r[7], "meta": r[8] or {},
            "token_count": int(r[9] or 0),
        }
        for r in rows
    ]


def outline(db: Session, doc) -> list[dict]:
    """The document's section tree — what an AST is FOR, beyond chunking.

    Exposed because a structure you cannot look at is a structure nobody can check,
    and because "which sections does this document have" is the question an author
    asks when a citation looks wrong.
    """
    rows = db.execute(
        text(
            """
            SELECT ordinal, level, text, heading_path, page
            FROM govern_doc_block
            WHERE doc_id = :d AND source_version = :v AND kind = 'section'
            ORDER BY ordinal
            """
        ),
        {"d": doc.id, "v": int(getattr(doc, "ast_version", 0) or 0)},
    ).fetchall()
    return [
        {"ordinal": int(r[0]), "level": int(r[1] or 0), "title": r[2],
         "heading_path": r[3], "page": r[4]}
        for r in rows
    ]
