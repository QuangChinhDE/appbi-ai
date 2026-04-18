'use client';

import { useState } from 'react';
import { Sidebar } from '@/components/layout/Sidebar';
import { LanguageProvider } from '@/providers/LanguageProvider';

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(true);

  return (
    <LanguageProvider>
      <div className="flex h-screen overflow-hidden bg-surface-0 print:block">
        <div className="print:hidden">
          <Sidebar
            isCollapsed={isSidebarCollapsed}
            onToggleCollapse={() => setIsSidebarCollapsed((current) => !current)}
          />
        </div>
        <main
          className={`flex-1 overflow-y-auto bg-surface-0 transition-[margin] duration-300 print:ml-0 print:overflow-visible print:bg-white ${
            isSidebarCollapsed ? 'ml-14' : 'ml-60'
          }`}
        >
          {children}
        </main>
      </div>
    </LanguageProvider>
  );
}
