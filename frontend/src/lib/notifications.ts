'use client';

import { useSyncExternalStore } from 'react';

export type AppNotificationLevel = 'success' | 'error' | 'info' | 'warning';

export interface AppNotification {
  id: string;
  level: AppNotificationLevel;
  title: string;
  description?: string;
  createdAt: string;
  read: boolean;
}

const STORAGE_KEY = 'appbi.notifications';
const MAX_NOTIFICATIONS = 100;

let isLoaded = false;
let notifications: AppNotification[] = [];
const listeners = new Set<() => void>();
const EMPTY_NOTIFICATIONS: AppNotification[] = [];

function canUseStorage(): boolean {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

function emitChange() {
  listeners.forEach((listener) => listener());
}

function persistNotifications() {
  if (!canUseStorage()) {
    return;
  }

  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(notifications));
}

function ensureLoaded() {
  if (isLoaded || !canUseStorage()) {
    return;
  }

  isLoaded = true;

  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (!stored) {
      notifications = [];
      return;
    }

    const parsed = JSON.parse(stored);
    notifications = Array.isArray(parsed)
      ? parsed.filter((item): item is AppNotification => (
        typeof item?.id === 'string'
        && typeof item?.level === 'string'
        && typeof item?.title === 'string'
        && typeof item?.createdAt === 'string'
        && typeof item?.read === 'boolean'
      )).slice(0, MAX_NOTIFICATIONS)
      : [];
  } catch {
    notifications = [];
  }
}

function createId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  return `notification-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function normalizeText(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  return undefined;
}

export function addNotification(input: {
  level: AppNotificationLevel;
  title: unknown;
  description?: unknown;
}) {
  ensureLoaded();

  const title = normalizeText(input.title);
  if (!title) {
    return null;
  }

  const notification: AppNotification = {
    id: createId(),
    level: input.level,
    title,
    description: normalizeText(input.description),
    createdAt: new Date().toISOString(),
    read: false,
  };

  notifications = [notification, ...notifications].slice(0, MAX_NOTIFICATIONS);
  persistNotifications();
  emitChange();

  return notification;
}

export function markNotificationRead(id: string) {
  ensureLoaded();

  let changed = false;
  notifications = notifications.map((notification) => {
    if (notification.id !== id || notification.read) {
      return notification;
    }

    changed = true;
    return { ...notification, read: true };
  });

  if (changed) {
    persistNotifications();
    emitChange();
  }
}

export function markAllNotificationsRead() {
  ensureLoaded();

  let changed = false;
  notifications = notifications.map((notification) => {
    if (notification.read) {
      return notification;
    }

    changed = true;
    return { ...notification, read: true };
  });

  if (changed) {
    persistNotifications();
    emitChange();
  }
}

export function clearNotifications() {
  ensureLoaded();

  if (notifications.length === 0) {
    return;
  }

  notifications = [];
  persistNotifications();
  emitChange();
}

function subscribe(listener: () => void) {
  ensureLoaded();
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot() {
  ensureLoaded();
  return notifications;
}

function getServerSnapshot() {
  return EMPTY_NOTIFICATIONS;
}

export function useNotifications() {
  const items = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  return {
    notifications: items,
    unreadCount: items.filter((notification) => !notification.read).length,
    markNotificationRead,
    markAllNotificationsRead,
    clearNotifications,
  };
}
