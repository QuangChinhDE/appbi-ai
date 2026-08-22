"""A citation that still opens the right text a year later.

WHAT WAS BROKEN
---------------
A citation recorded `{doc_id, source_version, block}` and there was no way to act
on it. `govern_doc_block` holds exactly ONE version of a document — `persist_ast`
deletes every row and rewrites — so document 27, cited at version 5, has only
version 6 in the block table today. Resolving `block: 3` against it returns
version 6's third block: different text, same coordinates, no warning. That is
precisely what section 9 forbids — "không được silently chuyển citation cũ sang
nội dung document mới".

The bodies were never lost: `govern_knowledge_doc_versions` keeps a snapshot per
version, and the markdown parser is a pure function of the body. So the old text is
recoverable; nothing was reading it.

HOW RESOLUTION WORKS, AND WHY IT VERIFIES
-----------------------------------------
    1. current version  → read the block table, which is the same content
    2. older version    → rebuild that version's blocks from its stored body
    3. EITHER WAY       → check the content fingerprint recorded in the citation

Step 3 is the point. An ordinal is a coordinate and coordinates move: a file
document's current tree may come from structured extraction (with bounding boxes)
while a historical version can only be rebuilt from markdown, and the two parsers
do not number blocks identically. When the fingerprint does not match, this
searches the version for the block that DOES match, and when nothing matches it
says the source has changed rather than showing the wrong paragraph confidently.

A citation that cannot be resolved is a normal outcome — a document can be deleted,
a version pruned — and it returns a reason, not an exception.

ANCHORS ARE PER SOURCE TYPE
---------------------------
"Where is this" means something different for each kind of source, so the anchor
is built from what that source actually records:

    file (PDF)    page number, and the bounding box when the layout pass found one
    google_doc    the heading path — a Google Doc has no pages until it is printed
    web           the source URL plus the heading
    xlsx          the SHEET, which the extractor writes as a heading. NOT a cell
                  range: `_extract_xlsx` flattens each sheet to one markdown table
                  and keeps no cell coordinates, so a range would be invented.
    authored      the heading path

Section 9 asks for a cell range on spreadsheets and a DOM anchor on web pages.
Neither exists in what the extractors record today; naming that here is more use
than an anchor that points at nothing.
"""
from __future__ import annotations

import hashlib
import logging
from typing import Any

logger = logging.getLogger(__name__)

#: Length of the content fingerprint. Twelve hex characters is 48 bits — ample for
#: "is this the same paragraph", and short enough to sit in a JSON payload that a
#: model will read.
_FINGERPRINT_CHARS = 12

RESOLVED = "resolved"
CHANGED = "source_changed"
MISSING_VERSION = "version_not_kept"
MISSING_DOC = "document_gone"
NOT_FOUND = "block_not_found"


def fingerprint(text: str) -> str:
    """A short, stable hash of a passage's MEANINGFUL characters.

    Folded and whitespace-collapsed first, so re-wrapping a paragraph or changing
    its capitalisation does not read as "the source changed" — the check exists to
    catch a citation pointing at different CONTENT, not at different formatting.
    """
    from app.core.text_fold import fold_text

    normalised = " ".join(fold_text(text or "").split())
    if not normalised:
        return ""
    return hashlib.sha256(normalised.encode("utf-8")).hexdigest()[:_FINGERPRINT_CHARS]


def anchor(row: dict, source_type: str | None) -> dict:
    """WHERE this passage is, in the terms its own source uses."""
    kind = (source_type or "authored").lower()
    out: dict[str, Any] = {"kind": kind}
    heading = row.get("heading_path")
    page = row.get("page")

    if kind == "file":
        out["page"] = page
        bbox = (row.get("meta") or {}).get("bbox") if isinstance(row.get("meta"), dict) else None
        if bbox:
            out["bbox"] = bbox
        out["heading_path"] = heading
        out["label"] = "trang %s" % page if page else (heading or "")
    elif kind == "web":
        out["url"] = row.get("source_url")
        out["heading_path"] = heading
        out["label"] = heading or out.get("url") or ""
    else:
        # google_doc, authored, and xlsx — whose sheet name IS the heading, because
        # `_extract_xlsx` writes each sheet as `## {sheet}`.
        out["heading_path"] = heading
        out["label"] = heading or ""
    return out


def build(row: dict, *, source_type: str | None = None) -> dict:
    """The citation for one retrieved passage.

    `block` is the anchor and `content` is the check on it. Neither is enough
    alone: an ordinal without a fingerprint silently drifts, and a fingerprint
    without an ordinal turns every resolution into a scan.
    """
    return {
        "doc_id": row.get("doc_id"),
        "document_version": row.get("source_version"),
        "title": row.get("title"),
        "heading_path": row.get("heading_path"),
        "page": row.get("page"),
        "block": row.get("block_from"),
        # The SPAN, not just its start. A chunk can cover several blocks, and the
        # chunker joins them with a blank line; the resolver has to rebuild exactly
        # that to compare fingerprints. Recording only `block_from` made every
        # citation to a multi-block chunk report "source changed" against its own
        # unmodified document.
        # `.get(key, default)` would be wrong here: the retriever always WRITES
        # `block_to`, sometimes as None, and a default only applies to an absent
        # key. A None span made the resolver rebuild nothing and report that an
        # untouched document had changed.
        "block_to": (row.get("block_to") if row.get("block_to") is not None
                     else row.get("block_from")),
        "block_kind": row.get("block_kind"),
        "chunk_id": row.get("chunk_id"),
        "source_type": source_type,
        "source_anchor": anchor(row, source_type),
        # What the passage SAID when it was cited. The whole point of a citation
        # that survives a re-publish.
        "content_fingerprint": fingerprint(row.get("content")),
    }


