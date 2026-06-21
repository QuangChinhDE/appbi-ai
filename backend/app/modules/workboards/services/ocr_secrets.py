"""Helpers for handling the per-form OCR API key inside ``layout_json``.

The OCR token is BYOK and sensitive. Lifecycle:
  - SAVE (builder PATCH/create): ``encrypt_layout_ocr_keys`` encrypts any new
    plaintext key; a blank key keeps whatever was already stored.
  - BUILDER GET: ``mask_layout_ocr_keys`` blanks the key + sets ``api_key_set``
    so the owner can see "đã cấu hình" without the secret leaving the server.
  - RUNTIME / PUBLIC: ``strip_layout_ocr_keys`` removes the key entirely.
  - OCR CALL: ``get_screen_ocr_config`` returns the screen's OCR config with the
    key DECRYPTED, read straight from the DB layout (never from the client).
"""
from __future__ import annotations

import copy
from typing import Any, Dict, Optional

from app.core.crypto import _is_encrypted, decrypt_value, encrypt_value


def _iter_form_ocr(layout: Dict[str, Any]):
    """Yield (screen_id, ocr_dict) for every form screen carrying an ``ocr`` block."""
    for screen in (layout.get("screens") or []):
        if not isinstance(screen, dict):
            continue
        form = screen.get("form")
        if not isinstance(form, dict):
            continue
        ocr = form.get("ocr")
        if isinstance(ocr, dict):
            yield str(screen.get("id") or ""), ocr


def _old_keys(old_layout: Optional[Dict[str, Any]]) -> Dict[str, str]:
    out: Dict[str, str] = {}
    if isinstance(old_layout, dict):
        for sid, ocr in _iter_form_ocr(old_layout):
            k = ocr.get("api_key")
            if isinstance(k, str) and k:
                out[sid] = k
    return out


def encrypt_layout_ocr_keys(
    new_layout: Dict[str, Any], old_layout: Optional[Dict[str, Any]] = None
) -> Dict[str, Any]:
    """Return a copy of ``new_layout`` with every OCR ``api_key`` encrypted.

    A blank/placeholder key reuses the previously-stored encrypted key for the
    same screen id (so re-saving the form without re-typing keeps the token).
    """
    if not isinstance(new_layout, dict):
        return new_layout
    result = copy.deepcopy(new_layout)
    previous = _old_keys(old_layout)
    for sid, ocr in _iter_form_ocr(result):
        raw = ocr.get("api_key")
        # drop the masked-GET sentinel if it ever round-trips
        ocr.pop("api_key_set", None)
        if not raw or not str(raw).strip() or str(raw).startswith("•"):
            # keep existing stored key (if any); else clear
            if previous.get(sid):
                ocr["api_key"] = previous[sid]
            else:
                ocr["api_key"] = None
        elif _is_encrypted(str(raw)):
            ocr["api_key"] = raw  # already ciphertext
        else:
            ocr["api_key"] = encrypt_value(str(raw))
    return result


def mask_layout_ocr_keys(layout: Dict[str, Any]) -> Dict[str, Any]:
    """Return a copy with OCR keys blanked + ``api_key_set`` flag — for the builder GET."""
    if not isinstance(layout, dict):
        return layout
    result = copy.deepcopy(layout)
    for _sid, ocr in _iter_form_ocr(result):
        has = bool(ocr.get("api_key"))
        ocr["api_key"] = ""
        ocr["api_key_set"] = has
    return result


def strip_layout_ocr_keys(layout: Dict[str, Any]) -> Dict[str, Any]:
    """Return a copy with OCR keys removed entirely — for runtime/public payloads."""
    if not isinstance(layout, dict):
        return layout
    result = copy.deepcopy(layout)
    for _sid, ocr in _iter_form_ocr(result):
        ocr.pop("api_key", None)
        ocr.pop("api_key_set", None)
    return result


def get_screen_ocr_config(layout: Dict[str, Any], screen_id: str) -> Optional[Dict[str, Any]]:
    """Return the screen's OCR config with the key DECRYPTED, or None if not enabled."""
    if not isinstance(layout, dict):
        return None
    for sid, ocr in _iter_form_ocr(layout):
        if sid == screen_id:
            if not ocr.get("enabled"):
                return None
            cfg = dict(ocr)
            key = cfg.get("api_key")
            cfg["api_key"] = decrypt_value(str(key)) if key else None
            return cfg
    return None
