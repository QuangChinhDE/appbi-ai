"""OCR / "chụp ảnh tự điền" for mini-app forms.

Sends a captured photo to a BYOK vision model and returns values keyed by the
form's columns, coerced to each field's widget type (number / date / select).

Provider-agnostic: anthropic | openai | gemini. The caller supplies the
decrypted api_key + model (configured per-form in the builder).
"""
from __future__ import annotations

import json
import logging
import re
from typing import Any, Dict, List, Optional

import httpx

logger = logging.getLogger(__name__)

_TIMEOUT = 60.0
_DEFAULT_MODEL = {
    "anthropic": "claude-3-5-sonnet-latest",
    "openai": "gpt-4o-mini",
    "gemini": "gemini-2.5-flash",
}


class OcrError(Exception):
    def __init__(self, message: str, status_code: int = 400):
        super().__init__(message)
        self.status_code = status_code


# ── image parsing ──────────────────────────────────────────────────────────
def _split_data_url(image: str) -> tuple[str, str]:
    """Return (media_type, base64_payload) from a data URL or raw base64."""
    if image.startswith("data:") and "," in image:
        header, payload = image.split(",", 1)
        m = re.match(r"data:([^;]+)", header)
        media = m.group(1) if m else "image/jpeg"
        return media, payload
    return "image/jpeg", image


# ── prompt ─────────────────────────────────────────────────────────────────
def _build_prompt(fields: List[Dict[str, Any]], hint: Optional[str]) -> str:
    lines = [
        "Bạn là trợ lý nhập liệu. Hãy ĐỌC ảnh phiếu/biểu mẫu và trích xuất giá trị cho các trường dưới đây.",
        "Chỉ trả về DUY NHẤT một JSON object: key là mã trường (column), value là giá trị đọc được dạng chuỗi.",
        "Nếu một trường không xuất hiện rõ trong ảnh, hãy BỎ QUA key đó (không bịa).",
        "Quy ước: ngày dạng dd/mm/yyyy; số dùng dấu chấm thập phân, không kèm đơn vị.",
        "",
        "Các trường cần đọc:",
    ]
    for f in fields:
        col = f.get("column")
        if not col:
            continue
        label = f.get("label") or col
        widget = f.get("widget") or "text"
        desc = f'- "{col}" — {label} (kiểu: {widget})'
        opts = f.get("options")
        if opts:
            vals = ", ".join(str(o) for o in opts[:30])
            desc += f" — chọn một trong: [{vals}]"
        lines.append(desc)
    if hint:
        lines += ["", f"Gợi ý bố cục phiếu: {hint}"]
    lines += ["", "JSON:"]
    return "\n".join(lines)


def _field_options(field: Dict[str, Any]) -> Optional[List[str]]:
    """Static option labels for select widgets (lookup-from-table is resolved by caller)."""
    lk = field.get("lookup")
    if isinstance(lk, dict) and lk.get("kind") == "static":
        vals = lk.get("values") or []
        out = []
        for v in vals:
            if isinstance(v, dict):
                out.append(str(v.get("label", v.get("value", ""))))
        return [o for o in out if o] or None
    return None


# ── provider calls (single-shot vision) ────────────────────────────────────
def _call_anthropic(api_key, model, prompt, media, payload) -> str:
    r = httpx.post(
        "https://api.anthropic.com/v1/messages",
        headers={"x-api-key": api_key, "anthropic-version": "2023-06-01",
                 "content-type": "application/json"},
        json={"model": model, "max_tokens": 1500, "messages": [{"role": "user", "content": [
            {"type": "text", "text": prompt},
            {"type": "image", "source": {"type": "base64", "media_type": media, "data": payload}},
        ]}]},
        timeout=_TIMEOUT,
    )
    if r.status_code != 200:
        raise OcrError(_provider_err("Anthropic", r), 502)
    data = r.json()
    return "".join(b.get("text", "") for b in data.get("content", []) if b.get("type") == "text")


