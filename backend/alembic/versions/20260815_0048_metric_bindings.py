"""One metric, many realizations: `govern_metric_bindings`.

WHAT CHANGES, AND WHY IT IS NOT A RENAME
----------------------------------------
`govern_metrics` carried a single realization — one `dataset_id`, one
`dataset_table_id`, one `measure_ref`. A company metric computed in more than one
dataset therefore could not be recorded truthfully: the author picked one and the
rest of the business's data silently had no definition attached.

That single column also decided the product's information architecture. Because a
metric could belong to exactly one dataset, the only place it made sense to edit
one was inside that dataset — so the metric catalogue read as a per-dataset
semantic dictionary rather than the company's shared vocabulary, and an assistant
reading it saw one fragment per report instead of one definition used in several.

NOTHING IS DROPPED
------------------
The scalar columns stay. They are backfilled into this table as the PRIMARY
binding and continue to be read as a fallback, so a deployment running the old
code against the new schema, or the new code against un-backfilled rows, both
behave. Removing them is a later decision that costs nothing to defer and cannot
be undone in a hurry.
"""
from alembic import op
import sqlalchemy as sa

revision = "20260815_0048"
down_revision = "20260814_0047"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "govern_metric_bindings",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("metric_id", sa.Integer(), nullable=False),
        sa.Column("dataset_id", sa.Integer(), nullable=True),
        sa.Column("dataset_table_id", sa.Integer(), nullable=True),
        sa.Column("measure_ref", sa.String(length=256), nullable=True),
        sa.Column("is_primary", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now()),
        sa.ForeignKeyConstraint(["metric_id"], ["govern_metrics.id"], ondelete="CASCADE"),
        sa.UniqueConstraint(
            "metric_id", "dataset_table_id", "measure_ref",
            name="uq_metric_binding_target",
        ),
    )
    op.create_index("ix_govern_metric_bindings_metric_id",
                    "govern_metric_bindings", ["metric_id"])
    op.create_index("ix_metric_binding_dataset",
                    "govern_metric_bindings", ["dataset_id"])

    # Backfill: every metric that names any target today becomes one primary
    # binding. A metric bound to nothing stays bound to nothing — it is company
    # vocabulary, and inventing a realization for it would be worse than none.
    op.execute(
        """
        INSERT INTO govern_metric_bindings
              (metric_id, dataset_id, dataset_table_id, measure_ref, is_primary)
        SELECT m.id, m.dataset_id, m.dataset_table_id, m.measure_ref, true
          FROM govern_metrics m
         WHERE m.dataset_id IS NOT NULL
            OR m.dataset_table_id IS NOT NULL
            OR COALESCE(m.measure_ref, '') <> ''
        """
    )


def downgrade() -> None:
    op.drop_index("ix_metric_binding_dataset", table_name="govern_metric_bindings")
    op.drop_index("ix_govern_metric_bindings_metric_id",
                  table_name="govern_metric_bindings")
    op.drop_table("govern_metric_bindings")
