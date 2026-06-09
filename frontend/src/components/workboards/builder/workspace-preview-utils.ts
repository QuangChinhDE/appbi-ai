/**
 * Shared helpers for the two builder preview components
 * (BuilderLivePreview, WorkboardPreview).
 *
 * Centralised so the access-mode logic lives in one place: as we add
 * modes (e.g. anonymous public forms in the future) only this file changes.
 */

export type WorkspaceAccessMode = 'internal' | 'public_app_users';

export interface WorkspaceLite {
  id: number;
  slug: string;
  name: string;
  token: string;
  /**
   * Server always emits this field now, but older snapshots may omit it.
   * Default to ``public_app_users`` to mirror the backend create-default
   * (workspaces are public + PIN-protected unless explicitly internal).
   */
  access_mode?: WorkspaceAccessMode;
  /** When false the public link rejects logins (Cổng deactivated). Older
   *  snapshots may omit it; treat missing as active. */
  is_active?: boolean;
  menu_config: Array<{ workboard_slug: string }>;
}

export function getAccessMode(ws: WorkspaceLite): WorkspaceAccessMode {
  return ws.access_mode === 'internal' ? 'internal' : 'public_app_users';
}

export function isWorkboardLinked(ws: WorkspaceLite, slug: string) {
  return (ws.menu_config || []).some((m) => m.workboard_slug === slug);
}

/**
 * Sort workspaces for the preview picker. We rank by:
 *   - workboard already in menu_config (highest signal)
 *   - workspace is public_app_users (matches the new product default and
 *     exercises real RLS / per-workboard app-user flows)
 *   - workspace is internal (fallback for staff-only testing)
 *
 * App-user identity now lives on the workboard itself, so workspace-level
 * user-source wiring is not part of this decision anymore.
 */
export function sortPreviewWorkspaces(
  data: WorkspaceLite[],
  slug: string,
): WorkspaceLite[] {
  return [...data].sort((a, b) => {
    const score = (ws: WorkspaceLite) =>
      (isWorkboardLinked(ws, slug) ? 8 : 0)
      + (getAccessMode(ws) === 'public_app_users' ? 4 : 0)
      + (getAccessMode(ws) === 'internal' ? 2 : 0);
    return score(b) - score(a);
  });
}

export function describePreviewIdentity(ws: WorkspaceLite): string {
  if (getAccessMode(ws) === 'internal') {
    return 'Preview runs as your AppBI account (internal workspace).';
  }
  return 'Preview runs as the sample app_user selected by role below.';
}
