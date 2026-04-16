'use client';

import { useState } from 'react';
import { Sidebar } from '@/components/layout/Sidebar';
import { LanguageProvider } from '@/providers/LanguageProvider';

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(true);

  return (
    <LanguageProvider>
      <div className="flex h-screen overflow-hidden print:block">
        <div className="print:hidden">
          <Sidebar
            isCollapsed={isSidebarCollapsed}
            onToggleCollapse={() => setIsSidebarCollapsed((current) => !current)}
          />
        </div>
        <main
          className={`flex-1 overflow-y-auto bg-gray-50 transition-[margin] duration-300 print:ml-0 print:overflow-visible print:bg-white ${
            isSidebarCollapsed ? 'ml-16' : 'ml-64'
          }`}
        >
          {children}
        </main>
      </div>
    </LanguageProvider>
  );
}
