import { useQuery } from '@tanstack/react-query';
import { permissionsApi } from '@/lib/api-client';

export type PermissionLevel = 'none' | 'view' | 'edit' | 'full';

export type ModuleKey =
  | 'data_sources'
  | 'datasets'
  | 'datasets'
  | 'explore_charts'
  | 'dashboards'
  | 'ai_chat'
  | 'ai_agent'
  | 'settings';

export interface MyPermissionsResponse {
  permissions: Partial<Record<ModuleKey, PermissionLevel>>;
  module_levels: Record<ModuleKey, PermissionLevel[]>;
}

const LEVEL_ORDER: Record<PermissionLevel, number> = {
  none: 0,
  view: 1,
  edit: 2,
  full: 3,
};

export function usePermissions() {
  return useQuery<MyPermissionsResponse>({
    queryKey: ['permissions', 'me'],
    queryFn: permissionsApi.getMyPermissions,
    staleTime: 2 * 60 * 1000,
    retry: false,
  });
}

/**
 * Check if user has at least `minLevel` permission on a module.
 * Levels (ascending): none < view < edit < full
 */
export function hasPermission(
  permissions: Partial<Record<string, string>> | undefined,
  module: string,
  minLevel: PermissionLevel = 'view',
): boolean {
  if (!permissions) return false;
  const perm = (permissions[module] ?? 'none') as PermissionLevel;
  return LEVEL_ORDER[perm] >= LEVEL_ORDER[minLevel];
}
