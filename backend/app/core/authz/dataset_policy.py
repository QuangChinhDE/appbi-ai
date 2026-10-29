"""The Dataset policy PORT: how core authorization reaches the Dataset policy.

The canonical Dataset capability model lives in the services layer
(``services/dataset_grants_service.py``) because it reads grant/team rows.
Core may not import services (``guardrail_rules.yaml`` layer ``be_core``), so
core asks this port and the services module registers ITSELF as the provider
when it is imported (``app.services`` imports it on package load, and every
app entrypoint reaches ``app.services``).

FAIL CLOSED: if nothing registered a provider, every call raises
``DatasetPolicyNotRegistered`` - an authorization question about a Dataset is
never answered by a default. The provider is looked up per call (attribute
access on the registered object), so behaviour is identical to the lazy
``from app.services.dataset_grants_service import ...`` it replaces.
"""
from __future__ import annotations

from typing import Any, Optional, Protocol, Set


class DatasetPolicyProvider(Protocol):
    def dataset_capabilities(self, db, user, dataset) -> Set[str]: ...

    def batch_dataset_capabilities(self, db, user, datasets) -> dict: ...

    def level_from_capabilities(self, caps: Set[str]) -> str: ...

    def grants_scope_subquery(self, user, db) -> Any: ...


class DatasetPolicyNotRegistered(RuntimeError):
    """No Dataset policy provider is wired: refuse rather than guess."""


_provider: Optional[DatasetPolicyProvider] = None


def register_dataset_policy(provider: DatasetPolicyProvider) -> None:
    global _provider
    _provider = provider


def dataset_policy() -> DatasetPolicyProvider:
    if _provider is None:
        raise DatasetPolicyNotRegistered(
            "Dataset policy provider is not registered (app.services.dataset_grants_service "
            "was never imported); refusing to decide Dataset access"
        )
    return _provider
