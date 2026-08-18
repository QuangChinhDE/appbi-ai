"""Remove the legacy `appearance_config.ai_bot_flow_key` mirror.

WHAT THIS IS
------------
Before bindings, a public link named its flow with a single string in its
appearance config. `20260810_0052` turned each of those into an `AgentFlowBinding`
and the binding has been the authority ever since — `dispatch.resolve_for_link`
reads the binding and NOTHING else, with no fallback. The string stayed on as a
mirror, rewritten on every save so the two could not drift.

A mirror nobody reads is not harmless: it is a second place that appears to say
which flow a link runs, and the next person to touch this cannot tell by looking
that it is inert.

WHY IT IS NOT STRIPPED EVERYWHERE
---------------------------------
Only where a binding exists. There, the flow key is duplicated information and
deleting it loses nothing.

A link that still carries the key and has NO binding is a different thing: it is
already broken at run time (the dispatcher answers "not_configured"), and that
string is the ONLY surviving record of which flow it was meant to run. Deleting it
would destroy the information needed to repair the link, in exchange for tidiness.
So those are left exactly as they are, for a human to resolve.

Verified on this deployment before writing: 2 links carried the key, both with a
binding, 0 orphans. The clause is for the deployments that were not checked.
"""
from alembic import op

revision = "20260814_0046"
down_revision = "20260814_0045"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # `appearance_config` is `json`, NOT `jsonb`: the key-exists (`?`) and
    # key-delete (`-`) operators are defined on jsonb only, so both sides are cast
    # here and the result cast back to the column's own type. Written without the
    # casts first, which failed the migration and crash-looped the container on
    # boot — the same way a two-heads mistake did earlier in this module.
    op.execute(
        """
        UPDATE dashboard_public_links AS l
           SET appearance_config =
               ((l.appearance_config::jsonb) - 'ai_bot_flow_key')::json
         WHERE (l.appearance_config::jsonb) ? 'ai_bot_flow_key'
           AND EXISTS (SELECT 1 FROM agent_flow_bindings b WHERE b.link_id = l.id)
        """
    )


def downgrade() -> None:
    # Rebuild the mirror from the binding, which is where the value came from.
    # Lossless in the direction that matters: the binding is the authority, so
    # restoring from it can only produce the value the mirror would have held.
    op.execute(
        """
        UPDATE dashboard_public_links AS l
           SET appearance_config =
               (COALESCE(l.appearance_config::jsonb, '{}'::jsonb)
                || jsonb_build_object('ai_bot_flow_key', b.brain_key))::json
          FROM agent_flow_bindings b
         WHERE b.link_id = l.id
           AND COALESCE(b.brain_key, '') <> ''
        """
    )
