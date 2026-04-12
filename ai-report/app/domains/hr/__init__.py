from app.domains.core.base import DomainMetadata, DomainPack

PACK = DomainPack(
    metadata=DomainMetadata(
        id="hr",
        label="HR",
        description="Coming soon specialist pack for workforce, attrition, and talent reporting.",
        version="0.1",
        enabled=False,
        public=True,
    ),
)
