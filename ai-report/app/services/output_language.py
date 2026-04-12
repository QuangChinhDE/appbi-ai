from __future__ import annotations

from typing import Iterable


VIETNAMESE_MARKERS = (
    "ă",
    "â",
    "đ",
    "ê",
    "ô",
    "ơ",
    "ư",
    "á",
    "à",
    "ả",
    "ã",
    "ạ",
    "é",
    "è",
    "ẻ",
    "ẽ",
    "ẹ",
    "í",
    "ì",
    "ỉ",
    "ĩ",
    "ị",
    "ó",
    "ò",
    "ỏ",
    "õ",
    "ọ",
    "ú",
    "ù",
    "ủ",
    "ũ",
    "ụ",
    "ý",
    "ỳ",
    "ỷ",
    "ỹ",
    "ỵ",
)

VIETNAMESE_WORD_HINTS = {
    "bao",
    "báo",
    "cáo",
    "theo",
    "dõi",
    "dữ",
    "liệu",
    "hệ",
    "thống",
    "phân",
    "tích",
    "rủi",
    "ro",
    "quản",
    "trị",
    "cần",
    "giúp",
    "để",
    "mục",
    "tiêu",
}


def pick_language(language: str | None, vi_text: str, en_text: str) -> str:
    return vi_text if normalize_output_language(language) == "vi" else en_text


def normalize_output_language(value: str | None) -> str:
    if value in {"vi", "en"}:
        return value
    return "auto"


def infer_output_language(explicit: str | None, text_parts: Iterable[str | None]) -> str:
    normalized = normalize_output_language(explicit)
    if normalized in {"vi", "en"}:
        return normalized

    combined = " ".join(part for part in text_parts if part).lower()
    if any(marker in combined for marker in VIETNAMESE_MARKERS):
        return "vi"

    tokens = {token.strip(".,!?;:()[]{}\"'") for token in combined.split()}
    if len(tokens & VIETNAMESE_WORD_HINTS) >= 2:
        return "vi"

    return "en"


def is_vietnamese(language: str | None) -> bool:
    return normalize_output_language(language) == "vi"
