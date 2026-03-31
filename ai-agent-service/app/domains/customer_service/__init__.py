from app.domains.core.base import DomainMetadata, DomainPack

PACK = DomainPack(
    metadata=DomainMetadata(
        id="customer_service",
        label="Customer Service",
        description="Coming soon specialist pack for service quality, backlog, and support experience reporting.",
        version="0.1",
        enabled=False,
        public=True,
    ),
)
