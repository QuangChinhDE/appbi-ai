'use client';

/**
 * Agent Flows — the module entry point, and nothing else.
 *
 * Two destinations: the catalogue of brains, and the bench for building one. Both
 * live in their own file; this decides which is on screen and answers the one
 * question both need — what this user is allowed to do.
 *
 * PERMISSIONS ARE READ HERE, NOT DISCOVERED FROM A 403.
 * The module gates on three levels (`view` / `edit` / `full`) and publishing needs
 * the top one, because it changes what a live report tells viewers. The previous
 * build rendered Save and Publish to everybody and let the server refuse — a
 * read-only viewer got a button, pressed it, and was told "403" in a toast.
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
  const canPublish = hasPermission(perms?.permissions, MODULE, 'full');

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
