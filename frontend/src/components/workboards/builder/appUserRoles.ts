export const APP_USER_ROLE_OPTIONS = [
  {
    value: 'user',
    label: 'User',
    description: 'End user, with data scope controlled by dataset/RLS settings.',
  },
  {
    value: 'admin',
    label: 'Admin',
    description: 'Operations admin role, used for management screens.',
  },
  {
    value: 'owner',
    label: 'Owner',
    description: 'Full access inside the mini-app, bypassing role/RLS limits.',
  },
] as const;

export type AppUserRoleValue = (typeof APP_USER_ROLE_OPTIONS)[number]['value'];

const CANONICAL_ROLE_VALUES = new Set<string>(
  APP_USER_ROLE_OPTIONS.map((option) => option.value),
);

export function normalizeAppUserRole(role?: string | null): string | null {
  const text = String(role ?? '').trim();
  if (!text) return null;
  const lowered = text.toLowerCase();
  return CANONICAL_ROLE_VALUES.has(lowered) ? lowered : text;
}

export function isOwnerAppUserRole(role?: string | null): boolean {
  return normalizeAppUserRole(role) === 'owner';
}

export function formatAppUserRoleLabel(role?: string | null): string {
  const normalized = normalizeAppUserRole(role);
  const builtIn = APP_USER_ROLE_OPTIONS.find((option) => option.value === normalized);
  if (builtIn) return builtIn.label;
  return String(role ?? '').trim() || 'Unassigned';
}

export function buildAppUserRoleOptions(extraRoles?: Array<string | null | undefined>) {
  const extras = new Map<string, { value: string; label: string; description: string }>();
  for (const rawRole of extraRoles || []) {
    const normalized = normalizeAppUserRole(rawRole);
    if (!normalized || CANONICAL_ROLE_VALUES.has(normalized)) continue;
    extras.set(normalized, {
      value: normalized,
      label: normalized,
      description: 'Legacy role already present on this workboard.',
    });
  }
  return [...APP_USER_ROLE_OPTIONS, ...extras.values()];
}
