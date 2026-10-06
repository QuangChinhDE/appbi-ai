/**
 * useResourcePermission — determine what the current user can do with a resource.
 *
 * The backend returns `user_permission` on every resource response:
 *   'none' | 'view' | 'edit' | 'full'
 *
 * Action matrix:
 *   none → nothing
 *   view → read-only (no edit/delete/share buttons)
 *   edit → can modify (but not delete or share)
 *   full → can edit + delete + share  (owner or admin)
 */

export type EffectivePermission = 'none' | 'view' | 'edit' | 'full';

const LEVEL: Record<EffectivePermission, number> = {
  none: 0,
  view: 1,
  edit: 2,
  full: 3,
};

export interface ResourcePermissions {
  /** Can the user see this resource at all? */
  canView: boolean;
  /** Can the user modify/save this resource? */
  canEdit: boolean;
  /** Can the user delete this resource? */
  canDelete: boolean;
  /** Can the user share this resource? */
  canShare: boolean;
  /** Can the user publish it (public links, embeds, ...)? */
  canPublish: boolean;
  /** Raw effective permission level (display only) */
  level: EffectivePermission;
}

/** Backend-computed {action: allowed} for THIS caller (`capabilities` on every
 *  resource response). The backend decides; the UI only reads it. */
export type ResourceCapabilities = Record<string, boolean> | null | undefined;

/**
 * What the UI may OFFER for a resource. When the backend sent `capabilities`
 * (it does for every resource response), they decide - the frontend does not
 * reconstruct owner / share / team / PAT / module-admin rules. The level is
 * only a fallback for an older response without them. Every mutation is still
 * re-checked by the API: hiding a button is UX, not security.
 */
export function getResourcePermissions(
  userPermission?: string | null,
  capabilities?: ResourceCapabilities,
): ResourcePermissions {
  const level = (userPermission ?? 'none') as EffectivePermission;
  if (capabilities) {
    return {
      canView: !!capabilities.read,
      canEdit: !!capabilities.edit,
      canDelete: !!(capabilities.delete ?? capabilities.manage),
      canShare: !!(capabilities.share ?? capabilities.grant),
      canPublish: !!capabilities.publish,
      level,
    };
  }
  const n = LEVEL[level] ?? 0;
  return {
    canView: n >= LEVEL.view,
    canEdit: n >= LEVEL.edit,
    canDelete: n >= LEVEL.full,
    canShare: n >= LEVEL.full,
    canPublish: false,
    level,
  };
}

/** A list's "access" bucket for one item, for filtering and badges only. */
export type AccessTier = 'manage' | 'edit' | 'view' | 'none';

/**
 * The access bucket of a listed resource, read from the backend's
 * `capabilities` (manage/delete -> manage, edit -> edit, read -> view). The
 * legacy level is translated here only, for an older response without
 * capabilities - no page compares levels itself.
 */
export function accessTier(
  userPermission?: string | null,
  capabilities?: ResourceCapabilities,
): AccessTier {
  if (capabilities) {
    if (capabilities.manage || capabilities.delete) return 'manage';
    if (capabilities.edit) return 'edit';
    if (capabilities.read) return 'view';
    return 'none';
  }
  const p = getResourcePermissions(userPermission, null);
  return p.canDelete ? 'manage' : p.canEdit ? 'edit' : p.canView ? 'view' : 'none';
}
