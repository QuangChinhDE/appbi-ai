'use client';

import { useEffect, useState } from 'react';

import { SessionKeepAlive } from '@/components/auth/SessionKeepAlive';
import { Sidebar } from '@/components/layout/Sidebar';

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(true);

  // Scope `overflow:hidden` to the authenticated app only.
  // Public/embed routes (/d/[token], /embed/[token]) use plain body scroll
  // and must not inherit this lock. Toggling on mount / off on unmount
  // keeps each surface's scroll model isolated.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const html = document.documentElement;
    const body = document.body;
    const prevHtml = html.style.overflow;
    const prevBody = body.style.overflow;
    html.style.overflow = 'hidden';
    body.style.overflow = 'hidden';
    return () => {
      html.style.overflow = prevHtml;
      body.style.overflow = prevBody;
    };
  }, []);

  return (
    <>
      <SessionKeepAlive />
      <div className="flex h-screen overflow-hidden bg-surface-0 print:block">
        <div className="print:hidden">
          <Sidebar
            isCollapsed={isSidebarCollapsed}
            onToggleCollapse={() => setIsSidebarCollapsed((current) => !current)}
          />
        </div>
        <main
          className={`flex-1 overflow-y-auto [scrollbar-gutter:stable] bg-surface-0 transition-[margin] duration-300 print:ml-0 print:overflow-visible print:bg-white ${
            isSidebarCollapsed ? 'ml-14' : 'ml-60'
          }`}
        >
          {children}
        </main>
      </div>
    </>
  );
}
