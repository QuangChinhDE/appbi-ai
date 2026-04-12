from app.domains.core.base import DomainMetadata, DomainPack

PACK = DomainPack(
    metadata=DomainMetadata(
        id="operations",
        label="Operations",
        description="Coming soon specialist pack for throughput, SLA, and operational efficiency reporting.",
        version="0.1",
        enabled=False,
        public=True,
    ),
)
