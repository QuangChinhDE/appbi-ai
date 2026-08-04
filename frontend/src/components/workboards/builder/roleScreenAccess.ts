/**
 * Client-side mirror of the backend per-role screen-access gate
 * (rls_service.role_has_screen_grant + screen_runtime.is_screen_visible_for).
 *
 * Used by the builder to WARN the author — before publish — when a defined
 * app-user role can reach ZERO screens: a silent lockout the builder's
 * permissive Live Preview hides (preview bypasses the gate), so the author
 * never sees the broken public app until a real app-user opens it. Advisory
 * only; the server stays the real gate.
 *
 * NOTE: a screen's own ``visible_for_roles`` is authoritative for access — a
 * workspace GROUP's ``visible_for_roles`` only controls whether that group's
 * nav tab shows, NOT whether the role can reach the screen (types.ts:
 * ScreenGroupSpec.visible_for_roles). So group visibility is deliberately NOT
 * part of reachability; including it produced false lockouts for roles whose
 * screens live in an owner/admin-scoped workspace.
 */
import type { MiniAppLayoutSpec, ScreenSpec } from './types';

const PRIVILEGED_ROLES = new Set(['owner', 'admin']);

/** owner + admin bypass the gate entirely (app managers) — they always see
 * every screen, mirroring roles.is_privileged_role on the backend. */
export function isPrivilegedAppRole(role?: string | null): boolean {
  return PRIVILEGED_ROLES.has(String(role ?? '').trim().toLowerCase());
}

function roleMatches(list: string[] | undefined, role: string): boolean {
  // Empty/absent visible_for_roles = visible to every role (backend default).
  if (!list || list.length === 0) return true;
  return list.some((r) => String(r ?? '').trim().toLowerCase() === role);
}

/** Whether a non-privileged role has an RLS grant to a screen (mirrors
 * role_has_screen_grant): a matching rule OR a screen default. Fail-closed —
 * no rules and no default means no grant. */
function hasScreenGrant(screen: ScreenSpec, role: string): boolean {
  const hasRule = (screen.rls || []).some(
    (r) => String(r.role ?? '').trim().toLowerCase() === role,
  );
  return hasRule || Boolean(screen.rls_default);
}

/** IDs of the screens a role can actually reach — nav-visible via the screen's
 * own ``visible_for_roles`` AND RLS-granted. Privileged roles reach all
 * screens. (Workspace-group visibility is a display concern, not access — see
 * the module note.) */
export function reachableScreenIds(layout: MiniAppLayoutSpec, role: string): string[] {
  const screens = layout.screens || [];
  if (isPrivilegedAppRole(role)) return screens.map((s) => s.id);
  const r = String(role ?? '').trim().toLowerCase();
  return screens
    .filter((s) => roleMatches(s.visible_for_roles, r) && hasScreenGrant(s, r))
    .map((s) => s.id);
}

export function reachableScreenCount(layout: MiniAppLayoutSpec, role: string): number {
  return reachableScreenIds(layout, role).length;
}
