from __future__ import annotations

import copy
import secrets
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

from passlib.context import CryptContext
from sqlalchemy.orm import Session

from app.modules.workboards.models import Workboard

_pwd_ctx = CryptContext(schemes=["bcrypt"], deprecated="auto")
_PUBLIC_LINKS_KEY = "public_links"


def _settings_payload(workboard: Workboard) -> Dict[str, Any]:
    payload = workboard.settings if isinstance(workboard.settings, dict) else {}
    return copy.deepcopy(payload)


def _raw_links(workboard: Workboard) -> List[Dict[str, Any]]:
    settings = _settings_payload(workboard)
    raw = settings.get(_PUBLIC_LINKS_KEY)
    if not isinstance(raw, list):
        return []
    return [item for item in raw if isinstance(item, dict)]


def _serialize_link(raw: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "id": str(raw.get("id") or ""),
        "name": str(raw.get("name") or ""),
        "token": str(raw.get("token") or ""),
        "mode": "view" if raw.get("mode") == "view" else "form",
        "view_id": raw.get("view_id"),
        "is_active": bool(raw.get("is_active", True)),
        "has_password": bool(raw.get("password_hash")),
        "access_count": int(raw.get("access_count") or 0),
        "last_accessed_at": raw.get("last_accessed_at"),
        "created_at": raw.get("created_at"),
        "updated_at": raw.get("updated_at"),
    }


def _commit_links(db: Session, workboard: Workboard, links: List[Dict[str, Any]]) -> Workboard:
    settings = _settings_payload(workboard)
    settings[_PUBLIC_LINKS_KEY] = links
    workboard.settings = settings
    db.commit()
    db.refresh(workboard)
    return workboard


class WorkboardPublicLinkService:
    @staticmethod
    def list_links(workboard: Workboard) -> List[Dict[str, Any]]:
        return [_serialize_link(item) for item in _raw_links(workboard)]

    @staticmethod
    def get_link(workboard: Workboard, link_id: str) -> Optional[Dict[str, Any]]:
        return next((item for item in _raw_links(workboard) if str(item.get("id")) == str(link_id)), None)

    @staticmethod
    def create_link(
        db: Session,
        workboard: Workboard,
        *,
        name: str,
        mode: str,
        view_id: Optional[str],
        password: Optional[str],
    ) -> Dict[str, Any]:
        now = datetime.now(timezone.utc).isoformat()
        links = _raw_links(workboard)
        link = {
            "id": str(uuid.uuid4()),
            "name": name,
            "token": secrets.token_urlsafe(32),
            "mode": "view" if mode == "view" else "form",
            "view_id": view_id,
            "is_active": True,
            "password_hash": _pwd_ctx.hash(password) if password else None,
            "access_count": 0,
            "last_accessed_at": None,
            "created_at": now,
            "updated_at": now,
        }
        links.insert(0, link)
        _commit_links(db, workboard, links)
        return _serialize_link(link)

    @staticmethod
    def update_link(
        db: Session,
        workboard: Workboard,
        link_id: str,
        *,
        name: Optional[str] = None,
        mode: Optional[str] = None,
        view_id: Optional[str] = None,
        is_active: Optional[bool] = None,
        password: Optional[str] = None,
    ) -> Optional[Dict[str, Any]]:
        links = _raw_links(workboard)
        for item in links:
            if str(item.get("id")) != str(link_id):
                continue
            if name is not None:
                item["name"] = name
            if mode is not None:
                item["mode"] = "view" if mode == "view" else "form"
            if view_id is not None:
                item["view_id"] = view_id or None
            if is_active is not None:
                item["is_active"] = bool(is_active)
            if password is not None:
                item["password_hash"] = _pwd_ctx.hash(password) if password else None
            item["updated_at"] = datetime.now(timezone.utc).isoformat()
            _commit_links(db, workboard, links)
            return _serialize_link(item)
        return None

    @staticmethod
    def delete_link(db: Session, workboard: Workboard, link_id: str) -> bool:
        links = _raw_links(workboard)
        filtered = [item for item in links if str(item.get("id")) != str(link_id)]
        if len(filtered) == len(links):
            return False
        _commit_links(db, workboard, filtered)
        return True

    @staticmethod
    def find_by_token(db: Session, token: str) -> Tuple[Optional[Workboard], Optional[Dict[str, Any]]]:
        items = (
            db.query(Workboard)
            .filter(Workboard.is_published.is_(True))
            .all()
        )
        for workboard in items:
            for link in _raw_links(workboard):
                if str(link.get("token") or "") == token:
                    return workboard, link
        return None, None

    @staticmethod
    def verify_password(raw_link: Dict[str, Any], password: str) -> bool:
        password_hash = raw_link.get("password_hash")
        if not password_hash:
            return False
        return _pwd_ctx.verify(password, password_hash)

    @staticmethod
    def touch_access(db: Session, workboard: Workboard, link_id: str) -> Optional[Dict[str, Any]]:
        links = _raw_links(workboard)
        for item in links:
            if str(item.get("id")) != str(link_id):
                continue
            item["access_count"] = int(item.get("access_count") or 0) + 1
            item["last_accessed_at"] = datetime.now(timezone.utc).isoformat()
            item["updated_at"] = datetime.now(timezone.utc).isoformat()
            _commit_links(db, workboard, links)
            return item
        return None