def _call_openai(api_key, model, prompt, media, payload) -> str:
    r = httpx.post(
        "https://api.openai.com/v1/chat/completions",
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
        json={"model": model, "max_tokens": 1500, "response_format": {"type": "json_object"},
              "messages": [{"role": "user", "content": [
                  {"type": "text", "text": prompt},
                  {"type": "image_url", "image_url": {"url": f"data:{media};base64,{payload}"}},
              ]}]},
        timeout=_TIMEOUT,
    )
    if r.status_code != 200:
        raise OcrError(_provider_err("OpenAI", r), 502)
    return r.json()["choices"][0]["message"]["content"]


def _call_gemini(api_key, model, prompt, media, payload) -> str:
    r = httpx.post(
        f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
        params={"key": api_key},
        headers={"Content-Type": "application/json"},
        json={"contents": [{"parts": [
                  {"text": prompt},
                  {"inline_data": {"mime_type": media, "data": payload}},
              ]}],
              "generationConfig": {"response_mime_type": "application/json"}},
        timeout=_TIMEOUT,
    )
    if r.status_code != 200:
        raise OcrError(_provider_err("Gemini", r), 502)
    cands = r.json().get("candidates") or []
    if not cands:
        raise OcrError("Model không trả về kết quả nhận diện.", 502)
    return "".join(p.get("text", "") for p in cands[0].get("content", {}).get("parts", []))


def _provider_err(name: str, r: httpx.Response) -> str:
    try:
        body = r.json()
        msg = body.get("error", {})
        msg = msg.get("message") if isinstance(msg, dict) else str(msg)
    except Exception:
        msg = r.text[:200]
    if r.status_code in (401, 403):
        return f"{name} từ chối token (mã {r.status_code}). Kiểm tra lại token/model trong cấu hình."
    if r.status_code == 429:
        return f"{name} báo quá giới hạn (429). Vui lòng thử lại sau."
    return f"{name} lỗi {r.status_code}: {msg}"


_CALLERS = {"anthropic": _call_anthropic, "openai": _call_openai, "gemini": _call_gemini}


# ── connection test (no image — cheap "ping" to validate token + model) ──────
def _test_anthropic(api_key, model) -> httpx.Response:
    return httpx.post(
        "https://api.anthropic.com/v1/messages",
        headers={"x-api-key": api_key, "anthropic-version": "2023-06-01",
                 "content-type": "application/json"},
        json={"model": model, "max_tokens": 1,
              "messages": [{"role": "user", "content": "ping"}]},
        timeout=30.0,
    )


def _test_openai(api_key, model) -> httpx.Response:
    return httpx.post(
        "https://api.openai.com/v1/chat/completions",
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
        json={"model": model, "max_tokens": 1,
              "messages": [{"role": "user", "content": "ping"}]},
        timeout=30.0,
    )


def _test_gemini(api_key, model) -> httpx.Response:
    return httpx.post(
        f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
        params={"key": api_key},
        headers={"Content-Type": "application/json"},
        json={"contents": [{"parts": [{"text": "ping"}]}],
              "generationConfig": {"maxOutputTokens": 1}},
        timeout=30.0,
    )


_TESTERS = {"anthropic": _test_anthropic, "openai": _test_openai, "gemini": _test_gemini}


def test_connection(*, provider: str, api_key: str, model: Optional[str] = None) -> Dict[str, Any]:
    """Validate a provider/model/api_key with a tiny text-only request.

    Returns ``{"ok": True, "provider": ..., "model": ...}`` on success;
    raises :class:`OcrError` (with a friendly message) otherwise.
    """
    provider = (provider or "anthropic").strip().lower()
    tester = _TESTERS.get(provider)
    if tester is None:
        raise OcrError(f"Nhà cung cấp không hợp lệ: {provider}")
    if not api_key:
        raise OcrError("Chưa nhập token để kiểm tra.", 400)
    model = (model or "").strip() or _DEFAULT_MODEL[provider]
    try:
        r = tester(api_key, model)
    except httpx.HTTPError as exc:
        raise OcrError(f"Không kết nối được tới nhà cung cấp: {exc}", 502) from exc
    if r.status_code != 200:
        names = {"openai": "OpenAI", "anthropic": "Anthropic", "gemini": "Gemini"}
        raise OcrError(_provider_err(names.get(provider, provider), r), 502)
    return {"ok": True, "provider": provider, "model": model}


