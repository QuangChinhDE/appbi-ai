'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';

import { apiClient } from '@/lib/api-client';

export type AppNotificationLevel = 'success' | 'error' | 'info' | 'warning';

export interface AppNotification {
  id: number;
  level: AppNotificationLevel;
  title: string;
  description?: string;
  link?: string;
  source?: string;
  createdAt: string;
  read: boolean;
}

interface RawNotification {
  id: number;
  level: AppNotificationLevel;
  title: string;
  description?: string | null;
  link?: string | null;
  source?: string | null;
  read: boolean;
  createdAt: string | null;
}

function normalize(raw: RawNotification): AppNotification {
  return {
    id: raw.id,
    level: raw.level,
    title: raw.title,
    description: raw.description ?? undefined,
    link: raw.link ?? undefined,
    source: raw.source ?? undefined,
    createdAt: raw.createdAt ?? new Date(0).toISOString(),
    read: raw.read,
  };
}

const NOTIFICATIONS_QUERY_KEY = ['notifications'] as const;
const POLL_INTERVAL_MS = 30_000;

async function fetchNotifications(): Promise<AppNotification[]> {
  const response = await apiClient.get<RawNotification[]>('/notifications', {
    params: { limit: 50 },
  });
  return response.data.map(normalize);
}

/**
 * Server-backed notification feed (bell icon). Replaces the old
 * localStorage-only store: notifications now come from background events
 * (observability incidents, snapshot failures, invites) recorded server-side
 * via /notifications, not from local toast() calls — so they are shared
 * across devices/sessions and survive a cleared browser.
 */
export function useNotifications() {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: NOTIFICATIONS_QUERY_KEY,
    queryFn: fetchNotifications,
    refetchInterval: typeof document === 'undefined'
      ? false
      : () => (document.visibilityState === 'visible' ? POLL_INTERVAL_MS : false),
  });

  const markReadMutation = useMutation({
    mutationFn: (id: number) => apiClient.patch(`/notifications/${id}/read`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: NOTIFICATIONS_QUERY_KEY }),
  });

  const markAllReadMutation = useMutation({
    mutationFn: () => apiClient.post('/notifications/read-all'),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: NOTIFICATIONS_QUERY_KEY }),
  });

  const clearAllMutation = useMutation({
    mutationFn: () => apiClient.delete('/notifications'),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: NOTIFICATIONS_QUERY_KEY }),
  });

  const notifications = query.data ?? [];

  return {
    notifications,
    unreadCount: notifications.filter((n) => !n.read).length,
    markNotificationRead: (id: number) => markReadMutation.mutate(id),
    markAllNotificationsRead: () => markAllReadMutation.mutate(),
    clearNotifications: () => clearAllMutation.mutate(),
  };
}