def _version_blocks(db: Any, doc_id: int, version: int) -> list[dict] | None:
    """That version's blocks, rebuilt from its stored body.

    The markdown parser is a pure function, so a version's body always produces the
    same blocks — which is what makes a historical citation resolvable at all.
    """
    from sqlalchemy import text as _text

    from app.services.dashboard_ai_bot.govern_doc_ast import _blocks_from_markdown

    row = db.execute(
        _text("SELECT body FROM govern_knowledge_doc_versions "
              "WHERE doc_id = :d AND version = :v"),
        {"d": doc_id, "v": version},
    ).first()
    if row is None or not row[0]:
        return None
    return _blocks_from_markdown(row[0])


def _current_blocks(db: Any, doc_id: int) -> list[dict]:
    from sqlalchemy import text as _text

    rows = db.execute(
        _text("SELECT ordinal, kind, text, heading_path, page "
              "FROM govern_doc_block WHERE doc_id = :d ORDER BY ordinal"),
        {"d": doc_id},
    ).fetchall()
    return [
        {"ordinal": r[0], "kind": r[1], "text": r[2], "heading_path": r[3], "page": r[4]}
        for r in rows
    ]


def resolve(db: Any, citation: dict) -> dict:
    """Open the exact text a citation names, or say why it cannot be opened.

    Returns `{status, text, heading_path, page, version, verified, note}`.
    `status` distinguishes the four ways this fails, because they need four
    different responses: the document is gone, that version was not kept, the
    ordinal points at nothing, or the source has been edited since.
    """
    from sqlalchemy import text as _text

    doc_id = citation.get("doc_id")
    wanted_version = citation.get("document_version")
    ordinal = citation.get("block")

    doc = db.execute(
        _text("SELECT id, title, published_version, source_type "
              "FROM govern_knowledge_docs WHERE id = :d"),
        {"d": doc_id},
    ).first()
    if doc is None:
        return _out(MISSING_DOC, note="tài liệu không còn tồn tại")

    current_version = doc[2]
    if wanted_version is None or wanted_version == current_version:
        blocks = _current_blocks(db, int(doc_id))
        which = current_version
    else:
        rebuilt = _version_blocks(db, int(doc_id), int(wanted_version))
        if rebuilt is None:
            return _out(MISSING_VERSION, version=wanted_version,
                        note="bản %s không còn được lưu; trích dẫn này không mở "
                             "lại được đúng nội dung đã dùng" % wanted_version)
        blocks = [{**b, "ordinal": i} for i, b in enumerate(rebuilt)]
        which = wanted_version

    expected = citation.get("content_fingerprint") or ""
    last = citation.get("block_to", ordinal)
    found = _span(blocks, ordinal, last)

    if found is not None and (not expected or fingerprint(found["text"]) == expected):
        return _out(RESOLVED, block=found, version=which, verified=bool(expected))

    # THE ORDINAL MOVED. Do not return what is at those coordinates now.
    #
    # A file document's live tree can come from structured extraction while a
    # historical version rebuilds from markdown, and the two do not number blocks
    # the same way. Searching by fingerprint finds the passage wherever it landed.
    if expected:
        match = next((b for b in blocks
                      if fingerprint(b.get("text")) == expected), None)
        if match is not None:
            return _out(RESOLVED, block=match, version=which, verified=True,
                        note="vị trí đã đổi (khối %s → %s) nhưng nội dung khớp"
                             % (ordinal, match.get("ordinal")))

    if found is not None:
        return _out(CHANGED, block=found, version=which, verified=False,
                    note="nội dung tại vị trí này đã thay đổi so với lúc trích dẫn")
    return _out(NOT_FOUND, version=which,
                note="không tìm thấy khối %s trong bản %s" % (ordinal, which))


def _span(blocks: list[dict], first: Any, last: Any) -> dict | None:
    """Blocks `first..last` joined the way the chunker joined them.

    `build_chunk_rows` joins a chunk's blocks with a BLANK LINE, so a fingerprint
    taken over a chunk only matches when the resolver rebuilds the same span the
    same way. Comparing a multi-block chunk against a single block was how a
    citation to an unmodified document reported that its source had changed.
    """
    if first is None:
        return None
    try:
        first_i, last_i = int(first), int(last if last is not None else first)
    except (TypeError, ValueError):
        return None
    members = [b for b in blocks
               if b.get("ordinal") is not None and first_i <= int(b["ordinal"]) <= last_i]
    if not members:
        return None
    head = members[0]
    return {
        "ordinal": head.get("ordinal"),
        "kind": head.get("kind"),
        "heading_path": head.get("heading_path"),
        "page": head.get("page"),
        "text": _BLANK_LINE.join(str(b.get("text") or "") for b in members).strip(),
    }


#: The separator `build_chunk_rows` uses between the blocks of one chunk. Named so
#: the two places that must agree can be seen to agree.
_BLANK_LINE = "\n\n"


def _out(status: str, *, block: dict | None = None, version: Any = None,
         verified: bool = False, note: str | None = None) -> dict:
    return {
        "status": status,
        "resolved": status == RESOLVED,
        "version": version,
        "text": (block or {}).get("text"),
        "heading_path": (block or {}).get("heading_path"),
        "page": (block or {}).get("page"),
        "block": (block or {}).get("ordinal"),
        "block_kind": (block or {}).get("kind"),
        # Did the CONTENT check pass, as opposed to merely finding something at the
        # coordinates? A citation resolved without verification is a guess that
        # happened to land.
        "verified": verified,
        "note": note,
    }
