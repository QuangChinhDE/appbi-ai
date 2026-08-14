"""Per-step cost and input on a flow run step, so a run can be inspected.

WHAT WAS MISSING AND WHY IT MATTERS
-----------------------------------
`TraceStep` already carried `prompt_tokens` / `completion_tokens` per node — the
executor computes them as the difference across the node — and the persistence
layer dropped both on the floor because the table had nowhere to put them. So a
run could say it cost 14,000 tokens and never say WHICH step spent them, which
is the only question worth asking: the answer is almost always one node pasting
a context it did not need.

`input_preview` is new. A step recorded what it produced and never what it was
given, so a node that answered badly could not be told apart from a node that
was handed nothing to answer from.

WHAT IS DELIBERATELY *NOT* ADDED
--------------------------------
A copy of the node's configuration. The run already records the flow VERSION,
and a version's body is immutable, so the exact settings a step ran under are
recoverable by reading that version — always correct, and no second copy to
drift. Storing config per step would duplicate an entire flow body into every
run, for information already on disk.

SELF-CONTAINED — imports nothing from `app`.

Revision ID: 20260813_0043
Revises: 20260812_0042
"""
from alembic import op
import sqlalchemy as sa

revision = "20260813_0043"
down_revision = "20260812_0042"
branch_labels = None
depends_on = None

_COLUMNS = (
    # Nullable, and nullable is the honest shape: rows written before this
    # migration genuinely do not know their cost, and 0 would claim they were
    # free. The reader distinguishes "no data" from "cost nothing".
    ("prompt_tokens", sa.Integer()),
    ("completion_tokens", sa.Integer()),
    ("input_preview", sa.Text()),
)


def upgrade() -> None:
    existing = {c["name"] for c in sa.inspect(op.get_bind()).get_columns("agent_flow_run_steps")}
    for name, type_ in _COLUMNS:
        if name not in existing:
            op.add_column("agent_flow_run_steps", sa.Column(name, type_, nullable=True))


def downgrade() -> None:
    existing = {c["name"] for c in sa.inspect(op.get_bind()).get_columns("agent_flow_run_steps")}
    for name, _ in reversed(_COLUMNS):
        if name in existing:
            op.drop_column("agent_flow_run_steps", name)
