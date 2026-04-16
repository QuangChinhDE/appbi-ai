'use client';

import { Toaster as SonnerToaster, toast as sonnerToast } from 'sonner';

import { addNotification, type AppNotificationLevel } from '@/lib/notifications';

type ToastOptions = Parameters<typeof sonnerToast.success>[1];

function recordToast(level: AppNotificationLevel, title: unknown, options?: ToastOptions) {
  addNotification({
    level,
    title,
    description: options?.description,
  });
}

export const toast = {
  success(title: unknown, options?: ToastOptions) {
    recordToast('success', title, options);
    return sonnerToast.success(title as string, options);
  },
  error(title: unknown, options?: ToastOptions) {
    recordToast('error', title, options);
    return sonnerToast.error(title as string, options);
  },
  info(title: unknown, options?: ToastOptions) {
    recordToast('info', title, options);
    return sonnerToast.info(title as string, options);
  },
  warning(title: unknown, options?: ToastOptions) {
    recordToast('warning', title, options);
    return sonnerToast.warning(title as string, options);
  },
};

export const Toaster = SonnerToaster;