"""Fetch a Google Doc's text for a Govern Knowledge Doc with source_type ==
'google_doc'.

A document reads Google through a GOOGLE DOCS DATA SOURCE — the source owns the
Google credential, so different documents can read through different Google
accounts. Requires the 'documents.readonly' scope; a source connected before
that scope existed reports it up front instead of 403-ing mid-sync. Docs
connected under the older per-user model still resolve via that user.
"""
from __future__ import annotations

import logging
import re

from googleapiclient.discovery import build
from googleapiclient.errors import HttpError

logger = logging.getLogger(__name__)

_DOC_ID_RE = re.compile(r"/d/([a-zA-Z0-9_-]{15,})")

def _reconnect_msg(account: str | None, source_name: str | None = None) -> str:
    """Name the exact source + Google account to reconnect. The credential
    belongs to the data source, so telling the user "reconnect Google" without
    saying WHICH source sends them to the wrong place."""
    who = f" ({account})" if account else ""
    where = f' "{source_name}"' if source_name else ""
    return (
        f"The Google Docs source{where}{who} was connected without permission to read Docs. "
        f"Open Data Sources, press \"Connect Google\" on that source and approve Google Docs access."
    )


def extract_google_doc_id(ref: str) -> str:
    """Accept a full Google Docs URL or a bare document id; return the id."""
    ref = (ref or "").strip()
    m = _DOC_ID_RE.search(ref)
    return m.group(1) if m else ref


def _flatten(doc: dict) -> str:
    """Walk the Docs API structural document into markdown-ish text — headings
    come from paragraphStyle.namedStyleType, paragraphs are blank-line joined."""
    lines: list[str] = []
    for el in (doc.get("body") or {}).get("content", []):
        para = el.get("paragraph")
        if not para:
            continue
        text = "".join(
            (run.get("textRun") or {}).get("content", "")
            for run in para.get("elements", [])
        ).rstrip("\n")
        if not text.strip():
            continue
        style = (para.get("paragraphStyle") or {}).get("namedStyleType", "")
        if style == "HEADING_1":
            lines.append(f"# {text.strip()}")
        elif style == "HEADING_2":
            lines.append(f"## {text.strip()}")
        elif style == "HEADING_3":
            lines.append(f"### {text.strip()}")
        else:
            lines.append(text.strip())
    return "\n\n".join(lines).strip()


def _image_markdown(doc: dict, inline_object_id: str, index: int) -> str:
    obj = (doc.get("inlineObjects") or {}).get(inline_object_id) or {}
    embedded = ((obj.get("inlineObjectProperties") or {}).get("embeddedObject") or {})
    image = embedded.get("imageProperties") or {}
    url = image.get("sourceUri") or image.get("contentUri")
    if not url:
        return f"[Image {index}: {inline_object_id}]"
    alt = embedded.get("title") or embedded.get("description") or f"Google Docs image {index}"
    return f"![{str(alt).strip()}]({url})"


def _styled_text(raw: str, style: dict) -> str:
    text = raw.replace("\v", "\n").rstrip("\n")
    if not text:
        return ""
    link = (style.get("link") or {}).get("url")
    if link and text.strip():
        text = f"[{text.strip()}]({link})"
    if style.get("bold") and text.strip():
        text = f"**{text}**"
    if style.get("italic") and text.strip():
        text = f"*{text}*"
    return text


def _paragraph_markdown(doc: dict, para: dict, image_counter: list[int]) -> str:
    parts: list[str] = []
    for run in para.get("elements", []):
        if run.get("textRun"):
            tr = run.get("textRun") or {}
            parts.append(_styled_text(tr.get("content") or "", tr.get("textStyle") or {}))
        elif run.get("inlineObjectElement"):
            image_counter[0] += 1
            parts.append(_image_markdown(doc, (run.get("inlineObjectElement") or {}).get("inlineObjectId") or "", image_counter[0]))
    text = "".join(parts).strip()
    if not text:
        return ""
    style = (para.get("paragraphStyle") or {}).get("namedStyleType", "")
    if style.startswith("HEADING_"):
        try:
            level = max(1, min(6, int(style.rsplit("_", 1)[1])))
        except Exception:  # noqa: BLE001
            level = 2
        return f"{'#' * level} {text}"
    if para.get("bullet"):
        return f"- {text}"
    return text


def _cell_markdown(doc: dict, cell: dict, image_counter: list[int]) -> str:
    chunks: list[str] = []
    for content in cell.get("content", []):
        if content.get("paragraph"):
            part = _paragraph_markdown(doc, content["paragraph"], image_counter)
        elif content.get("table"):
            part = _table_markdown(doc, content["table"], image_counter)
        else:
            part = ""
        if part:
            chunks.append(part)
    return "<br>".join(chunks).replace("|", "\\|")


