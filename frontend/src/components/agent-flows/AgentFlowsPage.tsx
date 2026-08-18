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
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import React from 'react';

import { hasPermission, usePermissions } from '@/hooks/use-permissions';
import { resolveFlowId } from '@/lib/agentFlows';

import { BrainBuilder } from './BrainBuilder';
import { BrainList } from './BrainList';

const MODULE = 'agent_flows';

export function AgentFlowsPage() {
  const { data: perms } = usePermissions();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // WHICH FLOW IS OPEN LIVES IN THE URL, NOT IN STATE.
  //
  // It was `useState`, so opening a flow and switching to its Runs tab left the
  // address bar on `/agent-flows` — F5 threw the reader back to the catalogue,
  // Back did not step out of the builder, and a run someone wanted to show a
  // colleague could not be linked to at all. For a screen whose whole job is
  // "look at this specific thing", not being addressable is the defect.
  //
  // THE URL CARRIES A NUMBER; THE BUILDER TAKES A KEY.
  // `?flow=12` is short, stable across renames, and matches every other module.
  // A non-numeric value is still accepted and used as the key directly, so links
  // shared while this screen used names keep working — there is no cutover.
  const param = searchParams?.get('flow') || null;
  const paramIsId = !!param && /^\d+$/.test(param);
  const [resolved, setResolved] = React.useState<Record<string, string>>({});
  const [unknownId, setUnknownId] = React.useState(false);

  React.useEffect(() => {
    if (!param || !paramIsId || resolved[param]) return;
    let live = true;
    setUnknownId(false);
    resolveFlowId(Number(param))
      .then((key) => { if (live) setResolved((m) => ({ ...m, [param]: key })); })
      // A number nobody can open and a number nobody has are the same 404 by
      // design, so this says "not available to you" rather than guessing which.
      .catch(() => { if (live) setUnknownId(true); });
    return () => { live = false; };
  }, [param, paramIsId, resolved]);

  const openKey = param === null ? null : (paramIsId ? resolved[param] ?? null : param);

  const canEdit = hasPermission(perms?.permissions, MODULE, 'edit');
  // Matches the server: module floor `edit`, plus an ownership check on the flow
  // itself (agent_flows/api.py::_may_manage_flow).
  const canPublish = hasPermission(perms?.permissions, MODULE, 'edit');

  // Called with the flow's number when the list has one, and with the key when
  // it does not — a flow created before `flow_id` existed, or one just created
  // whose row the list has not re-fetched yet. Both open the same builder.
  const openFlow = (idOrKey: string | number) => {
    router.push(`${pathname}?flow=${encodeURIComponent(String(idOrKey))}`);
  };
  const backToList = () => router.push(pathname || '/agent-flows');

  if (param !== null && paramIsId && openKey === null) {
    return (
      <div className="p-6 text-caption text-text-tertiary">
        {unknownId
          ? 'Không mở được flow này — có thể link đã cũ, flow đã bị xoá, hoặc bạn không có quyền xem.'
          : 'Đang mở flow…'}
      </div>
    );
  }

  if (openKey !== null) {
    return (
      <BrainBuilder
        brainKey={openKey}
        canEdit={canEdit}
        canPublish={canPublish}
        onBack={backToList}
      />
    );
  }
  return <BrainList canEdit={canEdit} onOpen={openFlow} />;
}

export default AgentFlowsPage;
