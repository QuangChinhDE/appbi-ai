"""AI scope allowlist mode (deny_all_except) + allowed_* lists.

Additive: existing rows default to 'allow_all_except' (the current deny-LIST
behavior), so no behavior change for any existing scope. allowed_columns /
allowed_measures are consulted ONLY when scope_mode = 'deny_all_except'
(default-deny for sensitive datasets: a new column is hidden from the AI unless
explicitly allowed).
"""
from alembic import op

revision = "20260713_0014"
down_revision = "20260712_0013"
branch_labels = None
depends_on = None


def upgrade():
    op.execute(
        "ALTER TABLE govern_ai_scope "
        "ADD COLUMN IF NOT EXISTS scope_mode VARCHAR(24) NOT NULL DEFAULT 'allow_all_except'"
    )
    op.execute(
        "ALTER TABLE govern_ai_scope ADD COLUMN IF NOT EXISTS allowed_columns JSON NOT NULL DEFAULT '[]'"
    )
    op.execute(
        "ALTER TABLE govern_ai_scope ADD COLUMN IF NOT EXISTS allowed_measures JSON NOT NULL DEFAULT '[]'"
    )


def downgrade():
    op.execute("ALTER TABLE govern_ai_scope DROP COLUMN IF EXISTS allowed_measures")
    op.execute("ALTER TABLE govern_ai_scope DROP COLUMN IF EXISTS allowed_columns")
    op.execute("ALTER TABLE govern_ai_scope DROP COLUMN IF EXISTS scope_mode")
