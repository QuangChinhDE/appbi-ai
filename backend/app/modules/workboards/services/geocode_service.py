"""Geocoding helpers for Workboard screens.

The route-map renderer must not geocode on every paint. Coordinates are
business data: when a row is created/updated with an address but no lat/lng,
the write path resolves the address ONCE and persists the result. This keeps
maps fast, deterministic, and reusable across apps.

Provider is config-driven and the endpoint/contact are environment-driven so a
deployment can point at its own Nominatim instance (the public server is
rate-limited to ~1 req/s and not meant for heavy/commercial use). Provider
failure is non-fatal — the write proceeds and an optional status column is
stamped for human review.
"""
from __future__ import annotations

import os
import re
from dataclasses import dataclass
from typing import Any, Mapping, Optional

import httpx

from app.core.logging import get_logger

logger = get_logger(__name__)

# Env-configurable so a deployment can run its own Nominatim (or a compatible
# endpoint) instead of the shared public server. Defaults keep it working
# out-of-the-box for light use.
_NOMINATIM_URL = os.getenv(
    "WORKBOARD_GEOCODE_NOMINATIM_URL", "https://nominatim.openstreetmap.org/search"
)
_GEOCODE_CONTACT = os.getenv("WORKBOARD_GEOCODE_CONTACT", "admin@appbi.io")


@dataclass(frozen=True)
class GeocodeResult:
    lat: float
    lng: float
    label: Optional[str] = None


_TOKEN_RE = re.compile(r"\[([A-Za-z0-9_]+)\]")


def render_address_template(template: str, row: Mapping[str, Any]) -> str:
    """Render a lightweight ``[Column]`` address template."""

    def repl(match: re.Match[str]) -> str:
        value = row.get(match.group(1))
        return "" if value is None else str(value)

    return _TOKEN_RE.sub(repl, template or "").strip()


def build_address(config: Any, row: Mapping[str, Any]) -> str:
    template = getattr(config, "address_template", None)
    if template:
        return render_address_template(str(template), row)
    column = getattr(config, "address_column", None)
    if column:
        return str(row.get(column) or "").strip()
    return ""


def geocode_address(config: Any, address: str) -> Optional[GeocodeResult]:
    """Resolve an address using the configured provider.

    Supports ``nominatim`` (default) and ``none``. Returns ``None`` on empty
    input or provider failure — the caller keeps writing and may stamp a status
    column so a human can fix unresolved rows.
    """
    address = (address or "").strip()
    if not address:
        return None

    provider = str(getattr(config, "provider", "nominatim") or "nominatim").lower()
    if provider == "none":
        return None

    if provider == "nominatim":
        params = {"q": address, "format": "jsonv2", "limit": "1"}
        country_codes = getattr(config, "country_codes", None)
        if country_codes:
            params["countrycodes"] = str(country_codes)
        headers = {
            # Nominatim usage policy requires an identifying User-Agent.
            "User-Agent": f"AppBI-Workboards/1.0 geocoding contact={_GEOCODE_CONTACT}",
        }
        language = getattr(config, "language", None)
        if language:
            headers["Accept-Language"] = str(language)
        timeout = float(getattr(config, "timeout_seconds", 5) or 5)
        try:
            with httpx.Client(timeout=timeout, follow_redirects=True) as client:
                res = client.get(_NOMINATIM_URL, params=params, headers=headers)
                res.raise_for_status()
                data = res.json()
            if isinstance(data, list) and data:
                first = data[0]
                lat = float(first["lat"])
                lng = float(first["lon"])
                return GeocodeResult(lat=lat, lng=lng, label=str(first.get("display_name") or ""))
        except Exception as exc:  # noqa: BLE001 - provider failures are non-fatal
            logger.warning("workboard geocode provider failed: %s", exc)

    return None
