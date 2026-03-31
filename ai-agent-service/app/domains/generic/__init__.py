from app.domains.core.base import DomainMetadata, DomainPack

PACK = DomainPack(
    metadata=DomainMetadata(
        id="generic",
        label="Generic",
        description="Internal compatibility fallback for legacy AI report specs.",
        version="1.0",
        enabled=True,
        public=False,
    ),
)
