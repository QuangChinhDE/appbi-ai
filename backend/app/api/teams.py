"""Team endpoints used by the sharing dialog."""

import uuid
from typing import List, Optional

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from sqlalchemy.orm import Session, joinedload

from app.core.database import get_db
from app.core.share_access import require_share_access
from app.core.dependencies import get_current_user
from app.models.resource_share import ResourceType
from app.models.team import Team, TeamMembership
from app.models.user import User, UserStatus

router = APIRouter(prefix="/teams", tags=["teams"])


class ShareableTeam(BaseModel):
    id: uuid.UUID
    name: str
    description: Optional[str] = None
    member_count: int


@router.get("/shareable", response_model=List[ShareableTeam])
def list_shareable_teams(
    resource_type: ResourceType = Query(...),
    resource_id: str = Query(..., min_length=1),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """List configured teams for an authorized sharing dialog."""
    require_share_access(db, current_user, resource_type, resource_id)

    teams = (
        db.query(Team)
        .options(joinedload(Team.memberships).joinedload(TeamMembership.user))
        .order_by(Team.name.asc())
        .all()
    )

    return [
        ShareableTeam(
            id=team.id,
            name=team.name,
            description=team.description,
            member_count=sum(
                1
                for membership in team.memberships
                if membership.user and membership.user.status == UserStatus.ACTIVE
            ),
        )
        for team in teams
    ]