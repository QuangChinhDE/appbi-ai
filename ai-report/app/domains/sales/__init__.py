from app.domains.core.base import DomainMetadata, DomainPack

PACK = DomainPack(
    metadata=DomainMetadata(
        id="sales",
        label="Sales",
        description="Coming soon specialist pack for pipeline, quota, and sales performance reporting.",
        version="0.1",
        enabled=False,
        public=True,
    ),
)
