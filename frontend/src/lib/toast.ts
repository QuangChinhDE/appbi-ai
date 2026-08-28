'use client';

import { Toaster as SonnerToaster, toast as sonnerToast } from 'sonner';

type ToastOptions = Parameters<typeof sonnerToast.success>[1];

/**
 * Ephemeral, per-action feedback only — NOT the notification center. Toasts
 * used to also write into the old localStorage-only notification store, which
 * conflated "I just clicked save" with "something happened in the background
 * that I need to know about." Background events (observability incidents,
 * snapshot failures, invites) now reach the user via the server-backed feed
 * in `@/lib/notifications` instead.
 */
export const toast = {
  success(title: unknown, options?: ToastOptions) {
    return sonnerToast.success(title as string, options);
  },
  error(title: unknown, options?: ToastOptions) {
    return sonnerToast.error(title as string, options);
  },
  info(title: unknown, options?: ToastOptions) {
    return sonnerToast.info(title as string, options);
  },
  warning(title: unknown, options?: ToastOptions) {
    return sonnerToast.warning(title as string, options);
  },
};

export const Toaster = SonnerToaster;
