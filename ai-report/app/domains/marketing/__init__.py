from app.domains.core.base import DomainMetadata, DomainPack

PACK = DomainPack(
    metadata=DomainMetadata(
        id="marketing",
        label="Marketing",
        description="Coming soon specialist pack for campaign, acquisition, and funnel reporting.",
        version="0.1",
        enabled=False,
        public=True,
    ),
)
