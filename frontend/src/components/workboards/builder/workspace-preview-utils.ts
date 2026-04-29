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
  app_users_config?: Record<string, unknown> | null;
  menu_config: Array<{ workboard_slug: string }>;
}

export function getAccessMode(ws: WorkspaceLite): WorkspaceAccessMode {
  return ws.access_mode === 'internal' ? 'internal' : 'public_app_users';
}

export function isWorkboardLinked(ws: WorkspaceLite, slug: string) {
  return (ws.menu_config || []).some((m) => m.workboard_slug === slug);
}

/**
 * A workspace can host preview if it's either an internal workspace (admin
 * staff opens it directly with their AppBI session) or a public_app_users
 * workspace with a populated config. Empty-config public_app_users would
 * actually fail at the backend, so we surface them last.
 */
export function isUsableForPreview(ws: WorkspaceLite): boolean {
  if (getAccessMode(ws) === 'internal') return true;
  return Boolean(
    ws.app_users_config && Object.keys(ws.app_users_config).length > 0,
  );
}

/**
 * Sort workspaces for the preview picker. We rank by:
 *   - workboard already in menu_config (highest signal)
 *   - workspace is usable (internal OR config present)
 *   - workspace is public_app_users (matches the new product default and
 *     exercises real RLS / per-workboard user table flows)
 * so the auto-selected one almost always works without further action.
 */
export function sortPreviewWorkspaces(
  data: WorkspaceLite[],
  slug: string,
): WorkspaceLite[] {
  return [...data].sort((a, b) => {
    const score = (ws: WorkspaceLite) =>
      (isWorkboardLinked(ws, slug) ? 8 : 0)
      + (isUsableForPreview(ws) ? 4 : 0)
      + (getAccessMode(ws) === 'public_app_users' ? 1 : 0);
    return score(b) - score(a);
  });
}

export function describePreviewIdentity(ws: WorkspaceLite): string {
  if (getAccessMode(ws) === 'internal') {
    return 'Preview chạy bằng tài khoản AppBI của bạn (workspace internal).';
  }
  return 'Preview chạy với app_user mẫu chọn theo role bên dưới.';
}
