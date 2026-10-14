"""Dataset access has ONE storage: legacy ResourceShare(DATASET) -> DatasetGrant.

Decision Q1 (final): legacy VIEW -> `explore` (view + raw rows, NO build);
legacy EDIT -> `edit` (view + explore + build + edit, NO publish/reshare/manage).

What this does, in one transaction:
1. dataset_grants.source - where a grant came from: NULL (granted directly),
   'legacy_share' (this migration), 'dashboard:<id>' (a dashboard-share cascade,
   so revoking that dashboard share removes only what it created).
2. resource_shares_dataset_archive - an exact copy of every ResourceShare row of
   type 'dataset' (recovery / downgrade source).
3. Each legacy row becomes a grant on the same target. An existing grant on that
   target is kept when it already covers the legacy capability, replaced when
   the legacy capability covers it, and otherwise KEPT (never broadened) with
   the conflict recorded in the impact report.
4. authz_impact_reports - a JSON report (also printed): legacy VIEW holders who
   lose BUILD with the charts / dashboards / workboards they own on that
   dataset; incomparable conflicts; per-verb counts.
5. The legacy rows are deleted. Nothing reads ResourceShare(DATASET) afterwards.

Narrowing by design (VIEW loses build) is REPORTED, never silent. Nothing is
broadened: no legacy row yields publish / reshare / manage.

Downgrade restores the archived rows, deletes the grants this migration
created (source='legacy_share'), and drops the added column and tables.
"""
from __future__ import annotations

import json

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "20261008_0001"
down_revision = "20261007_0002"
branch_labels = None
depends_on = None

_CAPS = {
    "view": {"view"},
    "explore": {"view", "explore"},
    "build": {"view", "explore", "build"},
    "reshare": {"view", "reshare"},
    "edit": {"view", "explore", "build", "edit"},
    "manage": {"view", "explore", "build", "reshare", "edit", "manage"},
}


def upgrade():
    op.add_column("dataset_grants", sa.Column("source", sa.String(64), nullable=True))
    op.create_table(
        "authz_impact_reports",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("name", sa.String(128), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("payload", postgresql.JSONB, nullable=False),
    )
    op.execute(
        "CREATE TABLE resource_shares_dataset_archive AS "
        "SELECT * FROM resource_shares WHERE resource_type = 'dataset'"
    )

    conn = op.get_bind()
    legacy = conn.execute(sa.text(
        "SELECT id, resource_id, user_id, team_id, permission, shared_by "
        "FROM resource_shares WHERE resource_type = 'dataset' ORDER BY id"
    )).mappings().all()

    counts = {"legacy_rows": len(legacy), "inserted": 0, "upgraded": 0, "kept_existing": 0,
              "incomparable": 0, "orphan_dataset": 0}
    incomparable, view_losing_build = [], []
    for row in legacy:
        try:
            ds_id = int(row["resource_id"])
        except (TypeError, ValueError):
            counts["orphan_dataset"] += 1
            continue
        if not conn.execute(sa.text("SELECT 1 FROM datasets WHERE id = :i"), {"i": ds_id}).first():
            counts["orphan_dataset"] += 1
            continue
        verb = "edit" if row["permission"] == "edit" else "explore"
        target_col = "user_id" if row["user_id"] is not None else "team_id"
        target = row["user_id"] if row["user_id"] is not None else row["team_id"]
        existing = conn.execute(sa.text(
            f"SELECT id, verb FROM dataset_grants WHERE dataset_id = :d AND {target_col} = :t"
        ), {"d": ds_id, "t": target}).mappings().first()
        if existing is None:
            conn.execute(sa.text(
                f"INSERT INTO dataset_grants (dataset_id, {target_col}, verb, granted_by, source) "
                "VALUES (:d, :t, :v, :g, 'legacy_share')"
            ), {"d": ds_id, "t": target, "v": verb, "g": row["shared_by"]})
            counts["inserted"] += 1
        else:
            old = _CAPS.get(existing["verb"], set())
            new = _CAPS[verb]
            if old >= new:
                counts["kept_existing"] += 1
            elif new >= old:
                conn.execute(sa.text("UPDATE dataset_grants SET verb = :v WHERE id = :i"),
                             {"v": verb, "i": existing["id"]})
                counts["upgraded"] += 1
            else:
                counts["incomparable"] += 1
                incomparable.append({"dataset_id": ds_id, target_col: str(target),
                                     "existing_verb": existing["verb"], "legacy_verb": verb})
        if verb == "explore":
            assets = _assets_built_on(conn, ds_id, row["user_id"])
            view_losing_build.append({
                "dataset_id": ds_id,
                target_col: str(target),
                "before": "legacy VIEW share: could create charts/dashboards/workboards (build)",
                "after": "explore: may read and query, may NOT build",
                "owned_downstream_assets": assets,
            })

    payload = {"counts": counts, "view_shares_losing_build": view_losing_build,
               "incomparable_kept_existing": incomparable}
    conn.execute(sa.text(
        "INSERT INTO authz_impact_reports (name, payload) VALUES ('dataset_single_authority', cast(:p AS jsonb))"
    ), {"p": json.dumps(payload, default=str)})
    print("[authz] dataset_single_authority:", json.dumps(counts))
    conn.execute(sa.text("DELETE FROM resource_shares WHERE resource_type = 'dataset'"))


def _assets_built_on(conn, dataset_id: int, user_id) -> dict:
    if user_id is None:
        return {"note": "team share: see the team's members' assets"}
    charts = [r[0] for r in conn.execute(sa.text(
        "SELECT c.id FROM charts c JOIN dataset_tables t ON t.id = c.dataset_table_id "
        "WHERE t.dataset_id = :d AND c.owner_id = :u"
    ), {"d": dataset_id, "u": user_id})]
    dashboards = []
    if charts:
        dashboards = [r[0] for r in conn.execute(sa.text(
            "SELECT DISTINCT d.id FROM dashboards d JOIN dashboard_charts dc ON dc.dashboard_id = d.id "
            "WHERE dc.chart_id = ANY(:c) AND d.owner_id = :u"
        ), {"c": charts, "u": user_id})]
    workboards = [r[0] for r in conn.execute(sa.text(
        "SELECT id FROM workboards WHERE dataset_id = :d AND owner_id = :u"
    ), {"d": dataset_id, "u": user_id})]
    return {"charts": charts, "dashboards": dashboards, "workboards": workboards}


def downgrade():
    op.execute(
        "INSERT INTO resource_shares SELECT * FROM resource_shares_dataset_archive "
        "ON CONFLICT DO NOTHING"
    )
    op.execute("DELETE FROM dataset_grants WHERE source = 'legacy_share'")
    op.execute("DROP TABLE resource_shares_dataset_archive")
    op.drop_table("authz_impact_reports")
    op.drop_column("dataset_grants", "source")
