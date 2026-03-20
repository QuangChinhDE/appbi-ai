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
  /** Raw effective permission level */
  level: EffectivePermission;
}

/**
 * Compute UI permissions from the backend-provided `user_permission` field.
 *
 * @param userPermission - The `user_permission` value from the API response.
 *   Falls back to 'none' if undefined.
 */
export function getResourcePermissions(
  userPermission?: string,
): ResourcePermissions {
  const level = (userPermission ?? 'none') as EffectivePermission;
  const n = LEVEL[level] ?? 0;
  return {
    canView: n >= LEVEL.view,
    canEdit: n >= LEVEL.edit,
    canDelete: n >= LEVEL.full,
    canShare: n >= LEVEL.full,
    level,
  };
}