def _table_markdown(doc: dict, table: dict, image_counter: list[int]) -> str:
    rows: list[list[str]] = []
    for row in table.get("tableRows", []):
        cells = [_cell_markdown(doc, cell, image_counter) for cell in row.get("tableCells", [])]
        if any(c.strip() for c in cells):
            rows.append(cells)
    if not rows:
        return ""
    width = max(len(r) for r in rows)
    rows = [r + [""] * (width - len(r)) for r in rows]
    out = [
        "| " + " | ".join(rows[0]) + " |",
        "| " + " | ".join(["---"] * width) + " |",
    ]
    out.extend("| " + " | ".join(r) + " |" for r in rows[1:])
    return "\n".join(out)


def _flatten_rich(doc: dict) -> str:
    blocks: list[str] = []
    image_counter = [0]
    for el in (doc.get("body") or {}).get("content", []):
        if el.get("paragraph"):
            block = _paragraph_markdown(doc, el["paragraph"], image_counter)
        elif el.get("table"):
            block = _table_markdown(doc, el["table"], image_counter)
        else:
            block = ""
        if block.strip():
            blocks.append(block.strip())
    return "\n\n".join(blocks).strip()


def fetch_google_doc(doc_ref: str, *, google_oauth_user_id: str | None = None,
                     datasource_id: int | None = None) -> dict:
    """Returns {ok, title, text, error}. Never raises.

    `datasource_id` is the Google Docs source that carries the credential;
    `google_oauth_user_id` is the legacy per-user fallback.
    """
    from app.core.crypto import decrypt_config
    from app.core.database import SessionLocal
    from app.models.models import DataSource
    from app.models.user import User
    from app.services.google_data_access_service import (
        credentials_from_source_config, get_google_credentials_for_user_id,
        source_google_capabilities,
    )

    owner_email: str | None = None
    try:
        with SessionLocal() as db:
            creds = None
            if datasource_id:
                ds = db.query(DataSource).filter(DataSource.id == datasource_id).first()
                if not ds:
                    return {"ok": False, "error": "The connected Google Docs source no longer exists."}
                config = decrypt_config(ds.config or {})
                owner_email = config.get("google_oauth_email")
                # The source owns its Google credential — check the granted
                # scope BEFORE calling Google so the message is actionable.
                if config.get("google_oauth_credentials"):
                    if not source_google_capabilities(config).get("docs"):
                        return {"ok": False, "error": _reconnect_msg(owner_email, ds.name)}
                    creds = credentials_from_source_config(config)
                else:
                    google_oauth_user_id = google_oauth_user_id or config.get("google_oauth_user_id")

            if creds is None:  # legacy: credential still lives on the AppBI user
                uid = str(google_oauth_user_id or "").strip()
                if not uid:
                    return {"ok": False, "error": "No Google account is connected for this document. Pick a Google Docs source in the Source tab."}
                owner = db.query(User).filter(User.id == uid).first()
                if owner is None or not owner.google_oauth_credentials:
                    return {"ok": False, "error": "The Google account for this document is no longer connected."}
                owner_email = owner_email or getattr(owner, "google_oauth_email", None) or getattr(owner, "email", None)
                granted = list(getattr(owner, "google_oauth_scopes", None) or [])
                if granted and not any("documents" in s for s in granted):
                    return {"ok": False, "error": _reconnect_msg(owner_email)}
                creds = get_google_credentials_for_user_id(uid)
    except Exception as exc:  # noqa: BLE001
        logger.warning("google_doc_fetcher: failed resolving Google credentials", exc_info=True)
        return {"ok": False, "error": f"Failed to load Google connection: {exc}"}

    doc_id = extract_google_doc_id(doc_ref)
    if not doc_id:
        return {"ok": False, "error": "Could not read a document id from the given URL/id."}

    try:
        service = build("docs", "v1", credentials=creds, cache_discovery=False)
        doc = service.documents().get(documentId=doc_id).execute()
    except HttpError as exc:
        status = getattr(getattr(exc, "resp", None), "status", None)
        if status in (401, 403):
            return {"ok": False, "error": _reconnect_msg(owner_email)}
        logger.warning("google_doc_fetcher: HttpError fetching doc %s", doc_ref, exc_info=True)
        return {"ok": False, "error": f"Google Docs API error: {exc}"}
    except Exception as exc:  # noqa: BLE001
        logger.warning("google_doc_fetcher: failed fetching doc %s", doc_ref, exc_info=True)
        return {"ok": False, "error": f"Failed to fetch Google Doc: {exc}"}

    text = _flatten_rich(doc)
    if not text:
        return {"ok": False, "error": "Google Doc has no readable text content."}
    return {"ok": True, "title": doc.get("title") or "", "text": text}