# ── JSON + type coercion ───────────────────────────────────────────────────
def _parse_json(text: str) -> Dict[str, Any]:
    text = (text or "").strip()
    if text.startswith("```"):
        text = re.sub(r"^```[a-zA-Z]*\n?", "", text).rstrip("`").strip()
    try:
        obj = json.loads(text)
    except Exception:
        m = re.search(r"\{.*\}", text, re.S)
        if not m:
            raise OcrError("Không đọc được dữ liệu từ ảnh (model trả về sai định dạng).", 502)
        obj = json.loads(m.group(0))
    return obj if isinstance(obj, dict) else {}


def _coerce_number(v: Any) -> Any:
    s = str(v).strip().replace(" ", "")
    if not s:
        return None
    # vi-VN: 1.234,56 -> 1234.56 ; or already 1234.56
    if "," in s and "." in s:
        s = s.replace(".", "").replace(",", ".")
    elif "," in s:
        s = s.replace(",", ".")
    s = re.sub(r"[^0-9.\-]", "", s)
    try:
        return int(s) if re.fullmatch(r"-?\d+", s) else float(s)
    except Exception:
        return None


def _coerce_date(v: Any) -> Optional[str]:
    s = str(v).strip()
    m = re.match(r"(\d{1,2})[/-](\d{1,2})[/-](\d{4})", s)
    if m:
        d, mo, y = m.groups()
        return f"{y}-{int(mo):02d}-{int(d):02d}"
    m = re.match(r"(\d{4})[/-](\d{1,2})[/-](\d{1,2})", s)
    if m:
        y, mo, d = m.groups()
        return f"{y}-{int(mo):02d}-{int(d):02d}"
    return s or None


def _match_option(v: Any, options: List[str]) -> Optional[str]:
    s = str(v).strip().lower()
    for o in options:
        if str(o).strip().lower() == s:
            return o
    for o in options:
        if s and s in str(o).strip().lower():
            return o
    return str(v)


def extract(
    *,
    image: str,
    fields: List[Dict[str, Any]],
    provider: str,
    api_key: str,
    model: Optional[str] = None,
    hint: Optional[str] = None,
) -> Dict[str, Any]:
    """Run OCR and return {"values": {column: coerced}, "raw": {...}}."""
    provider = (provider or "anthropic").strip().lower()
    caller = _CALLERS.get(provider)
    if caller is None:
        raise OcrError(f"Nhà cung cấp OCR không hợp lệ: {provider}")
    if not api_key:
        raise OcrError("Chưa cấu hình token cho tính năng chụp ảnh tự điền.", 400)
    model = (model or "").strip() or _DEFAULT_MODEL[provider]

    media, payload = _split_data_url(image)
    # attach static options for select-matching
    enriched = []
    by_col = {}
    for f in fields:
        d = dict(f)
        d["options"] = _field_options(f)
        enriched.append(d)
        by_col[f.get("column")] = f
    prompt = _build_prompt(enriched, hint)

    text = caller(api_key, model, prompt, media, payload)
    raw = _parse_json(text)

    values: Dict[str, Any] = {}
    for col, val in raw.items():
        f = by_col.get(col)
        if f is None or val in (None, "", []):
            continue
        widget = (f.get("widget") or "text")
        if widget == "number":
            cv = _coerce_number(val)
        elif widget in ("date", "datetime"):
            cv = _coerce_date(val)
        elif widget in ("select", "lookup"):
            opts = _field_options(f)
            cv = _match_option(val, opts) if opts else str(val)
        elif widget == "checkbox":
            cv = str(val).strip().lower() in ("1", "true", "có", "yes", "x")
        else:
            cv = str(val)
        if cv is not None:
            values[col] = cv
    return {"values": values, "raw": raw}
