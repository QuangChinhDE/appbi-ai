export const APP_USER_ROLE_OPTIONS = [
  {
    value: 'user',
    label: 'User',
    description: 'Người dùng cuối, phạm vi dữ liệu theo cấu hình dataset/RLS.',
  },
  {
    value: 'admin',
    label: 'Admin',
    description: 'Vai trò quản trị vận hành, dùng cho các màn hình quản lý.',
  },
  {
    value: 'owner',
    label: 'Owner',
    description: 'Toàn quyền trong mini-app, bỏ qua giới hạn role/RLS.',
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
      description: 'Legacy role đang tồn tại trên workboard này.',
    });
  }
  return [...APP_USER_ROLE_OPTIONS, ...extras.values()];
}
