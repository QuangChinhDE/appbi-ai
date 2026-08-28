'use client';

import { useEffect } from 'react';

/**
 * Root-level fallback — only fires when the error is in the root layout
 * itself (so `error.tsx` can't render, since it lives inside that layout).
 * Must render its own <html>/<body>. This closes the gap where the entire
 * app previously had no boundary above the per-route `error.tsx`.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // eslint-disable-next-line no-console
    console.error('[app-global-error]', error);
  }, [error]);

  return (
    <html lang="en">
      <body className="antialiased">
        <div style={{
          display: 'flex', minHeight: '100vh', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center', gap: '1rem', padding: '2rem', textAlign: 'center',
        }}>
          <h2 style={{ fontSize: '1.125rem', fontWeight: 600 }}>Ứng dụng gặp sự cố nghiêm trọng</h2>
          <p style={{ maxWidth: '28rem', fontSize: '0.875rem', color: '#666' }}>
            Vui lòng thử tải lại trang. Nếu vẫn lỗi, hãy liên hệ quản trị viên.
          </p>
          <button
            type="button"
            onClick={() => reset()}
            style={{
              borderRadius: '0.375rem', padding: '0.5rem 1rem', fontSize: '0.875rem',
              fontWeight: 500, background: '#0D3B7A', color: '#fff', border: 'none', cursor: 'pointer',
            }}
          >
            Thử lại
          </button>
        </div>
      </body>
    </html>
  );
}
