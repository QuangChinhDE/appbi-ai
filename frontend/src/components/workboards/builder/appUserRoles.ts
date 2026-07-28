type Translate = (key: string, values?: Record<string, string | number>) => string;

const ROLE_VALUES = ['user', 'admin', 'owner'] as const;

function builtInRoleOptions(t?: Translate) {
  const label = (key: string, fallback: string) => (t ? t(key) : fallback);
  return [
    {
      value: 'user',
      label: label('workboards.roles.user', 'User'),
      description: label(
        'workboards.roles.userDescription',
        'End user; data scope is controlled by mini-app RLS and user hierarchy.',
      ),
    },
    {
      value: 'admin',
      label: label('workboards.roles.admin', 'Admin'),
      description: label(
        'workboards.roles.adminDescription',
        'Operations admin; data scope is controlled by mini-app RLS and user hierarchy.',
      ),
    },
    {
      value: 'owner',
      label: label('workboards.roles.owner', 'Owner'),
      description: label(
        'workboards.roles.ownerDescription',
        'Full access inside the mini-app, bypassing role/RLS limits.',
      ),
    },
  ] as const;
}

export const APP_USER_ROLE_OPTIONS = builtInRoleOptions();

export type AppUserRoleValue = (typeof ROLE_VALUES)[number];

const CANONICAL_ROLE_VALUES = new Set<string>(ROLE_VALUES);

export function normalizeAppUserRole(role?: string | null): string | null {
  const text = String(role ?? '').trim();
  if (!text) return null;
  const lowered = text.toLowerCase();
  return CANONICAL_ROLE_VALUES.has(lowered) ? lowered : text;
}

export function isOwnerAppUserRole(role?: string | null): boolean {
  return normalizeAppUserRole(role) === 'owner';
}

export function formatAppUserRoleLabel(role?: string | null, t?: Translate): string {
  const normalized = normalizeAppUserRole(role);
  const builtIn = builtInRoleOptions(t).find((option) => option.value === normalized);
  if (builtIn) return builtIn.label;
  return String(role ?? '').trim() || (t ? t('workboards.roles.unassigned') : 'Unassigned');
}

export function buildAppUserRoleOptions(
  extraRoles?: Array<string | null | undefined>,
  t?: Translate,
) {
  const extras = new Map<string, { value: string; label: string; description: string }>();
  for (const rawRole of extraRoles || []) {
    const normalized = normalizeAppUserRole(rawRole);
    if (!normalized || CANONICAL_ROLE_VALUES.has(normalized)) continue;
    extras.set(normalized, {
      value: normalized,
      label: normalized,
      description: t
        ? t('workboards.roles.legacyDescription')
        : 'Legacy role already present on this workboard.',
    });
  }
  return [...builtInRoleOptions(t), ...extras.values()];
}
