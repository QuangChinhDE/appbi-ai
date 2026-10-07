"""Observability alert channels: an explicit global / dataset scope.

A channel with ``dataset_id IS NULL`` used to BE a global channel by convention,
and the API skipped every object check for it because there was no dataset to
check: any ``observability: edit`` user could repoint, test or delete it, and it
received every dataset's incidents. Global is now a declared property
(``scope = 'global'``) that only an Observability administrator may manage.

Additive and data-preserving: existing rows are backfilled from ``dataset_id``
(NULL -> 'global', else 'dataset'); a CHECK keeps the two consistent.
Downgrade drops the column and the constraint; nothing else is touched.
"""
from alembic import op
import sqlalchemy as sa

revision = "20261007_0001"
down_revision = "20261006_0001"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "observability_alert_channels",
        sa.Column("scope", sa.String(16), nullable=False, server_default="dataset"),
    )
    op.execute(
        "UPDATE observability_alert_channels SET scope = 'global' WHERE dataset_id IS NULL"
    )
    op.create_check_constraint(
        "ck_obs_alert_channel_scope",
        "observability_alert_channels",
        "(scope = 'global' AND dataset_id IS NULL) OR (scope = 'dataset' AND dataset_id IS NOT NULL)",
    )


def downgrade():
    op.drop_constraint("ck_obs_alert_channel_scope", "observability_alert_channels", type_="check")
    op.drop_column("observability_alert_channels", "scope")
