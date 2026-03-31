from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional

from app.schemas.agent import AgentBriefRequest, AgentPlanResponse, ParsedBriefArtifact, QualityGateArtifact


@dataclass(frozen=True)
class DomainMetadata:
    id: str
    label: str
    description: str
    version: str
    enabled: bool
    public: bool = True


@dataclass
class DomainReviewResult:
    warnings: List[str] = field(default_factory=list)
    quality_breakdown: Dict[str, float] = field(default_factory=dict)
    quality_score_delta: float = 0.0


PrepareBriefFn = Callable[[AgentBriefRequest, ParsedBriefArtifact], ParsedBriefArtifact]
PromptContextFn = Callable[..., Dict[str, Any]]
ReviewPlanFn = Callable[[AgentPlanResponse, AgentBriefRequest, QualityGateArtifact], DomainReviewResult]


@dataclass(frozen=True)
class DomainPack:
    metadata: DomainMetadata
    prepare_brief: Optional[PrepareBriefFn] = None
    enrichment_context: Optional[PromptContextFn] = None
    planner_context: Optional[PromptContextFn] = None
    insight_context: Optional[PromptContextFn] = None
    review_plan: Optional[ReviewPlanFn] = None

