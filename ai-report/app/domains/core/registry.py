from __future__ import annotations

from typing import Dict, Iterable, List

from app.domains.core.base import DomainMetadata, DomainPack
from app.domains.customer_service import PACK as CUSTOMER_SERVICE_PACK
from app.domains.finance import PACK as FINANCE_PACK
from app.domains.generic import PACK as GENERIC_PACK
from app.domains.hr import PACK as HR_PACK
from app.domains.marketing import PACK as MARKETING_PACK
from app.domains.operations import PACK as OPERATIONS_PACK
from app.domains.sales import PACK as SALES_PACK


_PACKS: Dict[str, DomainPack] = {
    pack.metadata.id: pack
    for pack in [
        GENERIC_PACK,
        SALES_PACK,
        MARKETING_PACK,
        FINANCE_PACK,
        HR_PACK,
        OPERATIONS_PACK,
        CUSTOMER_SERVICE_PACK,
    ]
}


def normalize_domain_id(domain_id: str | None) -> str:
    cleaned = str(domain_id or "").strip().lower().replace("-", "_")
    return cleaned or "generic"


def get_domain_pack(domain_id: str | None) -> DomainPack:
    normalized = normalize_domain_id(domain_id)
    pack = _PACKS.get(normalized)
    if pack is None:
        raise KeyError(f"Unknown domain '{domain_id}'")
    return pack


def get_public_domain_catalog() -> List[DomainMetadata]:
    return [pack.metadata for pack in _PACKS.values() if pack.metadata.public]


def iter_domain_packs() -> Iterable[DomainPack]:
    return _PACKS.values()

