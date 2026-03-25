'use client';

import { useState } from 'react';
import { Sidebar } from '@/components/layout/Sidebar';
import { LanguageProvider } from '@/providers/LanguageProvider';

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);

  return (
    <LanguageProvider>
      <div className="flex h-screen overflow-hidden">
        <Sidebar
          isCollapsed={isSidebarCollapsed}
          onToggleCollapse={() => setIsSidebarCollapsed((current) => !current)}
        />
        <main
          className={`flex-1 overflow-y-auto bg-gray-50 transition-[margin] duration-300 ${
            isSidebarCollapsed ? 'ml-16' : 'ml-64'
          }`}
        >
          {children}
        </main>
      </div>
    </LanguageProvider>
  );
}
