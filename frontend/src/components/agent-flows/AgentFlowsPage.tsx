'use client';

/**
 * Agent Flows — the module entry point, and nothing else.
 *
 * Two destinations: the catalogue of brains, and the bench for building one. Both
 * live in their own file; this decides which is on screen and answers the one
 * question both need — what this user is allowed to do.
 *
 * PERMISSIONS ARE READ HERE, NOT DISCOVERED FROM A 403.
 * The module gates on three levels (`view` / `edit` / `full`). An earlier build
 * rendered Save and Publish to everybody and let the server refuse — a read-only
 * viewer got a button, pressed it, and was told "403" in a toast.
 *
 * Publishing needs `edit`, not `full`. It DOES change what a live report tells
 * viewers, but `full` on this module means "manage every flow in the deployment",
 * so requiring it here meant an author could not ship their own flow without being
 * handed everybody else's. The risk is carried at the ROW instead: the server
 * additionally requires the caller to own the flow (or administer the module), so
 * this button appearing never implies you may publish someone else's work.
 */
import React from 'react';

import { hasPermission, usePermissions } from '@/hooks/use-permissions';

import { BrainBuilder } from './BrainBuilder';
import { BrainList } from './BrainList';

const MODULE = 'agent_flows';

export function AgentFlowsPage() {
  const { data: perms } = usePermissions();
  const [openKey, setOpenKey] = React.useState<string | null>(null);

  const canEdit = hasPermission(perms?.permissions, MODULE, 'edit');
  // Matches the server: module floor `edit`, plus an ownership check on the flow
  // itself (agent_flows/api.py::_may_manage_flow).
  const canPublish = hasPermission(perms?.permissions, MODULE, 'edit');

  if (openKey !== null) {
    return (
      <BrainBuilder
        brainKey={openKey}
        canEdit={canEdit}
        canPublish={canPublish}
        onBack={() => setOpenKey(null)}
      />
    );
  }
  return <BrainList canEdit={canEdit} onOpen={setOpenKey} />;
}

export default AgentFlowsPage;
