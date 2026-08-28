'use client';

import { useEffect } from 'react';

/**
 * Route-level error boundary. Before this, a Server/Client Component error
 * anywhere in the app fell through to Next.js's default error page — a dead
 * end that bypassed the app's own toast/notification UX entirely.
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // eslint-disable-next-line no-console
    console.error('[app-error]', error);
  }, [error]);

  return (
    <div className="flex h-full min-h-[60vh] flex-col items-center justify-center gap-4 p-8 text-center">
      <h2 className="text-lg font-semibold text-foreground">Đã có lỗi xảy ra</h2>
      <p className="max-w-md text-sm text-muted-foreground">
        Trang này gặp sự cố khi tải. Bạn có thể thử lại hoặc quay về trang chủ.
      </p>
      <div className="flex gap-3">
        <button
          type="button"
          onClick={() => reset()}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          Thử lại
        </button>
        <a
          href="/"
          className="rounded-md border border-border px-4 py-2 text-sm font-medium hover:bg-muted"
        >
          Về trang chủ
        </a>
      </div>
    </div>
  );
}
