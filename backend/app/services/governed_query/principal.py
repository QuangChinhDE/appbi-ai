"""Who a governed read is made for, and the one decision it is held to (spec §1).

ONE FORMULA, INTERSECTION ONLY (I-1):

    effective(action, r) = authz.can(db, live_user, action, r)
                           ∧ surface_ceiling(r)
                           ∧ policy_constraints(r)

* `authz.can` is the existing authorization core (`app/core/authz/decision.py`):
  the Dataset policy, module ceilings and PAT caps. Nothing here re-implements it.
* The SURFACE CEILING only narrows. Studio Test may not exceed the flow's attached
  datasets; the default Analyst has no extra ceiling.
* POLICY CONSTRAINTS only narrow. GovernAIScope exclusions; a lookup that fails is
  `policy_unavailable`, never "nothing excluded".

NOTHING EXTENDS IT (I-3). There is no delegation term. Agent Flow's explicit
delegations (`agent_flow_delegations`) can lend an owner's resource to a grantee;
GQS does not read them. A flow owner's, link assigner's or datasource owner's
rights are never added, implicitly or explicitly. Anything that must act beyond
the asker's rights needs its own ADR first (proposed ADR-018).
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from typing import Any, Iterable, Literal, Optional

from app.core.authz.decision import Action, Decision, can

Kind = Literal["human", "pat", "system"]
#: `chat` is the unified AI Chat Data Core; `analyst` remains for ledger rows written
#: before it (the same Core, under its earlier name).
Surface = Literal["chat", "analyst", "agent_flow", "studio_test", "chart", "preview", "profile"]

#: Surfaces a SYSTEM principal (a scheduler job) may never act on: an answer to a
#: person is made with that person's rights, not the service's (I-2).
_HUMAN_ONLY_SURFACES = frozenset({"analyst", "studio_test", "chart", "preview"})

#: Surfaces whose reach is defined by an attachment list, never by the caller's
#: whole rights: a context for them without a ceiling is refused.
_CEILING_REQUIRED = frozenset({"studio_test"})


class GovernedRefusal(Exception):
    """A typed refusal (spec §2.3). `code` is what a caller branches on;
    `message_vi` is what a person reads."""

    def __init__(self, code: str, message_vi: str, detail: Optional[dict] = None):
        super().__init__(f"{code}: {message_vi}")
        self.code = code
        self.message_vi = message_vi
        self.detail = dict(detail or {})


@dataclass(frozen=True)
class EffectivePrincipal:
    user_id: Any
    kind: Kind
    surface: Surface
    request_id: str

    @classmethod
    def for_user(cls, user: Any, *, surface: Surface, request_id: Optional[str] = None) -> "EffectivePrincipal":
        """The principal of an authenticated request. A PAT is recognised by the
        marker the auth layer stamps (`core.dependencies`). The auth layer has
        already applied the PAT's caps to the caller's permission row, so
        `authz.can` honours them; nothing here reads that row."""
        if user is None or getattr(user, "id", None) is None:
            raise GovernedRefusal("not_authenticated", "Cần đăng nhập để truy vấn dữ liệu.")
        from app.core.dependencies import PERSONAL_ACCESS_TOKEN_ID_ATTR

        kind: Kind = "pat" if getattr(user, PERSONAL_ACCESS_TOKEN_ID_ATTR, None) else "human"
        return cls(user_id=user.id, kind=kind, surface=surface,
                   request_id=request_id or uuid.uuid4().hex)

    @property
    def ref(self) -> str:
        """For audit and evidence: identity, never PII beyond the id."""
        return f"{self.kind}:{self.user_id}@{self.surface}"


@dataclass(frozen=True)
class SurfaceCeiling:
    """What a surface may reach at most. `dataset_ids=None` means the surface adds
    no ceiling of its own (the default Analyst): only the asker's rights apply."""

    dataset_ids: Optional[frozenset[int]] = None

    def allows_dataset(self, dataset_id: int) -> bool:
        return self.dataset_ids is None or int(dataset_id) in self.dataset_ids

    @classmethod
    def of(cls, dataset_ids: Optional[Iterable[int]]) -> "SurfaceCeiling":
        return cls(None if dataset_ids is None else frozenset(int(d) for d in dataset_ids))


@dataclass
class AuthorizationContext:
    """THE object GQS asks. Built per request; never cached across requests, so a
    revoked grant is honoured on the next question."""

    db: Any
    principal: EffectivePrincipal
    user: Any
    ceiling: SurfaceCeiling = field(default_factory=SurfaceCeiling)

    def __post_init__(self) -> None:
        if self.user is None or getattr(self.user, "id", None) != self.principal.user_id:
            raise GovernedRefusal("not_authenticated", "Phiên đăng nhập không khớp yêu cầu.")
        if self.principal.surface in _CEILING_REQUIRED and self.ceiling.dataset_ids is None:
            # Studio Test answers over the flow's attached datasets only. A context
            # built without that ceiling would silently mean "everything the
            # tester can read": refuse instead (fail closed).
            raise GovernedRefusal(
                "not_authorized",
                "Bề mặt này cần phạm vi dữ liệu được gắn; không có phạm vi thì không truy vấn.",
                {"surface": self.principal.surface},
            )
        if self.principal.kind == "system" and self.principal.surface in _HUMAN_ONLY_SURFACES:
            raise GovernedRefusal(
                "not_authorized",
                "Tác vụ hệ thống không được trả lời thay một người dùng.",
                {"surface": self.principal.surface},
            )

    # ── the decision ────────────────────────────────────────────────────────
    def decide(self, action: Action, dataset: Any) -> Decision:
        """I-1 for a Dataset: the authz core's answer AND the surface ceiling."""
        base = can(self.db, self.user, action, dataset)
        if not base.allowed:
            return base
        if not self.ceiling.allows_dataset(getattr(dataset, "id", -1)):
            return Decision(False, "outside this surface's ceiling", via="surface_ceiling")
        return base

    def require(self, action: Action, dataset: Any) -> Any:
        decision = self.decide(action, dataset)
        if not decision.allowed:
            raise GovernedRefusal(
                "not_authorized",
                "Bạn không có quyền truy vấn dữ liệu này.",
                {"action": action.value, "dataset_id": getattr(dataset, "id", None),
                 "reason": decision.reason, "via": decision.via},
            )
        return dataset

    # ── policy constraints ──────────────────────────────────────────────────
    def excluded_columns(self, dataset_ids: Iterable[int]) -> set[str]:
        """GovernAIScope column exclusions for an AI surface. A failed lookup is a
        REFUSAL (`policy_unavailable`): unknown is not empty (SEC-05 class)."""
        cols, _measures = self.ai_scope_exclusions(dataset_ids)
        return cols

    def ai_scope_exclusions(self, dataset_ids: Iterable[int]) -> tuple[set[str], set[str]]:
        """(columns, measures) GovernAIScope hides from an AI surface, folded the
        same way the store folds them. Fails closed like `excluded_columns`."""
        ids = {int(d) for d in dataset_ids}
        if not ids:
            return set(), set()
        try:
            from app.services.governance_ai_service import GovernanceAIService

            cols, measures = GovernanceAIService.scope_exclusions(self.db, ids)
        except Exception as exc:  # noqa: BLE001 - any failure means "unknown"
            raise GovernedRefusal(
                "policy_unavailable",
                "Không đọc được phạm vi dữ liệu AI được phép dùng; tạm không truy vấn.",
                {"dataset_ids": sorted(ids), "error": type(exc).__name__},
            ) from exc
        return {str(c).strip().lower() for c in cols}, {str(m).strip().lower() for m in measures}
