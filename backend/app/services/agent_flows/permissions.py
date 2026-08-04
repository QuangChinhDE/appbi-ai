"""Who may attach what, who may use which brain, and whose rights a run carries.

THREE QUESTIONS, KEPT APART
---------------------------
Collapsing them is what produced a design that blocked the reuse this module exists
for, so each has its own function and none of them calls the others:

  attachable(user)      What may I point a step at?      → my own view/edit rights
  usable(user)          Which brains may I put on a link? → shared with me
  run_scope(brain)      Whose rights does a run carry?    → the brain's owner

DELEGATION, STATED
------------------
Sharing a brain lends its owner's reading rights. The alternative — intersecting
with each assigner's rights — makes one brain answer differently on two links, and
"what does this brain read" stops having a single answer.

Two things keep it honest. Nobody can attach what they cannot themselves read, so a
delegation can never exceed the rights it came from. And `run_scope` re-checks at
RUN time against the owner, so rights lost after publishing take effect on the next
question rather than at the next publish.

A public viewer has no rights at all, which is why the question "whose rights" has
to be answered explicitly somewhere. It is answered here.
"""
from __future__ import annotations

import logging
from typing import Any

from sqlalchemy.orm import Session

from app.core.permissions import _owned_or_shared
from app.models.agent_brain import AgentBrainVersion
from app.models.resource_share import ResourceType
from app.services.agent_flows.contract import Brain, KnowledgeAttachment

logger = logging.getLogger(__name__)


def attachable_documents(db: Session, user: Any) -> set[int]:
    """Knowledge documents THIS user may point a step at.

    `_owned_or_shared` is the same filter the Documents screen uses — one notion of
    visibility, so the builder and that screen can never disagree about what
    somebody may open.
    """
    from app.models.governance import GovernKnowledgeDoc

    rows = _owned_or_shared(db, GovernKnowledgeDoc, ResourceType.KNOWLEDGE_DOC, user).all()
    return {int(r.id) for r in rows}


def attachable_datasets(db: Session, user: Any) -> set[int]:
    """Datasets whose semantic model THIS user may point a step at."""
    from app.models.dataset import Dataset

    rows = _owned_or_shared(db, Dataset, ResourceType.DATASET, user).all()
    return {int(r.id) for r in rows}


def check_attachments(db: Session, user: Any, brain: Brain) -> list[str]:
    """Reasons this user may not save this brain. Empty means allowed.

    Runs over `bound_sources()` — the derived list — so a step cannot smuggle a
    reference past the check by declaring it somewhere the validator forgot to look.

    Returns REASONS rather than raising, because a save form should show every
    problem at once instead of the first one.
    """
    docs = attachable_documents(db, user)
    datasets = attachable_datasets(db, user)
    problems: list[str] = []

    for src in brain.bound_sources():
        if src.source == "document":
            if not src.ref.isdigit() or int(src.ref) not in docs:
                # Deliberately does not say whether the document exists. Telling an
                # unauthorised caller "id 26 exists but is not yours" is a directory
                # of everybody else's documents.
                problems.append(f"Bạn không có quyền với tài liệu được gắn (ref {src.ref}).")
        elif src.source == "semantic":
            if not src.ref.isdigit() or int(src.ref) not in datasets:
                problems.append(f"Bạn không có quyền với bộ dữ liệu được gắn (ref {src.ref}).")
        # `metric` refs are names inside a dataset's governed catalogue and carry no
        # separate grant; they are readable by anyone who may read the report.
    return problems


def usable_brains(db: Session, user: Any):
    """Brains this user may put on a link: their own, plus those shared with them.

    Same mechanism as every other first-class resource. A brain is not special, and
    a bespoke sharing table would have been a second answer to "who may use this".
    """
    return _owned_or_shared(db, AgentBrainVersion, ResourceType.AGENT_BRAIN, user)


def run_scope(db: Session, brain_row: AgentBrainVersion, brain: Brain) -> dict[str, list]:
    """The knowledge scope a RUN of this brain may reach.

    Re-derived from the owner's CURRENT rights, not from what was stored when the
    brain was published. A brain outlives the session that authored it, and freezing
    the scope at save time means an owner who loses access to a document keeps
    answering from it — the kind of stale grant nobody goes looking for.

    Fails CLOSED: an owner who cannot be resolved yields an empty scope, so the
    brain runs with no attached knowledge rather than with all of it.
    """
    owner = _resolve_owner(db, brain_row)
    if owner is None:
        logger.warning(
            "[brain] owner %r not resolvable; running with no attached knowledge",
            brain_row.owner_email,
        )
        return {"doc_ids": [], "dataset_ids": [], "metric_names": []}

    docs = attachable_documents(db, owner)
    datasets = attachable_datasets(db, owner)
    scope: dict[str, list] = {"doc_ids": [], "dataset_ids": [], "metric_names": []}
    for src in brain.bound_sources():
        if src.source == "document" and src.ref.isdigit() and int(src.ref) in docs:
            scope["doc_ids"].append(int(src.ref))
        elif src.source == "semantic" and src.ref.isdigit() and int(src.ref) in datasets:
            scope["dataset_ids"].append(int(src.ref))
        elif src.source == "metric":
            scope["metric_names"].append(src.ref)
    return scope


def share_disclosure(brain: Brain) -> list[dict[str, str]]:
    """What a share dialog must say out loud.

    Sharing this brain lends reading rights to everything in this list. An
    undisclosed delegation is a hole; a disclosed one is a feature, and the only
    difference is whether this text is on the screen.
    """
    labels = {"document": "Tài liệu", "semantic": "Bộ dữ liệu", "metric": "Chỉ số"}
    return [
        {"source": s.source, "label": labels.get(s.source, s.source), "ref": s.ref}
        for s in brain.bound_sources()
    ]


def _resolve_owner(db: Session, brain_row: AgentBrainVersion) -> Any | None:
    from app.models.user import User

    email = (brain_row.owner_email or "").strip()
    if not email:
        return None
    return db.query(User).filter(User.email == email).first()
