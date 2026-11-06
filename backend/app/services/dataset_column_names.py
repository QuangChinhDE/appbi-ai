"""Column-name rule for a table added to a Dataset.

A Dataset's snapshot lives in BigQuery, which only accepts ``[A-Za-z_][A-Za-z0-9_]*``
field names. A header like "Mã phiếu" is stored under a sanitized name and read back
under its original one. That works while SOME columns keep their name; when EVERY
column needs renaming the snapshot cannot be read back at all (every chart on the
dataset fails once the snapshot is built). So a table is refused when none of its
column names is standard, and the author is told which columns to rename when only
some are.
"""
from __future__ import annotations

from typing import Any, Dict, Iterable, List, Optional

CODE = "COLUMN_NAMES_NONSTANDARD"
_SHOWN = 8


def _names(columns: Iterable[Any]) -> List[str]:
    out = []
    for c in columns or []:
        name = c.get("name") if isinstance(c, dict) else getattr(c, "name", None)
        if name:
            out.append(str(name))
    return out


def check(columns: Iterable[Any]) -> Dict[str, Any]:
    """``{bad: [names], blocked: bool, message: str|None}`` for a table's columns."""
    from app.services.datasource_service import bq_safe_field

    names = _names(columns)
    bad = [n for n in names if bq_safe_field(n) != n]
    blocked = bool(names) and len(bad) == len(names)
    return {"bad": bad, "blocked": blocked, "message": message(bad, blocked) if bad else None}


def message(bad: List[str], blocked: bool) -> str:
    shown = ", ".join(f"'{n}'" for n in bad[:_SHOWN]) + (f" và {len(bad) - _SHOWN} cột khác" if len(bad) > _SHOWN else "")
    rule = ("Tên cột chuẩn chỉ gồm chữ không dấu, số và dấu gạch dưới, bắt đầu bằng chữ "
            "(ví dụ: ma_phieu, san_luong, ngay_tao). Đổi tên ở dòng tiêu đề của nguồn rồi thêm lại.")
    if blocked:
        return (f"Không thêm được bảng: tất cả {len(bad)} cột đều có tên không chuẩn ({shown}). "
                f"Dataset sẽ không truy vấn được sau khi lưu snapshot. {rule}")
    return (f"{len(bad)} cột có tên không chuẩn ({shown}). Bảng vẫn dùng được, nhưng nên đổi tên "
            f"để tránh lỗi khi lưu snapshot. {rule}")


def detail(result: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    if not result.get("bad"):
        return None
    return {"code": CODE, "message": result["message"], "columns": result["bad"], "blocked": result["blocked"]}
