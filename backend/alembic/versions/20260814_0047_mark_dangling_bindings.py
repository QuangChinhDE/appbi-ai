"""Mark bindings whose flow no longer exists as `broken`, with the reason.

WHY THERE ARE ANY
-----------------
`registry.delete_version` removed a version row without asking who was using the
flow. Deleting the last version therefore deleted the flow, and every binding
naming it stayed behind pointing at nothing. The dispatcher answered
`not_published` on each question and recorded nothing on the binding, so the
screens whose whole job is to show unhealthy links reported these as `active`.

Both causes are fixed in code: `delete_version` now refuses while links still use
the flow, and the dispatcher marks the binding broken when the flow is gone rather
than only when a chart is. This repairs the rows that predate those fixes, so an
operator does not have to wait for a viewer to ask a question before the problem
becomes visible.

NOT DELETED, MARKED. The binding records which flow the link was meant to run and
what data contract was agreed; that is what somebody needs in order to reassign
it. `broken` is the state the model already has for exactly this.
"""
from alembic import op

revision = "20260814_0047"
down_revision = "20260814_0046"
branch_labels = None
depends_on = None

_REASON = (
    "Flow này không còn tồn tại — link đang trỏ vào chỗ trống. "
    "Hãy gán lại flow khác cho link."
)


def upgrade() -> None:
    op.execute(
        f"""
        UPDATE agent_flow_bindings AS b
           SET status = 'broken',
               last_validation = jsonb_build_object(
                   'errors', jsonb_build_array(
                       jsonb_build_object(
                           'code', 'flow_deleted',
                           'key', b.brain_key,
                           'message', '{_REASON}'
                       )
                   ),
                   'warnings', COALESCE(
                       (b.last_validation::jsonb) -> 'warnings', '[]'::jsonb
                   )
               )::json
         WHERE b.status <> 'broken'
           AND NOT EXISTS (
               SELECT 1 FROM agent_brain_versions v
                WHERE v.brain_key = b.brain_key
           )
        """
    )


def downgrade() -> None:
    # Deliberately not reversed. The previous status said these links were healthy
    # and they were not; restoring that claim would reintroduce the defect this
    # exists to correct, and the true state is recomputed on the next question
    # anyway.
    pass
