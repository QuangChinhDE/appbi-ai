/**
 * Authenticated workspace-admin client.
 *
 * NOTE: distinct from `lib/api/workspace.ts` (singular) which is the PUBLIC
 * end-user flow (getMeta/login/getAppShell, no auth). This module is the
 * builder-side admin surface (`workboards: full` permission) for creating a
 * workspace and attaching a workboard to its menu — backed by
 * `workspace_admin_api.py` (`POST /workspaces`, `PATCH /workspaces/{id}`).
 */
import { apiClient } from '@/lib/api-client';

export interface WorkspaceMenuItemFull {
  workboard_slug: string;
  label: string;
  description?: string | null;
  icon?: string | null;
  roles?: string[];
  view_id?: string | null;
  /** Screen ids hidden ON THIS PUBLIC LINK only (builder layout untouched). */
  hidden_screen_ids?: string[];
}

export interface WorkspaceAdmin {
  id: number;
  slug: string | null;
  name: string;
  description: string | null;
  icon: string | null;
  token: string;
  is_active: boolean;
  session_ttl_seconds: number;
  access_mode: 'internal' | 'public_app_users';
  branding: Record<string, unknown> | null;
  menu_config: WorkspaceMenuItemFull[];
}

/** A menu item with EXACTLY the keys the strict public validator accepts
 *  (`workspace_schemas.WorkspaceMenuItem`, extra="forbid"). label must be
 *  non-empty or the public menu silently drops the card. `view_id` is left
 *  out entirely when null (a non-string value would be forbidden). */
function menuItem(input: {
  workboard_slug: string;
  label: string;
  icon?: string | null;
  description?: string | null;
}): WorkspaceMenuItemFull {
  return {
    workboard_slug: input.workboard_slug,
    label: input.label,
    description: input.description ?? null,
    icon: input.icon ?? null,
    roles: [],
  };
}

export const workspaceAdminApi = {
  async list(): Promise<WorkspaceAdmin[]> {
    const r = await apiClient.get<WorkspaceAdmin[]>('/workspaces');
    return r.data || [];
  },

  async get(id: number): Promise<WorkspaceAdmin> {
    const r = await apiClient.get<WorkspaceAdmin>(`/workspaces/${id}`);
    return r.data;
  },

  /** Create a workspace whose menu ALREADY contains this workboard. slug is
   *  omitted (BE allows NULL → no 409 collision); access_mode is omitted (BE
   *  defaults to "public_app_users" so the PIN-login flow works). */
  async createWithWorkboard(input: {
    name: string;
    workboardSlug: string;
    workboardLabel: string;
    workboardIcon?: string | null;
    workboardDescription?: string | null;
  }): Promise<WorkspaceAdmin> {
    if (!input.workboardSlug) {
      throw new Error('Workboard chưa có slug — lưu workboard trước khi tạo workspace.');
    }
    const r = await apiClient.post<WorkspaceAdmin>('/workspaces', {
      name: input.name,
      menu_config: [
        menuItem({
          workboard_slug: input.workboardSlug,
          label: input.workboardLabel,
          icon: input.workboardIcon,
          description: input.workboardDescription,
        }),
      ],
    });
    return r.data;
  },

  /** Activate / deactivate the Cổng. When inactive, the public link rejects
   *  PIN logins (the app goes offline for end-users without unpublishing it). */
  async setActive(workspaceId: number, isActive: boolean): Promise<WorkspaceAdmin> {
    const r = await apiClient.patch<WorkspaceAdmin>(`/workspaces/${workspaceId}`, {
      is_active: isActive,
    });
    return r.data;
  },

  /** Append this workboard to an existing workspace's menu (idempotent).
   *  Re-fetches the FULL menu first (the preview list only carries
   *  {workboard_slug}) so sibling cards' labels/icons are not clobbered, and
   *  dedups FE-side (update_workspace does NOT dedup server-side). */
  async attachWorkboard(
    workspaceId: number,
    item: {
      workboard_slug: string;
      label: string;
      icon?: string | null;
      description?: string | null;
    },
  ): Promise<WorkspaceAdmin> {
    if (!item.workboard_slug) {
      throw new Error('Workboard chưa có slug — không thể đính kèm.');
    }
    const ws = await this.get(workspaceId);
    const existing = ws.menu_config || [];
    if (existing.some((m) => m.workboard_slug === item.workboard_slug)) {
      return ws; // already linked
    }
    const menu_config = [...existing, menuItem(item)];
    const r = await apiClient.patch<WorkspaceAdmin>(`/workspaces/${workspaceId}`, {
      menu_config,
    });
    return r.data;
  },

  /** Set the screens hidden on THIS Cổng's public link for one workboard. Only
   *  touches that workboard's menu item (other cards' fields preserved); the
   *  workboard layout is untouched, so the Builder still shows every screen. */
  async setHiddenScreens(
    workspaceId: number,
    workboardSlug: string,
    hiddenScreenIds: string[],
  ): Promise<WorkspaceAdmin> {
    const ws = await this.get(workspaceId);
    const menu_config = (ws.menu_config || []).map((m) =>
      m.workboard_slug === workboardSlug
        ? { ...m, hidden_screen_ids: hiddenScreenIds }
        : m,
    );
    const r = await apiClient.patch<WorkspaceAdmin>(`/workspaces/${workspaceId}`, {
      menu_config,
    });
    return r.data;
  },
};
