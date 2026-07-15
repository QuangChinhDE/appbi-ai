"""Intelligence modules — teach-the-AI knowledge types + governance spine.

New tables:
  govern_rules / govern_playbooks / govern_verified_qa — how the AI analyzes
  govern_ai_instructions — versioned, scoped system steering (global/dataset/dashboard)
  govern_review_items    — THE single review ledger (suggest/certify/recertify/flag)
  govern_data_caveats    — always-inject data caveats (freshness/grain/quality)
  govern_ai_scope        — AI data scope per dataset (exclude columns/measures)
  govern_answer_provenance — which knowledge each bot answer was grounded on

All additive — no existing table is touched, defaults keep every current
behavior unchanged (no scope row = everything allowed; bot reads Approved only).
"""
from alembic import op

revision = "20260712_0013"
down_revision = "20260707_0012"
branch_labels = None
depends_on = None


def upgrade():
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS govern_rules (
            id SERIAL PRIMARY KEY,
            name VARCHAR(255) NOT NULL,
            condition_text TEXT NOT NULL,
            conclusion_text TEXT NOT NULL,
            exceptions_text TEXT,
            applies_to JSON NOT NULL DEFAULT '[]',
            status VARCHAR(24) NOT NULL DEFAULT 'Draft',
            version INTEGER NOT NULL DEFAULT 1,
            owner VARCHAR(128),
            provider VARCHAR(16) NOT NULL DEFAULT 'user',
            created_at TIMESTAMP DEFAULT now(),
            updated_at TIMESTAMP DEFAULT now()
        )
        """
    )
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS govern_playbooks (
            id SERIAL PRIMARY KEY,
            name VARCHAR(255) NOT NULL,
            trigger_text TEXT NOT NULL,
            steps JSON NOT NULL DEFAULT '[]',
            dim_priority JSON NOT NULL DEFAULT '[]',
            expected_output TEXT,
            linked_metrics JSON NOT NULL DEFAULT '[]',
            status VARCHAR(24) NOT NULL DEFAULT 'Draft',
            version INTEGER NOT NULL DEFAULT 1,
            owner VARCHAR(128),
            run_count INTEGER NOT NULL DEFAULT 0,
            last_run_at TIMESTAMP,
            provider VARCHAR(16) NOT NULL DEFAULT 'user',
            created_at TIMESTAMP DEFAULT now(),
            updated_at TIMESTAMP DEFAULT now()
        )
        """
    )
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS govern_verified_qa (
            id SERIAL PRIMARY KEY,
            question VARCHAR(512) NOT NULL,
            trigger_phrases JSON NOT NULL DEFAULT '[]',
            answer_md TEXT NOT NULL,
            chart_id INTEGER,
            dashboard_id INTEGER,
            playbook_id INTEGER,
            status VARCHAR(24) NOT NULL DEFAULT 'Draft',
            as_test BOOLEAN NOT NULL DEFAULT TRUE,
            owner VARCHAR(128),
            use_count INTEGER NOT NULL DEFAULT 0,
            last_used_at TIMESTAMP,
            version INTEGER NOT NULL DEFAULT 1,
            provider VARCHAR(16) NOT NULL DEFAULT 'user',
            created_at TIMESTAMP DEFAULT now(),
            updated_at TIMESTAMP DEFAULT now()
        )
        """
    )
    op.execute("CREATE INDEX IF NOT EXISTS ix_govern_verified_qa_dash ON govern_verified_qa (dashboard_id)")
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS govern_ai_instructions (
            id SERIAL PRIMARY KEY,
            scope VARCHAR(16) NOT NULL DEFAULT 'global',
            scope_id INTEGER,
            content_md TEXT NOT NULL,
            version INTEGER NOT NULL DEFAULT 1,
            status VARCHAR(16) NOT NULL DEFAULT 'active',
            eval_pass_rate FLOAT,
            created_by VARCHAR(128),
            created_at TIMESTAMP DEFAULT now()
        )
        """
    )
    op.execute("CREATE INDEX IF NOT EXISTS ix_govern_ai_instructions_scope ON govern_ai_instructions (scope, scope_id)")
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS govern_review_items (
            id SERIAL PRIMARY KEY,
            entity_type VARCHAR(24) NOT NULL,
            entity_id INTEGER,
            action VARCHAR(24) NOT NULL DEFAULT 'suggest',
            title VARCHAR(512) NOT NULL,
            payload JSON,
            evidence TEXT,
            confidence FLOAT,
            source VARCHAR(16) NOT NULL DEFAULT 'user',
            status VARCHAR(16) NOT NULL DEFAULT 'pending',
            note VARCHAR(512),
            created_by VARCHAR(128),
            resolved_by VARCHAR(128),
            created_at TIMESTAMP DEFAULT now(),
            resolved_at TIMESTAMP
        )
        """
    )
    op.execute("CREATE INDEX IF NOT EXISTS ix_govern_review_items_status ON govern_review_items (status)")
    op.execute("CREATE INDEX IF NOT EXISTS ix_govern_review_items_type ON govern_review_items (entity_type)")
    op.execute("CREATE INDEX IF NOT EXISTS ix_govern_review_items_created ON govern_review_items (created_at)")
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS govern_data_caveats (
            id SERIAL PRIMARY KEY,
            dataset_id INTEGER,
            title VARCHAR(255) NOT NULL,
            content TEXT NOT NULL,
            always_inject BOOLEAN NOT NULL DEFAULT TRUE,
            status VARCHAR(24) NOT NULL DEFAULT 'Approved',
            owner VARCHAR(128),
            created_at TIMESTAMP DEFAULT now(),
            updated_at TIMESTAMP DEFAULT now()
        )
        """
    )
    op.execute("CREATE INDEX IF NOT EXISTS ix_govern_data_caveats_ds ON govern_data_caveats (dataset_id)")
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS govern_ai_scope (
            id SERIAL PRIMARY KEY,
            dataset_id INTEGER NOT NULL UNIQUE,
            excluded_columns JSON NOT NULL DEFAULT '[]',
            excluded_measures JSON NOT NULL DEFAULT '[]',
            updated_by VARCHAR(128),
            updated_at TIMESTAMP DEFAULT now()
        )
        """
    )
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS govern_answer_provenance (
            id SERIAL PRIMARY KEY,
            dashboard_id INTEGER,
            question VARCHAR(512),
            refs JSON NOT NULL DEFAULT '[]',
            grounded BOOLEAN NOT NULL DEFAULT TRUE,
            created_at TIMESTAMP DEFAULT now()
        )
        """
    )
    op.execute("CREATE INDEX IF NOT EXISTS ix_govern_answer_prov_dash ON govern_answer_provenance (dashboard_id)")
    op.execute("CREATE INDEX IF NOT EXISTS ix_govern_answer_prov_created ON govern_answer_provenance (created_at)")


def downgrade():
    for t in (
        "govern_answer_provenance", "govern_ai_scope", "govern_data_caveats",
        "govern_review_items", "govern_ai_instructions", "govern_verified_qa",
        "govern_playbooks", "govern_rules",
    ):
        op.execute(f"DROP TABLE IF EXISTS {t}")
